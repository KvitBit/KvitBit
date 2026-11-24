/**
 * Public Share Links (core-ports 4.6): Members create, revoke and read view events of a
 * document's link; the `ShareLinkVisitor` caller opens its own token's document, PDF and logo.
 *
 * Layout:
 * - record.ts   rows and collections (`share_links`, `share_view_events`), `ShareLinkId`
 * - repo.ts     `ShareLinksRepo` port + `ShareLinksRepoMemory` on MemoryTables
 * - ports.ts    narrow driven ports `ShareLinkKeys` (current HMAC key version, public URLs),
 *               `ShareWorkspaces` (membership, branding, logo), the `ShareVisitorDevice`
 *               reference (coarse device from the user agent, set by the share route), fakes
 * - token.ts    token derivation "v{n}." + base64url(HMAC-SHA256(key, linkId))
 * - members.ts  create / revoke / views; visitor.ts open / pdf / logo; service.ts the layer
 *
 * Seams used from documents (board #554/#571): `DocumentDeliveryReads.load/render`,
 * `DocumentsRepo.lock/get/getMany`, `outstandingOf`. Audit: `share.create` / `share.revoke` on the
 * Document subject (visible in `Documents.history`). Integration: fill `DocumentView.share` from
 * `ShareLinksRepo.activeFor` + view events (not wired by this module).
 */
import { Layer } from "effect";
import { ShareLinkKeysTest, ShareWorkspacesFake } from "./ports";
import { ShareLinksRepoMemory } from "./repo";
import { PublicShareLinksLive } from "./service";

export {
  DEFAULT_BRANDING,
  ShareFixtures,
  ShareLinkKeys,
  ShareLinkKeysTest,
  ShareVisitorDevice,
  ShareWorkspaces,
  ShareWorkspacesFake,
  shareLinkKeysTest,
} from "./ports";
export type { ShareDevice } from "./record";
export {
  ShareLink,
  ShareLinkId,
  ShareLinksTable,
  ShareViewEventRow,
  ShareViewsTable,
} from "./record";
export { ShareLinksRepo, ShareLinksRepoMemory } from "./repo";
export type { PublicShareLinksDeps } from "./service";
export { PublicShareLinksLive } from "./service";
export { deriveToken, tokenVersion } from "./token";
export { VIEW_DEDUP_MILLIS } from "./visitor";

/**
 * `PublicShareLinksLive` over the memory repo, test keys and the `ShareWorkspaces` fake (with
 * `ShareFixtures` exposed). Needs `DocumentsTestLayer` (DocumentsRepo, DocumentDeliveryReads)
 * and `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator).
 */
export const ShareLinksTestLayer = Layer.provideMerge(
  PublicShareLinksLive,
  Layer.mergeAll(ShareLinksRepoMemory, ShareLinkKeysTest, ShareWorkspacesFake),
);
