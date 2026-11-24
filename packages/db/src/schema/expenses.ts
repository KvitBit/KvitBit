import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
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
import { contacts } from "./contacts";
import { expenseStatus, fxSource } from "./enums";
import { workspaces } from "./workspaces";

const isoDate = (name: string) => date(name, { mode: "string" });

/**
 * Received invoices and receipts (core-ports.md §4.7). `incomplete` rows skip the required and
 * arithmetic checks. `vat_breakdown` holds the user-entered VAT amounts per rate.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    workspaceId: workspaceIdColumn().references(() => workspaces.id, { onDelete: "cascade" }),
    status: expenseStatus("status").notNull().default("complete"),
    contactId: uuid("contact_id"),
    supplierName: text("supplier_name"),
    supplierIco: text("supplier_ico"),
    supplierDic: text("supplier_dic"),
    supplierDocumentNumber: text("supplier_document_number"),
    issuedOn: isoDate("issued_on"),
    taxableSupplyOn: isoDate("taxable_supply_on"),
    dueOn: isoDate("due_on"),
    currency: currency("currency"),
    vatBreakdown: jsonb("vat_breakdown"),
    totalGross: money("total_gross"),
    category: text("category"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    note: text("note"),
    fxRate: decimal("fx_rate"),
    fxQuantity: integer("fx_quantity"),
    fxFixingDate: isoDate("fx_fixing_date"),
    fxSource: fxSource("fx_source"),
    /** Input VAT deductibility coefficient in percent (§76): 100 full, 0 none. */
    deductiblePercent: integer("deductible_percent").notNull().default(100),
    /**
     * Sum of live Payments in `currency` and their count, kept by `ExpensePayables.settle`.
     * Unbounded: each Payment fits `money`, their sum (overpayment allowed) may not.
     */
    paid: decimal("paid").notNull().default("0"),
    payments: integer("payments").notNull().default(0),
    /** Removal marker: removed Expenses leave active use but keep their Payments (core-ports.md:926). */
    removedAt: instant("removed_at"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("expenses_workspace_id_id_unique").on(t.workspaceId, t.id),
    index("expenses_workspace_issued_idx").on(t.workspaceId, t.issuedOn),
    index("expenses_supplier_document_idx").on(
      t.workspaceId,
      t.supplierIco,
      t.supplierDocumentNumber,
    ),
    foreignKey({
      name: "expenses_contact_fk",
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }),
    check(
      "expenses_complete_required",
      sql`${t.status} = 'incomplete' or (${t.issuedOn} is not null and ${t.currency} is not null and ${t.totalGross} is not null)`,
    ),
    check("expenses_deductible_percent_range", sql`${t.deductiblePercent} between 0 and 100`),
    check("expenses_payments_nonnegative", sql`${t.payments} >= 0`),
  ],
);

/** Expense file attachments; attach is idempotent by content hash (core-ports.md:926-928). */
export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    expenseId: uuid("expense_id").notNull(),
    blobKey: text("blob_key").notNull(),
    fileName: text("file_name"),
    contentType: text("content_type").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("attachments_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("attachments_expense_sha256_unique").on(t.expenseId, t.sha256),
    foreignKey({
      name: "attachments_expense_fk",
      columns: [t.workspaceId, t.expenseId],
      foreignColumns: [expenses.workspaceId, expenses.id],
    }).onDelete("cascade"),
    check("attachments_bytes_nonnegative", sql`${t.bytes} >= 0`),
  ],
);
