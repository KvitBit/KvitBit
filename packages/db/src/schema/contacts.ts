import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  currency,
  decimal,
  id,
  instant,
  revision,
  updatedAt,
  workspaceIdColumn,
} from "./columns";
import {
  contactRole,
  documentKind,
  locale,
  paymentMethod,
  reminderPolicyMode,
  vatTreatment,
} from "./enums";
import { numberingSeries, workspaces } from "./workspaces";

/**
 * Contacts with their per-Contact billing overrides, `ContactDefaults` (core-ports.md:600-622).
 * Each `default_*` column is null when the Contact does not override the Workspace default.
 * `reminder_policy_mode` + `reminder_offsets_days` encode `ReminderPolicy`.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    roles: contactRole("roles").array().notNull().default(sql`'{customer}'::contact_role[]`),
    name: text("name").notNull(),
    ico: text("ico"),
    dic: text("dic"),
    legalForm: text("legal_form"),
    street: text("street"),
    city: text("city"),
    postalCode: text("postal_code"),
    country: text("country").notNull().default("CZ"),
    billingEmails: text("billing_emails").array().notNull().default(sql`'{}'::text[]`),
    phone: text("phone"),
    note: text("note"),
    registryFetchedAt: instant("registry_fetched_at"),
    defaultCurrency: currency("default_currency"),
    defaultLanguage: locale("default_language"),
    defaultDueDays: integer("default_due_days"),
    defaultPaymentMethod: paymentMethod("default_payment_method"),
    defaultNote: text("default_note"),
    reminderPolicyMode: reminderPolicyMode("reminder_policy_mode").notNull().default("inherit"),
    reminderOffsetsDays: integer("reminder_offsets_days").array(),
    archivedAt: instant("archived_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contacts_workspace_id_id_unique").on(t.workspaceId, t.id),
    // IČO is unique per Workspace among active Contacts (core-ports.md:600).
    uniqueIndex("contacts_active_ico_unique")
      .on(t.workspaceId, t.ico)
      .where(sql`${t.archivedAt} is null and ${t.ico} is not null`),
    index("contacts_workspace_name_idx").on(t.workspaceId, t.name),
    check(
      "contacts_reminder_offsets_match_mode",
      sql`(${t.reminderPolicyMode} = 'custom') = (${t.reminderOffsetsDays} is not null)`,
    ),
    check("contacts_roles_nonempty", sql`cardinality(${t.roles}) > 0`),
    check("contacts_default_due_days_nonnegative", sql`${t.defaultDueDays} >= 0`),
  ],
);

/** `ContactDefaults.preferredSeriesByKind`: a partial map, one row per overridden kind. */
export const contactPreferredSeries = pgTable(
  "contact_preferred_series",
  {
    workspaceId: workspaceIdColumn(),
    contactId: uuid("contact_id").notNull(),
    kind: documentKind("kind").notNull(),
    seriesId: uuid("series_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.kind] }),
    foreignKey({
      name: "contact_preferred_series_contact_fk",
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contact_preferred_series_series_fk",
      columns: [t.workspaceId, t.seriesId],
      foreignColumns: [numberingSeries.workspaceId, numberingSeries.id],
    }),
  ],
);

/** Price List Items; values are copied onto Document lines at draft time (core-ports.md §4.3). */
export const priceListItems = pgTable(
  "price_list_items",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    unit: text("unit"),
    unitPrice: decimal("unit_price").notNull(),
    currency: currency("currency").notNull(),
    vat: vatTreatment("vat"),
    archivedAt: instant("archived_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("price_list_items_workspace_id_id_unique").on(t.workspaceId, t.id)],
);
