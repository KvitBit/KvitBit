/**
 * Public Share Link rows (core-ports 4.6), exactly the columns of `share_links` and
 * `share_view_events` in packages/db/src/schema/documents.ts: no revision column, and events
 * reach their document through their link. The token is never stored: it is re-derived from
 * the link id and `keyVersion` (token.ts) and found by its SHA-256 `tokenHash`.
 */
import {
  DocumentId,
  ShareViewId,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { defineCollection } from "../../store/tables";

/** Share link ids are UUIDv7 like every entity id; the domain has no `ShareLinkId` brand. */
export const ShareLinkId = Schema.String.pipe(Schema.brand("ShareLinkId"));
export type ShareLinkId = typeof ShareLinkId.Type;

export const ShareLink = Schema.Struct({
  id: ShareLinkId,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  /** Hex SHA-256 of the token. */
  tokenHash: Schema.String,
  keyVersion: Schema.Int,
  createdBy: Schema.NullOr(UserId),
  /** ISO instant of the first recorded view. */
  viewedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ShareLink = typeof ShareLink.Type;

const ShareEventKind = Schema.Literals(["view", "download"]);
export const ShareDevice = Schema.Literals(["desktop", "mobile", "tablet", "unknown"]);
export type ShareDevice = typeof ShareDevice.Type;

/** A view or download. No IP or user agent: only the daily `VisitorHash`, time and device. */
export const ShareViewEventRow = Schema.Struct({
  id: ShareViewId,
  workspaceId: WorkspaceId,
  shareLinkId: ShareLinkId,
  kind: ShareEventKind,
  device: ShareDevice,
  visitorHash: VisitorHash,
  at: Schema.String,
});
export type ShareViewEventRow = typeof ShareViewEventRow.Type;

// In-memory table rows: MemoryTables needs a revision; it never leaves repo.ts.
type Revisioned<A> = A & { readonly revision: number };

export const SHARE_TOKEN_HASH_UNIQUE = "share_links_token_hash_unique";
export const SHARE_ONE_ACTIVE_PER_DOCUMENT = "share_links_one_active_per_document";

export const ShareLinksTable = defineCollection<Revisioned<ShareLink>>({
  name: "share_links",
  entity: "ShareLink",
  schema: Schema.Struct({ ...ShareLink.fields, revision: Schema.Finite }),
  unique: [
    { name: SHARE_TOKEN_HASH_UNIQUE, scope: "global", key: (r) => [r.tokenHash] },
    {
      name: SHARE_ONE_ACTIVE_PER_DOCUMENT,
      scope: "workspace",
      key: (r) => (r.revokedAt === null ? [r.documentId] : null),
    },
  ],
});

export const ShareViewsTable = defineCollection<Revisioned<ShareViewEventRow>>({
  name: "share_view_events",
  entity: "ShareLink",
  schema: Schema.Struct({ ...ShareViewEventRow.fields, revision: Schema.Finite }),
});
