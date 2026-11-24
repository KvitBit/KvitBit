/**
 * `number_reservations_document_fk` (not deferrable) against the committed migration on PGlite.
 * Each flow runs on the real core over the in-memory store while a recorder logs, in order,
 * every `documents` insert/update and every `reservations.tryReserve`. The log is then replayed
 * as SQL in one Postgres transaction on the migrated schema: a reservation for a document whose
 * row does not exist yet fails with SQLSTATE 23503, as it would under a Postgres `CoreStore`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { DocumentId, IsoDate } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit, Layer } from "effect";
import {
  DocumentPayments,
  type DocumentRecord,
  DocumentsTestLayer,
} from "../src/modules/documents";
import { NumberingSeries } from "../src/modules/numbering";
import { CoreStore, type Reservation } from "../src/store/CoreStore";
import type { Collection, Row } from "../src/store/tables";
import { MemoryTables } from "../src/store/tables";
import { member, runTest, WORKSPACE_A } from "./helpers";
import { CZ_BUYER, invoiceInput, seed } from "./modules/documents/fixtures";

const MIGRATION = fileURLToPath(
  new URL("../../db/drizzle/20261123175822_init/migration.sql", import.meta.url),
);

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
          return {
            ...c,
            insert: (row: A) =>
              Effect.tap(c.insert(row), (stored) =>
                Effect.sync(() =>
                  log.push({ op: "insert", row: stored as unknown as DocumentRecord }),
                ),
              ),
            update: (next: A, expectedRevision: number) =>
              Effect.tap(c.update(next, expectedRevision), (stored) =>
                Effect.sync(() =>
                  log.push({ op: "update", row: stored as unknown as DocumentRecord }),
                ),
              ),
          };
        },
      })),
    ),
  );

const WS = WORKSPACE_A;
const TODAY = "2026-11-23" as IsoDate;

/** Runs `flow` on the real core and returns the recorded statements of its last transaction. */
const record = async <A, E>(flow: Effect.Effect<A, E, never>): Promise<ReadonlyArray<Event>> => {
  const log: Array<Event> = [];
  const exit = await runTest(
    member("owner"),
    Effect.gen(function* () {
      yield* seed("vat_payer", { seriesByKind: {} });
      const store = yield* CoreStore;
      yield* store.transaction(
        Effect.flatMap(NumberingSeries, (n) =>
          n.ensureDefaults(WS, ["invoice", "proforma", "credit_note", "payment_tax_document"]),
        ),
      );
      return yield* flow;
    }).pipe(Effect.provide(DocumentsTestLayer), Effect.provide(recorder(log))),
    { fixings: [] },
  );
  if (Exit.isFailure(exit)) throw new Error(`flow failed: ${String(exit.cause)}`);
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
    await db.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, 'ws-a', 'A')`, [WS]);
    await db.query(`INSERT INTO contacts (id, workspace_id, name) VALUES ($1, $2, 'Buyer')`, [
      CZ_BUYER,
      WS,
    ]);
    for (const [id, kind] of series) {
      await db.query(
        `INSERT INTO numbering_series (id, workspace_id, kind, name, pattern) VALUES ($1, $2, $3, $4, 'YYYY-NNNN')`,
        [id, WS, kind, `series ${id}`],
      );
    }
    for (const e of events) {
      if (e.op === "reserve") {
        const r = e.reservation;
        await db.query(
          `INSERT INTO number_reservations (workspace_id, kind, number, series_id, document_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [r.workspaceId, r.kind, r.number, r.seriesId, r.documentId],
        );
      } else if (e.op === "insert") {
        const d = e.row;
        await db.query(
          `INSERT INTO documents (id, workspace_id, kind, status, number, series_id, contact_id,
             currency, language, payment_method)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cs', 'bank_transfer')`,
          [d.id, d.workspaceId, d.kind, d.status, d.number, d.seriesId, d.contactId, d.currency],
        );
      } else {
        const d = e.row;
        await db.query(
          `UPDATE documents SET status = $3, number = $4, series_id = $5
           WHERE workspace_id = $1 AND id = $2`,
          [d.workspaceId, d.id, d.status, d.number, d.seriesId],
        );
      }
    }
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  } finally {
    await db.exec("ROLLBACK");
  }
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(MIGRATION, "utf8"));
});

afterAll(async () => {
  await db.close();
});

const docs = Documents;
const issue = (kind: "invoice" | "proforma") =>
  Effect.flatMap(docs, (d) => d.issue({ input: invoiceInput({ kind }) }));

/** Records the payment on the Proforma and issues its PTD, as `Payments.record` does. */
const payInFull = (id: DocumentId, amount: BigDecimal.BigDecimal) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const seam = yield* DocumentPayments;
    return yield* store.transaction(
      Effect.gen(function* () {
        const on = (yield* seam.lock(WS, id)).settleOn;
        yield* seam.settle(
          WS,
          on.id,
          { amount: BigDecimal.sum(on.paid.amount, amount), payments: on.payments + 1 },
          { action: "payment.record" },
        );
        return yield* seam.issuePaymentTaxDocument(WS, on.id, { amount, paidOn: TODAY });
      }),
    );
  });

const flows: ReadonlyArray<{
  readonly name: string;
  readonly kind: DocumentRecord["kind"];
  readonly run: Effect.Effect<unknown, unknown, never>;
}> = [
  { name: "issue from input", kind: "invoice", run: issue("invoice") as never },
  {
    name: "Credit Note",
    kind: "credit_note",
    run: Effect.flatMap(issue("invoice"), (original) =>
      Effect.flatMap(docs, (d) => d.correct(original.id, { reason: "sleva", lines: "full" })),
    ) as never,
  },
  {
    name: "Payment Tax Document",
    kind: "payment_tax_document",
    run: Effect.flatMap(issue("proforma"), (p) => payInFull(p.id, p.totals.gross.amount)) as never,
  },
  {
    name: "Final Invoice",
    kind: "invoice",
    run: Effect.flatMap(issue("proforma"), (p) =>
      Effect.andThen(
        payInFull(p.id, p.totals.gross.amount),
        Effect.flatMap(docs, (d) => d.issueFinalInvoice(p.id)),
      ),
    ) as never,
  },
];

describe("number_reservations_document_fk on the committed migration (PGlite)", () => {
  for (const flow of flows) {
    test(`${flow.name}: the document row exists before its number is reserved`, async () => {
      const events = await record(flow.run);
      const reservations = events.filter(
        (e): e is Extract<Event, { op: "reserve" }> => e.op === "reserve",
      );
      // The flow numbered a document of its kind.
      expect(reservations.some((r) => r.reservation.kind === flow.kind)).toBe(true);
      // Postgres accepts every statement in core's order (23503 on a reservation before its row).
      expect(await replay(events)).toBeNull();
      // Statement order: each reservation comes after its document's insert.
      for (const r of reservations) {
        const at = events.indexOf(r);
        const inserted = events.findIndex(
          (e) => e.op === "insert" && e.row.id === r.reservation.documentId,
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
    const events = await record(flows[0]?.run as Effect.Effect<unknown, unknown, never>);
    // Move every reservation in front of its document's insert: the order before F2.
    const reversed = [...events];
    for (const e of events) {
      if (e.op !== "reserve") continue;
      const insert = reversed.findIndex(
        (x) => x.op === "insert" && x.row.id === e.reservation.documentId,
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
