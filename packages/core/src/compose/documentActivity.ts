/**
 * `DocumentActivityLive`: documents' `DocumentActivity` port (`DocumentView.share` and
 * `deliveries`, core-ports 4.4 and 4.6) over the share-links and deliveries repos. Lives here,
 * not in documents, because share links import documents.
 *
 * - `share`: the active link, its URL re-derived from the link id under the current key (the
 *   token is never stored), `views` = its view events, `lastViewedAt` = the latest one. A link
 *   minted under a rotated-out key version is expired (its token returns NotFound) until
 *   `PublicShareLinks.create` replaces it, so it reads as no link.
 * - `deliveries`: queueing order; `at` is the delivery's last status change (`updatedAt`).
 *
 * Read-only, Workspace scoped, inside the caller's transaction.
 *
 * Provide it to the documents layers that build views (DocumentsLive, DocumentPaymentsLive,
 * DocumentDeliveryReadsLive, PaymentDocumentsLive): `viewOf` reads it optionally.
 *
 * Requires ShareLinksRepo | ShareLinkKeys | DeliveriesRepo.
 */
import { Effect, Layer, Option } from "effect";
import { DeliveriesRepo, DocumentActivity } from "../modules/documents";
import { deriveToken, ShareLinkKeys, ShareLinksRepo } from "../modules/sharelinks";

export const DocumentActivityLive: Layer.Layer<
  DocumentActivity,
  never,
  ShareLinksRepo | ShareLinkKeys | DeliveriesRepo
> = Layer.effect(
  DocumentActivity,
  Effect.gen(function* () {
    const links = yield* ShareLinksRepo;
    const keys = yield* ShareLinkKeys;
    const deliveries = yield* DeliveriesRepo;
    return DocumentActivity.of({
      share: (workspaceId, id) =>
        Effect.gen(function* () {
          const active = yield* links.activeFor(workspaceId, id);
          if (Option.isNone(active) || active.value.keyVersion !== keys.version) return null;
          const token = yield* deriveToken(active.value.id, keys.version, keys.secret);
          const stats = yield* links.viewStats(workspaceId, active.value.id);
          return { url: keys.pageUrl(token), ...stats };
        }),
      deliveries: (workspaceId, id) =>
        Effect.map(deliveries.byDocument(workspaceId, id), (rows) =>
          rows.map((row) => ({
            id: row.id,
            to: row.to,
            purpose: row.purpose,
            status: row.status,
            at: row.updatedAt,
          })),
        ),
    });
  }),
);
