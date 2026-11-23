import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, instant, workspaceIdColumn } from "./columns";
import { botScope, channel, clientKind, entityKind, exportStatus, systemJob } from "./enums";
import { workspaces } from "./workspaces";

/**
 * Append-only audit log (core-ports.md §4.10), written in the same transaction as the change.
 * The runtime role gets INSERT and SELECT only. `actor_kind` 'member' carries the user id and
 * channel; 'system' carries the job tag.
 */
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    at: createdAt("at"),
    actorUserId: text("actor_user_id"),
    actorChannel: channel("actor_channel"),
    actorClientKind: clientKind("actor_client_kind"),
    actorClientId: text("actor_client_id"),
    actorClientName: text("actor_client_name"),
    actorSystemJob: systemJob("actor_system_job"),
    /** The System job's identifiers, e.g. `{ scheduleId, occurrence }` (core-ports.md:222-226). */
    actorJob: jsonb("actor_job"),
    subjectEntity: entityKind("subject_entity").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectRevision: integer("subject_revision"),
    action: text("action").notNull(),
    changes: jsonb("changes").notNull().default(sql`'[]'::jsonb`),
    reason: text("reason"),
  },
  (t) => [
    index("audit_entries_subject_idx").on(t.workspaceId, t.subjectEntity, t.subjectId, t.at),
    index("audit_entries_workspace_at_idx").on(t.workspaceId, t.at),
    check(
      "audit_entries_one_actor",
      sql`(${t.actorUserId} is not null and ${t.actorChannel} is not null and ${t.actorSystemJob} is null) or (${t.actorUserId} is null and ${t.actorChannel} is null and ${t.actorSystemJob} is not null)`,
    ),
    check(
      "audit_entries_job_with_system_actor",
      sql`(${t.actorSystemJob} is null) = (${t.actorJob} is null)`,
    ),
    check(
      "audit_entries_client_complete",
      sql`(${t.actorClientKind} is null) = (${t.actorClientId} is null) and (${t.actorClientKind} is null) = (${t.actorClientName} is null)`,
    ),
  ],
);

/**
 * Idempotency log (core-ports.md C3, :121-123): one row per (Workspace or user, requestKey),
 * kept 24 hours. A replay with the same method and payload hash returns `result`.
 */
export const requestLog = pgTable(
  "request_log",
  {
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    requestKey: text("request_key").notNull(),
    method: text("method").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("request_log_workspace_key_unique")
      .on(t.workspaceId, t.requestKey)
      .where(sql`${t.workspaceId} is not null`),
    uniqueIndex("request_log_user_key_unique")
      .on(t.userId, t.requestKey)
      .where(sql`${t.workspaceId} is null`),
    index("request_log_created_at_idx").on(t.createdAt),
    check("request_log_one_scope", sql`num_nonnulls(${t.workspaceId}, ${t.userId}) >= 1`),
  ],
);

/**
 * ALTCHA single-use replay store (ADR 0002, core-ports.md:1262-1275). Consuming a solution is an
 * `INSERT ... ON CONFLICT DO NOTHING` on the challenge digest; zero rows inserted means replay.
 * Rows past `expires_at` are purged by Housekeeping.
 */
export const altchaReplays = pgTable(
  "altcha_replays",
  {
    challengeDigest: text("challenge_digest").primaryKey(),
    scope: botScope("scope").notNull(),
    expiresAt: instant("expires_at").notNull(),
    consumedAt: createdAt("consumed_at"),
  },
  (t) => [index("altcha_replays_expires_at_idx").on(t.expiresAt)],
);

/** Data exports (core-ports.md:1014-1031); one running per Workspace, deleted 7 days after ready. */
export const exports = pgTable(
  "exports",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    status: exportStatus("status").notNull().default("running"),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    blobKey: text("blob_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    failure: text("failure"),
    workflowStartedAt: instant("workflow_started_at"),
    readyAt: instant("ready_at"),
    expiresAt: instant("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("exports_one_running_per_workspace")
      .on(t.workspaceId)
      .where(sql`${t.status} = 'running'`),
    index("exports_expires_at_idx").on(t.expiresAt),
  ],
);

/** CNB fixing cache (core-ports.md:1219-1231). `rates` is `[{ code, quantity, rate }]`. */
export const fxFixings = pgTable("fx_fixings", {
  fixingDate: date("fixing_date", { mode: "string" }).primaryKey(),
  sequence: integer("sequence").notNull(),
  rates: jsonb("rates").notNull(),
  fetchedAt: instant("fetched_at").notNull().defaultNow(),
});
