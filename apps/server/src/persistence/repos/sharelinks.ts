/**
 * `ShareLinksRepo` over `share_links` and `share_view_events`.
 * `share_links` has no revision column: `revoke` and `markViewed` are state-conditional updates.
 */
import { ShareLinksModule, ShareLinksRepo } from "@kvitbit/core";
import {
  DocumentId,
  NotFound,
  ShareViewId,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { unavailable, writeErrors } from "../errors";
import { col } from "../table";

interface ShareLinkSqlRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly document_id: string;
  readonly token_hash: string;
  readonly key_version: number;
  readonly created_by: string | null;
  readonly viewed_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

interface ShareViewEventSqlRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly share_link_id: string;
  readonly kind: ShareLinksModule.ShareViewEventRow["kind"];
  readonly device: ShareLinksModule.ShareViewEventRow["device"];
  readonly visitor_hash: string;
  readonly at: string;
}

const LINK_SELECT = Arr.join(
  [
    "id",
    "workspace_id",
    "document_id",
    "token_hash",
    "key_version",
    "created_by",
    col.instant("viewed_at"),
    col.instant("revoked_at"),
    col.instant("created_at"),
  ],
  ", ",
);

const EVENT_SELECT = Arr.join(
  [
    "e.id",
    "e.workspace_id",
    "e.share_link_id",
    "e.kind",
    "e.device",
    "e.visitor_hash",
    col.instant("e.at", "at"),
  ],
  ", ",
);

const decodeLink = (row: ShareLinkSqlRow): ShareLinksModule.ShareLink => ({
  id: ShareLinksModule.ShareLinkId.make(row.id),
  workspaceId: WorkspaceId.make(row.workspace_id),
  documentId: DocumentId.make(row.document_id),
  tokenHash: row.token_hash,
  keyVersion: Number(row.key_version),
  createdBy: row.created_by === null ? null : UserId.make(row.created_by),
  viewedAt: row.viewed_at,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
});

const decodeEvent = (row: ShareViewEventSqlRow): ShareLinksModule.ShareViewEventRow => ({
  id: ShareViewId.make(row.id),
  workspaceId: WorkspaceId.make(row.workspace_id),
  shareLinkId: ShareLinksModule.ShareLinkId.make(row.share_link_id),
  kind: row.kind,
  device: row.device,
  visitorHash: VisitorHash.make(row.visitor_hash),
  at: row.at,
});

export const ShareLinksRepoSql: Layer.Layer<ShareLinksRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    ShareLinksRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const linkWriteFailure = writeErrors("share_links");
      return ShareLinksRepo.of({
        activeFor: Effect.fn("ShareLinksRepo.activeFor")((workspaceId, documentId) =>
          Effect.map(
            unavailable(
              sql<ShareLinkSqlRow>`
                select ${sql.unsafe(LINK_SELECT)} from share_links
                where workspace_id = ${workspaceId} and document_id = ${documentId}
                  and revoked_at is null
                limit 1
              `,
            ),
            (rows) => (rows[0] === undefined ? Option.none() : Option.some(decodeLink(rows[0]))),
          ),
        ),
        lockByTokenHash: Effect.fn("ShareLinksRepo.lockByHash")((tokenHash) =>
          Effect.map(
            unavailable(
              sql<ShareLinkSqlRow>`
                select ${sql.unsafe(LINK_SELECT)} from share_links
                where token_hash = ${tokenHash}
                for update
              `,
            ),
            (rows) => (rows[0] === undefined ? Option.none() : Option.some(decodeLink(rows[0]))),
          ),
        ),
        insert: Effect.fn("ShareLinksRepo.insert")((link) =>
          sql
            .withTransaction(
              sql`insert into share_links ${sql.insert({
                id: link.id,
                workspace_id: link.workspaceId,
                document_id: link.documentId,
                token_hash: link.tokenHash,
                key_version: link.keyVersion,
                created_by: link.createdBy,
                viewed_at: link.viewedAt,
                revoked_at: link.revokedAt,
                created_at: link.createdAt,
              })}`,
            )
            .pipe(linkWriteFailure, Effect.asVoid),
        ),
        revoke: Effect.fn("ShareLinksRepo.revoke")(function* (workspaceId, id, at) {
          const locked = yield* unavailable(
            sql<{ id: string; revoked_at: string | null }>`
                select id, revoked_at from share_links
                where workspace_id = ${workspaceId} and id = ${id}
                for update
              `,
          );
          const row = locked[0];
          if (row === undefined) {
            return yield* NotFound.make({ entity: "ShareLink", id });
          }
          if (row.revoked_at === null) {
            yield* unavailable(
              sql`update share_links set revoked_at = ${at}
                  where workspace_id = ${workspaceId} and id = ${id}`,
            );
          }
        }),
        markViewed: Effect.fn("ShareLinksRepo.markViewed")(function* (workspaceId, id, at) {
          const locked = yield* unavailable(
            sql<{ id: string; viewed_at: string | null }>`
                select id, viewed_at from share_links
                where workspace_id = ${workspaceId} and id = ${id}
                for update
              `,
          );
          const row = locked[0];
          if (row === undefined) {
            return yield* NotFound.make({ entity: "ShareLink", id });
          }
          if (row.viewed_at === null) {
            yield* unavailable(
              sql`update share_links set viewed_at = ${at}
                  where workspace_id = ${workspaceId} and id = ${id}`,
            );
          }
        }),
        recordEvent: Effect.fn("ShareLinksRepo.recordEvent")((event) =>
          unavailable(
            sql`insert into share_view_events ${sql.insert({
              id: event.id,
              workspace_id: event.workspaceId,
              share_link_id: event.shareLinkId,
              kind: event.kind,
              device: event.device,
              visitor_hash: event.visitorHash,
              at: event.at,
            })}`,
          ).pipe(Effect.asVoid),
        ),
        hasEventSince: Effect.fn("ShareLinksRepo.hasEventSince")(
          (workspaceId, link, visitor, kind, since) =>
            Effect.map(
              unavailable(
                sql<{ ok: number }>`
                select 1 as ok from share_view_events
                where workspace_id = ${workspaceId} and share_link_id = ${link}
                  and visitor_hash = ${visitor} and kind = ${kind}
                  and at > ${since}::timestamptz
                limit 1
              `,
              ),
              (rows) => rows.length > 0,
            ),
        ),
        events: Effect.fn("ShareLinksRepo.events")((workspaceId, documentId, page) =>
          Effect.map(
            unavailable(
              page.after === undefined
                ? sql<ShareViewEventSqlRow>`
                    select ${sql.unsafe(EVENT_SELECT)}
                    from share_view_events e
                    join share_links l on l.workspace_id = e.workspace_id and l.id = e.share_link_id
                    where e.workspace_id = ${workspaceId} and l.document_id = ${documentId}
                    order by e.at desc, e.id desc
                    limit ${page.limit + 1}
                  `
                : sql<ShareViewEventSqlRow>`
                    select ${sql.unsafe(EVENT_SELECT)}
                    from share_view_events e
                    join share_links l on l.workspace_id = e.workspace_id and l.id = e.share_link_id
                    where e.workspace_id = ${workspaceId} and l.document_id = ${documentId}
                      and (e.at < ${page.after[0]}::timestamptz
                        or (e.at = ${page.after[0]}::timestamptz and e.id < ${page.after[1]}::uuid))
                    order by e.at desc, e.id desc
                    limit ${page.limit + 1}
                  `,
            ),
            (rows) => ({
              rows: Arr.map(rows.slice(0, page.limit), decodeEvent),
              more: rows.length > page.limit,
            }),
          ),
        ),
        viewStats: Effect.fn("ShareLinksRepo.viewStats")((workspaceId, link) =>
          Effect.map(
            unavailable(
              sql<{ views: string; last_viewed_at: string | null }>`
                select count(*)::text as views,
                  ${sql.unsafe(col.instant("max(at)", "last_viewed_at"))}
                from share_view_events
                where workspace_id = ${workspaceId} and share_link_id = ${link} and kind = 'view'
              `,
            ),
            (rows) => ({
              views: Number(rows[0]?.views ?? 0),
              lastViewedAt: rows[0]?.last_viewed_at ?? null,
            }),
          ),
        ),
      });
    }),
  );
