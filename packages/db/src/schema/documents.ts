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
  decimal,
  id,
  instant,
  money,
  revision,
  updatedAt,
  workspaceIdColumn,
} from "./columns";
import { contacts, priceListItems } from "./contacts";
import {
  deliveryPurpose,
  deliveryStatus,
  documentKind,
  documentRelation,
  documentSettlement,
  documentStatus,
  fxSource,
  locale,
  paymentMethod,
  paymentRounding,
  remindersChoice,
  shareDevice,
  shareEventKind,
  vatTreatment,
} from "./enums";
import { expenses } from "./expenses";
import { schedules } from "./recurring";
import { bankAccounts, numberingSeries, workspaces } from "./workspaces";

const isoDate = (name: string) => date(name, { mode: "string" });

/**
 * The Document aggregate (core-ports.md §4.4). Drafts have no number; issuing allocates one and
 * freezes the Contact and Issuer snapshots. `vat_breakdown` and the totals hold the VatMath
 * result computed at issue (core-ports.md §5.1). Reminder state per rule D16 / §7.2.
 */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    kind: documentKind("kind").notNull(),
    status: documentStatus("status").notNull().default("draft"),
    number: text("number"),
    seriesId: uuid("series_id"),
    contactId: uuid("contact_id").notNull(),
    bankAccountId: uuid("bank_account_id"),
    currency: currency("currency").notNull(),
    language: locale("language").notNull(),
    issuedOn: isoDate("issued_on"),
    taxableSupplyOn: isoDate("taxable_supply_on"),
    dueOn: isoDate("due_on"),
    dueInDays: integer("due_in_days"),
    paymentMethod: paymentMethod("payment_method").notNull(),
    pricesIncludeVat: boolean("prices_include_vat").notNull().default(false),
    variableSymbol: text("variable_symbol"),
    orderNumber: text("order_number"),
    note: text("note"),
    fxRate: decimal("fx_rate"),
    fxQuantity: integer("fx_quantity"),
    fxFixingDate: isoDate("fx_fixing_date"),
    fxSource: fxSource("fx_source"),
    /** Manual FX override as given (decision Q4); survives tax-point edits (D11). */
    fxOverride: jsonb("fx_override"),
    /** Caller-given fields for draft recomputation (`GivenFields`). */
    given: jsonb("given").notNull().default(sql`'{}'::jsonb`),
    contactSnapshot: jsonb("contact_snapshot"),
    issuerSnapshot: jsonb("issuer_snapshot"),
    vatBreakdown: jsonb("vat_breakdown"),
    totalNet: money("total_net"),
    totalVat: money("total_vat"),
    totalGross: money("total_gross"),
    taxDocument: boolean("tax_document").notNull().default(false),
    paymentRounding: paymentRounding("payment_rounding").notNull().default("none"),
    /** Sum of live Payments in `currency` and their count (overpayment allowed). */
    paidAmount: decimal("paid_amount").notNull().default("0"),
    payments: integer("payments").notNull().default(0),
    settlement: documentSettlement("settlement").notNull().default("unpaid"),
    locked: boolean("locked").notNull().default(false),
    lockedAt: instant("locked_at"),
    remindersChoice: remindersChoice("reminders_choice").notNull().default("inherit"),
    remindersOn: boolean("reminders_on").notNull().default(false),
    reminderEpoch: integer("reminder_epoch").notNull().default(0),
    /**
     * Offsets resolved when `reminder_epoch` was armed, so recovery rebuilds the original
     * `PaymentReminders` payload after later Contact or Workspace edits (core-ports.md:1333-1350).
     */
    reminderOffsetsDays: integer("reminder_offsets_days").array(),
    scheduleId: uuid("schedule_id"),
    occurrence: isoDate("occurrence"),
    /** Credit Note's corrected document number as it was at correction time (rule D7). */
    correctedNumber: text("corrected_number"),
    /** Credit Note reason (core-ports.md D7). */
    correctionReason: text("correction_reason"),
    /** Cancellation reason (core-ports.md:725). */
    cancellationReason: text("cancellation_reason"),
    issuedAt: instant("issued_at"),
    cancelledOn: isoDate("cancelled_on"),
    cancelledAt: instant("cancelled_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("documents_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("documents_number_unique")
      .on(t.workspaceId, t.kind, t.number)
      .where(sql`${t.number} is not null`),
    // One document per schedule occurrence (core-ports.md:1360-1366).
    uniqueIndex("documents_schedule_occurrence_unique")
      .on(t.scheduleId, t.occurrence)
      .where(sql`${t.scheduleId} is not null`),
    index("documents_workspace_status_idx").on(t.workspaceId, t.status, t.issuedOn),
    index("documents_workspace_contact_idx").on(t.workspaceId, t.contactId),
    foreignKey({
      name: "documents_contact_fk",
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }),
    foreignKey({
      name: "documents_series_fk",
      columns: [t.workspaceId, t.seriesId],
      foreignColumns: [numberingSeries.workspaceId, numberingSeries.id],
    }),
    foreignKey({
      name: "documents_bank_account_fk",
      columns: [t.workspaceId, t.bankAccountId],
      foreignColumns: [bankAccounts.workspaceId, bankAccounts.id],
    }),
    foreignKey({
      name: "documents_schedule_fk",
      columns: [t.workspaceId, t.scheduleId],
      foreignColumns: [schedules.workspaceId, schedules.id],
    }),
    check("documents_number_iff_not_draft", sql`(${t.status} = 'draft') = (${t.number} is null)`),
    check(
      "documents_occurrence_with_schedule",
      sql`(${t.scheduleId} is null) = (${t.occurrence} is null)`,
    ),
    check("documents_currency_format", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "documents_fx_complete",
      sql`(${t.fxRate} is null) = (${t.fxSource} is null) and (${t.fxRate} is null) = (${t.fxQuantity} is null)`,
    ),
    check("documents_fx_positive", sql`${t.fxRate} > 0 and ${t.fxQuantity} >= 1`),
    check("documents_payments_nonnegative", sql`${t.payments} >= 0`),
    check("documents_reminder_epoch_nonnegative", sql`${t.reminderEpoch} >= 0`),
  ],
);

/** Resolved document lines (core-ports.md:100-107), copied from the Price List at draft time. */
export const documentLines = pgTable(
  "document_lines",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
    priceListItemId: uuid("price_list_item_id"),
    description: text("description").notNull(),
    quantity: decimal("quantity").notNull().default("1"),
    unit: text("unit"),
    unitPrice: decimal("unit_price").notNull(),
    itemPrice: jsonb("item_price"),
    givenVat: vatTreatment("given_vat"),
    itemVat: vatTreatment("item_vat"),
    vat: vatTreatment("vat").notNull(),
    ratePercent: decimal("rate_percent").notNull().default("0"),
    amount: decimal("amount").notNull().default("0"),
    /**
     * Final Invoice deduction line (core-ports.md D8): the Payment Tax Document (or, outside
     * `vat_payer`, the Proforma) it deducts, with the deducted VAT frozen at issue.
     */
    deductsDocumentId: uuid("deducts_document_id"),
    deductedVat: money("deducted_vat"),
    /** `deducted_vat` in CZK at the deducted document's rate, frozen at issue. */
    deductedVatCzk: money("deducted_vat_czk"),
  },
  (t) => [
    unique("document_lines_document_position_unique").on(t.documentId, t.position),
    foreignKey({
      name: "document_lines_deducts_document_fk",
      columns: [t.workspaceId, t.deductsDocumentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
    check(
      "document_lines_deducted_vat_on_deduction",
      sql`${t.deductedVat} is null or ${t.deductsDocumentId} is not null`,
    ),
    check(
      "document_lines_deducted_vat_czk_on_deduction",
      sql`${t.deductedVatCzk} is null or ${t.deductsDocumentId} is not null`,
    ),
    foreignKey({
      name: "document_lines_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "document_lines_price_list_item_fk",
      columns: [t.workspaceId, t.priceListItemId],
      foreignColumns: [priceListItems.workspaceId, priceListItems.id],
    }),
  ],
);

/**
 * Links between documents (core-ports.md:700, :814-818). Stored in the forward direction only;
 * `corrected_by` is the read-side inverse of `corrects`. `final_invoice_for` goes from the
 * Proforma to its Final Invoice (D8) and is unique on both ends: one Final Invoice per Proforma.
 */
export const documentRelations = pgTable(
  "document_relations",
  {
    workspaceId: workspaceIdColumn(),
    fromDocumentId: uuid("from_document_id").notNull(),
    toDocumentId: uuid("to_document_id").notNull(),
    relation: documentRelation("relation").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fromDocumentId, t.toDocumentId, t.relation] }),
    index("document_relations_to_idx").on(t.toDocumentId),
    uniqueIndex("document_relations_one_final_invoice_per_proforma")
      .on(t.fromDocumentId)
      .where(sql`${t.relation} = 'final_invoice_for'`),
    uniqueIndex("document_relations_final_invoice_one_proforma")
      .on(t.toDocumentId)
      .where(sql`${t.relation} = 'final_invoice_for'`),
    foreignKey({
      name: "document_relations_from_fk",
      columns: [t.workspaceId, t.fromDocumentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "document_relations_to_fk",
      columns: [t.workspaceId, t.toDocumentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }).onDelete("cascade"),
    check("document_relations_not_self", sql`${t.fromDocumentId} <> ${t.toDocumentId}`),
  ],
);

/**
 * Payments against a Document or an Expense (core-ports.md §4.5). Removal is a soft delete.
 * `tax_document_id` is the Payment Tax Document created for a Proforma payment.
 */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id"),
    expenseId: uuid("expense_id"),
    amount: money("amount").notNull(),
    currency: currency("currency").notNull(),
    paidOn: isoDate("paid_on").notNull(),
    method: paymentMethod("method").notNull(),
    note: text("note"),
    taxDocumentId: uuid("tax_document_id"),
    removedAt: instant("removed_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("payments_workspace_id_id_unique").on(t.workspaceId, t.id),
    index("payments_document_idx").on(t.documentId),
    index("payments_expense_idx").on(t.expenseId),
    foreignKey({
      name: "payments_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
    foreignKey({
      name: "payments_expense_fk",
      columns: [t.workspaceId, t.expenseId],
      foreignColumns: [expenses.workspaceId, expenses.id],
    }),
    foreignKey({
      name: "payments_tax_document_fk",
      columns: [t.workspaceId, t.taxDocumentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
    check("payments_one_target", sql`num_nonnulls(${t.documentId}, ${t.expenseId}) = 1`),
    check("payments_amount_positive", sql`${t.amount} > 0`),
  ],
);

/**
 * Delivery intents: the outbox row for the DocumentDelivery workflow, with an immutable
 * content snapshot (core-ports.md:1287-1330). `reminder_epoch` is null for manual sends.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid("document_id").notNull(),
    sequence: integer("sequence").notNull().default(1),
    documentRevision: integer("document_revision").notNull(),
    purpose: deliveryPurpose("purpose").notNull(),
    status: deliveryStatus("status").notNull().default("queued"),
    recipients: text("recipients").array().notNull(),
    replyTo: text("reply_to"),
    language: locale("language").notNull(),
    subject: text("subject").notNull(),
    renderModel: jsonb("render_model").notNull(),
    attachment: jsonb("attachment"),
    contactId: uuid("contact_id"),
    arms: boolean("arms").notNull().default(false),
    dueOn: isoDate("due_on"),
    reminderEpoch: integer("reminder_epoch"),
    reminderDueOn: isoDate("reminder_due_on"),
    reminderOffsetDays: integer("reminder_offset_days"),
    reminderArmedBy: integer("reminder_armed_by"),
    attempts: integer("attempts").notNull().default(0),
    lastOutcome: text("last_outcome"),
    failure: text("failure"),
    /** The EmailSender that accepted the message and its message id, once sent. */
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    workflowStartedAt: instant("workflow_started_at"),
    sentAt: instant("sent_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("deliveries_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("deliveries_document_sequence").on(t.workspaceId, t.documentId, t.sequence),
    uniqueIndex("deliveries_reminder_step")
      .on(t.workspaceId, t.documentId, t.reminderDueOn, t.reminderOffsetDays, t.reminderArmedBy)
      .where(
        sql`${t.reminderDueOn} is not null and not (${t.status} = 'skipped' and ${t.attempts} = 0 and ${t.lastOutcome} is null)`,
      ),
    index("deliveries_document_idx").on(t.documentId),
    index("deliveries_pending_idx")
      .on(t.status, t.workflowStartedAt)
      .where(sql`${t.status} in ('queued', 'sending')`),
    foreignKey({
      name: "deliveries_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
    foreignKey({
      name: "deliveries_contact_fk",
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }),
    check("deliveries_recipients_nonempty", sql`cardinality(${t.recipients}) > 0`),
    check(
      "deliveries_reminder_epoch_purpose",
      sql`${t.reminderEpoch} is null or ${t.purpose} = 'reminder'`,
    ),
    check(
      "deliveries_reminder_step_complete",
      sql`(${t.reminderDueOn} is null) = (${t.reminderOffsetDays} is null) and (${t.reminderDueOn} is null) = (${t.reminderArmedBy} is null)`,
    ),
    check("deliveries_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "deliveries_last_outcome_values",
      sql`${t.lastOutcome} is null or ${t.lastOutcome} in ('not_accepted', 'outcome_unknown')`,
    ),
  ],
);

/**
 * Public Share Links (core-ports.md §4.6). The token is re-derived from the link id and key
 * version and looked up by hash; at most one active link per document.
 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    documentId: uuid("document_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    viewedAt: instant("viewed_at"),
    revokedAt: instant("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("share_links_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("share_links_token_hash_unique").on(t.tokenHash),
    uniqueIndex("share_links_one_active_per_document")
      .on(t.documentId)
      .where(sql`${t.revokedAt} is null`),
    foreignKey({
      name: "share_links_document_fk",
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [documents.workspaceId, documents.id],
    }),
  ],
);

/** Share view/download events; no IP or user agent, only the daily VisitorHash (core-ports.md:886-899). */
export const shareViewEvents = pgTable(
  "share_view_events",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    shareLinkId: uuid("share_link_id").notNull(),
    kind: shareEventKind("kind").notNull(),
    device: shareDevice("device").notNull(),
    visitorHash: text("visitor_hash").notNull(),
    at: createdAt("at"),
  },
  (t) => [
    index("share_view_events_dedupe_idx").on(t.shareLinkId, t.visitorHash, t.kind, t.at),
    foreignKey({
      name: "share_view_events_share_link_fk",
      columns: [t.workspaceId, t.shareLinkId],
      foreignColumns: [shareLinks.workspaceId, shareLinks.id],
    }).onDelete("cascade"),
  ],
);
