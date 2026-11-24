/**
 * `ShareLinksRepo`: persistence port of the share-links module (src/store/tables.ts
 * conventions: Workspace scoped, revisioned links, `StoreUnavailable` for database failures).
 * The SQL implementation maps it onto `share_links` and `share_view_events`.
 */
import type {
  Conflict,
  DocumentId,
  NotFound,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { Option } from "effect";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { MemoryTables } from "../../store/tables";
import type { ShareLinkId, ShareLinkRecord, ShareViewRecord } from "./record";
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
    ) => Effect.Effect<Option.Option<ShareLinkRecord>, StoreUnavailable>;
    /** Token lookup across Workspaces (the visitor has none yet), revoked links included. */
    readonly byTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<ShareLinkRecord>, StoreUnavailable>;
    /** Row-lock without a revision check (create/revoke are idempotent by state, C6). */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: ShareLinkId,
    ) => Effect.Effect<ShareLinkRecord, NotFound | StoreUnavailable>;
    readonly insert: (
      row: ShareLinkRecord,
    ) => Effect.Effect<ShareLinkRecord, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: ShareLinkRecord,
      expectedRevision: number,
    ) => Effect.Effect<ShareLinkRecord, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    readonly recordEvent: (event: ShareViewRecord) => Effect.Effect<void, StoreUnavailable>;
    /** Whether the link has an event of `kind` by `visitor` at or after `since` (dedup). */
    readonly hasEventSince: (
      workspaceId: WorkspaceId,
      link: ShareLinkId,
      visitor: VisitorHash,
      kind: ShareViewRecord["kind"],
      since: string,
    ) => Effect.Effect<boolean, StoreUnavailable>;
    /** Events of every link of the document, newest first (`at` desc, `id` desc), keyset paged. */
    readonly events: (
      workspaceId: WorkspaceId,
      documentId: DocumentId,
      page: { readonly after?: readonly [string, string] | undefined; readonly limit: number },
    ) => Effect.Effect<
      { readonly rows: ReadonlyArray<ShareViewRecord>; readonly more: boolean },
      StoreUnavailable
    >;
  }
>()("kvitbit/core/sharelinks/ShareLinksRepo") {}

/** In-memory `ShareLinksRepo` on `MemoryTables` (tests). */
export const ShareLinksRepoMemory: Layer.Layer<ShareLinksRepo, never, MemoryTables> = Layer.effect(
  ShareLinksRepo,
  Effect.map(MemoryTables, (tables) => {
    const links = tables.collection(ShareLinksTable);
    const views = tables.collection(ShareViewsTable);
    return ShareLinksRepo.of({
      activeFor: (workspaceId, documentId) =>
        links.findUnique(SHARE_ONE_ACTIVE_PER_DOCUMENT, [documentId], workspaceId),
      byTokenHash: (tokenHash) => links.findUnique(SHARE_TOKEN_HASH_UNIQUE, [tokenHash]),
      lock: (workspaceId, id) => links.lock(workspaceId, id),
      insert: links.insert,
      update: links.update,
      recordEvent: (event) =>
        views.insert(event).pipe(
          // No unique index on events: a violation cannot happen.
          Effect.catchTag("UniqueViolation", (e) => Effect.die(e)),
          Effect.asVoid,
        ),
      hasEventSince: (workspaceId, link, visitor, kind, since) =>
        Effect.map(
          views.list(workspaceId, {
            where: { shareLinkId: link, visitorHash: visitor, kind },
            range: { at: { gte: since } },
            limit: 1,
          }),
          (rows) => rows.length > 0,
        ),
      events: (workspaceId, documentId, page) =>
        Effect.map(
          views.list(workspaceId, {
            where: { documentId },
            orderBy: ["at"],
            direction: "desc",
            ...(page.after === undefined ? {} : { after: page.after }),
            limit: page.limit + 1,
          }),
          (rows) => ({ rows: rows.slice(0, page.limit), more: rows.length > page.limit }),
        ),
    });
  }),
);
