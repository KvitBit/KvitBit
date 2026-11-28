import { TestCaller } from "../helpers/callerContext";
import { withoutStackTrace } from "../helpers/run";
/**
 * Write results are never enriched with `DocumentView.share` / `.deliveries` (rule C3: a keyed
 * replay returns exactly the stored result). A share link or delivery added after the write does
 * not change its replay, and a failing `DocumentActivity` read never affects a write or its
 * replay; owner reads (`Documents.get`) still carry both.
 */

import { describe, expect, test } from "bun:test";
import type { DocumentView } from "@kvitbit/domain/contract";
import {
  DocumentId,
  Documents,
  Payments,
  PublicShareLinks,
  RequestKey,
  Unavailable,
} from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
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
class ActivityDown extends Context.Service<ActivityDown, Ref.Ref<boolean>>()(
  "@kvitbit/core/test/compose/activityRollback.test/ActivityDown",
) {}

const switchable = Layer.effect(
  DocumentActivity,
  Effect.gen(function* () {
    const inner = yield* DocumentActivity;
    const down = yield* ActivityDown;
    const gate = <A>(read: Effect.Effect<A, StoreUnavailable>) =>
      Effect.flatMap(Ref.get(down), (d) => (d ? Effect.fail(StoreUnavailable.make({})) : read));
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
  | TestCaller;

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
  if (Exit.isFailure(exit))
    throw new Error("Expected document activity flow to succeed", { cause: exit.cause });
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
          DateTime.makeUnsafe(TEST_NOW).pipe(DateTime.formatIso),
        ),
        (claim) => (claim._tag === "Existing" ? claim.entry.result : undefined),
      ),
    ),
  );

const database = Exit.fail(Unavailable.make({ dependency: "database" }));
const issueInvoice = (key?: RequestKey) =>
  Effect.flatMap(Documents, (d) =>
    Effect.flatMap(TestCaller, (caller) =>
      d.issue(
        caller,
        { input: invoiceInput() },
        key === undefined ? undefined : { requestKey: key },
      ),
    ),
  );
const getDocument = (id: DocumentId) =>
  Effect.flatMap(Documents, (d) => Effect.flatMap(TestCaller, (caller) => d.get(caller, id)));

/** The result as the request log stores it (decoding normalizes decimals, so compare this). */
const asStored = <A>(codec: Schema.Codec<A, unknown>, value: A) =>
  Result.getOrThrow(Schema.encodeResult(Schema.toCodecJson(codec))(value));

/** A write result: never enriched (rule C3: a replay returns the stored result). */
const activityFields = (view: DocumentView | undefined) => ({
  share: view?.share,
  deliveries: view?.deliveries,
});
const noActivity = { share: null, deliveries: [] };

describe("Documents.issue: write results are never enriched", () => {
  test("a failing activity read does not affect the write, keyless or keyed", async () => {
    const key = RequestKey.make("issue-down");
    const r = ok(
      await run(
        Effect.gen(function* () {
          yield* setDown(true);
          const keyless = yield* call(issueInvoice());
          const keyed = yield* call(issueInvoice(key));
          const replay = yield* call(issueInvoice(key));
          const id = DocumentId.make(ok(keyed.exit).id);
          // An owner read still enriches, so it reports the failing read.
          const read = yield* Effect.exit(getDocument(id));
          yield* setDown(false);
          const list = yield* Effect.flatMap(Documents, (d) =>
            Effect.flatMap(TestCaller, (caller) => d.list(caller, {})),
          );
          return { keyless, keyed, replay, read, list, stored: yield* storedResult(key) };
        }),
      ),
    );
    const keylessView = r.keyless.exit.pipe(ok, activityFields);
    const keyedView = r.keyed.exit.pipe(ok, activityFields);
    expect(keylessView).toEqual(noActivity);
    expect(keyedView).toEqual(noActivity);
    expect(r.keyed.replayed).toBe(false);
    expect(r.replay.replayed).toBe(true);
    const keyed = asStored(DocumentViewCodec, ok(r.keyed.exit));
    expect(asStored(DocumentViewCodec, ok(r.replay.exit))).toEqual(keyed);
    expect(r.stored).toEqual(keyed);
    expect(r.read.pipe(withoutStackTrace)).toEqual(database);
    expect(r.list.items).toHaveLength(2);
  });

  test("a keyed replay returns exactly the stored result; Documents.get shows share and deliveries", async () => {
    const key = RequestKey.make("issue-share");
    const r = ok(
      await run(
        Effect.gen(function* () {
          const first = ok((yield* call(issueInvoice(key))).exit);
          const id = DocumentId.make(first.id);
          const { url } = yield* Effect.flatMap(PublicShareLinks, (s) =>
            Effect.flatMap(TestCaller, (caller) => s.create(caller, id)),
          );
          yield* Effect.flatMap(Documents, (d) =>
            Effect.flatMap(TestCaller, (caller) => d.send(caller, id)),
          );
          const replay = yield* call(issueInvoice(key));
          yield* setDown(true);
          const downReplay = yield* call(issueInvoice(key));
          yield* setDown(false);
          const read = yield* getDocument(id);
          return { url, first, replay, downReplay, read, stored: yield* storedResult(key) };
        }),
      ),
    );
    expect(activityFields(r.first)).toEqual(noActivity);
    expect(r.replay.replayed).toBe(true);
    const first = asStored(DocumentViewCodec, r.first);
    expect(asStored(DocumentViewCodec, ok(r.replay.exit))).toEqual(first);
    expect(r.downReplay.replayed).toBe(true);
    expect(asStored(DocumentViewCodec, ok(r.downReplay.exit))).toEqual(first);
    expect(r.stored).toEqual(first);
    // The owner read carries the bearer URL and the delivery; the stored result never does.
    expect(r.read.share?.url).toBe(r.url);
    expect(r.read.deliveries).toHaveLength(1);
    const json = Formatter.formatJson(r.stored);
    expect(EffectString.includes(r.url)(json)).toBe(false);
    expect(
      EffectString.includes(
        EffectString.slice(Option.getOrElse(EffectString.lastIndexOf("/")(r.url), () => -1) + 1)(
          r.url,
        ),
      )(json),
    ).toBe(false);
  });
});

/** Pays the whole Proforma: a vat_payer Proforma payment issues a PTD (P2). */
const payProforma = (proforma: DocumentId, key?: RequestKey) =>
  Effect.flatMap(Payments, (p) =>
    Effect.flatMap(TestCaller, (caller) =>
      p.record(
        caller,
        { target: { document: proforma } },
        key === undefined ? undefined : { requestKey: key },
      ),
    ),
  );
const issueProforma = Effect.flatMap(Documents, (d) =>
  Effect.flatMap(TestCaller, (caller) =>
    d.issue(caller, { input: invoiceInput({ kind: "proforma" }) }),
  ),
);

describe("Payments.record: write results are never enriched", () => {
  test("a failing activity read does not affect the payment, keyless or keyed", async () => {
    const key = RequestKey.make("pay-down");
    const r = ok(
      await run(
        Effect.gen(function* () {
          const keylessPf = yield* issueProforma;
          const keyedPf = yield* issueProforma;
          yield* setDown(true);
          const keyless = yield* call(payProforma(DocumentId.make(keylessPf.id)));
          const keyed = yield* call(payProforma(DocumentId.make(keyedPf.id), key));
          const replay = yield* call(payProforma(DocumentId.make(keyedPf.id), key));
          yield* setDown(false);
          return { keyless, keyed, replay };
        }),
      ),
    );
    expect(ok(r.keyless.exit).issued).toHaveLength(1);
    expect(activityFields(ok(r.keyless.exit).issued[0])).toEqual(noActivity);
    expect(activityFields(ok(r.keyed.exit).issued[0])).toEqual(noActivity);
    expect(r.replay.replayed).toBe(true);
    expect(asStored(RecordResultCodec, ok(r.replay.exit))).toEqual(
      asStored(RecordResultCodec, ok(r.keyed.exit)),
    );
  });

  test("a keyed replay returns the stored PTD view; Documents.get shows its share link", async () => {
    const key = RequestKey.make("pay-share");
    const r = ok(
      await run(
        Effect.gen(function* () {
          const pf = yield* issueProforma;
          const first = ok((yield* call(payProforma(DocumentId.make(pf.id), key))).exit);
          const ptd = EffectArray.getUnsafe(first.issued, 0);
          const { url } = yield* Effect.flatMap(PublicShareLinks, (s) =>
            Effect.flatMap(TestCaller, (caller) => s.create(caller, DocumentId.make(ptd.id))),
          );
          const replay = yield* call(payProforma(DocumentId.make(pf.id), key));
          const read = yield* getDocument(DocumentId.make(ptd.id));
          return { url, first, replay, read, stored: yield* storedResult(key) };
        }),
      ),
    );
    expect(activityFields(r.first.issued[0])).toEqual(noActivity);
    expect(r.replay.replayed).toBe(true);
    expect(asStored(RecordResultCodec, ok(r.replay.exit))).toEqual(
      asStored(RecordResultCodec, r.first),
    );
    expect(r.stored).toEqual(asStored(RecordResultCodec, r.first));
    expect(r.read.share?.url).toBe(r.url);
    expect(EffectString.includes(r.url)(Formatter.formatJson(r.stored))).toBe(false);
  });
});
