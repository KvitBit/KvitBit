/**
 * Stored rows of Public Share Links (core-ports 4.6), mirroring `share_links` and
 * `share_view_events` in packages/db/src/schema/documents.ts. The token is never stored: it is
 * re-derived from the link id and `keyVersion` (token.ts) and found by its SHA-256 `tokenHash`.
 */
import {
  DocumentId,
  ShareViewId,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import { defineCollection } from "../../store/tables";

/** Share link ids are UUIDv7 like every entity id; the domain has no `ShareLinkId` brand. */
export const ShareLinkId = Schema.String.pipe(Schema.brand("ShareLinkId"));
export type ShareLinkId = typeof ShareLinkId.Type;

export const ShareLinkRecord = Schema.Struct({
  id: ShareLinkId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,
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
export type ShareLinkRecord = typeof ShareLinkRecord.Type;

export const ShareEventKind = Schema.Literals(["view", "download"]);
export const ShareDevice = Schema.Literals(["desktop", "mobile", "tablet", "unknown"]);
export type ShareDevice = typeof ShareDevice.Type;

/** A view or download. No IP or user agent: only the daily `VisitorHash`, time and device. */
export const ShareViewRecord = Schema.Struct({
  id: ShareViewId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,
  shareLinkId: ShareLinkId,
  /** Denormalized for `views(documentId)` across a document's links. */
  documentId: DocumentId,
  kind: ShareEventKind,
  device: ShareDevice,
  visitorHash: VisitorHash,
  at: Schema.String,
});
export type ShareViewRecord = typeof ShareViewRecord.Type;

export const SHARE_TOKEN_HASH_UNIQUE = "share_links_token_hash_unique";
export const SHARE_ONE_ACTIVE_PER_DOCUMENT = "share_links_one_active_per_document";

export const ShareLinksTable = defineCollection<ShareLinkRecord>({
  name: "share_links",
  entity: "ShareLink",
  schema: ShareLinkRecord as unknown as Schema.Codec<ShareLinkRecord, unknown>,
  unique: [
    { name: SHARE_TOKEN_HASH_UNIQUE, scope: "global", key: (r) => [r.tokenHash] },
    {
      name: SHARE_ONE_ACTIVE_PER_DOCUMENT,
      scope: "workspace",
      key: (r) => (r.revokedAt === null ? [r.documentId] : null),
    },
  ],
});

export const ShareViewsTable = defineCollection<ShareViewRecord>({
  name: "share_view_events",
  entity: "ShareLink",
  schema: ShareViewRecord as unknown as Schema.Codec<ShareViewRecord, unknown>,
});
