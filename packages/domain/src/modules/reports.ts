/** Reports module (core-ports section 4.9). Interface only. */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Caller } from "../caller";
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
    readonly run: (
      caller: Caller,
      q: ReportQuery,
    ) => Effect.Effect<ReportView, Invalid | Unavailable | Forbidden>;
    readonly export: (
      caller: Caller,
      q: ReportQuery,
      format: "csv" | "pdf",
    ) => Effect.Effect<FileDownload, Invalid | Unavailable | Forbidden>;
    /** Dashboard tiles and a 12-month cashflow series ending at period.to (report.run). */
    readonly dashboard: (
      caller: Caller,
      period: ReportPeriod,
    ) => Effect.Effect<DashboardView, Invalid | Unavailable | Forbidden>;
    /** CNB fixing for a currency on a date, through the fx_fixings cache (report.run). */
    readonly fxRate: (
      caller: Caller,
      q: {
        readonly currency: CurrencyCode;
        readonly on: IsoDate;
      },
    ) => Effect.Effect<FxRateView, Invalid | Unavailable | Forbidden>;

    // Full data export (report.export): ZIP of document PDFs, Expense attachments and CSVs.
    /** Starts the DataExport workflow. Returns the running job when one is already running. */
    readonly startExport: (
      caller: Caller,
      opts?: RequestOptions,
    ) => Effect.Effect<ExportJobView, Conflict | Unavailable | Forbidden>;
    readonly getExport: (
      caller: Caller,
      id: ExportId,
    ) => Effect.Effect<ExportJobView, NotFound | Unavailable | Forbidden>;
    /** The ZIP. Conflict{illegal_transition, export.not_ready} while running or failed; NotFound after expiry. */
    readonly exportFile: (
      caller: Caller,
      id: ExportId,
    ) => Effect.Effect<FileDownload, NotFound | Conflict | Unavailable | Forbidden>;
  }
>()("@kvitbit/domain/modules/reports") {}
