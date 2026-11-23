/** Reports module (core-ports section 4.9). Interface only. */
import type { Effect } from "effect";
import { Context, Schema } from "effect";
import type { CurrentCaller } from "../caller";
import type { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import { ExportId } from "../ids";
import type { FileDownload } from "../shared";
import type { RequestOptions } from "../vocabulary";
import { CurrencyCode, IsoDate, Money } from "../vocabulary";

export const ReportKind = Schema.Literals([
  "revenue",
  "vat_summary",
  "receivables",
  "expenses",
  "profit",
  "cashflow",
]);
export type ReportKind = typeof ReportKind.Type;

export interface ReportPeriod {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export interface ReportQuery {
  readonly report: ReportKind;
  readonly period: ReportPeriod;
  readonly groupBy?: "month" | "contact" | "currency" | "category";
}

export const ReportView = Schema.Unknown.pipe(Schema.brand("ReportView"));
export type ReportView = typeof ReportView.Type;

export const CashflowPoint = Schema.Struct({
  month: Schema.String, // YYYY-MM
  in: Money,
  out: Money,
  net: Money,
});
export type CashflowPoint = typeof CashflowPoint.Type;

export const DashboardView = Schema.Struct({
  period: Schema.Struct({ from: IsoDate, to: IsoDate }),
  revenue: Money, // CZK, issued in period, as the revenue report
  unpaid: Money, // CZK, open receivables today
  overdue: Schema.Struct({ total: Money, count: Schema.Int }),
  expenses: Money, // CZK, complete Expenses in period
  incompleteExpenses: Schema.Int,
  cashflow: Schema.Array(CashflowPoint), // 12 months, oldest first
});
export type DashboardView = typeof DashboardView.Type;

export const FxRateView = Schema.Struct({
  currency: CurrencyCode,
  rate: Schema.BigDecimal,
  quantity: Schema.Int,
  fixingDate: IsoDate,
  source: Schema.Literal("cnb"),
});
export type FxRateView = typeof FxRateView.Type;

export const ExportJobView = Schema.Struct({
  id: ExportId,
  status: Schema.Literals(["running", "ready", "failed"]),
  createdAt: Schema.String,
  readyAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String), // ready for 7 days
  sizeBytes: Schema.NullOr(Schema.Int),
});
export type ExportJobView = typeof ExportJobView.Type;

export class Reports extends Context.Service<
  Reports,
  {
    readonly run: (q: ReportQuery) => Effect.Effect<ReportView, Invalid | Forbidden, CurrentCaller>;
    readonly export: (
      q: ReportQuery,
      format: "csv" | "pdf",
    ) => Effect.Effect<FileDownload, Invalid | Forbidden, CurrentCaller>;
    /** Dashboard tiles and a 12-month cashflow series ending at period.to (report.run). */
    readonly dashboard: (
      period: ReportPeriod,
    ) => Effect.Effect<DashboardView, Invalid | Forbidden, CurrentCaller>;
    /** CNB fixing for a currency on a date, through the fx_fixings cache (report.run). */
    readonly fxRate: (q: {
      readonly currency: CurrencyCode;
      readonly on: IsoDate;
    }) => Effect.Effect<FxRateView, Invalid | Unavailable | Forbidden, CurrentCaller>;

    // Full data export (report.export): ZIP of document PDFs, Expense attachments and CSVs.
    /** Starts the DataExport workflow. Returns the running job when one is already running. */
    readonly startExport: (
      opts?: RequestOptions,
    ) => Effect.Effect<ExportJobView, Forbidden, CurrentCaller>;
    readonly getExport: (
      id: ExportId,
    ) => Effect.Effect<ExportJobView, NotFound | Forbidden, CurrentCaller>;
    /** The ZIP. Conflict{illegal_transition, export.not_ready} while running or failed; NotFound after expiry. */
    readonly exportFile: (
      id: ExportId,
    ) => Effect.Effect<FileDownload, NotFound | Conflict | Unavailable | Forbidden, CurrentCaller>;
  }
>()("kvitbit/Reports") {}
