import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, revision, workspaceIdColumn } from "./columns";
import { deliveries, documents } from "./documents";
import { recurringOutcome, recurringSendState } from "./enums";
import { schedules } from "./recurring";

/** One row per processed occurrence; `Templates.runs` reads it (core-ports.md:953, :962-968). */
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    scheduleId: uuid("schedule_id").notNull(),
    occurrence: date("occurrence", { mode: "string" }).notNull(),
    outcome: recurringOutcome("outcome").notNull(),
    at: createdAt("at"),
    documentId: uuid("document_id"),
    deliveryId: uuid("delivery_id"),
    /**
     * The send half of an issued run. `pending` (autoSend was on, delivery not queued yet) is not
     * derivable from `delivery_id` and `failure`, so it is stored.
     */
    sendState: recurringSendState("send_state").notNull().default("none"),
    failure: text("failure"),
    revision: revision(),
  },
  (t) => [
    unique("schedule_runs_schedule_occurrence_unique").on(t.scheduleId, t.occurrence),
    // RecurringIssuance recovery (`pendingSendRuns`): issued runs whose send is not queued yet.
    index("schedule_runs_pending_send_idx")
      .on(t.at)
      .where(sql`${t.outcome} = 'issued' and ${t.sendState} = 'pending'`),
    check(
      "schedule_runs_send_needs_issued",
      sql`${t.sendState} = 'none' or ${t.outcome} = 'issued'`,
    ),
    check(
      "schedule_runs_queued_has_delivery",
      sql`${t.sendState} <> 'queued' or ${t.deliveryId} is not null`,
    ),
    foreignKey({
      name: "schedule_runs_schedule_fk",
      columns: [t.workspaceId, t.scheduleId],
      foreignColumns: [schedules.workspaceId, schedules.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_runs_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
    foreignKey({
      name: "schedule_runs_delivery_fk",
      columns: [t.workspaceId, t.deliveryId],
      foreignColumns: [deliveries.workspaceId, deliveries.id],
    }),
  ],
);
