import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
  createdAt,
  currency,
  id,
  instant,
  revision,
  updatedAt,
  workspaceIdColumn,
} from "./columns";
import { documents } from "./documents";
import {
  documentKind,
  invitationRole,
  invitationStatus,
  locale,
  paymentMethod,
  paymentRounding,
  pdfTemplate,
  role,
  taxRegime,
  themeContrast,
  themeMode,
  themeStyle,
} from "./enums";

/**
 * A Workspace with its defaults, reminder schedule and branding (core-ports.md §4.1).
 * `theme_source` stores `ThemeSource` as sent; `logo`/`stamp` store `ImageRef` (core-ports.md:132).
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    defaultCurrency: currency("default_currency").notNull().default("CZK"),
    defaultLanguage: locale("default_language").notNull().default("cs"),
    defaultDueDays: integer("default_due_days").notNull().default(14),
    defaultNote: text("default_note"),
    defaultPaymentMethod: paymentMethod("default_payment_method")
      .notNull()
      .default("bank_transfer"),
    constantSymbol: text("constant_symbol"),
    paymentRounding: paymentRounding("payment_rounding").notNull().default("none"),
    autoSendPaymentTaxDocument: boolean("auto_send_payment_tax_document").notNull().default(false),
    /** Workspace reminder policy (core-ports.md D16; user-flows.md:702-714). */
    remindersEnabled: boolean("reminders_enabled").notNull().default(true),
    remindersForProformas: boolean("reminders_for_proformas").notNull().default(false),
    reminderOffsetsDays: integer("reminder_offsets_days")
      .array()
      .notNull()
      .default(sql`'{3,10,30}'::integer[]`),
    pdfTemplate: pdfTemplate("pdf_template").notNull().default("classic"),
    accentColor: text("accent_color"),
    footerText: text("footer_text"),
    themeSource: jsonb("theme_source"),
    logo: jsonb("logo"),
    stamp: jsonb("stamp"),
    closedAt: instant("closed_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workspaces_slug_unique").on(t.slug),
    check("workspaces_slug_format", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`),
    check("workspaces_default_currency_format", sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
    check("workspaces_accent_color_format", sql`${t.accentColor} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

/** Old slugs keep resolving for 90 days after a rename (core-ports.md:578). */
export const workspaceSlugAliases = pgTable(
  "workspace_slug_aliases",
  {
    slug: text("slug").primaryKey(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    expiresAt: instant("expires_at").notNull(),
  },
  (t) => [index("workspace_slug_aliases_workspace_id_idx").on(t.workspaceId)],
);

/** The one Issuing Entity per Workspace (core-ports.md:573). Revisioned with its Workspace. */
export const issuingEntities = pgTable("issuing_entities", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  legalName: text("legal_name").notNull(),
  legalForm: text("legal_form"),
  ico: text("ico"),
  dic: text("dic"),
  street: text("street"),
  city: text("city"),
  postalCode: text("postal_code"),
  country: text("country").notNull().default("CZ"),
  commercialRegister: text("commercial_register"),
  senderName: text("sender_name"),
  registryFetchedAt: instant("registry_fetched_at"),
});

/** Effective-dated Tax Regime history; earlier tax points keep the earlier regime (core-ports.md:555-557). */
export const taxRegimePeriods = pgTable(
  "tax_regime_periods",
  {
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    regime: taxRegime("regime").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.effectiveFrom] })],
);

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    role: role("role").notNull(),
    joinedAt: createdAt("joined_at"),
    /** Soft delete: set when the member was removed or left; cleared when the user rejoins. */
    removedAt: instant("removed_at"),
    revision: revision(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("memberships_user_id_idx").on(t.userId),
    // Exactly one owner per Workspace (core-ports.md:576); "at least one" is enforced by core.
    uniqueIndex("memberships_one_owner").on(t.workspaceId).where(sql`${t.role} = 'owner'`),
  ],
);

/**
 * Invitations are also the outbox intent for the invitation workflow (core-ports.md:1375-1381).
 * Only the SHA-256 hash of the token is stored (core-ports.md:65).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: invitationRole("role").notNull(),
    status: invitationStatus("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    sendEpoch: integer("send_epoch").notNull().default(0),
    expiresAt: instant("expires_at").notNull(),
    acceptedAt: instant("accepted_at"),
    revokedAt: instant("revoked_at"),
    workflowStartedAt: instant("workflow_started_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("invitations_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("invitations_token_hash_unique").on(t.tokenHash),
    uniqueIndex("invitations_pending_email_unique")
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label"),
    currency: currency("currency").notNull(),
    accountNumber: text("account_number"),
    bankCode: text("bank_code"),
    iban: text("iban"),
    bic: text("bic"),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: instant("archived_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("bank_accounts_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("bank_accounts_one_default_per_currency")
      .on(t.workspaceId, t.currency)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
    check(
      "bank_accounts_has_number",
      sql`${t.iban} is not null or (${t.accountNumber} is not null and ${t.bankCode} is not null)`,
    ),
  ],
);

/** Numbering Series configuration (core-ports.md §4.1, §5.2). */
export const numberingSeries = pgTable(
  "numbering_series",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: documentKind("kind").notNull(),
    name: text("name").notNull(),
    pattern: text("pattern").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: instant("archived_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("numbering_series_workspace_id_id_unique").on(t.workspaceId, t.id),
    // Exactly one default per DocumentKind (core-ports.md:558); "at least one" is enforced by core.
    uniqueIndex("numbering_series_one_default_per_kind")
      .on(t.workspaceId, t.kind)
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * Monotonic counter per series and period key (`YYYY`, `YYYY-MM` or `all`), locked and
 * incremented inside the issue transaction (core-ports.md S3, :1447).
 */
export const numberingCounters = pgTable(
  "numbering_counters",
  {
    workspaceId: workspaceIdColumn(),
    seriesId: uuid("series_id").notNull(),
    period: text("period").notNull(),
    nextCounter: integer("next_counter").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.period] }),
    foreignKey({
      name: "numbering_counters_series_fk",
      columns: [t.workspaceId, t.seriesId],
      foreignColumns: [numberingSeries.workspaceId, numberingSeries.id],
    }).onDelete("cascade"),
    check("numbering_counters_period_format", sql`${t.period} ~ '^([0-9]{4}(-[0-9]{2})?|all)$'`),
    check("numbering_counters_positive", sql`${t.nextCounter} >= 1`),
  ],
);

/**
 * Permanent, insert-only reservation of every allocated or overridden number, so a number is
 * never reused within a Workspace and kind (core-ports.md S3, :805-808).
 */
export const numberReservations = pgTable(
  "number_reservations",
  {
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: documentKind("kind").notNull(),
    number: text("number").notNull(),
    seriesId: uuid("series_id"),
    documentId: uuid("document_id"),
    reservedAt: createdAt("reserved_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.kind, t.number] }),
    foreignKey({
      name: "number_reservations_series_fk",
      columns: [t.workspaceId, t.seriesId],
      foreignColumns: [numberingSeries.workspaceId, numberingSeries.id],
    }),
    foreignKey({
      name: "number_reservations_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
  ],
);

/**
 * Account preferences, keyed by Better Auth user id with their own revision
 * (http-mcp-contracts.md T5, `ThemePreference` :655-661). `theme_source` null follows the
 * Workspace theme, then the `graphite_atelier` preset (T4). `locale` null falls back to the
 * request's `Accept-Language` (core-ports.md:1467-1469).
 */
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  locale: locale("locale"),
  themeMode: themeMode("theme_mode").notNull().default("system"),
  themeStyle: themeStyle("theme_style").notNull().default("elegant"),
  themeContrast: themeContrast("theme_contrast").notNull().default("standard"),
  dynamicColor: boolean("dynamic_color").notNull().default(true),
  themeSource: jsonb("theme_source"),
  revision: revision(),
  updatedAt: updatedAt(),
});
