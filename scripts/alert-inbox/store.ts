/**
 * Scoped, typed-Effect SQLite store for processed and in-flight alert emails.
 *
 * All SQLite operations return `Effect.Effect<..., AlertStoreError>` and the connection
 * lifecycle is managed with `Effect.acquireRelease` so corrupted files (`SQLITE_NOTADB`)
 * or I/O failures stay cleanly in the Effect error channel.
 */

import { Database } from "bun:sqlite";
import { Data, Effect, type Scope } from "effect";

export type AlertRecordStatus = "claiming" | "created" | "duplicate" | "rejected" | "retry";

export class AlertStoreError extends Data.TaggedError("AlertStoreError")<{
  readonly operation: string;
  readonly reason: string;
}> {}

export interface ProcessedAlertRecord {
  readonly objectKey: string;
  readonly deliveryHash: string;
  readonly dedupKey: string | null;
  readonly messageId: string | null;
  readonly status: AlertRecordStatus;
  readonly issueNumber: number | null;
  readonly reason: string | null;
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly processedAt: string;
}

export interface ExistingAlertMatch {
  readonly objectKey: string;
  readonly status: "claiming" | "created";
  readonly issueNumber: number | null;
  readonly matchedBy: "delivery_hash" | "dedup_key" | "message_id";
}

export interface AlertInboxStoreService {
  readonly getObject: (
    objectKey: string,
  ) => Effect.Effect<ProcessedAlertRecord | null, AlertStoreError>;
  readonly findByDeliveryHash: (
    deliveryHash: string,
  ) => Effect.Effect<ExistingAlertMatch | null, AlertStoreError>;
  readonly findByDedupKeyOrMessageId: (
    dedupKey: string,
    signedMessageId: string | undefined,
  ) => Effect.Effect<ExistingAlertMatch | null, AlertStoreError>;
  readonly claimForCreation: (entry: {
    readonly objectKey: string;
    readonly deliveryHash: string;
    readonly dedupKey: string;
    readonly messageId: string | null;
    readonly nowIso: string;
  }) => Effect.Effect<void, AlertStoreError>;
  readonly markCreated: (entry: {
    readonly objectKey: string;
    readonly issueNumber: number;
    readonly nowIso: string;
  }) => Effect.Effect<void, AlertStoreError>;
  readonly markDuplicate: (entry: {
    readonly objectKey: string;
    readonly deliveryHash: string;
    readonly dedupKey: string | null;
    readonly messageId: string | null;
    readonly issueNumber: number | null;
    readonly reason: string;
    readonly nowIso: string;
  }) => Effect.Effect<void, AlertStoreError>;
  readonly markRejected: (entry: {
    readonly objectKey: string;
    readonly deliveryHash: string;
    readonly reason: string;
    readonly nowIso: string;
  }) => Effect.Effect<void, AlertStoreError>;
  readonly markRetry: (entry: {
    readonly objectKey: string;
    readonly deliveryHash: string;
    readonly dedupKey: string | null;
    readonly messageId: string | null;
    readonly keepClaiming: boolean;
    readonly reason: string;
    readonly nextRetryAt: string;
    readonly nowIso: string;
  }) => Effect.Effect<void, AlertStoreError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProcessedAlertRecord>, AlertStoreError>;
}

const wrapDb = <A>(operation: string, thunk: () => A): Effect.Effect<A, AlertStoreError> =>
  Effect.try({
    try: thunk,
    catch: (error) =>
      new AlertStoreError({
        operation,
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

const SELECT_COLUMNS = `
  object_key AS objectKey,
  delivery_hash AS deliveryHash,
  dedup_key AS dedupKey,
  message_id AS messageId,
  status,
  issue_number AS issueNumber,
  reason,
  attempt_count AS attemptCount,
  next_retry_at AS nextRetryAt,
  processed_at AS processedAt
`;

export const openAlertInboxStore = (
  path: string,
  readonly = false,
): Effect.Effect<AlertInboxStoreService, AlertStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    wrapDb("open", () => {
      const db = new Database(path, { readonly, create: !readonly, strict: true });
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        if (!readonly) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS processed_alert (
              object_key TEXT PRIMARY KEY,
              delivery_hash TEXT NOT NULL,
              dedup_key TEXT,
              message_id TEXT,
              status TEXT NOT NULL CHECK (status IN ('claiming', 'created', 'duplicate', 'rejected', 'retry')),
              issue_number INTEGER,
              reason TEXT,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              next_retry_at TEXT,
              processed_at TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS idx_processed_alert_delivery_hash
              ON processed_alert (delivery_hash);
            CREATE INDEX IF NOT EXISTS idx_processed_alert_dedup_key
              ON processed_alert (dedup_key)
              WHERE dedup_key IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_processed_alert_message_id
              ON processed_alert (message_id)
              WHERE message_id IS NOT NULL;
          `);
        } else {
          // Validate readability & schema eagerly on readonly open so corrupt files fail cleanly.
          db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
        }
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    }),
    (db) =>
      Effect.sync(() => {
        try {
          db.close();
        } catch {
          // Ignore close errors during scope teardown.
        }
      }),
  ).pipe(
    Effect.map(
      (db): AlertInboxStoreService => ({
        getObject: (objectKey) =>
          wrapDb("getObject", () =>
            db
              .query<ProcessedAlertRecord, [string]>(
                `SELECT ${SELECT_COLUMNS} FROM processed_alert WHERE object_key = ? LIMIT 1`,
              )
              .get(objectKey),
          ),

        findByDeliveryHash: (deliveryHash) =>
          wrapDb("findByDeliveryHash", () => {
            const row = db
              .query<
                { objectKey: string; status: "claiming" | "created"; issueNumber: number | null },
                [string]
              >(
                `SELECT object_key AS objectKey, status, issue_number AS issueNumber
                 FROM processed_alert
                 WHERE delivery_hash = ? AND status IN ('created', 'claiming')
                 ORDER BY CASE status WHEN 'created' THEN 0 ELSE 1 END
                 LIMIT 1`,
              )
              .get(deliveryHash);
            return row === null ? null : { ...row, matchedBy: "delivery_hash" as const };
          }),

        findByDedupKeyOrMessageId: (dedupKey, signedMessageId) =>
          wrapDb("findByDedupKeyOrMessageId", () => {
            const byDedup = db
              .query<
                { objectKey: string; status: "claiming" | "created"; issueNumber: number | null },
                [string]
              >(
                `SELECT object_key AS objectKey, status, issue_number AS issueNumber
                 FROM processed_alert
                 WHERE dedup_key = ? AND status IN ('created', 'claiming')
                 ORDER BY CASE status WHEN 'created' THEN 0 ELSE 1 END
                 LIMIT 1`,
              )
              .get(dedupKey);
            if (byDedup !== null) {
              return { ...byDedup, matchedBy: "dedup_key" as const };
            }
            if (signedMessageId !== undefined && signedMessageId.length > 0) {
              const byMsg = db
                .query<
                  { objectKey: string; status: "claiming" | "created"; issueNumber: number | null },
                  [string]
                >(
                  `SELECT object_key AS objectKey, status, issue_number AS issueNumber
                   FROM processed_alert
                   WHERE message_id = ? AND status IN ('created', 'claiming')
                   ORDER BY CASE status WHEN 'created' THEN 0 ELSE 1 END
                   LIMIT 1`,
                )
                .get(signedMessageId);
              if (byMsg !== null) {
                return { ...byMsg, matchedBy: "message_id" as const };
              }
            }
            return null;
          }),

        claimForCreation: (entry) =>
          wrapDb("claimForCreation", () => {
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, processed_at
              ) VALUES (?, ?, ?, ?, 'claiming', NULL, NULL, 1, NULL, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = excluded.dedup_key,
                message_id = excluded.message_id,
                status = 'claiming',
                reason = NULL,
                attempt_count = processed_alert.attempt_count + 1,
                next_retry_at = NULL,
                processed_at = excluded.processed_at
            `).run(
              entry.objectKey,
              entry.deliveryHash,
              entry.dedupKey,
              entry.messageId,
              entry.nowIso,
            );
          }),

        markCreated: (entry) =>
          wrapDb("markCreated", () => {
            db.query(`
              UPDATE processed_alert
              SET status = 'created',
                  issue_number = ?,
                  reason = NULL,
                  next_retry_at = NULL,
                  processed_at = ?
              WHERE object_key = ?
            `).run(entry.issueNumber, entry.nowIso, entry.objectKey);
          }),

        markDuplicate: (entry) =>
          wrapDb("markDuplicate", () => {
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, processed_at
              ) VALUES (?, ?, ?, ?, 'duplicate', ?, ?, 0, NULL, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = excluded.dedup_key,
                message_id = excluded.message_id,
                status = 'duplicate',
                issue_number = excluded.issue_number,
                reason = excluded.reason,
                next_retry_at = NULL,
                processed_at = excluded.processed_at
            `).run(
              entry.objectKey,
              entry.deliveryHash,
              entry.dedupKey,
              entry.messageId,
              entry.issueNumber,
              entry.reason,
              entry.nowIso,
            );
          }),

        markRejected: (entry) =>
          wrapDb("markRejected", () => {
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, processed_at
              ) VALUES (?, ?, NULL, NULL, 'rejected', NULL, ?, 0, NULL, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                status = 'rejected',
                reason = excluded.reason,
                next_retry_at = NULL,
                processed_at = excluded.processed_at
            `).run(entry.objectKey, entry.deliveryHash, entry.reason, entry.nowIso);
          }),

        markRetry: (entry) =>
          wrapDb("markRetry", () => {
            const nextStatus: AlertRecordStatus = entry.keepClaiming ? "claiming" : "retry";
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, processed_at
              ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = COALESCE(excluded.dedup_key, processed_alert.dedup_key),
                message_id = COALESCE(excluded.message_id, processed_alert.message_id),
                status = excluded.status,
                reason = excluded.reason,
                attempt_count = processed_alert.attempt_count + 1,
                next_retry_at = excluded.next_retry_at,
                processed_at = excluded.processed_at
            `).run(
              entry.objectKey,
              entry.deliveryHash,
              entry.dedupKey,
              entry.messageId,
              nextStatus,
              entry.reason,
              entry.nextRetryAt,
              entry.nowIso,
            );
          }),

        listAll: () =>
          wrapDb("listAll", () =>
            db
              .query<ProcessedAlertRecord, []>(
                `SELECT ${SELECT_COLUMNS} FROM processed_alert ORDER BY processed_at ASC, object_key ASC`,
              )
              .all(),
          ),
      }),
    ),
  );
