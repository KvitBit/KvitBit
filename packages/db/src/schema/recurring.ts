import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, instant, revision, updatedAt, workspaceIdColumn } from "./columns";
import { contacts } from "./contacts";
import { deliveries, documents } from "./documents";
import { cadenceUnit, draftableKind, recurringOutcome } from "./enums";
import { workspaces } from "./workspaces";

const isoDate = (name: string) => date(name, { mode: "string" });

/**
 * Invoice Templates (core-ports.md §4.8). `TemplateInput` = DocumentInput without the dates plus
 * a name and relative due; the remaining document fields are kept in `body`.
 */
export const templates = pgTable(
  "templates",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: draftableKind("kind").notNull(),
    contactId: uuid("contact_id").notNull(),
    dueInDays: integer("due_in_days"),
    body: jsonb("body").notNull(),
    archivedAt: instant("archived_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("templates_workspace_id_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      name: "templates_contact_fk",
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }),
  ],
);

/**
 * Recurring Schedules: at most one per Template (core-ports.md:939-954, §5.6). `every` is stored
 * as unit + interval. `next_occurrence` is advanced by compare-and-set (core-ports.md:1366).
 * Changes are made through the Template, whose revision covers the schedule. Detaching sets
 * `detached_at` instead of deleting, so issued documents and run history keep their schedule.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    templateId: uuid("template_id").notNull(),
    cadenceUnit: cadenceUnit("cadence_unit").notNull(),
    cadenceInterval: integer("cadence_interval").notNull(),
    startOn: isoDate("start_on").notNull(),
    endOn: isoDate("end_on"),
    issueAs: draftableKind("issue_as").notNull(),
    autoSend: boolean("auto_send").notNull().default(false),
    nextOccurrence: isoDate("next_occurrence"),
    pausedReason: text("paused_reason"),
    pausedAt: instant("paused_at"),
    detachedAt: instant("detached_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("schedules_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("schedules_one_attached_per_template")
      .on(t.templateId)
      .where(sql`${t.detachedAt} is null`),
    foreignKey({
      name: "schedules_template_fk",
      columns: [t.workspaceId, t.templateId],
      foreignColumns: [templates.workspaceId, templates.id],
    }).onDelete("cascade"),
    check("schedules_interval_positive", sql`${t.cadenceInterval} > 0`),
    check("schedules_end_after_start", sql`${t.endOn} is null or ${t.endOn} >= ${t.startOn}`),
  ],
);

/** One row per processed occurrence; `Templates.runs` reads it (core-ports.md:953, :962-968). */
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    scheduleId: uuid("schedule_id").notNull(),
    occurrence: isoDate("occurrence").notNull(),
    outcome: recurringOutcome("outcome").notNull(),
    at: createdAt("at"),
    documentId: uuid("document_id"),
    deliveryId: uuid("delivery_id"),
    failure: text("failure"),
  },
  (t) => [
    unique("schedule_runs_schedule_occurrence_unique").on(t.scheduleId, t.occurrence),
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
