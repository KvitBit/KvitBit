/**
 * Owner-facing enrichment (`DocumentView.share` / `.deliveries`) runs inside the write's
 * transaction: a failing `DocumentActivity` read rolls the whole write back (no number, no
 * document, no payment, no request-log entry) and the call fails with Unavailable{database}. The
 * request log stores the clean view; a keyed replay is enriched before it reports success, and a
 * replay whose enrichment fails leaves the stored entry as it was.
 */
import { describe, expect, test } from "bun:test";
import type { CurrentCaller, DocumentId, DocumentView, RequestKey } from "@kvitbit/domain/contract";
import { Documents, Payments, PublicShareLinks, Unavailable } from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Context, Effect, Exit, Layer, Ref } from "effect";
import { DocumentActivityLive } from "../../src/compose/documentActivity";
import {
  DeliveriesRepoMemory,
  DocumentActivity,
  documentsDeliveryTestLayer,
} from "../../src/modules/documents";
import { NumberingSeries } from "../../src/modules/numbering";
import {
  PaymentDocumentsLive,
  PaymentFakesLive,
  PaymentsLive,
  PaymentsRepoMemory,
} from "../../src/modules/payments";
import {
  ShareLinkKeysTest,
  ShareLinksRepoMemory,
  ShareLinksTestLayer,
} from "../../src/modules/sharelinks";
import { makeRequestOutcome } from "../../src/shared/requestOutcome";
import { CoreStore, StoreUnavailable } from "../../src/store/CoreStore";
import type { InMemoryPortsLive } from "../../src/testing";
import { member, runTest, TEST_NOW, WORKSPACE_A } from "../helpers";
import { invoiceInput, seed } from "../modules/documents/fixtures";

/** When set, every `DocumentActivity` read fails with `StoreUnavailable`. */
class ActivityDown extends Context.Service<ActivityDown, Ref.Ref<boolean>>()("test/ActivityDown") {}

const switchable = Layer.effect(
  DocumentActivity,
  Effect.gen(function* () {
    const inner = yield* DocumentActivity;
    const down = yield* ActivityDown;
    const gate = <A>(read: Effect.Effect<A, StoreUnavailable>) =>
      Effect.flatMap(Ref.get(down), (d) => (d ? Effect.fail(new StoreUnavailable({})) : read));
    return DocumentActivity.of({
      share: (w, id) => gate(inner.share(w, id)),
      deliveries: (w, id) => gate(inner.deliveries(w, id)),
    });
  }),
).pipe(
  Layer.provide(
    DocumentActivityLive.pipe(
      Layer.provide(Layer.mergeAll(ShareLinksRepoMemory, ShareLinkKeysTest, DeliveriesRepoMemory)),
    ),
  ),
);

const documents = documentsDeliveryTestLayer(switchable);
const world = ShareLinksTestLayer.pipe(
  Layer.provideMerge(
    PaymentsLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          PaymentDocumentsLive.pipe(Layer.provide(documents)),
          documents,
          PaymentsRepoMemory,
          PaymentFakesLive,
        ),
      ),
    ),
  ),
  Layer.provideMerge(Layer.effect(ActivityDown, Ref.make(false))),
);

type Services =
  | Layer.Success<typeof world>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

const series = Effect.flatMap(CoreStore, (store) =>
  store.transaction(
    Effect.flatMap(NumberingSeries, (n) =>
      n.ensureDefaults(WORKSPACE_A, ["invoice", "proforma", "credit_note", "payment_tax_document"]),
    ),
  ),
);

const run = <A, E>(body: Effect.Effect<A, E, Services>) =>
  runTest(
    member("owner"),
    Effect.andThen(Effect.andThen(seed("vat_payer", { seriesByKind: {} }), series), body).pipe(
      Effect.provide(world),
    ),
  );

const ok = <A, Err>(exit: Exit.Exit<A, Err>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

const setDown = (down: boolean) => Effect.flatMap(ActivityDown, (r) => Ref.set(r, down));

/** Runs `effect` under its own `RequestOutcome`; returns its exit and whether it replayed. */
const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const outcome = yield* makeRequestOutcome;
    const exit = yield* Effect.exit(Effect.provideService(effect, RequestOutcome, outcome));
    return { exit, replayed: yield* outcome.replayed };
  });

/** The stored request-log result for `key` (an Existing claim changes nothing). */
const storedResult = (key: RequestKey) =>
  Effect.flatMap(CoreStore, (store) =>
    store.transaction(
      Effect.map(
        store.requestLog.claim(
          { _tag: "Workspace", workspaceId: WORKSPACE_A },
          key,
          new Date(TEST_NOW).toISOString(),
        ),
        (claim) => (claim._tag === "Existing" ? claim.entry.result : undefined),
      ),
    ),
  );

const database = Exit.fail(new Unavailable({ dependency: "database" }));
const issueInvoice = (key?: RequestKey) =>
  Effect.flatMap(Documents, (d) =>
    d.issue({ input: invoiceInput() }, key === undefined ? undefined : { requestKey: key }),
  );
const numberOf = (exit: Exit.Exit<DocumentView, unknown>) => ok(exit).number;

describe("Documents.issue: enrichment inside the transaction", () => {
  test("a failing activity read rolls the issue back, keyless and keyed", async () => {
    const key = "issue-down" as RequestKey;
    const r = ok(
      await run(
        Effect.gen(function* () {
          yield* setDown(true);
          const keyless = yield* call(issueInvoice());
          const keyed = yield* call(issueInvoice(key));
          const afterFailure = yield* storedResult(key);
          yield* setDown(false);
          // A retry runs afresh (no request-log entry, no number taken by the failed attempts).
          const retried = yield* call(issueInvoice(key));
          const list = yield* Effect.flatMap(Documents, (d) => d.list({}));
          return { keyless, keyed, afterFailure, retried, list };
        }),
      ),
    );
    const control = ok(await run(Effect.map(call(issueInvoice()), (c) => numberOf(c.exit))));
    expect(r.keyless.exit).toEqual(database);
    expect(r.keyed.exit).toEqual(database);
    expect(r.keyed.replayed).toBe(false);
    expect(r.afterFailure).toBeUndefined();
    expect(r.retried.replayed).toBe(false);
    expect(numberOf(r.retried.exit)).toBe(control);
    expect(r.list.items).toHaveLength(1);
  });

  test("a keyed replay is enriched while the stored result is clean; a failing replay keeps it", async () => {
    const key = "issue-share" as RequestKey;
    const r = ok(
      await run(
        Effect.gen(function* () {
          const first = ok((yield* call(issueInvoice(key))).exit);
          const id = first.id as DocumentId;
          const { url } = yield* Effect.flatMap(PublicShareLinks, (s) => s.create(id));
          yield* Effect.flatMap(Documents, (d) => d.send(id));
          const replay = yield* call(issueInvoice(key));
          yield* setDown(true);
          const downReplay = yield* call(issueInvoice(key));
          yield* setDown(false);
          const again = yield* call(issueInvoice(key));
          return { url, first, replay, downReplay, again, stored: yield* storedResult(key) };
        }),
      ),
    );
    const replayed = ok(r.replay.exit);
    expect(r.replay.replayed).toBe(true);
    expect(replayed.id).toBe(r.first.id);
    expect(replayed.share?.url).toBe(r.url);
    expect(replayed.deliveries).toHaveLength(1);
    // Replay enrichment failed: Unavailable, not marked replayed, the entry still replays.
    expect(r.downReplay.exit).toEqual(database);
    expect(r.downReplay.replayed).toBe(false);
    expect(r.again.replayed).toBe(true);
    expect(ok(r.again.exit)).toEqual(replayed);
    // Stored: no bearer URL or token, no delivery history.
    const json = JSON.stringify(r.stored);
    expect(r.stored).toBeDefined();
    expect(json.includes(r.url)).toBe(false);
    expect(json.includes(r.url.slice(r.url.lastIndexOf("/") + 1))).toBe(false);
    expect((r.stored as { share: unknown; deliveries: unknown }).share).toBeNull();
    expect((r.stored as { deliveries: unknown }).deliveries).toEqual([]);
  });
});

/** Pays the whole Proforma: a vat_payer Proforma payment issues a PTD (P2). */
const payProforma = (proforma: DocumentId, key?: RequestKey) =>
  Effect.flatMap(Payments, (p) =>
    p.record(
      { target: { document: proforma } },
      key === undefined ? undefined : { requestKey: key },
    ),
  );
const issueProforma = Effect.flatMap(Documents, (d) =>
  d.issue({ input: invoiceInput({ kind: "proforma" }) }),
);

describe("Payments.record: enrichment inside the transaction", () => {
  test("a failing activity read rolls the payment and its PTD back, keyless and keyed", async () => {
    const key = "pay-down" as RequestKey;
    const r = ok(
      await run(
        Effect.gen(function* () {
          const pf = yield* issueProforma;
          const id = pf.id as DocumentId;
          yield* setDown(true);
          const keyless = yield* call(payProforma(id));
          const keyed = yield* call(payProforma(id, key));
          const afterFailure = yield* storedResult(key);
          const payments = yield* Effect.flatMap(Payments, (p) => p.listFor({ document: id }));
          yield* setDown(false);
          const proforma = yield* Effect.flatMap(Documents, (d) => d.get(id));
          const retried = yield* call(payProforma(id, key));
          return { keyless, keyed, afterFailure, payments, proforma, retried };
        }),
      ),
    );
    const control = ok(
      await run(
        Effect.gen(function* () {
          const pf = yield* issueProforma;
          return ok((yield* call(payProforma(pf.id as DocumentId))).exit).issued[0]?.number;
        }),
      ),
    );
    expect(r.keyless.exit).toEqual(database);
    expect(r.keyed.exit).toEqual(database);
    expect(r.afterFailure).toBeUndefined();
    expect(r.payments).toEqual([]);
    expect(r.proforma.settlement).toBe("unpaid");
    expect(r.retried.replayed).toBe(false);
    const issued = ok(r.retried.exit).issued;
    expect(issued).toHaveLength(1);
    // The failed attempts took no PTD number.
    expect(issued[0]?.number).toBe(control);
  });

  test("the returned PTD view is enriched; the stored result is clean", async () => {
    const key = "pay-share" as RequestKey;
    const r = ok(
      await run(
        Effect.gen(function* () {
          const pf = yield* issueProforma;
          const first = ok((yield* call(payProforma(pf.id as DocumentId, key))).exit);
          const ptd = first.issued[0] as DocumentView;
          const { url } = yield* Effect.flatMap(PublicShareLinks, (s) =>
            s.create(ptd.id as DocumentId),
          );
          const replay = yield* call(payProforma(pf.id as DocumentId, key));
          return { url, first, replay, stored: yield* storedResult(key) };
        }),
      ),
    );
    expect(r.replay.replayed).toBe(true);
    const ptd = ok(r.replay.exit).issued[0];
    expect(ptd?.share?.url).toBe(r.url);
    expect(JSON.stringify(r.stored).includes(r.url)).toBe(false);
    const stored = r.stored as { issued: ReadonlyArray<{ share: unknown; deliveries: unknown }> };
    expect(stored.issued).toHaveLength(1);
    expect(stored.issued[0]?.share).toBeNull();
    expect(stored.issued[0]?.deliveries).toEqual([]);
  });
});
