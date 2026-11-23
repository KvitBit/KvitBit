import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { RequestKeyReused } from "./errors";

/**
 * Who a request key belongs to (core-ports.md C3). Workspace-scoped keys are unique per
 * Workspace; account-level calls without a Workspace use the user id.
 */
export type RequestScope =
  | { readonly workspaceId: string; readonly userId?: string }
  | { readonly workspaceId?: undefined; readonly userId: string };

export interface RequestFingerprint {
  readonly requestKey: string;
  /** Operation name, e.g. `Documents.issue`. */
  readonly method: string;
  readonly payloadHash: string;
}

export interface RequestClaim extends RequestFingerprint {
  /** JSON-serializable result returned to replays. */
  readonly result: unknown;
}

/** `Claimed`: this call owns the key. `Replayed`: an earlier call committed `result` first. */
export type ClaimOutcome =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "Replayed"; readonly result: unknown };

interface LogRow {
  readonly method: string;
  readonly payload_hash: string;
  readonly result: unknown;
}

const selectRow = (sql: SqlClient.SqlClient, scope: RequestScope, requestKey: string) =>
  scope.workspaceId !== undefined
    ? sql<LogRow>`
        select method, payload_hash, result from request_log
        where workspace_id = ${scope.workspaceId} and request_key = ${requestKey}`
    : sql<LogRow>`
        select method, payload_hash, result from request_log
        where workspace_id is null and user_id = ${scope.userId} and request_key = ${requestKey}`;

const matchRow = (
  row: LogRow,
  request: RequestFingerprint,
): Effect.Effect<unknown, RequestKeyReused> =>
  row.method === request.method && row.payload_hash === request.payloadHash
    ? Effect.succeed(row.result)
    : Effect.fail(
        new RequestKeyReused({
          requestKey: request.requestKey,
          method: request.method,
          storedMethod: row.method,
          payloadHashMatches: row.payload_hash === request.payloadHash,
        }),
      );

/**
 * Looks up a request key before doing the work. `Some(result)` is a replay to return as is;
 * `None` means the key is unused. A key stored with another method or payload hash fails with
 * `RequestKeyReused`.
 */
export const lookupRequest = (
  scope: RequestScope,
  request: RequestFingerprint,
): Effect.Effect<Option.Option<unknown>, RequestKeyReused | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = (yield* selectRow(sql, scope, request.requestKey))[0];
    if (row === undefined) return Option.none();
    return Option.some(yield* matchRow(row, request));
  });

/**
 * Records the result under the request key, in the same transaction as the work it describes
 * (core-ports.md S2). If a concurrent call with the same key committed first, the insert waits
 * for it and this returns `Replayed` with its result: the caller should then roll back its own
 * work and return that result. A stored row with another method or payload fails with
 * `RequestKeyReused`.
 */
export const claimRequest = (
  scope: RequestScope,
  claim: RequestClaim,
): Effect.Effect<ClaimOutcome, RequestKeyReused | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = JSON.stringify(claim.result);
    const values = sql`(${scope.workspaceId ?? null}, ${scope.userId ?? null}, ${claim.requestKey},
      ${claim.method}, ${claim.payloadHash}, ${result}::jsonb)`;
    const inserted =
      scope.workspaceId !== undefined
        ? yield* sql`
            insert into request_log (workspace_id, user_id, request_key, method, payload_hash, result)
            values ${values}
            on conflict (workspace_id, request_key) where workspace_id is not null do nothing
            returning request_key`
        : yield* sql`
            insert into request_log (workspace_id, user_id, request_key, method, payload_hash, result)
            values ${values}
            on conflict (user_id, request_key) where workspace_id is null do nothing
            returning request_key`;
    if (inserted.length > 0) return { _tag: "Claimed" } as const;
    const row = (yield* selectRow(sql, scope, claim.requestKey))[0];
    if (row === undefined) {
      return yield* Effect.die(
        new Error(`sql: request_log conflict on ${claim.requestKey} but no row is visible`),
      );
    }
    return { _tag: "Replayed", result: yield* matchRow(row, claim) } as const;
  });
