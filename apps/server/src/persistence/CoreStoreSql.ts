/**
 * `CoreStore` over Effect `SqlClient` (core-ports.md section 8). Transactions run at READ
 * COMMITTED; a nested `transaction` is a savepoint; the outermost one is rerun on a deadlock or
 * serialization failure (S4). Counters, reservations and the request log delegate to the
 * primitives of `@kvitbit/adapters/sql`; `afterCommit` is `SqlClient.afterCommit`.
 */
import {
  claimRequest,
  completeRequest,
  lockCounter,
  peekCounter,
  setCounter,
  tryReserveNumber,
} from "@kvitbit/adapters/sql";
import type { CoreStoreShape, RequestLogEntry, RequestScope } from "@kvitbit/core/ports";
import { CoreStore, type StoreUnavailable } from "@kvitbit/core/ports";
import type { AuditEntry, RequestKey, WorkspaceId } from "@kvitbit/domain/contract";
import { Cause, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { isLockConflict, unavailable } from "./errors";
import { col, type DbRow } from "./table";

/** Retries of the outermost transaction after a deadlock or serialization failure (S4). */
const LOCK_RETRIES = 3;

/** Request-log entries live 24 hours (C3). */
const TTL_MS = 24 * 60 * 60 * 1000;

/** An edge check that must run with its idempotent write and result in the same transaction. */
export class RequestClaimCheck extends Context.Service<
  RequestClaimCheck,
  {
    readonly requestKey: RequestKey;
    readonly workspaceId: WorkspaceId;
    readonly check: (replayed: boolean) => Effect.Effect<void, StoreUnavailable>;
  }
>()("kvitbit/server/persistence/RequestClaimCheck") {}

const adapterScope = (scope: RequestScope) =>
  scope._tag === "Workspace" ? { workspaceId: scope.workspaceId } : { userId: scope.userId };

const actorColumns = (actor: AuditEntry["actor"]) =>
  actor._tag === "Member"
    ? {
        actor_user_id: actor.userId,
        actor_channel: actor.channel,
        actor_client_kind: actor.client?.kind ?? null,
        actor_client_id: actor.client?.id ?? null,
        actor_client_name: actor.client?.name ?? null,
        actor_system_job: null,
        actor_job: null,
      }
    : {
        actor_user_id: null,
        actor_channel: null,
        actor_client_kind: null,
        actor_client_id: null,
        actor_client_name: null,
        actor_system_job: actor.job._tag,
        actor_job: JSON.stringify(actor.job),
      };

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : value;

const toAuditEntry = (row: DbRow): AuditEntry =>
  ({
    id: row.id,
    at: row.at,
    actor:
      row.actor_system_job === null
        ? {
            _tag: "Member",
            userId: row.actor_user_id,
            channel: row.actor_channel,
            client:
              row.actor_client_kind === null
                ? null
                : {
                    kind: row.actor_client_kind,
                    id: row.actor_client_id,
                    name: row.actor_client_name,
                  },
          }
        : { _tag: "System", job: parseJson(row.actor_job) },
    subject: { entity: row.subject_entity, id: row.subject_id },
    action: row.action,
    revision: row.subject_revision === null ? null : Number(row.subject_revision),
    changes: parseJson(row.changes),
    reason: row.reason,
  }) as AuditEntry;

export const makeCoreStoreSql = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  /** The adapter primitives read `SqlClient` from context; they join the caller's transaction. */
  const db = <A, E>(self: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    unavailable(Effect.provideService(self, SqlClient.SqlClient, sql));
  const inTransaction = Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome);

  const requireTransaction = (operation: string) =>
    Effect.flatMap(inTransaction, (open) =>
      open
        ? Effect.void
        : Effect.die(new Error(`CoreStore: ${operation} outside a transaction (rule C1)`)),
    );

  const transaction = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StoreUnavailable, R> =>
    Effect.flatMap(
      inTransaction,
      (nested): Effect.Effect<A, E | StoreUnavailable, R> =>
        nested
          ? unavailable(sql.withTransaction(effect))
          : unavailable(
              sql
                .withTransaction(effect)
                .pipe(
                  Effect.provideService(
                    SqlClient.BeginTransaction,
                    "BEGIN ISOLATION LEVEL READ COMMITTED",
                  ),
                ),
            ).pipe(Effect.retry({ while: isLockConflict, times: LOCK_RETRIES })),
    );

  const store: CoreStoreShape = {
    transaction,
    afterCommit: (effect) =>
      Effect.andThen(
        requireTransaction("afterCommit"),
        sql.afterCommit(
          effect.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("CoreStore.afterCommit failed", cause),
            ),
          ),
        ),
      ),
    counters: {
      lock: (key) => db(lockCounter(key)).pipe(Effect.catchTag("RowNotFound", Effect.die)),
      peek: (key) => db(peekCounter(key)),
      set: (key, next) => db(setCounter(key, next)),
    },
    reservations: {
      tryReserve: (reservation) =>
        db(
          tryReserveNumber({
            workspaceId: reservation.workspaceId,
            kind: reservation.kind,
            number: reservation.number,
            documentId: reservation.documentId,
            ...(reservation.seriesId === null ? {} : { seriesId: reservation.seriesId }),
          }),
        ),
    },
    requestLog: {
      claim: (scope, key, now) =>
        Effect.gen(function* () {
          const outcome = yield* db(claimRequest(adapterScope(scope), key, { now }));
          const hook = yield* Effect.serviceOption(RequestClaimCheck);
          if (
            Option.isSome(hook) &&
            scope._tag === "Workspace" &&
            hook.value.workspaceId === scope.workspaceId &&
            hook.value.requestKey === key
          ) {
            yield* hook.value.check(outcome._tag === "Existing");
          }
          if (outcome._tag === "Claimed") return outcome;
          const createdAt = new Date(outcome.entry.createdAt).toISOString();
          const entry: RequestLogEntry = {
            scope,
            key: key as RequestKey,
            method: outcome.entry.method,
            fingerprint: outcome.entry.payloadHash,
            result: outcome.entry.result,
            createdAt,
            expiresAt: new Date(Date.parse(createdAt) + TTL_MS).toISOString(),
          };
          return { _tag: "Existing" as const, entry };
        }),
      complete: (entry) =>
        db(
          completeRequest(adapterScope(entry.scope), {
            requestKey: entry.key,
            method: entry.method,
            payloadHash: entry.fingerprint,
            result: entry.result === undefined ? null : entry.result,
          }),
        ),
    },
    audit: {
      append: (workspaceId, entry) =>
        Effect.andThen(
          requireTransaction("audit.append"),
          unavailable(
            sql`insert into audit_entries ${sql.insert({
              id: entry.id,
              workspace_id: workspaceId,
              at: entry.at,
              ...actorColumns(entry.actor),
              subject_entity: entry.subject.entity,
              subject_id: entry.subject.id,
              subject_revision: entry.revision,
              action: entry.action,
              changes: JSON.stringify(entry.changes),
              reason: entry.reason,
            })}`,
          ),
        ),
      history: (workspaceId: WorkspaceId, subject) =>
        Effect.map(
          unavailable(
            sql<DbRow>`select id, ${sql.unsafe(col.instant("at"))}, actor_user_id, actor_channel,
                actor_client_kind, actor_client_id, actor_client_name, actor_system_job, actor_job,
                subject_entity, subject_id, subject_revision, action, changes, reason
              from audit_entries
              where workspace_id = ${workspaceId} and subject_entity = ${subject.entity}
                and subject_id = ${subject.id}
              order by at, id`,
          ),
          (rows) => rows.map(toAuditEntry),
        ),
    },
  };
  return store;
});

/** The SQL `CoreStore`. */
export const CoreStoreSql: Layer.Layer<CoreStore, never, SqlClient.SqlClient> = Layer.effect(
  CoreStore,
  makeCoreStoreSql,
);
