/**
 * Revokes a removed/departing member's edge-owned credentials (API keys and MCP OAuth grants)
 * in the same request after core commits the membership change (http-mcp-contracts 2.1 A2, 3.5.3).
 */
import { Unavailable, type UserId, type WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Deletes the member's API keys and OAuth grants for `workspaceId`. Deleting `auth.oauth_consent`
 * cascades to `auth.oauth_refresh_token` and `auth.oauth_access_token` via foreign-key `on delete cascade`.
 */
export const revokeMemberCredentials = (
  workspaceId: WorkspaceId,
  userId: UserId,
): Effect.Effect<void, Unavailable> =>
  Effect.gen(function* () {
    const maybeSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(maybeSql)) return;
    const sql = maybeSql.value;
    yield* Effect.all([
      sql`DELETE FROM auth.apikey WHERE workspace_id = ${workspaceId} AND created_by = ${userId}`,
      sql`DELETE FROM auth.oauth_consent WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`,
    ]).pipe(Effect.mapError(() => new Unavailable({ dependency: "database" })));
  });
