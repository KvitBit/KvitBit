import { TestCaller } from "../helpers/callerContext";
/** DocumentView.share and .deliveries through DocumentActivityLive, and empty without it. */

import { describe, expect, test } from "bun:test";
import {
  DeliveryId,
  DocumentId,
  Documents,
  PublicShareLinks,
  RequestKey,
  ShareToken,
  ShareViewId,
  VisitorHash,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as EffectString from "effect/String";
import { DocumentActivityLive } from "../../src/compose/documentActivity";
import {
  DeliveriesRepo,
  DeliveriesRepoMemory,
  DocumentFixtures,
  DocumentsDeliveryTestLayer,
  documentsDeliveryTestLayer,
} from "../../src/modules/documents";
import { NumberingSeries } from "../../src/modules/numbering";
import type { ShareLink, ShareViewEventRow } from "../../src/modules/sharelinks";
import {
  ShareLinkKeysTest,
  ShareLinksRepo,
  ShareLinksRepoMemory,
  ShareLinksTestLayer,
} from "../../src/modules/sharelinks";
import { ShareLinkId } from "../../src/modules/sharelinks/record";
import { CoreStore } from "../../src/store/CoreStore";
import type { InMemoryPortsLive } from "../../src/testing";
import { member, runTest, shareVisitor, TEST_NOW, WORKSPACE_A, WORKSPACE_B } from "../helpers";
import { as, invoiceInput, seed } from "../modules/documents/fixtures";

const activity = DocumentActivityLive.pipe(
  Layer.provide(Layer.mergeAll(ShareLinksRepoMemory, ShareLinkKeysTest, DeliveriesRepoMemory)),
);
const base = ShareLinksTestLayer.pipe(Layer.provideMerge(DocumentsDeliveryTestLayer));
const bound = ShareLinksTestLayer.pipe(Layer.provideMerge(documentsDeliveryTestLayer(activity)));

const series = Effect.flatMap(CoreStore, (store) =>
  store.transaction(
    Effect.flatMap(NumberingSeries, (n) =>
      n.ensureDefaults(WORKSPACE_A, ["invoice", "proforma", "credit_note"]),
    ),
  ),
);

/** Issues, sends and shares an invoice, visits the link once; returns the views read back. */
const flow = Effect.gen(function* () {
  const testCaller = yield* TestCaller;
  const docs = yield* Documents;
  const links = yield* PublicShareLinks;
  const draft = yield* docs.createDraft(testCaller, invoiceInput());
  const issued = yield* docs.issue(testCaller, { input: invoiceInput() });
  const id = DocumentId.make(issued.id);
  const sent = yield* docs.send(testCaller, id);
  const { url } = yield* links.create(testCaller, id);
  const token = ShareToken.make(EffectString.slice("https://share.test/s/".length)(url));
  yield* as(
    shareVisitor({ token }),
    Effect.flatMap(PublicShareLinks, (s) => s.open(shareVisitor({ token }))),
  );
  return {
    url,
    sent,
    draft: yield* docs.get(testCaller, draft.id),
    got: yield* docs.get(testCaller, id),
    // A write result is never enriched (rule C3): it is what a keyed replay returns.
    locked: yield* docs.lock(testCaller, id),
    revoked: yield* Effect.andThen(links.revoke(testCaller, id), docs.get(testCaller, id)),
  };
});

/** Runs `body` as the owner over `layer` after seeding both Workspaces and the series. */
type FlowServices =
  | Layer.Success<typeof base>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | TestCaller;

const runWith = <A, E>(layer: typeof base, body: Effect.Effect<A, E, FlowServices>) =>
  runTest(
    member("owner"),
    Effect.andThen(seed("vat_payer", { seriesByKind: {} }), Effect.andThen(series, body)).pipe(
      Effect.provide(layer),
    ),
  );

const run = (layer: typeof base) => runWith(layer, flow);

const ok = <A, Err>(exit: Exit.Exit<A, Err>): A => {
  if (Exit.isFailure(exit))
    throw new Error("Expected document activity to succeed", { cause: exit.cause });
  return exit.value;
};

describe("DocumentView.share and .deliveries", () => {
  test("filled from share links and deliveries when DocumentActivityLive is bound", async () => {
    const r = ok(await run(bound));
    const at = DateTime.makeUnsafe(TEST_NOW).pipe(DateTime.formatIso);
    expect(r.got.share).toEqual({ url: r.url, views: 1, lastViewedAt: at });
    expect(r.got.deliveries).toHaveLength(1);
    expect(r.got.deliveries[0]).toMatchObject({ purpose: "document", status: "queued", at });
    expect(r.got.deliveries[0]?.to.length).toBeGreaterThan(0);
    expect(r.locked.share).toBeNull();
    expect(r.locked.deliveries).toEqual([]);
    // Drafts are never shared or sent; a revoked link is no link.
    expect(r.draft.share).toBeNull();
    expect(r.draft.deliveries).toEqual([]);
    expect(r.revoked.share).toBeNull();
    expect(r.revoked.deliveries).toEqual(r.got.deliveries);
  });

  test("empty with DocumentActivityNone (DocumentsDeliveryTestLayer default)", async () => {
    const r = ok(await run(base));
    expect(r.got.share).toBeNull();
    expect(r.got.deliveries).toEqual([]);
    expect(r.locked.share).toBeNull();
  });
});

/**
 * Shares, sends twice and cancels (keyed) an invoice, opens and downloads it as a visitor; returns
 * what was stored (delivery rows, the request-log result), rendered, and returned to the owner.
 */
const storedFlow = Effect.gen(function* () {
  const testCaller = yield* TestCaller;
  const docs = yield* Documents;
  const links = yield* PublicShareLinks;
  const issued = yield* docs.issue(testCaller, { input: invoiceInput() });
  const id = DocumentId.make(issued.id);
  const { url } = yield* links.create(testCaller, id);
  const token = EffectString.slice("https://share.test/s/".length)(url);
  const first = yield* docs.send(testCaller, id);
  const second = yield* docs.send(testCaller, id);
  yield* as(
    shareVisitor({ token: ShareToken.make(token) }),
    Effect.flatMap(PublicShareLinks, (s) =>
      Effect.andThen(
        s.open(shareVisitor({ token: ShareToken.make(token) })),
        s.pdf(shareVisitor({ token: ShareToken.make(token) })),
      ),
    ),
  );
  yield* docs.pdf(testCaller, id);
  const requestKey = RequestKey.make("cancel-after-share");
  const cancelled = yield* docs.cancel(testCaller, id, { reason: "duplicate" }, { requestKey });
  const replayed = yield* docs.cancel(testCaller, id, { reason: "duplicate" }, { requestKey });
  const store = yield* CoreStore;
  const claim = yield* store.transaction(
    store.requestLog.claim(
      { _tag: "Workspace", workspaceId: WORKSPACE_A },
      requestKey,
      DateTime.makeUnsafe(TEST_NOW).pipe(DateTime.formatIso),
    ),
  );
  const deliveries = yield* DeliveriesRepo;
  const rows = yield* Effect.forEach(
    [first, second],
    (d) => deliveries.get(WORKSPACE_A, DeliveryId.make(d.deliveryId)),
    { concurrency: 1 },
  );
  const fixtures = yield* DocumentFixtures;
  return {
    url,
    token,
    rows,
    stored: claim._tag === "Existing" ? claim.entry.result : undefined,
    renders: yield* Ref.get(fixtures.renders),
    cancelled,
    replayed,
    got: yield* docs.get(testCaller, id),
  };
});

describe("stored, replayed and rendered views carry no share link or deliveries", () => {
  test("delivery snapshots, the keyed cancel result, its replay and renderer views are un-enriched; owner reads are not", async () => {
    const r = ok(await runWith(bound, storedFlow));
    const leaks = <A>(value: A) => {
      const json = Formatter.formatJson(value);
      return EffectString.includes(r.token)(json) || EffectString.includes(r.url)(json);
    };
    // Owner read: share and deliveries. The cancel result and its replay: neither (rule C3).
    expect(r.got.share?.url).toBe(r.url);
    expect(r.got.deliveries).toHaveLength(2);
    for (const result of [r.cancelled, r.replayed]) {
      expect(result.document.share).toBeNull();
      expect(result.document.deliveries).toEqual([]);
    }
    expect(leaks([r.cancelled, r.replayed])).toBe(false);
    // Stored: both delivery rows' snapshots (the second was taken after a share and a delivery).
    for (const row of r.rows) {
      expect(row.view.share).toBeNull();
      expect(row.view.deliveries).toEqual([]);
    }
    expect(leaks(r.rows)).toBe(false);
    // Stored: the request-log result of the keyed cancel.
    expect(r.stored).toBeDefined();
    expect(leaks(r.stored)).toBe(false);
    expect(r.stored).toMatchObject({ document: { deliveries: [] } });
    // Rendered: the owner PDF and the share-link visitor PDF.
    expect(r.renders.length).toBeGreaterThanOrEqual(2);
    for (const call of r.renders) {
      expect(call.view.share).toBeNull();
      expect(call.view.deliveries).toEqual([]);
    }
    expect(leaks(EffectArray.map(r.renders, (c) => c.view))).toBe(false);
  });
});

describe("ShareLinksRepo.viewStats", () => {
  test("counts the link's view events (not downloads, not other links) and the latest at", async () => {
    const link = (id: string): ShareLink => ({
      id: ShareLinkId.make(id),
      workspaceId: WORKSPACE_A,
      documentId: DocumentId.make("01900000-0000-7000-8000-0000d0c00001"),
      tokenHash: `hash-${id}`,
      keyVersion: 1,
      createdBy: null,
      viewedAt: null,
      revokedAt: id === "l1" ? "2026-11-01T00:00:00.000Z" : null,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const event = (
      id: string,
      shareLinkId: string,
      kind: "view" | "download",
      at: string,
    ): ShareViewEventRow => ({
      id: ShareViewId.make(`01900000-0000-7000-8000-0000000000${id}`),
      workspaceId: WORKSPACE_A,
      shareLinkId: ShareLinkId.make(shareLinkId),
      kind,
      device: "desktop",
      visitorHash: VisitorHash.make("v"),
      at,
    });
    const stats = ok(
      await runTest(
        member("owner"),
        Effect.gen(function* () {
          const repo = yield* ShareLinksRepo;
          const store = yield* CoreStore;
          yield* store.transaction(
            Effect.gen(function* () {
              yield* repo.insert(link("l1"));
              yield* repo.insert(link("l2"));
              yield* repo.recordEvent(event("e1", "l2", "view", "2026-11-02T00:00:00.000Z"));
              yield* repo.recordEvent(event("e2", "l2", "view", "2026-11-05T00:00:00.000Z"));
              yield* repo.recordEvent(event("e3", "l2", "download", "2026-11-06T00:00:00.000Z"));
              yield* repo.recordEvent(event("e4", "l1", "view", "2026-11-07T00:00:00.000Z"));
            }),
          );
          return {
            l2: yield* repo.viewStats(WORKSPACE_A, ShareLinkId.make("l2")),
            none: yield* repo.viewStats(WORKSPACE_A, ShareLinkId.make("l3")),
            otherWorkspace: yield* repo.viewStats(WORKSPACE_B, ShareLinkId.make("l2")),
          };
        }).pipe(Effect.provide(ShareLinksRepoMemory)),
      ),
    );
    expect(stats).toEqual({
      l2: { views: 2, lastViewedAt: "2026-11-05T00:00:00.000Z" },
      none: { views: 0, lastViewedAt: null },
      otherWorkspace: { views: 0, lastViewedAt: null },
    });
  });
});
