/**
 * `number_reservations_document_fk` (not deferrable) against the committed migration on PGlite.
 * Each flow runs on the real core over the in-memory store while a recorder logs, in order,
 * every `documents` insert/update and every `reservations.tryReserve`. The log is then replayed
 * as SQL in one Postgres transaction on the migrated schema: a reservation for a document whose
 * row does not exist yet fails with SQLSTATE 23503, as it would under a Postgres `CoreStore`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { DocumentId } from "@kvitbit/domain/contract";
import { CurrentCaller, Documents, IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DocumentPayments, DocumentRecord, DocumentsTestLayer } from "../src/modules/documents";
import { NumberingSeries } from "../src/modules/numbering";
import { CoreStore, type Reservation } from "../src/store/CoreStore";
import type { Collection, Row } from "../src/store/tables";
import { MemoryTables } from "../src/store/tables";
import { member, runTest, WORKSPACE_A } from "./helpers";
import { CZ_BUYER, invoiceInput, seed } from "./modules/documents/fixtures";

const MIGRATION = new URL("../../db/drizzle/20261123175822_init/migration.sql", import.meta.url);

type Event =
  | { readonly op: "insert" | "update"; readonly row: DocumentRecord }
  | { readonly op: "reserve"; readonly reservation: Reservation };

/** Wraps the in-memory CoreStore and the documents collection to log their writes in order. */
const recorder = (log: Array<Event>) =>
  Layer.merge(
    Layer.effect(
      CoreStore,
      Effect.map(CoreStore, (store) => ({
        ...store,
        reservations: {
          tryReserve: (reservation: Reservation) =>
            Effect.suspend(() => {
              log.push({ op: "reserve", reservation });
              return store.reservations.tryReserve(reservation);
            }),
        },
      })),
    ),
    Layer.effect(
      MemoryTables,
      Effect.map(MemoryTables, (tables) => ({
        collection: <A extends Row>(def: Parameters<typeof tables.collection<A>>[0]) => {
          const c: Collection<A> = tables.collection(def);
          if (def.name !== "documents") return c;
          const append = (op: "insert" | "update", row: A) =>
            Effect.sync(() => {
              if (!Schema.is(DocumentRecord)(row)) throw new Error("Expected a stored document");
              log.push({ op, row });
            });
          return {
            ...c,
            insert: (row: A) => Effect.tap(c.insert(row), (stored) => append("insert", stored)),
            update: (next: A, expectedRevision: number) =>
              Effect.tap(c.update(next, expectedRevision), (stored) => append("update", stored)),
          };
        },
      })),
    ),
  );

const TODAY = IsoDate.make("2026-11-23");

/** Runs `flow` on the real core and returns the recorded statements of its last transaction. */
const record = async <A, E>(
  flow: Effect.Effect<A, E, CurrentCaller | Documents | DocumentPayments | CoreStore>,
): Promise<ReadonlyArray<Event>> => {
  const log: Array<Event> = [];
  const exit = await runTest(
    member("owner"),
    Effect.gen(function* () {
      yield* seed("vat_payer", { seriesByKind: {} });
      const store = yield* CoreStore;
      yield* store.transaction(
        Effect.flatMap(NumberingSeries, (n) =>
          n.ensureDefaults(WORKSPACE_A, [
            "invoice",
            "proforma",
            "credit_note",
            "payment_tax_document",
          ]),
        ),
      );
      return yield* flow;
    }).pipe(Effect.provide(DocumentsTestLayer.pipe(Layer.provideMerge(recorder(log))))),
    { fixings: [] },
  );
  if (Exit.isFailure(exit)) throw new Error("Document flow failed", { cause: exit.cause });
  return log;
};

/** Replays `events` as SQL in one transaction; returns the failing SQLSTATE and message, if any. */
const replay = async (events: ReadonlyArray<Event>) => {
  const series = new Map<string, string>();
  for (const e of events) {
    if (e.op === "reserve" && e.reservation.seriesId !== null) {
      series.set(e.reservation.seriesId, e.reservation.kind);
    } else if (e.op !== "reserve" && e.row.seriesId !== null) {
      series.set(e.row.seriesId, e.row.kind);
    }
  }
  await db.exec("BEGIN");
  try {
    await db.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, 'ws-a', 'A')`, [
      WORKSPACE_A,
    ]);
    await db.query(`INSERT INTO contacts (id, workspace_id, name) VALUES ($1, $2, 'Buyer')`, [
      CZ_BUYER,
      WORKSPACE_A,
    ]);
    await EffectArray.reduce(series, Promise.resolve(), (previous, [id, kind]) =>
      previous
        .then(() =>
          db.query(
            `INSERT INTO numbering_series (id, workspace_id, kind, name, pattern) VALUES ($1, $2, $3, $4, 'YYYY-NNNN')`,
            [id, WORKSPACE_A, kind, `series ${id}`],
          ),
        )
        .then(() => undefined),
    );
    const execute = (e: Event) => {
      if (e.op === "reserve") {
        const r = e.reservation;
        return db.query(
          `INSERT INTO number_reservations (workspace_id, kind, number, series_id, document_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [r.workspaceId, r.kind, r.number, r.seriesId, r.documentId],
        );
      }
      if (e.op === "insert") {
        const d = e.row;
        return db.query(
          `INSERT INTO documents (id, workspace_id, kind, status, number, series_id, contact_id,
             currency, language, payment_method)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cs', 'bank_transfer')`,
          [d.id, d.workspaceId, d.kind, d.status, d.number, d.seriesId, d.contactId, d.currency],
        );
      }
      const d = e.row;
      return db.query(
        `UPDATE documents SET status = $3, number = $4, series_id = $5
           WHERE workspace_id = $1 AND id = $2`,
        [d.workspaceId, d.id, d.status, d.number, d.seriesId],
      );
    };
    await EffectArray.reduce(events, Promise.resolve(), (previous, event) =>
      previous.then(() => execute(event)).then(() => undefined),
    );
    return null;
  } catch (error) {
    if (!Schema.is(SqlError)(error)) throw error;
    return { code: error.code, message: error.message };
  } finally {
    await db.exec("ROLLBACK");
  }
};

const SqlError = Schema.Struct({ code: Schema.String, message: Schema.String });
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(await Bun.file(MIGRATION).text());
}, 30_000);

afterAll(async () => {
  await db.close();
});

const issue = (kind: "invoice" | "proforma") =>
  Effect.flatMap(Documents, (documents) => documents.issue({ input: invoiceInput({ kind }) }));

/** Records the payment on the Proforma and issues its PTD, as `Payments.record` does. */
const payInFull = (id: DocumentId, amount: BigDecimal.BigDecimal) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const seam = yield* DocumentPayments;
    const caller = yield* CurrentCaller;
    return yield* store.transaction(
      Effect.gen(function* () {
        const on = (yield* seam.lock(WORKSPACE_A, id)).settleOn;
        yield* seam.settle(
          caller,
          WORKSPACE_A,
          on.id,
          { amount: BigDecimal.sum(on.paid.amount, amount), payments: on.payments + 1 },
          { action: "payment.record" },
        );
        return yield* seam.issuePaymentTaxDocument(caller, WORKSPACE_A, on.id, {
          amount,
          paidOn: TODAY,
        });
      }),
    );
  });

const flows = [
  { name: "issue from input", kind: "invoice", run: issue("invoice") },
  {
    name: "Credit Note",
    kind: "credit_note",
    run: Effect.flatMap(issue("invoice"), (original) =>
      Effect.flatMap(Documents, (d) => d.correct(original.id, { reason: "sleva", lines: "full" })),
    ),
  },
  {
    name: "Payment Tax Document",
    kind: "payment_tax_document",
    run: Effect.flatMap(issue("proforma"), (p) => payInFull(p.id, p.totals.gross.amount)),
  },
  {
    name: "Final Invoice",
    kind: "invoice",
    run: Effect.flatMap(issue("proforma"), (p) =>
      Effect.andThen(
        payInFull(p.id, p.totals.gross.amount),
        Effect.flatMap(Documents, (d) => d.issueFinalInvoice(p.id)),
      ),
    ),
  },
] as const;

describe("number_reservations_document_fk on the committed migration (PGlite)", () => {
  for (const flow of flows) {
    test(`${flow.name}: the document row exists before its number is reserved`, async () => {
      const events = await record(flow.run);
      const reservations = EffectArray.filter(
        events,
        (e): e is Extract<Event, { op: "reserve" }> => e.op === "reserve",
      );
      // The flow numbered a document of its kind.
      expect(EffectArray.some(reservations, (r) => r.reservation.kind === flow.kind)).toBe(true);
      // Postgres accepts every statement in core's order (23503 on a reservation before its row).
      expect(await replay(events)).toBeNull();
      // Statement order: each reservation comes after its document's insert.
      for (const r of reservations) {
        const at = events.indexOf(r);
        const inserted = Option.getOrElse(
          EffectArray.findFirstIndex(
            events,
            (e) => e.op === "insert" && e.row.id === r.reservation.documentId,
          ),
          () => -1,
        );
        expect({
          number: r.reservation.number,
          inserted: inserted !== -1 && inserted < at,
        }).toEqual({
          number: r.reservation.number,
          inserted: true,
        });
      }
    });
  }

  test("control: the same statements with each reservation before its row fail with 23503", async () => {
    const events = await record(flows[0].run);
    // Move every reservation in front of its document's insert: the order before F2.
    const reversed = [...events];
    for (const e of events) {
      if (e.op !== "reserve") continue;
      const insert = Option.getOrElse(
        EffectArray.findFirstIndex(
          reversed,
          (x) => x.op === "insert" && x.row.id === e.reservation.documentId,
        ),
        () => -1,
      );
      reversed.splice(reversed.indexOf(e), 1);
      reversed.splice(insert, 0, e);
    }
    expect(await replay(reversed)).toMatchObject({
      code: "23503",
      message: expect.stringContaining("number_reservations_document_fk"),
    });
  });
});
