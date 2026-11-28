/**
 * Revokes a removed/departing member's edge-owned credentials (API keys and MCP OAuth grants)
 * in the transaction that changes the membership (http-mcp-contracts 2.1 A2, 3.5.3).
 */
import { transactionWithRetry } from "@kvitbit/adapters/sql";
import { Unavailable, type UserId, type WorkspaceId } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

/**
 * Deletes the member's API keys and OAuth grants for `workspaceId`. Deleting `auth.oauth_consent`
 * cascades to `auth.oauth_refresh_token` and `auth.oauth_access_token` via foreign-key `on delete cascade`.
 */
export const changeMembershipAndRevokeCredentials = Effect.fnUntraced(function* <E, R>(
  sql: SqlClient.SqlClient,
  change: Effect.Effect<void, E, R>,
  workspaceId: WorkspaceId,
  userId: UserId,
) {
  return yield* transactionWithRetry(
    Effect.gen(function* () {
      yield* change;
      yield* sql`DELETE FROM auth.apikey WHERE workspace_id = ${workspaceId} AND created_by = ${userId}`;
      yield* sql`DELETE FROM auth.oauth_consent WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
    }),
  ).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError((error) =>
      SqlError.isSqlError(error) ? Unavailable.make({ dependency: "database" }) : error,
    ),
  );
});
