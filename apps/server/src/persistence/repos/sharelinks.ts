/**
 * `ShareLinksRepo` over `share_links` and `share_view_events`.
 * `share_links` has no revision column: `revoke` and `markViewed` are state-conditional updates.
 */
import { ShareLinksRepo } from "@kvitbit/core";
import type {
  DocumentId,
  ShareViewId,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { NotFound } from "@kvitbit/domain/contract";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { unavailable, writeErrors } from "../errors";
import { col, type DbRow } from "../table";

type ShareLink = Option.Option.Value<
  Effect.Success<ReturnType<ShareLinksRepo["Service"]["activeFor"]>>
>;
type ShareLinkId = ShareLink["id"];
type ShareViewEventRow = Effect.Success<
  ReturnType<ShareLinksRepo["Service"]["events"]>
>["rows"][number];

const LINK_SELECT = [
  "id",
  "workspace_id",
  "document_id",
  "token_hash",
  "key_version",
  "created_by",
  col.instant("viewed_at"),
  col.instant("revoked_at"),
  col.instant("created_at"),
].join(", ");

const EVENT_SELECT = [
  "e.id",
  "e.workspace_id",
  "e.share_link_id",
  "e.kind",
  "e.device",
  "e.visitor_hash",
  col.instant("e.at", "at"),
].join(", ");

const decodeLink = (row: DbRow): ShareLink => ({
  id: row.id as ShareLinkId,
  workspaceId: row.workspace_id as WorkspaceId,
  documentId: row.document_id as DocumentId,
  tokenHash: row.token_hash as string,
  keyVersion: Number(row.key_version),
  createdBy: (row.created_by as UserId | null) ?? null,
  viewedAt: (row.viewed_at as string | null) ?? null,
  revokedAt: (row.revoked_at as string | null) ?? null,
  createdAt: row.created_at as string,
});

const decodeEvent = (row: DbRow): ShareViewEventRow => ({
  id: row.id as ShareViewId,
  workspaceId: row.workspace_id as WorkspaceId,
  shareLinkId: row.share_link_id as ShareLinkId,
  kind: row.kind as ShareViewEventRow["kind"],
  device: row.device as ShareViewEventRow["device"],
  visitorHash: row.visitor_hash as VisitorHash,
  at: row.at as string,
});

export const ShareLinksRepoSql: Layer.Layer<ShareLinksRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    ShareLinksRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const linkWriteFailure = writeErrors("share_links");
      return ShareLinksRepo.of({
        activeFor: (workspaceId, documentId) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(LINK_SELECT)} from share_links
                where workspace_id = ${workspaceId} and document_id = ${documentId}
                  and revoked_at is null
                limit 1
              `,
            ),
            (rows) => (rows[0] === undefined ? Option.none() : Option.some(decodeLink(rows[0]))),
          ),
        lockByTokenHash: (tokenHash) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(LINK_SELECT)} from share_links
                where token_hash = ${tokenHash}
                for update
              `,
            ),
            (rows) => (rows[0] === undefined ? Option.none() : Option.some(decodeLink(rows[0]))),
          ),
        insert: (link) =>
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
        revoke: (workspaceId, id, at) =>
          Effect.gen(function* () {
            const locked = yield* unavailable(
              sql<{ id: string; revoked_at: string | null }>`
                select id, revoked_at from share_links
                where workspace_id = ${workspaceId} and id = ${id}
                for update
              `,
            );
            const row = locked[0];
            if (row === undefined) {
              return yield* Effect.fail(new NotFound({ entity: "ShareLink", id }));
            }
            if (row.revoked_at === null) {
              yield* unavailable(
                sql`update share_links set revoked_at = ${at}
                  where workspace_id = ${workspaceId} and id = ${id}`,
              );
            }
          }),
        markViewed: (workspaceId, id, at) =>
          Effect.gen(function* () {
            const locked = yield* unavailable(
              sql<{ id: string; viewed_at: string | null }>`
                select id, viewed_at from share_links
                where workspace_id = ${workspaceId} and id = ${id}
                for update
              `,
            );
            const row = locked[0];
            if (row === undefined) {
              return yield* Effect.fail(new NotFound({ entity: "ShareLink", id }));
            }
            if (row.viewed_at === null) {
              yield* unavailable(
                sql`update share_links set viewed_at = ${at}
                  where workspace_id = ${workspaceId} and id = ${id}`,
              );
            }
          }),
        recordEvent: (event) =>
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
        hasEventSince: (workspaceId, link, visitor, kind, since) =>
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
        events: (workspaceId, documentId, page) =>
          Effect.map(
            unavailable(
              page.after === undefined
                ? sql<DbRow>`
                    select ${sql.unsafe(EVENT_SELECT)}
                    from share_view_events e
                    join share_links l on l.workspace_id = e.workspace_id and l.id = e.share_link_id
                    where e.workspace_id = ${workspaceId} and l.document_id = ${documentId}
                    order by e.at desc, e.id desc
                    limit ${page.limit + 1}
                  `
                : sql<DbRow>`
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
              rows: rows.slice(0, page.limit).map(decodeEvent),
              more: rows.length > page.limit,
            }),
          ),
        viewStats: (workspaceId, link) =>
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
      });
    }),
  );
