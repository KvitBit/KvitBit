/**
 * `connectedApps` group handlers (http-mcp-contracts 3.5.3): list and revoke MCP OAuth grants
 * in `auth.oauth_consent` joined with `auth.oauth_client` and `auth.user`.
 */

import { type AccessMode, Api, type ConnectedAppView } from "@kvitbit/api-contract";
import { can } from "@kvitbit/core";
import { Forbidden, NotFound, UserId, Workspaces } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import { compact } from "../conventions";
import {
  dbUnavailable,
  normalizeStoredAccess,
  redirectHostOf,
  requireMemberCaller,
  toIsoString,
  toNullableIsoString,
} from "./credentials/helpers";

interface ConnectedAppRow {
  readonly grant_id: string;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly redirect_uris: ReadonlyArray<string> | null;
  readonly user_id: string;
  readonly user_name: string | null;
  readonly access: AccessMode;
  readonly granted_scopes: ReadonlyArray<string>;
  readonly created_at: Date | string | null;
  readonly last_used_at: Date | string | null;
}

const toConnectedAppView = (row: ConnectedAppRow): ConnectedAppView => {
  const granted = normalizeStoredAccess({ access: row.access, scopes: row.granted_scopes });
  return {
    grantId: row.grant_id,
    client: {
      id: row.client_id,
      name: row.client_name ?? row.client_id,
      redirectHost: redirectHostOf(row.redirect_uris),
    },
    member: {
      userId: UserId.make(row.user_id),
      name: row.user_name ?? "",
    },
    access: granted.access,
    scopes: granted.scopes,
    createdAt: toIsoString(row.created_at ?? "1970-01-01T00:00:00.000Z"),
    lastUsedAt: toNullableIsoString(row.last_used_at),
  };
};

export const ConnectedAppsGroupLive = HttpApiBuilder.group(
  Api,
  "connectedApps",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const workspaces = yield* Workspaces;

    return handlers
      .handle(
        "listConnectedApps",
        Effect.fnUntraced(function* () {
          const caller = yield* requireMemberCaller;
          const canReadAll = can(caller, "grant.read.all");
          if (!(canReadAll || can(caller, "grant.read.own"))) {
            return yield* Forbidden.make({ action: "grant.read.own" });
          }

          const rows = yield* dbUnavailable(
            canReadAll
              ? sql<ConnectedAppRow>`
                  select
                    c.id as grant_id,
                    c.client_id,
                    cl.name as client_name,
                    cl.redirect_uris,
                    c.user_id,
                    u.name as user_name,
                    c.access,
                    c.granted_scopes,
                    c.created_at,
                    c.last_used_at
                  from auth.oauth_consent c
                  inner join auth.oauth_client cl on cl.client_id = c.client_id
                  left join auth."user" u on u.id = c.user_id
                  where c.workspace_id = ${caller.workspaceId}
                    and c.access is not null
                    and c.granted_scopes is not null
                    and c.user_id is not null
                  order by c.created_at desc nulls last, c.id desc
                `
              : sql<ConnectedAppRow>`
                  select
                    c.id as grant_id,
                    c.client_id,
                    cl.name as client_name,
                    cl.redirect_uris,
                    c.user_id,
                    u.name as user_name,
                    c.access,
                    c.granted_scopes,
                    c.created_at,
                    c.last_used_at
                  from auth.oauth_consent c
                  inner join auth.oauth_client cl on cl.client_id = c.client_id
                  left join auth."user" u on u.id = c.user_id
                  where c.workspace_id = ${caller.workspaceId}
                    and c.user_id = ${caller.userId}
                    and c.access is not null
                    and c.granted_scopes is not null
                  order by c.created_at desc nulls last, c.id desc
                `,
          );
          return Arr.map(rows, toConnectedAppView);
        }),
      )
      .handle(
        "revokeConnectedApp",
        Effect.fnUntraced(function* ({ params }) {
          const caller = yield* requireMemberCaller;
          if (!(can(caller, "grant.revoke.own") || can(caller, "grant.revoke.all"))) {
            return yield* Forbidden.make({ action: "grant.revoke.own" });
          }

          yield* dbUnavailable(
            sql.withTransaction(
              Effect.gen(function* () {
                const found = yield* sql<{
                  readonly id: string;
                  readonly client_id: string;
                  readonly user_id: string | null;
                  readonly client_name: string | null;
                }>`
                  select
                    c.id,
                    c.client_id,
                    c.user_id,
                    cl.name as client_name
                  from auth.oauth_consent c
                  left join auth.oauth_client cl on cl.client_id = c.client_id
                  where c.id = ${params.grantId}
                    and c.workspace_id = ${caller.workspaceId}
                  for update of c
                `;
                const row = found[0];
                if (row === undefined) {
                  return yield* NotFound.make({ entity: "McpGrant", id: params.grantId });
                }

                const isOwn = row.user_id === caller.userId;
                const requiredAction = isOwn ? "grant.revoke.own" : "grant.revoke.all";
                if (!can(caller, requiredAction)) {
                  return yield* Forbidden.make({ action: requiredAction });
                }

                yield* sql`
                  delete from auth.oauth_access_token
                  where consent_id = ${row.id}
                `;
                yield* sql`
                  delete from auth.oauth_refresh_token
                  where consent_id = ${row.id}
                `;
                yield* sql`
                  delete from auth.oauth_consent
                  where id = ${row.id}
                    and workspace_id = ${caller.workspaceId}
                `;

                yield* workspaces.recordAccessEvent({
                  action: "grant.revoke",
                  subject: {
                    entity: "McpGrant",
                    id: row.id,
                    name: row.client_name ?? row.client_id,
                  },
                  ...compact({
                    onBehalfOf:
                      isOwn || row.user_id === null ? undefined : UserId.make(row.user_id),
                  }),
                });
              }),
            ),
          );
        }),
      );
  }),
);
