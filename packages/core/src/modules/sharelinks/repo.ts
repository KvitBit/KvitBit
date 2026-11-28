/**
 * `ShareLinksRepo`: persistence port of the share-links module, shaped on the real tables
 * (`share_links` has no revision column, so writes are state-conditional updates, not
 * compare-and-set). Workspace scoped except the token lookup; `StoreUnavailable` for database
 * failures. Write operations run inside the caller's transaction.
 */

import type { DocumentId, NotFound, VisitorHash, WorkspaceId } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { MemoryTables } from "../../store/tables";
import type { ShareLink, ShareLinkId, ShareViewEventRow } from "./record";
import {
  SHARE_ONE_ACTIVE_PER_DOCUMENT,
  SHARE_TOKEN_HASH_UNIQUE,
  ShareLinksTable,
  ShareViewsTable,
} from "./record";

export class ShareLinksRepo extends Context.Service<
  ShareLinksRepo,
  {
    /** The document's active (not revoked) link; at most one exists. */
    readonly activeFor: (
      workspaceId: WorkspaceId,
      documentId: DocumentId,
    ) => Effect.Effect<Option.Option<ShareLink>, StoreUnavailable>;
    /**
     * Token lookup across Workspaces (the visitor has none yet), revoked links included.
     * Row-locks the link (`FOR UPDATE`) for the rest of the transaction, so a visitor's
     * dedup check, event insert and first-view update are atomic against a concurrent revoke.
     */
    readonly lockByTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<ShareLink>, StoreUnavailable>;
    readonly insert: (link: ShareLink) => Effect.Effect<void, UniqueViolation | StoreUnavailable>;
    /** `revoked_at = at` where it is still null. */
    readonly revoke: (
      workspaceId: WorkspaceId,
      id: ShareLinkId,
      at: string,
    ) => Effect.Effect<void, NotFound | StoreUnavailable>;
    /** `viewed_at = at` where it is still null. */
    readonly markViewed: (
      workspaceId: WorkspaceId,
      id: ShareLinkId,
      at: string,
    ) => Effect.Effect<void, NotFound | StoreUnavailable>;
    readonly recordEvent: (event: ShareViewEventRow) => Effect.Effect<void, StoreUnavailable>;
    /** Whether the link has an event of `kind` by `visitor` strictly after `since` (dedup). */
    readonly hasEventSince: (
      workspaceId: WorkspaceId,
      link: ShareLinkId,
      visitor: VisitorHash,
      kind: ShareViewEventRow["kind"],
      since: string,
    ) => Effect.Effect<boolean, StoreUnavailable>;
    /**
     * Events of every link of the document (join through `share_links`), newest first
     * (`at` desc, `id` desc), keyset paged after `[at, id]`.
     */
    readonly events: (
      workspaceId: WorkspaceId,
      documentId: DocumentId,
      page: { readonly after?: readonly [string, string] | undefined; readonly limit: number },
    ) => Effect.Effect<
      { readonly rows: ReadonlyArray<ShareViewEventRow>; readonly more: boolean },
      StoreUnavailable
    >;

    // DocumentView.share (compose/documentActivity.ts) ---------------------------------------
    /** The link's `view` events (downloads excluded): their count and the latest `at`. */
    readonly viewStats: (
      workspaceId: WorkspaceId,
      link: ShareLinkId,
    ) => Effect.Effect<
      { readonly views: number; readonly lastViewedAt: string | null },
      StoreUnavailable
    >;
  }
>()("@kvitbit/core/modules/sharelinks/repo/ShareLinksRepo") {}

const withoutRevision = <A extends { readonly revision: number }>({
  revision: _revision,
  ...rest
}: A): Omit<A, "revision"> => rest;

/** In-memory `ShareLinksRepo` on `MemoryTables` (tests). */
export const ShareLinksRepoMemory: Layer.Layer<ShareLinksRepo, never, MemoryTables> = Layer.effect(
  ShareLinksRepo,
  Effect.map(MemoryTables, (tables) => {
    const links = tables.collection(ShareLinksTable);
    const views = tables.collection(ShareViewsTable);
    /** Locks the row and applies `change` unless `skip` holds (a state-conditional UPDATE). */
    const conditional = (
      workspaceId: WorkspaceId,
      id: ShareLinkId,
      skip: (row: ShareLink) => boolean,
      change: (row: ShareLink) => ShareLink,
    ) =>
      Effect.flatMap(links.lock(workspaceId, id), (row) =>
        skip(row)
          ? Effect.void
          : links.update({ ...change(row), revision: row.revision }, row.revision).pipe(
              // Locked row, no unique key touched: neither can happen.
              Effect.catchTags({ Conflict: Effect.die, UniqueViolation: Effect.die }),
              Effect.asVoid,
            ),
      );
    return ShareLinksRepo.of({
      activeFor: Effect.fn("ShareLinksRepo.activeFor")((workspaceId, documentId) =>
        Effect.map(
          links.findUnique(SHARE_ONE_ACTIVE_PER_DOCUMENT, [documentId], workspaceId),
          Option.map(withoutRevision),
        ),
      ),
      lockByTokenHash: Effect.fn("shareLinks.lockHash")((tokenHash) =>
        Effect.flatMap(links.findUnique(SHARE_TOKEN_HASH_UNIQUE, [tokenHash]), (found) =>
          Option.isNone(found)
            ? Effect.succeedNone
            : links.lock(found.value.workspaceId, found.value.id).pipe(
                Effect.map((row) => Option.some(withoutRevision(row))),
                Effect.catchTag("NotFound", () => Effect.succeed(Option.none<ShareLink>())),
              ),
        ),
      ),
      insert: Effect.fn("ShareLinksRepo.insert")((link) =>
        Effect.asVoid(links.insert({ ...link, revision: 1 })),
      ),
      revoke: Effect.fn("ShareLinksRepo.revoke")((workspaceId, id, at) =>
        conditional(
          workspaceId,
          id,
          (row) => row.revokedAt !== null,
          (row) => ({ ...row, revokedAt: at }),
        ),
      ),
      markViewed: Effect.fn("ShareLinksRepo.markViewed")((workspaceId, id, at) =>
        conditional(
          workspaceId,
          id,
          (row) => row.viewedAt !== null,
          (row) => ({ ...row, viewedAt: at }),
        ),
      ),
      recordEvent: Effect.fn("ShareLinksRepo.recordEvent")((event) =>
        views.insert({ ...event, revision: 1 }).pipe(
          // No unique index on events.
          Effect.catchTag("UniqueViolation", Effect.die),
          Effect.asVoid,
        ),
      ),
      hasEventSince: Effect.fn("ShareLinksRepo.hasEventSince")(
        (workspaceId, link, visitor, kind, since) =>
          Effect.map(
            views.list(workspaceId, {
              where: { shareLinkId: link, visitorHash: visitor, kind },
              range: { at: { gt: since } },
              limit: 1,
            }),
            (rows) => rows.length > 0,
          ),
      ),
      events: Effect.fn("ShareLinksRepo.events")(function* (workspaceId, documentId, page) {
        const ofDocument = yield* links.list(workspaceId, { where: { documentId } });
        if (ofDocument.length === 0) return { rows: [], more: false };
        const query = {
          whereIn: { shareLinkId: EffectArray.map(ofDocument, (link) => link.id) },
          orderBy: ["at"],
          direction: "desc",
          limit: page.limit + 1,
        } as const;
        const rows = yield* views.list(
          workspaceId,
          page.after === undefined ? query : { ...query, after: page.after },
        );

        return {
          rows: EffectArray.map(rows.slice(0, page.limit), withoutRevision),
          more: rows.length > page.limit,
        };
      }),

      // DocumentView.share ---------------------------------------------------------------------
      viewStats: Effect.fn("ShareLinksRepo.viewStats")((workspaceId, link) =>
        Effect.map(
          views.list(workspaceId, {
            where: { shareLinkId: link, kind: "view" },
            orderBy: ["at"],
            direction: "desc",
          }),
          (rows) => ({ views: rows.length, lastViewedAt: rows[0]?.at ?? null }),
        ),
      ),
    });
  }),
);
