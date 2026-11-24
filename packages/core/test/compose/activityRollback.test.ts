/**
 * Write results are never enriched with `DocumentView.share` / `.deliveries` (rule C3: a keyed
 * replay returns exactly the stored result). A share link or delivery added after the write does
 * not change its replay, and a failing `DocumentActivity` read never affects a write or its
 * replay; owner reads (`Documents.get`) still carry both.
 */
import { describe, expect, test } from "bun:test";
import type { CurrentCaller, DocumentId, DocumentView, RequestKey } from "@kvitbit/domain/contract";
import { Documents, Payments, PublicShareLinks, Unavailable } from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Context, Effect, Exit, Layer, Ref, Schema } from "effect";
import { DocumentActivityLive } from "../../src/compose/documentActivity";
import {
  DeliveriesRepoMemory,
  DocumentActivity,
  documentsDeliveryTestLayer,
} from "../../src/modules/documents";
import { DocumentViewCodec } from "../../src/modules/documents/view";
import { NumberingSeries } from "../../src/modules/numbering";
import {
  PaymentDocumentsLive,
  PaymentFakesLive,
  PaymentsLive,
  PaymentsRepoMemory,
} from "../../src/modules/payments";
import { RecordResultCodec } from "../../src/modules/payments/record";
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
const getDocument = (id: DocumentId) => Effect.flatMap(Documents, (d) => d.get(id));

/** The result as the request log stores it (decoding normalizes decimals, so compare this). */
const asStored = <A>(codec: Schema.Codec<A, unknown>, value: A) =>
  Schema.encodeUnknownSync(Schema.toCodecJson(codec))(value);
const sameView = (a: DocumentView, b: DocumentView) =>
  expect(asStored(DocumentViewCodec, a)).toEqual(asStored(DocumentViewCodec, b));

/** A write result: never enriched (rule C3: a replay returns the stored result). */
const expectClean = (view: DocumentView | undefined) => {
  expect(view).toBeDefined();
  expect(view?.share).toBeNull();
  expect(view?.deliveries).toEqual([]);
};

describe("Documents.issue: write results are never enriched", () => {
  test("a failing activity read does not affect the write, keyless or keyed", async () => {
    const key = "issue-down" as RequestKey;
    const r = ok(
      await run(
        Effect.gen(function* () {
          yield* setDown(true);
          const keyless = yield* call(issueInvoice());
          const keyed = yield* call(issueInvoice(key));
          const replay = yield* call(issueInvoice(key));
          const id = ok(keyed.exit).id as DocumentId;
          // An owner read still enriches, so it reports the failing read.
          const read = yield* Effect.exit(getDocument(id));
          yield* setDown(false);
          const list = yield* Effect.flatMap(Documents, (d) => d.list({}));
          return { keyless, keyed, replay, read, list, stored: yield* storedResult(key) };
        }),
      ),
    );
    expectClean(ok(r.keyless.exit));
    expectClean(ok(r.keyed.exit));
    expect(r.keyed.replayed).toBe(false);
    expect(r.replay.replayed).toBe(true);
    sameView(ok(r.replay.exit), ok(r.keyed.exit));
    expect(asStored(DocumentViewCodec, ok(r.keyed.exit))).toEqual(r.stored as never);
    expect(r.read).toEqual(database as never);
    expect(r.list.items).toHaveLength(2);
  });

  test("a keyed replay returns exactly the stored result; Documents.get shows share and deliveries", async () => {
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
          const read = yield* getDocument(id);
          return { url, first, replay, downReplay, read, stored: yield* storedResult(key) };
        }),
      ),
    );
    expectClean(r.first);
    expect(r.replay.replayed).toBe(true);
    sameView(ok(r.replay.exit), r.first);
    expect(r.downReplay.replayed).toBe(true);
    sameView(ok(r.downReplay.exit), r.first);
    expect(asStored(DocumentViewCodec, r.first)).toEqual(r.stored as never);
    // The owner read carries the bearer URL and the delivery; the stored result never does.
    expect(r.read.share?.url).toBe(r.url);
    expect(r.read.deliveries).toHaveLength(1);
    const json = JSON.stringify(r.stored);
    expect(json.includes(r.url)).toBe(false);
    expect(json.includes(r.url.slice(r.url.lastIndexOf("/") + 1))).toBe(false);
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

describe("Payments.record: write results are never enriched", () => {
  test("a failing activity read does not affect the payment, keyless or keyed", async () => {
    const key = "pay-down" as RequestKey;
    const r = ok(
      await run(
        Effect.gen(function* () {
          const keylessPf = yield* issueProforma;
          const keyedPf = yield* issueProforma;
          yield* setDown(true);
          const keyless = yield* call(payProforma(keylessPf.id as DocumentId));
          const keyed = yield* call(payProforma(keyedPf.id as DocumentId, key));
          const replay = yield* call(payProforma(keyedPf.id as DocumentId, key));
          yield* setDown(false);
          return { keyless, keyed, replay };
        }),
      ),
    );
    expect(ok(r.keyless.exit).issued).toHaveLength(1);
    expectClean(ok(r.keyless.exit).issued[0]);
    expectClean(ok(r.keyed.exit).issued[0]);
    expect(r.replay.replayed).toBe(true);
    expect(asStored(RecordResultCodec, ok(r.replay.exit))).toEqual(
      asStored(RecordResultCodec, ok(r.keyed.exit)),
    );
  });

  test("a keyed replay returns the stored PTD view; Documents.get shows its share link", async () => {
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
          const read = yield* getDocument(ptd.id as DocumentId);
          return { url, first, replay, read, stored: yield* storedResult(key) };
        }),
      ),
    );
    expectClean(r.first.issued[0]);
    expect(r.replay.replayed).toBe(true);
    expect(asStored(RecordResultCodec, ok(r.replay.exit))).toEqual(
      asStored(RecordResultCodec, r.first),
    );
    expect(asStored(RecordResultCodec, r.first)).toEqual(r.stored as never);
    expect(r.read.share?.url).toBe(r.url);
    expect(JSON.stringify(r.stored).includes(r.url)).toBe(false);
  });
});
