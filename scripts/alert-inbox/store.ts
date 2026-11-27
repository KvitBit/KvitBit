/**
 * SQLite deduplication store for processed alert emails (`scripts/alert-inbox`).
 *
 * Mirrors `scripts/issue-pool/pool.ts`: strict SQLite tables, busy timeout,
 * read-only mode for dry runs, and deduplication by GCS object key,
 * delivery hash, and RFC 5322 Message-ID.
 */

import { Database } from "bun:sqlite";

export type AlertRecordStatus = "created" | "duplicate" | "rejected";

export interface ProcessedAlertRecord {
  readonly objectKey: string;
  readonly deliveryHash: string;
  readonly messageId: string | null;
  readonly status: AlertRecordStatus;
  readonly issueNumber: number | null;
  readonly reason: string | null;
  readonly processedAt: string;
}

export class AlertInboxStore {
  private readonly db: Database;

  constructor(path: string, readonly = false) {
    this.db = new Database(path, { readonly, create: !readonly, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (!readonly) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS processed_alert (
          object_key TEXT PRIMARY KEY,
          delivery_hash TEXT NOT NULL,
          message_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('created', 'duplicate', 'rejected')),
          issue_number INTEGER,
          reason TEXT,
          processed_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_processed_alert_delivery_hash
          ON processed_alert (delivery_hash);
        CREATE INDEX IF NOT EXISTS idx_processed_alert_message_id
          ON processed_alert (message_id)
          WHERE message_id IS NOT NULL;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  hasObjectKey(objectKey: string): boolean {
    const row = this.db
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM processed_alert WHERE object_key = ? LIMIT 1",
      )
      .get(objectKey);
    return row !== null;
  }

  findCreatedByHashOrMessageId(
    deliveryHash: string,
    messageId: string | undefined,
  ): {
    readonly issueNumber: number | null;
    readonly matchedBy: "delivery_hash" | "message_id";
  } | null {
    const byHash = this.db
      .query<{ issueNumber: number | null }, [string]>(
        "SELECT issue_number AS issueNumber FROM processed_alert WHERE delivery_hash = ? AND status = 'created' LIMIT 1",
      )
      .get(deliveryHash);
    if (byHash !== null) {
      return { issueNumber: byHash.issueNumber, matchedBy: "delivery_hash" };
    }
    if (messageId !== undefined && messageId.length > 0) {
      const byMsg = this.db
        .query<{ issueNumber: number | null }, [string]>(
          "SELECT issue_number AS issueNumber FROM processed_alert WHERE message_id = ? AND status = 'created' LIMIT 1",
        )
        .get(messageId);
      if (byMsg !== null) {
        return { issueNumber: byMsg.issueNumber, matchedBy: "message_id" };
      }
    }
    return null;
  }

  record(entry: ProcessedAlertRecord): void {
    this.db
      .query(`
        INSERT INTO processed_alert (
          object_key, delivery_hash, message_id, status, issue_number, reason, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_key) DO NOTHING
      `)
      .run(
        entry.objectKey,
        entry.deliveryHash,
        entry.messageId,
        entry.status,
        entry.issueNumber,
        entry.reason,
        entry.processedAt,
      );
  }

  listAll(): ReadonlyArray<ProcessedAlertRecord> {
    return this.db
      .query<ProcessedAlertRecord, []>(`
        SELECT
          object_key AS objectKey,
          delivery_hash AS deliveryHash,
          message_id AS messageId,
          status,
          issue_number AS issueNumber,
          reason,
          processed_at AS processedAt
        FROM processed_alert
        ORDER BY processed_at ASC, object_key ASC
      `)
      .all();
  }
}
