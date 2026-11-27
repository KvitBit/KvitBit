/**
 * Report views and source rows as CSV tables. Column names are stable snake_case keys (the
 * same in every locale, so imports keep working); only number formatting follows the locale.
 */

import * as EffectArray from "effect/Array";
import type { CsvTable } from "./csv";
import { amount, int, money, num, text } from "./csv";
import type { ReportDocument, ReportExpense, ReportPayment } from "./source";
import type { AmountRow, ReportViewData } from "./views";

const amountTable = (rows: ReadonlyArray<AmountRow>, withOriginal: boolean): CsvTable => ({
  header: [
    "group",
    "label",
    "count",
    "net_czk",
    "vat_czk",
    "gross_czk",
    ...(withOriginal ? ["gross_original", "currency"] : []),
  ],
  rows: EffectArray.map(rows, (r) => [
    text(r.key),
    text(r.label),
    int(r.count),
    money(r.net.amount),
    money(r.vat.amount),
    money(r.gross.amount),
    ...(withOriginal && r.original !== null
      ? [amount(r.original.amount, r.original.currency), text(r.original.currency)]
      : []),
  ]),
});

export const reportTable = (view: ReportViewData): CsvTable => {
  switch (view.report) {
    case "revenue":
    case "expenses":
      return amountTable(view.rows, view.groupBy === "currency");
    case "profit":
      return {
        header: ["month", "revenue_czk", "expenses_czk", "profit_czk"],
        rows: EffectArray.map(view.rows, (r) => [
          text(r.month),
          money(r.revenue.amount),
          money(r.expenses.amount),
          money(r.profit.amount),
        ]),
      };
    case "cashflow":
      return {
        header: ["month", "in_czk", "out_czk", "net_czk"],
        rows: EffectArray.map(view.points, (p) => [
          text(p.month),
          money(p.in.amount),
          money(p.out.amount),
          money(p.net.amount),
        ]),
      };
    case "receivables":
      return {
        header: [
          "bucket",
          "document_id",
          "kind",
          "number",
          "contact",
          "currency",
          "due_on",
          "days_overdue",
          "outstanding",
          "outstanding_czk",
        ],
        rows: EffectArray.flatMap(view.buckets, (b) =>
          EffectArray.map(b.documents, (d) => [
            text(b.bucket),
            text(d.id),
            text(d.kind),
            text(d.number),
            text(d.contact.name),
            text(d.currency),
            text(d.dueOn),
            int(d.daysOverdue),
            amount(d.outstanding.amount, d.currency),
            money(d.outstandingCzk.amount),
          ]),
        ),
      };
    case "vat_summary":
      return {
        header: [
          "section",
          "month",
          "treatment",
          "rate_percent",
          "base_czk",
          "vat_czk",
          "documents",
        ],
        rows: EffectArray.map(
          [
            ...EffectArray.map(view.output, (l) => ["output", l] as const),
            ...EffectArray.map(view.input, (l) => ["input", l] as const),
          ],
          ([section, l]) => [
            text(section),
            text(l.month),
            text(l.treatment),
            num(l.ratePercent),
            money(l.base.amount),
            money(l.vat.amount),
            int(l.documents.length),
          ],
        ),
      };
  }
};

// Full data export tables ---------------------------------------------------------------------

const byId = <A extends { readonly id: string }>(rows: ReadonlyArray<A>) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export const documentsTable = (rows: ReadonlyArray<ReportDocument>): CsvTable => ({
  header: [
    "id",
    "kind",
    "final_invoice",
    "status",
    "number",
    "contact_id",
    "contact",
    "currency",
    "issued_on",
    "tax_point",
    "due_on",
    "net",
    "vat",
    "gross",
    "vat_czk",
    "fx_rate",
    "fx_quantity",
    "settlement",
    "outstanding",
  ],
  rows: EffectArray.map(byId(rows), (d) => [
    text(d.id),
    text(d.kind),
    text(d.finalInvoice ? "true" : "false"),
    text(d.status),
    text(d.number),
    text(d.contact.id),
    text(d.contact.name),
    text(d.currency),
    text(d.issuedOn),
    text(d.taxPoint),
    text(d.dueOn),
    amount(d.totals.net.amount, d.currency),
    amount(d.totals.vat.amount, d.currency),
    amount(d.totals.gross.amount, d.currency),
    d.totals.vatCzk === null ? text(null) : money(d.totals.vatCzk.amount),
    d.fx === null ? text(null) : num(d.fx.rate),
    d.fx === null ? text(null) : int(d.fx.quantity),
    text(d.settlement),
    amount(d.outstanding, d.currency),
  ]),
});

export const paymentsTable = (rows: ReadonlyArray<ReportPayment>): CsvTable => ({
  header: ["id", "direction", "document_id", "expense_id", "paid_on", "amount", "currency"],
  rows: EffectArray.map(byId(rows), (p) => [
    text(p.id),
    text(p.direction),
    text("document" in p.target ? p.target.document : null),
    text("expense" in p.target ? p.target.expense : null),
    text(p.paidOn),
    amount(p.amount.amount, p.amount.currency),
    text(p.amount.currency),
  ]),
});

export const expensesTable = (rows: ReadonlyArray<ReportExpense>): CsvTable => ({
  header: [
    "id",
    "supplier_document_number",
    "supplier_contact_id",
    "supplier",
    "category",
    "tags",
    "issued_on",
    "tax_point",
    "currency",
    "net",
    "vat",
    "gross",
    "vat_czk",
    "fx_rate",
    "fx_quantity",
    "deductible_percent",
  ],
  rows: EffectArray.map(byId(rows), (e) => [
    text(e.id),
    text(e.supplierDocumentNumber),
    text(e.supplier?.contactId ?? null),
    text(e.supplier?.name ?? null),
    text(e.category),
    text(
      EffectArray.join(
        [...e.tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        "|",
      ),
    ),
    text(e.issuedOn),
    text(e.taxPoint),
    text(e.currency),
    amount(e.totals.net.amount, e.currency),
    amount(e.totals.vat.amount, e.currency),
    amount(e.totals.gross.amount, e.currency),
    e.totals.vatCzk === null ? text(null) : money(e.totals.vatCzk.amount),
    e.fx === null ? text(null) : num(e.fx.rate),
    e.fx === null ? text(null) : int(e.fx.quantity),
    int(e.deductiblePercent),
  ]),
});
