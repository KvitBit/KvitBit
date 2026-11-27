/**
 * Scoped, typed-Effect SQLite store for processed and in-flight alert emails.
 *
 * Operational & concurrency invariants:
 * - All SQLite operations return `Effect.Effect<..., AlertStoreError>` and the connection
 *   lifecycle is managed with `Effect.acquireRelease` so corrupted files (`SQLITE_NOTADB`),
 *   wrong schemas, or I/O failures stay cleanly in the Effect error channel.
 * - Migrates legacy databases in-place inside `BEGIN IMMEDIATE ... COMMIT`, preserving recorded
 *   `issue_number` / `delivery_hash` while clearing historical unverified `message_id`s.
 * - Enforces exclusive apply ownership across all callers (same-process, cross-process, and
 *   symlink/hardlink path aliases) using kernel `flock(2)` directly on the backing database inode,
 *   so the OS atomically releases ownership on process exit / SIGKILL with zero lockfiles or
 *   stale-PID cleanup races.
 * - Pairs atomic SQLite claim acquisition (`BEGIN IMMEDIATE` + partial unique index on active
 *   `dedup_key`) with a monotonic `claim_generation` fencing token verified/renewed immediately
 *   before GitHub POST and checked on every state transition, while making terminal `'created'`
 *   rows immutable so a delayed or stale pass can never overwrite or downgrade a created issue.
 * - Tracks fair-scheduling turn state in `alert_inbox_meta` so neither fresh arrivals nor overdue
 *   retries can starve even when `maxPerPass === 1`.
 */

import { dlopen, FFIType, read } from "bun:ffi";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
  readonly claimGeneration: number;
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
      readonly holderObjectKey: string;
      readonly claimGeneration: number;
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
  readonly withExclusiveApplyLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    { readonly acquired: true; readonly value: A } | { readonly acquired: false },
    E | AlertStoreError,
    R
  >;
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
  readonly verifyAndRenewClaim: (entry: {
    readonly objectKey: string;
    readonly claimGeneration: number;
    readonly nowIso: string;
    readonly leaseUntilIso: string;
  }) => Effect.Effect<boolean, AlertStoreError>;
  readonly markCreated: (entry: {
    readonly objectKey: string;
    readonly claimGeneration: number;
    readonly issueNumber: number;
    readonly nowIso: string;
  }) => Effect.Effect<boolean, AlertStoreError>;
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
    readonly expectedClaimGeneration?: number;
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

// Kernel `flock(2)` binding (POSIX Linux & macOS). `flock(2)` locks are owned by the kernel on
// the backing inode / open file description, automatically released on process exit or SIGKILL,
// completely independent of SQLite's POSIX `fcntl(F_SETLK)` byte-range locks on Linux, and
// immune to symlinks, hardlinks, stale PID files, and unlink races.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

interface NativeFlock {
  readonly flock: (fd: number, operation: number) => number;
  readonly getErrno: () => number;
}

let cachedNativeFlock: NativeFlock | null = null;

const loadNativeFlock = (): NativeFlock => {
  if (cachedNativeFlock !== null) return cachedNativeFlock;
  if (process.platform === "darwin") {
    const lib = dlopen("libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    cachedNativeFlock = {
      flock: (fd, op) => lib.symbols.flock(fd, op),
      getErrno: () => {
        const ptr = lib.symbols.__error();
        return ptr ? read.i32(ptr, 0) : -1;
      },
    };
  } else {
    const lib = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    cachedNativeFlock = {
      flock: (fd, op) => lib.symbols.flock(fd, op),
      getErrno: () => {
        const ptr = lib.symbols.__errno_location();
        return ptr ? read.i32(ptr, 0) : -1;
      },
    };
  }
  return cachedNativeFlock;
};

// In-process registry keyed by `inode:<dev>:<ino>` (or `memory:<uuid>` for `:memory:`) so
// concurrent same-process passes and `:memory:` tests also serialize cleanly.
const activeInProcessApplyLocks = new Set<string>();

interface AcquiredApplyLock {
  readonly lockKey: string;
  readonly fd: number | null;
}

const tryAcquireLockHandle = (
  memoryLockKey: string | null,
  canonicalDbPath: string | null,
): AcquiredApplyLock | null => {
  if (canonicalDbPath === null) {
    const lockKey = memoryLockKey ?? "memory:default";
    if (activeInProcessApplyLocks.has(lockKey)) return null;
    activeInProcessApplyLocks.add(lockKey);
    return { lockKey, fd: null };
  }

  const native = loadNativeFlock();
  const fd = openSync(canonicalDbPath, fsConstants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (st.nlink > 1) {
      throw new Error(
        `Refusing to lock multiply hard-linked SQLite state file (${canonicalDbPath}, nlink=${st.nlink})`,
      );
    }
    const lockKey = `inode:${st.dev}:${st.ino}`;
    if (activeInProcessApplyLocks.has(lockKey)) {
      closeSync(fd);
      return null;
    }

    while (true) {
      const rc = native.flock(fd, LOCK_EX | LOCK_NB);
      if (rc === 0) {
        activeInProcessApplyLocks.add(lockKey);
        return { lockKey, fd };
      }
      const err = native.getErrno();
      if (err === EINTR) continue;
      if (err === EWOULDBLOCK) {
        closeSync(fd);
        return null;
      }
      throw new Error(`flock(${canonicalDbPath}) failed with errno ${err}`);
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Ignore close errors while unwinding.
    }
    throw error;
  }
};

const releaseLockHandle = (handle: AcquiredApplyLock): void => {
  try {
    if (handle.fd !== null) {
      try {
        loadNativeFlock().flock(handle.fd, LOCK_UN);
      } catch {
        // Closing the fd also releases the kernel lock.
      }
      try {
        closeSync(handle.fd);
      } catch {
        // Ignore close errors during teardown.
      }
    }
  } finally {
    activeInProcessApplyLocks.delete(handle.lockKey);
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
  "claim_generation",
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
    claim_generation INTEGER NOT NULL DEFAULT 0,
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
  claim_generation AS claimGeneration,
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
      const hasClaimGeneration = existingCols.has("claim_generation");

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
          claim_generation INTEGER NOT NULL DEFAULT 0,
          processed_at TEXT NOT NULL
        ) STRICT;
      `);

      // When migrating from legacy Round 1 (no dedup_key column), historical message_id values
      // were stored from unverified headers — clear dedup_key & message_id while preserving
      // delivery_hash and recorded issue_number.
      db.exec(`
        INSERT INTO processed_alert_migrated (
          object_key, delivery_hash, dedup_key, message_id, status,
          issue_number, reason, attempt_count, next_retry_at, claim_expires_at,
          claim_generation, processed_at
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
          ${hasClaimGeneration ? "COALESCE(claim_generation, 0)" : "0"},
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

const resolveAndValidateDbPath = (path: string, readonly: boolean): string | null => {
  if (path === ":memory:") return null;
  let canonicalPath: string;
  if (existsSync(path)) {
    canonicalPath = realpathSync(path);
    const st = statSync(canonicalPath);
    if (st.nlink > 1) {
      throw new Error(
        `Refusing to open multiply hard-linked SQLite state file (${canonicalPath}, nlink=${st.nlink}): hard links break SQLite journal/WAL discovery`,
      );
    }
  } else {
    if (readonly) {
      throw new Error(`SQLite state file does not exist: ${path}`);
    }
    canonicalPath = join(realpathSync(dirname(path)), basename(path));
  }
  return canonicalPath;
};

export const openAlertInboxStore = (
  path: string,
  readonly = false,
): Effect.Effect<AlertInboxStoreService, AlertStoreError, Scope.Scope> =>
  Effect.acquireRelease(
    wrapDb("open", () => {
      const canonicalDbPath = resolveAndValidateDbPath(path, readonly);
      const openTarget = canonicalDbPath ?? ":memory:";
      const db = new Database(openTarget, { readonly, create: !readonly, strict: true });
      try {
        if (canonicalDbPath !== null) {
          const st = statSync(canonicalDbPath);
          if (st.nlink > 1) {
            throw new Error(
              `Refusing to open multiply hard-linked SQLite state file (${canonicalDbPath}, nlink=${st.nlink}): hard links break SQLite journal/WAL discovery`,
            );
          }
        }
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
        const memoryLockKey = canonicalDbPath === null ? `memory:${randomUUID()}` : null;
        return { db, memoryLockKey, canonicalDbPath };
      } catch (error) {
        db.close();
        throw error;
      }
    }),
    ({ db }) =>
      Effect.sync(() => {
        try {
          db.close();
        } catch {
          // Ignore close errors during scope teardown.
        }
      }),
  ).pipe(
    Effect.map(
      ({ db, memoryLockKey, canonicalDbPath }): AlertInboxStoreService => ({
        withExclusiveApplyLock: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* Effect.acquireRelease(
                wrapDb("acquireApplyLock", () =>
                  tryAcquireLockHandle(memoryLockKey, canonicalDbPath),
                ),
                (acquired) =>
                  Effect.sync(() => {
                    if (acquired !== null) {
                      releaseLockHandle(acquired);
                    }
                  }),
              );
              if (handle === null) {
                return { acquired: false as const };
              }
              const value = yield* effect;
              return { acquired: true as const, value };
            }),
          ),

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
                    claimGeneration: number;
                  },
                  [string, string]
                >(
                  `SELECT
                     object_key AS objectKey,
                     status,
                     issue_number AS issueNumber,
                     claim_expires_at AS claimExpiresAt,
                     claim_generation AS claimGeneration
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
                const nextGen = activeRow.claimGeneration + 1;
                db.query(`
                  UPDATE processed_alert
                  SET dedup_key = COALESCE(dedup_key, ?),
                      message_id = COALESCE(message_id, ?),
                      status = 'claiming',
                      reason = NULL,
                      attempt_count = attempt_count + 1,
                      next_retry_at = NULL,
                      claim_expires_at = ?,
                      claim_generation = ?,
                      processed_at = ?
                  WHERE object_key = ? AND status = 'claiming'
                `).run(
                  entry.dedupKey,
                  entry.messageId,
                  entry.leaseUntilIso,
                  nextGen,
                  entry.nowIso,
                  activeRow.objectKey,
                );
                return {
                  outcome: "acquired",
                  needsReconcile: true,
                  holderObjectKey: activeRow.objectKey,
                  claimGeneration: nextGen,
                };
              }

              const priorRow = db
                .query<{ claimGeneration: number }, [string]>(
                  "SELECT claim_generation AS claimGeneration FROM processed_alert WHERE object_key = ? LIMIT 1",
                )
                .get(entry.objectKey);
              const nextGen = (priorRow?.claimGeneration ?? 0) + 1;

              db.query(`
                INSERT INTO processed_alert (
                  object_key, delivery_hash, dedup_key, message_id, status,
                  issue_number, reason, attempt_count, next_retry_at, claim_expires_at,
                  claim_generation, processed_at
                ) VALUES (?, ?, ?, ?, 'claiming', NULL, NULL, 1, NULL, ?, ?, ?)
                ON CONFLICT(object_key) DO UPDATE SET
                  dedup_key = excluded.dedup_key,
                  message_id = excluded.message_id,
                  status = 'claiming',
                  reason = NULL,
                  attempt_count = processed_alert.attempt_count + 1,
                  next_retry_at = NULL,
                  claim_expires_at = excluded.claim_expires_at,
                  claim_generation = excluded.claim_generation,
                  processed_at = excluded.processed_at
                WHERE processed_alert.status <> 'created'
              `).run(
                entry.objectKey,
                entry.deliveryHash,
                entry.dedupKey,
                entry.messageId,
                entry.leaseUntilIso,
                nextGen,
                entry.nowIso,
              );
              return {
                outcome: "acquired",
                needsReconcile: false,
                holderObjectKey: entry.objectKey,
                claimGeneration: nextGen,
              };
            }),
          ),

        verifyAndRenewClaim: (entry) =>
          wrapDb("verifyAndRenewClaim", () =>
            withImmediateTx(db, () => {
              // Fencing check: ownership holds iff the row is still `claiming` at our exact
              // `claim_generation` (no other caller took over or completed it).
              const res = db
                .query(`
                  UPDATE processed_alert
                  SET claim_expires_at = ?,
                      processed_at = ?
                  WHERE object_key = ?
                    AND status = 'claiming'
                    AND claim_generation = ?
                `)
                .run(entry.leaseUntilIso, entry.nowIso, entry.objectKey, entry.claimGeneration);
              return res.changes === 1;
            }),
          ),

        markCreated: (entry) =>
          wrapDb("markCreated", () => {
            const res = db
              .query(`
                UPDATE processed_alert
                SET status = 'created',
                    issue_number = ?,
                    reason = NULL,
                    next_retry_at = NULL,
                    claim_expires_at = NULL,
                    processed_at = ?
                WHERE object_key = ?
                  AND status = 'claiming'
                  AND claim_generation = ?
              `)
              .run(entry.issueNumber, entry.nowIso, entry.objectKey, entry.claimGeneration);
            return res.changes === 1;
          }),

        markDuplicate: (entry) =>
          wrapDb("markDuplicate", () => {
            // Never overwrite or downgrade an already-created row.
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, claim_expires_at,
                claim_generation, processed_at
              ) VALUES (?, ?, ?, ?, 'duplicate', ?, ?, 0, NULL, NULL, 0, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = excluded.dedup_key,
                message_id = excluded.message_id,
                status = 'duplicate',
                issue_number = excluded.issue_number,
                reason = excluded.reason,
                next_retry_at = NULL,
                claim_expires_at = NULL,
                processed_at = excluded.processed_at
              WHERE processed_alert.status <> 'created'
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
            // Never overwrite or downgrade an already-created row.
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, claim_expires_at,
                claim_generation, processed_at
              ) VALUES (?, ?, NULL, NULL, 'rejected', NULL, ?, 0, NULL, NULL, 0, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = NULL,
                message_id = NULL,
                status = 'rejected',
                reason = excluded.reason,
                next_retry_at = NULL,
                claim_expires_at = NULL,
                processed_at = excluded.processed_at
              WHERE processed_alert.status <> 'created'
            `).run(entry.objectKey, entry.deliveryHash, entry.reason, entry.nowIso);
          }),

        markRetry: (entry) =>
          wrapDb("markRetry", () => {
            const nextStatus: AlertRecordStatus = entry.keepClaiming ? "claiming" : "retry";
            if (entry.expectedClaimGeneration !== undefined) {
              db.query(`
                UPDATE processed_alert
                SET dedup_key = COALESCE(?, dedup_key),
                    message_id = COALESCE(?, message_id),
                    status = ?,
                    reason = ?,
                    attempt_count = attempt_count + 1,
                    next_retry_at = ?,
                    claim_expires_at = NULL,
                    processed_at = ?
                WHERE object_key = ?
                  AND status = 'claiming'
                  AND claim_generation = ?
              `).run(
                entry.dedupKey,
                entry.messageId,
                nextStatus,
                entry.reason,
                entry.nextRetryAt,
                entry.nowIso,
                entry.objectKey,
                entry.expectedClaimGeneration,
              );
              return;
            }
            db.query(`
              INSERT INTO processed_alert (
                object_key, delivery_hash, dedup_key, message_id, status,
                issue_number, reason, attempt_count, next_retry_at, claim_expires_at,
                claim_generation, processed_at
              ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, NULL, 0, ?)
              ON CONFLICT(object_key) DO UPDATE SET
                dedup_key = COALESCE(excluded.dedup_key, processed_alert.dedup_key),
                message_id = COALESCE(excluded.message_id, processed_alert.message_id),
                status = excluded.status,
                reason = excluded.reason,
                attempt_count = processed_alert.attempt_count + 1,
                next_retry_at = excluded.next_retry_at,
                claim_expires_at = NULL,
                processed_at = excluded.processed_at
              WHERE processed_alert.status <> 'created'
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
