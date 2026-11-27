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
import { createdAt, decimal, id, instant, revision, updatedAt, workspaceIdColumn } from "./columns";
import { contacts, priceListItems } from "./contacts";
import { cadenceUnit, draftableKind, vatTreatment } from "./enums";
import { bankAccounts, numberingSeries, workspaces } from "./workspaces";

const isoDate = (name: string) => date(name, { mode: "string" });

/**
 * Invoice Templates (core-ports.md §4.8). `TemplateInput` = DocumentInput without the dates plus
 * a name and relative due. Every reference to another row (Contact, series, bank account, Price
 * List Item) is a column with a workspace-scoped foreign key; `body` keeps only the remaining
 * scalar document fields (currency, language, payment method, symbols, note, FX override).
 */
export const templates = pgTable(
  "templates",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: draftableKind("kind").notNull(),
    contactId: uuid("contact_id").notNull(),
    seriesId: uuid("series_id"),
    bankAccountId: uuid("bank_account_id"),
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
    foreignKey({
      name: "templates_series_fk",
      columns: [t.workspaceId, t.seriesId],
      foreignColumns: [numberingSeries.workspaceId, numberingSeries.id],
    }),
    foreignKey({
      name: "templates_bank_account_fk",
      columns: [t.workspaceId, t.bankAccountId],
      foreignColumns: [bankAccounts.workspaceId, bankAccounts.id],
    }),
  ],
);

/** Template lines, the `LineInput`s of a `TemplateInput` (core-ports.md:100-107, :958). */
export const templateLines = pgTable(
  "template_lines",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    templateId: uuid("template_id").notNull(),
    position: integer("position").notNull(),
    priceListItemId: uuid("price_list_item_id"),
    description: text("description"),
    quantity: decimal("quantity"),
    unit: text("unit"),
    unitPrice: decimal("unit_price"),
    vat: vatTreatment("vat"),
  },
  (t) => [
    unique("template_lines_template_position_unique").on(t.templateId, t.position),
    foreignKey({
      name: "template_lines_template_fk",
      columns: [t.workspaceId, t.templateId],
      foreignColumns: [templates.workspaceId, templates.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "template_lines_price_list_item_fk",
      columns: [t.workspaceId, t.priceListItemId],
      foreignColumns: [priceListItems.workspaceId, priceListItems.id],
    }),
  ],
);

/**
 * Recurring Schedules: at most one per Template (core-ports.md:939-954, §5.6). `every` is stored
 * as unit + interval. `next_occurrence` is advanced by compare-and-set (core-ports.md:1366).
 * Issuance advances and pauses the schedule under its own `revision` (core `ScheduleRow`); user
 * edits go through the Template, whose revision covers the schedule. Detaching sets
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
    /** The error that paused the schedule when no IssueCode names it, e.g. `NotFound:Contact`. */
    pausedError: text("paused_error"),
    /** Set by resume: occurrences on or before this date are issued however late (core-ports 4.8). */
    catchUpThrough: isoDate("catch_up_through"),
    detachedAt: instant("detached_at"),
    /**
     * Outbox stamp (core-ports.md J1, :1296): the occurrence whose RecurringIssuance workflow was
     * last started, and when. Reconcile restarts it under the same deterministic key.
     */
    startedOccurrence: isoDate("started_occurrence"),
    workflowStartedAt: instant("workflow_started_at"),
    revision: revision(),
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
    check(
      "schedules_workflow_start_complete",
      sql`(${t.startedOccurrence} is null) = (${t.workflowStartedAt} is null)`,
    ),
    check("schedules_interval_positive", sql`${t.cadenceInterval} > 0`),
    check(
      "schedules_pause_fields_need_paused_at",
      sql`${t.pausedAt} is not null or (${t.pausedReason} is null and ${t.pausedError} is null)`,
    ),
    check("schedules_end_after_start", sql`${t.endOn} is null or ${t.endOn} >= ${t.startOn}`),
  ],
);
