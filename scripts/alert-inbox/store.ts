/**
 * Scoped, typed-Effect SQLite store for processed and in-flight alert emails.
 *
 * Operational & concurrency invariants:
 * - All SQLite operations return `Effect.Effect<..., AlertStoreError>` and the connection
 *   lifecycle is managed with `Effect.acquireRelease` so corrupted files (`SQLITE_NOTADB`),
 *   wrong schemas, or I/O failures stay cleanly in the Effect error channel.
 * - Migrates legacy Round 1 databases in-place inside `BEGIN IMMEDIATE ... COMMIT`, preserving
 *   recorded `issue_number` / `delivery_hash` while clearing historical unverified `message_id`s.
 * - Acquires issue-creation claims atomically inside `BEGIN IMMEDIATE ... COMMIT` backed by a
 *   partial unique index on active `dedup_key` and an explicit lease (`claim_expires_at`), so
 *   overlapping passes cannot both post duplicate GitHub issues.
 * - Tracks fair-scheduling turn state in `alert_inbox_meta` so neither fresh arrivals nor overdue
 *   retries can starve even when `maxPerPass === 1`.
 */

import { Database } from "bun:sqlite";
import { Data, Effect, type Scope } from "effect";

export type AlertRecordStatus = "claiming" | "created" | "duplicate" | "rejected" | "retry";
export type SchedulerQueue = "fresh" | "retry";

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
  readonly claimExpiresAt: string | null;
  readonly processedAt: string;
}

export interface ExistingAlertMatch {
  readonly objectKey: string;
  readonly status: "claiming" | "created";
  readonly issueNumber: number | null;
  readonly matchedBy: "delivery_hash" | "dedup_key" | "message_id";
}

export type ClaimAcquisitionResult =
  | {
      readonly outcome: "acquired";
      readonly needsReconcile: boolean;
      readonly holderObjectKey: string | null;
    }
  | {
      readonly outcome: "already_created";
      readonly objectKey: string;
      readonly issueNumber: number | null;
    }
  | {
      readonly outcome: "in_flight";
      readonly holderObjectKey: string;
    };

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
  readonly tryClaimForCreation: (entry: {
    readonly objectKey: string;
    readonly deliveryHash: string;
    readonly dedupKey: string;
    readonly messageId: string | null;
    readonly nowIso: string;
    readonly leaseUntilIso: string;
  }) => Effect.Effect<ClaimAcquisitionResult, AlertStoreError>;
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
  readonly getLastScheduledQueue: () => Effect.Effect<SchedulerQueue | null, AlertStoreError>;
  readonly setLastScheduledQueue: (queue: SchedulerQueue) => Effect.Effect<void, AlertStoreError>;
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

const withImmediateTx = <A>(db: Database, thunk: () => A): A => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = thunk();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors if transaction was already closed.
    }
    throw error;
  }
};

const REQUIRED_COLUMNS = [
  "object_key",
  "delivery_hash",
  "dedup_key",
  "message_id",
  "status",
  "issue_number",
  "reason",
  "attempt_count",
  "next_retry_at",
  "claim_expires_at",
  "processed_at",
] as const;

const CREATE_PROCESSED_ALERT_TABLE_SQL = `
  CREATE TABLE processed_alert (
    object_key TEXT PRIMARY KEY,
    delivery_hash TEXT NOT NULL,
    dedup_key TEXT,
    message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('claiming', 'created', 'duplicate', 'rejected', 'retry')),
    issue_number INTEGER,
    reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    claim_expires_at TEXT,
    processed_at TEXT NOT NULL
  ) STRICT;
`;

const CREATE_INDEXES_AND_META_SQL = `
  CREATE INDEX IF NOT EXISTS idx_processed_alert_delivery_hash
    ON processed_alert (delivery_hash);
  CREATE INDEX IF NOT EXISTS idx_processed_alert_dedup_key
    ON processed_alert (dedup_key)
    WHERE dedup_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_alert_active_dedup
    ON processed_alert (dedup_key)
    WHERE dedup_key IS NOT NULL AND status IN ('claiming', 'created');
  CREATE INDEX IF NOT EXISTS idx_processed_alert_message_id
    ON processed_alert (message_id)
    WHERE message_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS alert_inbox_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
`;

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
  claim_expires_at AS claimExpiresAt,
  processed_at AS processedAt
`;

const hasCurrentSchema = (db: Database): boolean => {
  const tableRow = db
    .query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processed_alert' LIMIT 1",
    )
    .get();
  if (!tableRow || typeof tableRow.sql !== "string") return false;
  const cols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(processed_alert)")
      .all()
      .map((c) => c.name),
  );
  for (const required of REQUIRED_COLUMNS) {
    if (!cols.has(required)) return false;
  }
  return tableRow.sql.includes("'claiming'") && tableRow.sql.includes("'retry'");
};

const initializeOrMigrateSchema = (db: Database): void => {
  withImmediateTx(db, () => {
    const existing = db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'processed_alert' LIMIT 1",
      )
      .get();

    if (!existing) {
      db.exec(CREATE_PROCESSED_ALERT_TABLE_SQL);
      db.exec(CREATE_INDEXES_AND_META_SQL);
      return;
    }

    if (!hasCurrentSchema(db)) {
      const existingCols = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(processed_alert)")
          .all()
          .map((c) => c.name),
      );
      for (const legacyRequired of [
        "object_key",
        "delivery_hash",
        "status",
        "issue_number",
        "reason",
        "processed_at",
      ]) {
        if (!existingCols.has(legacyRequired)) {
          throw new Error(
            `Incompatible processed_alert table: missing required column '${legacyRequired}'`,
          );
        }
      }

      const hasDedupKey = existingCols.has("dedup_key");
      const hasAttemptCount = existingCols.has("attempt_count");
      const hasNextRetryAt = existingCols.has("next_retry_at");
      const hasClaimExpiresAt = existingCols.has("claim_expires_at");

      db.exec(`
        CREATE TABLE processed_alert_migrated (
          object_key TEXT PRIMARY KEY,
          delivery_hash TEXT NOT NULL,
          dedup_key TEXT,
          message_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('claiming', 'created', 'duplicate', 'rejected', 'retry')),
          issue_number INTEGER,
          reason TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at TEXT,
          claim_expires_at TEXT,
          processed_at TEXT NOT NULL
        ) STRICT;
      `);

      // When migrating from legacy Round 1 (no dedup_key column), historical message_id values
      // were stored from unverified headers — clear dedup_key & message_id while preserving
      // delivery_hash and recorded issue_number.
      db.exec(`
        INSERT INTO processed_alert_migrated (
          object_key, delivery_hash, dedup_key, message_id, status,
          issue_number, reason, attempt_count, next_retry_at, claim_expires_at, processed_at
        )
        SELECT
          object_key,
          delivery_hash,
          ${hasDedupKey ? "dedup_key" : "NULL"},
          ${hasDedupKey ? "message_id" : "NULL"},
          CASE
            WHEN status IN ('claiming', 'created', 'duplicate', 'rejected', 'retry') THEN status
            ELSE 'rejected'
          END,
          issue_number,
          reason,
          ${hasAttemptCount ? "COALESCE(attempt_count, 0)" : "0"},
          ${hasNextRetryAt ? "next_retry_at" : "NULL"},
          ${hasClaimExpiresAt ? "claim_expires_at" : "NULL"},
          processed_at
        FROM processed_alert;
      `);

      db.exec("DROP TABLE processed_alert;");
      db.exec("ALTER TABLE processed_alert_migrated RENAME TO processed_alert;");

      // Ensure legacy duplicate active dedup_keys (if any) cannot violate the new partial unique index.
      db.exec(`
        UPDATE processed_alert
        SET dedup_key = NULL
        WHERE dedup_key IS NOT NULL
          AND status IN ('claiming', 'created')
          AND rowid NOT IN (
            SELECT MIN(rowid)
            FROM processed_alert
            WHERE dedup_key IS NOT NULL AND status IN ('claiming', 'created')
            GROUP BY dedup_key
          );
      `);
    }

    db.exec(CREATE_INDEXES_AND_META_SQL);
  });
};

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
          initializeOrMigrateSchema(db);
        } else {
          // Validate required table & columns eagerly on readonly open so wrong schemas fail cleanly.
          if (!hasCurrentSchema(db)) {
            throw new Error(
              "SQLite state file does not contain a valid processed_alert schema (missing table or required columns)",
            );
          }
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

        tryClaimForCreation: (entry) =>
          wrapDb("tryClaimForCreation", () =>
            withImmediateTx(db, (): ClaimAcquisitionResult => {
              const activeRow = db
                .query<
                  {
                    objectKey: string;
                    status: "claiming" | "created";
                    issueNumber: number | null;
                    claimExpiresAt: string | null;
                  },
                  [string, string]
                >(
                  `SELECT
                     object_key AS objectKey,
                     status,
                     issue_number AS issueNumber,
                     claim_expires_at AS claimExpiresAt
                   FROM processed_alert
                   WHERE (dedup_key = ? OR object_key = ?)
                     AND status IN ('created', 'claiming')
                   ORDER BY CASE status WHEN 'created' THEN 0 ELSE 1 END
                   LIMIT 1`,
                )
                .get(entry.dedupKey, entry.objectKey);

              if (activeRow !== null) {
                if (activeRow.status === "created") {
                  return {
                    outcome: "already_created",
                    objectKey: activeRow.objectKey,
                    issueNumber: activeRow.issueNumber,
                  };
                }
                if (activeRow.claimExpiresAt !== null && activeRow.claimExpiresAt > entry.nowIso) {
                  return {
                    outcome: "in_flight",
                    holderObjectKey: activeRow.objectKey,
                  };
                }
                // Lease expired or prior attempt failed cleanly: take over the claim atomically
                // on the holder row so the partial unique index stays intact and only this caller reconciles.
                db.query(`
                  UPDATE processed_alert
                  SET dedup_key = COALESCE(dedup_key, ?),
                      message_id = COALESCE(message_id, ?),
                      status = 'claiming',
                      reason = NULL,
                      attempt_count = attempt_count + 1,
                      next_retry_at = NULL,
                      claim_expires_at = ?,
                      processed_at = ?
                  WHERE object_key = ?
                `).run(
                  entry.dedupKey,
                  entry.messageId,
                  entry.leaseUntilIso,
                  entry.nowIso,
                  activeRow.objectKey,
                );
                return {
                  outcome: "acquired",
                  needsReconcile: true,
                  holderObjectKey: activeRow.objectKey,
                };
              }

              db.query(`
                INSERT INTO processed_alert (
                  object_key, delivery_hash, dedup_key, message_id, status,
                  issue_number, reason, attempt_count, next_retry_at, claim_expires_at, processed_at
                ) VALUES (?, ?, ?, ?, 'claiming', NULL, NULL, 1, NULL, ?, ?)
                ON CONFLICT(object_key) DO UPDATE SET
                  dedup_key = excluded.dedup_key,
                  message_id = excluded.message_id,
                  status = 'claiming',
                  reason = NULL,
                  attempt_count = processed_alert.attempt_count + 1,
                  next_retry_at = NULL,
                  claim_expires_at = excluded.claim_expires_at,
                  processed_at = excluded.processed_at
              `).run(
                entry.objectKey,
                entry.deliveryHash,
                entry.dedupKey,
                entry.messageId,
                entry.leaseUntilIso,
                entry.nowIso,
              );
              return {
                outcome: "acquired",
                needsReconcile: false,
                holderObjectKey: entry.objectKey,
              };
            }),
          ),

        markCreated: (entry) =>
          wrapDb("markCreated", () => {
            db.query(`
              UPDATE processed_alert
              SET status = 'created',
                  issue_number = ?,
                  reason = NULL,
                  next_retry_at = NULL,
                  claim_expires_at = NULL,
                  processed_at = ?
              WHERE object_key = ?
            `).run(entry.issueNumber, entry.nowIso, entry.objectKey);
          }),

        markDuplicate: (entry) =>
          wrapDb("markDuplicate", () => {
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, claim_expires_at, processed_at
              ) VALUES (?, ?, ?, ?, 'duplicate', ?, ?, 0, NULL, NULL, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = excluded.dedup_key,
                message_id = excluded.message_id,
                status = 'duplicate',
                issue_number = excluded.issue_number,
                reason = excluded.reason,
                next_retry_at = NULL,
                claim_expires_at = NULL,
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
                issue_number, reason, attempt_count, next_retry_at, claim_expires_at, processed_at
              ) VALUES (?, ?, NULL, NULL, 'rejected', NULL, ?, 0, NULL, NULL, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = NULL,
                message_id = NULL,
                status = 'rejected',
                reason = excluded.reason,
                next_retry_at = NULL,
                claim_expires_at = NULL,
                processed_at = excluded.processed_at
            `).run(entry.objectKey, entry.deliveryHash, entry.reason, entry.nowIso);
          }),

        markRetry: (entry) =>
          wrapDb("markRetry", () => {
            const nextStatus: AlertRecordStatus = entry.keepClaiming ? "claiming" : "retry";
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, claim_expires_at, processed_at
              ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, NULL, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = COALESCE(excluded.dedup_key, processed_alert.dedup_key),
                message_id = COALESCE(excluded.message_id, processed_alert.message_id),
                status = excluded.status,
                reason = excluded.reason,
                attempt_count = processed_alert.attempt_count + 1,
                next_retry_at = excluded.next_retry_at,
                claim_expires_at = NULL,
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

        getLastScheduledQueue: () =>
          wrapDb("getLastScheduledQueue", () => {
            const metaExists = db
              .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alert_inbox_meta' LIMIT 1",
              )
              .get();
            if (!metaExists) return null;
            const row = db
              .query<{ value: string }, []>(
                "SELECT value FROM alert_inbox_meta WHERE key = 'last_scheduled_queue' LIMIT 1",
              )
              .get();
            if (row?.value === "fresh" || row?.value === "retry") {
              return row.value;
            }
            return null;
          }),

        setLastScheduledQueue: (queue) =>
          wrapDb("setLastScheduledQueue", () => {
            db.query(`
              INSERT INTO alert_inbox_meta (key, value) VALUES ('last_scheduled_queue', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `).run(queue);
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
