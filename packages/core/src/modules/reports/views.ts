/**
 * Concrete shapes behind the domain `ReportView` placeholder (core-ports 4.9): one tagged view
 * per `ReportKind`. Every amount is CZK computed from the fixing stored on each document,
 * payment target and Expense, never from today's rate.
 */
import {
  CashflowPoint,
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  ExpenseId,
  IsoDate,
  Money,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";

export const Period = Schema.Struct({ from: IsoDate, to: IsoDate });

/** One group of the revenue or expenses report. */
export const AmountRow = Schema.Struct({
  /** month `YYYY-MM`, contact id (or `name:<name>`), currency code, or category ("" = none). */
  key: Schema.String,
  label: Schema.NullOr(Schema.String),
  count: Schema.Int,
  net: Money,
  vat: Money,
  gross: Money,
  /** `currency` grouping only: the gross in the original currency. */
  original: Schema.NullOr(Money),
});
export type AmountRow = typeof AmountRow.Type;

export const AmountTotals = Schema.Struct({
  count: Schema.Int,
  net: Money,
  vat: Money,
  gross: Money,
});

export const RevenueView = Schema.Struct({
  report: Schema.Literal("revenue"),
  period: Period,
  groupBy: Schema.Literals(["month", "contact", "currency"]),
  rows: Schema.Array(AmountRow),
  totals: AmountTotals,
});
export type RevenueView = typeof RevenueView.Type;

export const ExpensesView = Schema.Struct({
  report: Schema.Literal("expenses"),
  period: Period,
  groupBy: Schema.Literals(["month", "contact", "currency", "category"]),
  rows: Schema.Array(AmountRow),
  totals: AmountTotals,
  /** Incomplete Expenses left out of the figures. */
  incomplete: Schema.Int,
});
export type ExpensesView = typeof ExpensesView.Type;

export const ProfitRow = Schema.Struct({
  month: Schema.String,
  revenue: Money,
  expenses: Money,
  profit: Money,
});
export const ProfitView = Schema.Struct({
  report: Schema.Literal("profit"),
  period: Period,
  rows: Schema.Array(ProfitRow),
  totals: Schema.Struct({ revenue: Money, expenses: Money, profit: Money }),
});
export type ProfitView = typeof ProfitView.Type;

export const CashflowView = Schema.Struct({
  report: Schema.Literal("cashflow"),
  period: Period,
  points: Schema.Array(CashflowPoint),
  totals: Schema.Struct({ in: Money, out: Money, net: Money }),
});
export type CashflowView = typeof CashflowView.Type;

export const AgingBucket = Schema.Literals(["not_due", "1_30", "31_60", "61_90", "over_90"]);
export type AgingBucket = typeof AgingBucket.Type;

export const ReceivableRow = Schema.Struct({
  id: DocumentId,
  kind: DocumentKind,
  number: Schema.NullOr(Schema.String),
  contact: Schema.Struct({ id: Schema.NullOr(ContactId), name: Schema.String }),
  currency: CurrencyCode,
  dueOn: Schema.NullOr(IsoDate),
  /** asOf − dueOn in days; 0 or less is not due. */
  daysOverdue: Schema.Int,
  outstanding: Money,
  outstandingCzk: Money,
});
export type ReceivableRow = typeof ReceivableRow.Type;

export const ReceivablesView = Schema.Struct({
  report: Schema.Literal("receivables"),
  period: Period,
  asOf: IsoDate,
  buckets: Schema.Array(
    Schema.Struct({
      bucket: AgingBucket,
      count: Schema.Int,
      total: Money,
      documents: Schema.Array(ReceivableRow),
    }),
  ),
  total: Money,
  overdue: Schema.Struct({ total: Money, count: Schema.Int }),
});
export type ReceivablesView = typeof ReceivablesView.Type;

/** A drill-down reference: which entity a VAT figure comes from. */
export const VatSource = Schema.Union([
  Schema.TaggedStruct("Document", { id: DocumentId }),
  Schema.TaggedStruct("Expense", { id: ExpenseId }),
]);
export type VatSource = typeof VatSource.Type;

export const VatLine = Schema.Struct({
  /** Tax point month `YYYY-MM`. */
  month: Schema.String,
  treatment: VatTreatment,
  ratePercent: Schema.BigDecimal,
  base: Money,
  vat: Money,
  /** The documents and Expenses behind the figure (drill-down), sorted by kind then id. */
  documents: Schema.Array(VatSource),
});
export type VatLine = typeof VatLine.Type;

export const VatSummaryView = Schema.Struct({
  report: Schema.Literal("vat_summary"),
  period: Period,
  /** Issued documents, Payment Tax Documents and Credit Notes (Final Invoice advances netted), plus self-assessed reverse charge on Expenses. */
  output: Schema.Array(VatLine),
  /** Deductible input VAT from Expenses. */
  input: Schema.Array(VatLine),
  totals: Schema.Struct({ output: Money, input: Money, payable: Money }),
});
export type VatSummaryView = typeof VatSummaryView.Type;

export const ReportViewData = Schema.Union([
  RevenueView,
  ExpensesView,
  ProfitView,
  CashflowView,
  ReceivablesView,
  VatSummaryView,
]);
export type ReportViewData = typeof ReportViewData.Type;
