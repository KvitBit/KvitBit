/** DocumentView.share and .deliveries through DocumentActivityLive, and empty without it. */
import { describe, expect, test } from "bun:test";
import type { DocumentId, ShareToken } from "@kvitbit/domain/contract";
import { Documents, PublicShareLinks } from "@kvitbit/domain/contract";
import { Effect, Exit, Layer } from "effect";
import { DocumentActivityLive } from "../../src/compose/documentActivity";
import { DeliveriesRepoMemory, DocumentsDeliveryTestLayer } from "../../src/modules/documents";
import { NumberingSeries } from "../../src/modules/numbering";
import type { ShareLink, ShareLinkId, ShareViewEventRow } from "../../src/modules/sharelinks";
import {
  ShareLinkKeysTest,
  ShareLinksRepo,
  ShareLinksRepoMemory,
  ShareLinksTestLayer,
} from "../../src/modules/sharelinks";
import { CoreStore } from "../../src/store/CoreStore";
import { member, runTest, shareVisitor, TEST_NOW, WORKSPACE_A, WORKSPACE_B } from "../helpers";
import { as, invoiceInput, seed } from "../modules/documents/fixtures";

const activity = DocumentActivityLive.pipe(
  Layer.provide(Layer.mergeAll(ShareLinksRepoMemory, ShareLinkKeysTest, DeliveriesRepoMemory)),
);
const base = ShareLinksTestLayer.pipe(Layer.provideMerge(DocumentsDeliveryTestLayer));
const bound = base.pipe(Layer.provide(activity));

const series = Effect.flatMap(CoreStore, (store) =>
  store.transaction(
    Effect.flatMap(NumberingSeries, (n) =>
      n.ensureDefaults(WORKSPACE_A, ["invoice", "proforma", "credit_note"]),
    ),
  ),
);

/** Issues, sends and shares an invoice, visits the link once; returns the views read back. */
const flow = Effect.gen(function* () {
  const docs = yield* Documents;
  const links = yield* PublicShareLinks;
  const draft = yield* docs.createDraft(invoiceInput());
  const issued = yield* docs.issue({ input: invoiceInput() });
  const id = issued.id as DocumentId;
  const sent = yield* docs.send(id);
  const { url } = yield* links.create(id);
  const token = url.slice("https://share.test/s/".length) as ShareToken;
  yield* as(
    shareVisitor({ token }),
    Effect.flatMap(PublicShareLinks, (s) => s.open),
  );
  return {
    url,
    sent,
    draft: yield* docs.get(draft.id),
    got: yield* docs.get(id),
    // A mutation's returned view goes through the same `viewOf`.
    locked: yield* docs.lock(id),
    revoked: yield* Effect.andThen(links.revoke(id), docs.get(id)),
  };
});

/** Runs `flow` as the owner over `layer` after seeding both Workspaces and the series. */
const run = (layer: typeof base) =>
  runTest(
    member("owner"),
    Effect.andThen(seed("vat_payer", { seriesByKind: {} }), Effect.andThen(series, flow)).pipe(
      Effect.provide(layer),
    ),
  );

const ok = <A, Err>(exit: Exit.Exit<A, Err>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

describe("DocumentView.share and .deliveries", () => {
  test("filled from share links and deliveries when DocumentActivityLive is bound", async () => {
    const r = ok(await run(bound));
    const at = new Date(TEST_NOW).toISOString();
    expect(r.got.share).toEqual({ url: r.url, views: 1, lastViewedAt: at });
    expect(r.got.deliveries).toHaveLength(1);
    expect(r.got.deliveries[0]).toMatchObject({ purpose: "document", status: "queued", at });
    expect(r.got.deliveries[0]?.to.length).toBeGreaterThan(0);
    expect(r.locked.share).toEqual(r.got.share);
    expect(r.locked.deliveries).toEqual(r.got.deliveries);
    // Drafts are never shared or sent; a revoked link is no link.
    expect(r.draft.share).toBeNull();
    expect(r.draft.deliveries).toEqual([]);
    expect(r.revoked.share).toBeNull();
    expect(r.revoked.deliveries).toEqual(r.got.deliveries);
  });

  test("empty without the port (DocumentsTestLayer default)", async () => {
    const r = ok(await run(base));
    expect(r.got.share).toBeNull();
    expect(r.got.deliveries).toEqual([]);
    expect(r.locked.share).toBeNull();
  });
});

describe("ShareLinksRepo.viewStats", () => {
  test("counts the link's view events (not downloads, not other links) and the latest at", async () => {
    const link = (id: string): ShareLink => ({
      id: id as ShareLinkId,
      workspaceId: WORKSPACE_A,
      documentId: "01900000-0000-7000-8000-0000d0c00001" as DocumentId,
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
      id: id as ShareViewEventRow["id"],
      workspaceId: WORKSPACE_A,
      shareLinkId: shareLinkId as ShareLinkId,
      kind,
      device: "desktop",
      visitorHash: "v" as ShareViewEventRow["visitorHash"],
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
            l2: yield* repo.viewStats(WORKSPACE_A, "l2" as ShareLinkId),
            none: yield* repo.viewStats(WORKSPACE_A, "l3" as ShareLinkId),
            otherWorkspace: yield* repo.viewStats(WORKSPACE_B, "l2" as ShareLinkId),
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
