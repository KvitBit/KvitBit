import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/**
 * Who a request key belongs to (core-ports.md C3). Workspace-scoped keys are unique per
 * Workspace; account-level calls without a Workspace use the user id.
 */
export type RequestScope =
  | { readonly workspaceId: string; readonly userId?: string }
  | { readonly workspaceId?: undefined; readonly userId: string };

/** A completed request: what a replay with the same key compares against and returns. */
export interface RequestLogEntry {
  readonly requestKey: string;
  /** Operation name, e.g. `Documents.issue`. */
  readonly method: string;
  readonly payloadHash: string;
  readonly result: unknown;
  /** ISO 8601 instant of the claim. */
  readonly createdAt: string;
}

/**
 * `Claimed`: this transaction owns the key until it ends and must `completeRequest` before
 * committing. `Existing`: an earlier, unexpired call completed it; compare its method and
 * payload hash and replay its result instead of doing the work.
 */
export type ClaimOutcome =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "Existing"; readonly entry: RequestLogEntry };

export interface ClaimOptions {
  /** ISO 8601 instant of this call; rows claimed `ttlHours` before it count as expired. */
  readonly now: string;
  /** Default 24 (core-ports.md C3). */
  readonly ttlHours?: number;
}

/** Placeholder written by a claim; `completeRequest` replaces it. `method` is never empty. */
const PENDING = "";

interface LogRow {
  readonly method: string;
  readonly payload_hash: string;
  readonly result: unknown;
  readonly created_at: string;
  readonly expired: boolean;
}

const scopeWhere = (sql: SqlClient.SqlClient, scope: RequestScope, requestKey: string) =>
  scope.workspaceId !== undefined
    ? sql`workspace_id = ${scope.workspaceId} and request_key = ${requestKey}`
    : sql`workspace_id is null and user_id = ${scope.userId} and request_key = ${requestKey}`;

const toEntry = (requestKey: string, row: LogRow): RequestLogEntry => ({
  requestKey,
  method: row.method,
  payloadHash: row.payload_hash,
  result: row.result,
  createdAt: row.created_at,
});

const requireTransaction = (operation: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = yield* Effect.serviceOption(sql.transactionService);
    if (Option.isNone(transaction)) {
      return yield* Effect.die(new Error(`sql: ${operation} must run inside a transaction`));
    }
  });

/**
 * Claims a request key before the work it guards (core-ports.md C3, S2), so two calls with one
 * key never both run. The claim is a placeholder row inside the caller's transaction: a
 * concurrent claim of the same key waits for that transaction, then sees the completed entry
 * (`Existing`) or, after a rollback, claims the key itself. An expired entry, or a placeholder
 * committed without `completeRequest`, is taken over. Run it in the outermost transaction; a
 * claim outside any transaction is a defect.
 */
export const claimRequest = (
  scope: RequestScope,
  requestKey: string,
  options: ClaimOptions,
): Effect.Effect<ClaimOutcome, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* requireTransaction("claimRequest");
    const sql = yield* SqlClient.SqlClient;
    const ttlSeconds = (options.ttlHours ?? 24) * 3600;
    const values = sql`(${scope.workspaceId ?? null}, ${scope.userId ?? null}, ${requestKey},
      ${PENDING}, ${PENDING}, 'null'::jsonb, ${options.now}::timestamptz)`;
    const conflict =
      scope.workspaceId !== undefined
        ? sql`(workspace_id, request_key) where workspace_id is not null`
        : sql`(user_id, request_key) where workspace_id is null`;

    // A row deleted by housekeeping between the conflict and the read makes the insert succeed
    // on the next pass; two passes cover it, the third is a safety margin.
    for (let pass = 0; pass < 3; pass++) {
      const inserted = yield* sql`
        insert into request_log (workspace_id, user_id, request_key, method, payload_hash, result,
          created_at)
        values ${values}
        on conflict ${conflict} do nothing
        returning request_key`;
      if (inserted.length > 0) return { _tag: "Claimed" } as const;

      const rows = yield* sql<LogRow>`
        select method, payload_hash, result, to_json(created_at) #>> '{}' as created_at,
          created_at <= ${options.now}::timestamptz - make_interval(secs => ${ttlSeconds}) as expired
        from request_log where ${scopeWhere(sql, scope, requestKey)}
        for update`;
      const row = rows[0];
      if (row === undefined) continue;
      if (row.method !== PENDING && !row.expired) {
        return { _tag: "Existing", entry: toEntry(requestKey, row) } as const;
      }
      yield* sql`
        update request_log
        set method = ${PENDING}, payload_hash = ${PENDING}, result = 'null'::jsonb,
          created_at = ${options.now}::timestamptz
        where ${scopeWhere(sql, scope, requestKey)}`;
      return { _tag: "Claimed" } as const;
    }
    return yield* Effect.die(new Error(`sql: could not claim request key ${requestKey}`));
  });

export interface RequestCompletion {
  readonly requestKey: string;
  readonly method: string;
  readonly payloadHash: string;
  /** JSON-serializable result returned to replays; `undefined` is a defect, use `null`. */
  readonly result: unknown;
}

/**
 * Stores the outcome under a key this transaction claimed, just before commit. Completing a key
 * that is not claimed by this transaction is a defect.
 */
export const completeRequest = (
  scope: RequestScope,
  completion: RequestCompletion,
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* requireTransaction("completeRequest");
    const sql = yield* SqlClient.SqlClient;
    const { requestKey, method, payloadHash } = completion;
    if (method === PENDING || completion.result === undefined) {
      return yield* Effect.die(
        new Error(`sql: request ${requestKey} needs a method and a defined result`),
      );
    }
    const updated = yield* sql`
      update request_log
      set method = ${method}, payload_hash = ${payloadHash},
        result = ${JSON.stringify(completion.result)}::jsonb
      where ${scopeWhere(sql, scope, requestKey)} and method = ${PENDING}
      returning request_key`;
    if (updated.length === 0) {
      return yield* Effect.die(new Error(`sql: request key ${requestKey} is not claimed`));
    }
  });

/**
 * The completed entry for a key, if any, without locking or claiming it. Expiry is not applied:
 * Housekeeping purges old rows, and `claimRequest` takes expired ones over.
 */
export const lookupRequest = (
  scope: RequestScope,
  requestKey: string,
): Effect.Effect<Option.Option<RequestLogEntry>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<LogRow>`
      select method, payload_hash, result, to_json(created_at) #>> '{}' as created_at,
        false as expired
      from request_log where ${scopeWhere(sql, scope, requestKey)} and method <> ${PENDING}`;
    const row = rows[0];
    return row === undefined ? Option.none() : Option.some(toEntry(requestKey, row));
  });
