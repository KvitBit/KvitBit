/**
 * `apiKeys` group handlers (http-mcp-contracts 2.2 & 3.5.3): list, create and revoke
 * Workspace `kvb_` API keys in `auth.apikey`.
 */
import { generateApiKey } from "@kvitbit/adapters/auth";
import {
  type AccessMode,
  API_PREFIX,
  Api,
  ApiKeyId,
  type ApiKeyView,
  apiKeyDisplayPrefix,
  expandAccess,
} from "@kvitbit/api-contract";
import { Invalid, NotFound, UserId, Workspaces } from "@kvitbit/domain/contract";
import { Clock, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { setLocation } from "../conventions";
import {
  authorizeMember,
  dbUnavailable,
  enforceRoleScopeCap,
  normalizeStoredAccess,
  toIsoString,
  toNullableIsoString,
} from "./credentials/helpers";

interface ApiKeyRow {
  readonly id: string;
  readonly name: string | null;
  readonly start: string | null;
  readonly access: AccessMode;
  readonly scopes: ReadonlyArray<string>;
  readonly created_by: string;
  readonly creator_name: string | null;
  readonly created_at: Date | string;
  readonly last_request: Date | string | null;
  readonly expires_at: Date | string | null;
}

const toApiKeyView = (row: ApiKeyRow): ApiKeyView => {
  const id = ApiKeyId.make(row.id);
  const granted = normalizeStoredAccess(row.access, row.scopes);
  return {
    id,
    name: row.name ?? "",
    prefix: row.start ?? apiKeyDisplayPrefix(id),
    access: granted.access,
    scopes: granted.scopes,
    createdBy: {
      userId: UserId.make(row.created_by),
      name: row.creator_name ?? "",
    },
    createdAt: toIsoString(row.created_at),
    lastUsedAt: toNullableIsoString(row.last_request),
    expiresAt: toNullableIsoString(row.expires_at),
  };
};

export const ApiKeysGroupLive = HttpApiBuilder.group(Api, "apiKeys", (handlers) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspaces = yield* Workspaces;

    return handlers
      .handle("listApiKeys", () =>
        Effect.gen(function* () {
          const caller = yield* authorizeMember("apiKey.manage");
          const rows = yield* dbUnavailable(
            sql<ApiKeyRow>`
              select
                k.id,
                k.name,
                k.start,
                k.access,
                k.scopes,
                k.created_by,
                u.name as creator_name,
                k.created_at,
                k.last_request,
                k.expires_at
              from auth.apikey k
              left join auth."user" u on u.id = k.created_by
              where k.workspace_id = ${caller.workspaceId}
                and k.enabled = true
              order by k.created_at desc, k.id desc
            `,
          );
          return rows.map(toApiKeyView);
        }),
      )
      .handle("createApiKey", ({ params, payload }) =>
        Effect.gen(function* () {
          const caller = yield* authorizeMember("apiKey.manage");
          const trimmedName = payload.name.trim();
          if (trimmedName.length === 0) {
            return yield* new Invalid({
              issues: [{ path: ["name"], code: "request.malformed" }],
            });
          }

          const nowMillis = yield* Clock.currentTimeMillis;
          const now = new Date(nowMillis);
          const expiresAt =
            payload.expiresOn === undefined ? null : new Date(`${payload.expiresOn}T23:59:59.999Z`);
          if (expiresAt !== null && (Number.isNaN(expiresAt.getTime()) || expiresAt <= now)) {
            return yield* new Invalid({
              issues: [{ path: ["expiresOn"], code: "request.malformed" }],
            });
          }

          const granted = expandAccess(payload);
          yield* enforceRoleScopeCap(caller.role, granted.scopes, "apiKey.manage");

          const issued = generateApiKey();

          const creatorName = yield* dbUnavailable(
            sql.withTransaction(
              Effect.gen(function* () {
                const inserted = yield* sql<{ creator_name: string | null }>`
                  with ins as (
                    insert into auth.apikey (
                      id,
                      config_id,
                      name,
                      start,
                      prefix,
                      key,
                      reference_id,
                      enabled,
                      rate_limit_enabled,
                      request_count,
                      expires_at,
                      created_at,
                      updated_at,
                      workspace_id,
                      created_by,
                      access,
                      scopes
                    ) values (
                      ${issued.keyId},
                      'default',
                      ${trimmedName},
                      ${issued.start},
                      ${issued.prefix},
                      ${issued.hash},
                      ${caller.userId},
                      true,
                      true,
                      0,
                      ${expiresAt},
                      ${now},
                      ${now},
                      ${caller.workspaceId},
                      ${caller.userId},
                      ${granted.access},
                      ${[...granted.scopes]}
                    )
                    returning created_by
                  )
                  select u.name as creator_name
                  from ins
                  left join auth."user" u on u.id = ins.created_by
                `;
                yield* workspaces.recordAccessEvent({
                  action: "apiKey.create",
                  subject: { entity: "ApiKey", id: issued.keyId, name: trimmedName },
                });
                return inserted[0]?.creator_name ?? "";
              }),
            ),
          );

          yield* setLocation(
            `${API_PREFIX}/workspaces/${params.workspaceId}/api-keys/${issued.keyId}`,
          );

          return {
            key: {
              id: issued.keyId,
              name: trimmedName,
              prefix: issued.start,
              access: granted.access,
              scopes: granted.scopes,
              createdBy: { userId: caller.userId, name: creatorName },
              createdAt: now.toISOString(),
              lastUsedAt: null,
              expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
            },
            secret: issued.token,
          };
        }),
      )
      .handle("revokeApiKey", ({ params }) =>
        Effect.gen(function* () {
          const caller = yield* authorizeMember("apiKey.manage");
          yield* dbUnavailable(
            sql.withTransaction(
              Effect.gen(function* () {
                const deleted = yield* sql<{ id: string; name: string | null }>`
                  delete from auth.apikey
                  where id = ${params.keyId}
                    and workspace_id = ${caller.workspaceId}
                  returning id, name
                `;
                const row = deleted[0];
                if (row === undefined) {
                  return yield* new NotFound({ entity: "ApiKey", id: params.keyId });
                }
                yield* workspaces.recordAccessEvent({
                  action: "apiKey.revoke",
                  subject: { entity: "ApiKey", id: row.id, name: row.name ?? "" },
                });
              }),
            ),
          );
        }),
      );
  }),
);
