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
import { DocumentsModule } from "@kvitbit/core";
import type { CoreStoreShape, RequestLogEntry, RequestScope } from "@kvitbit/core/ports";
import { CoreStore, type StoreUnavailable } from "@kvitbit/core/ports";
import {
  AuditEntry,
  AuditEntryId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  IsoDate,
  type RequestKey,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { projectDocumentFromSql } from "../projections/documents";
import { decodeStored, encodeJson, parseJson, StoredUuid } from "./codec";
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
>()("@kvitbit/server/persistence/CoreStoreSql/RequestClaimCheck") {}

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
        actor_job: encodeJson(actor.job),
      };

// JSON omits undefined change values. Restore them on read, as in the memory store.
const AuditChangeValue = Schema.Unknown.pipe(Schema.withDecodingDefaultKey(Effect.undefined));
const StoredAudit = Schema.Struct({
  ...AuditEntry.fields,
  id: StoredUuid,
  changes: Schema.Array(
    Schema.Struct({ path: Schema.String, before: AuditChangeValue, after: AuditChangeValue }),
  ),
});
const decodeAudit = decodeStored(StoredAudit);
const readJson = parseJson(Schema.Unknown);

const toAuditEntry = (row: DbRow): AuditEntry => {
  const entry = decodeAudit({
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
        : { _tag: "System", job: readJson(row.actor_job) },
    subject: { entity: row.subject_entity, id: row.subject_id },
    action: row.action,
    revision: row.subject_revision === null ? null : Number(row.subject_revision),
    changes: readJson(row.changes),
    reason: row.reason,
  });
  return { ...entry, id: AuditEntryId.make(entry.id, { disableChecks: true }) };
};

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isString = Schema.is(Schema.String);
const isIsoDate = Schema.is(IsoDate);
const EncodedView = Schema.Struct({
  id: DocumentId,
  kind: DocumentKind,
  status: Schema.Literals(["issued", "draft"]),
  paymentQr: Schema.Null,
  issuer: DocumentsModule.DocumentRecord.fields.issuer,
  totals: Schema.Struct({ gross: Schema.Struct({ currency: CurrencyCode }) }),
  dates: Schema.Struct({ dueOn: Schema.optional(Schema.Unknown) }),
  number: Schema.optional(Schema.Unknown),
});
const isEncodedView = Schema.is(EncodedView);

const makeCoreStoreSql = Effect.gen(function* () {
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
      tryReserve: (reservation) => {
        const { seriesId, ...required } = reservation;
        return db(tryReserveNumber(seriesId === null ? required : { ...required, seriesId }));
      },
    },
    requestLog: {
      claim: Effect.fn("claim")(function* (scope, key, now) {
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
        const createdAt = DateTime.makeUnsafe(outcome.entry.createdAt);
        const entry: RequestLogEntry = {
          scope,
          key,
          method: outcome.entry.method,
          fingerprint: outcome.entry.payloadHash,
          result: outcome.entry.result,
          createdAt: DateTime.formatIso(createdAt),
          expiresAt: DateTime.formatIso(DateTime.addDuration(createdAt, TTL_MS)),
        };
        return { _tag: "Existing" as const, entry };
      }),
      complete: Effect.fn("complete")(function* (entry) {
        let result: unknown = entry.result === undefined ? null : entry.result;
        if (entry.scope._tag === "Workspace" && isRecord(result)) {
          const wsId = entry.scope.workspaceId;
          const enrichEncodedView = Effect.fn("enrichEncodedView")(function* (
            candidate: typeof EncodedView.Type,
          ) {
            const projected = yield* projectDocumentFromSql(sql, wsId, candidate.id, {
              kind: candidate.kind,
              status: candidate.status,
              number: isString(candidate.number) ? candidate.number : null,
              currency: candidate.totals.gross.currency,
              issuer: candidate.issuer,
              dueOn: isIsoDate(candidate.dates.dueOn) ? candidate.dates.dueOn : null,
            });
            return projected === undefined || projected.paymentQr === null
              ? candidate
              : { ...candidate, paymentQr: projected.paymentQr };
          });

          if (isEncodedView(result.document)) {
            result = {
              ...result,
              document: yield* enrichEncodedView(result.document),
            };
          } else if (!isRecord(result.document) && isEncodedView(result)) {
            result = yield* enrichEncodedView(result);
          }
        }
        yield* completeRequest(adapterScope(entry.scope), {
          requestKey: entry.key,
          method: entry.method,
          payloadHash: entry.fingerprint,
          result,
        });
      }, db),
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
              changes: encodeJson(entry.changes),
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
          (rows) => Arr.map(rows, toAuditEntry),
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
