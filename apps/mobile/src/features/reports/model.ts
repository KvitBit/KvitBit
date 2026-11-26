import type { ExportFormat, ReportGroupBy } from "@kvitbit/api-contract";
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  ExpenseId,
  IsoDate,
  ReportKind,
  VatTreatment,
} from "@kvitbit/domain/contract";
import type { Period } from "@kvitbit/ui-port/view-models";
import type { DownloadRequest } from "../../platform/transfer";
import { safeFileName } from "../../platform/transfer/http";

export interface ReportMoney {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export interface ReportAmountRow {
  readonly key: string;
  readonly label: string | null;
  readonly count: number;
  readonly net: ReportMoney;
  readonly vat: ReportMoney;
  readonly gross: ReportMoney;
  readonly original: ReportMoney | null;
}

export interface ReportAmountTotals {
  readonly count: number;
  readonly net: ReportMoney;
  readonly vat: ReportMoney;
  readonly gross: ReportMoney;
}

export interface RevenueReportData {
  readonly report: "revenue";
  readonly period: { readonly from: IsoDate; readonly to: IsoDate };
  readonly groupBy: "month" | "contact" | "currency";
  readonly rows: ReadonlyArray<ReportAmountRow>;
  readonly totals: ReportAmountTotals;
}

export interface ExpensesReportData {
  readonly report: "expenses";
  readonly period: { readonly from: IsoDate; readonly to: IsoDate };
  readonly groupBy: "month" | "contact" | "currency" | "category";
  readonly rows: ReadonlyArray<ReportAmountRow>;
  readonly totals: ReportAmountTotals;
  readonly incomplete: number;
}

export interface ProfitReportRow {
  readonly month: string;
  readonly revenue: ReportMoney;
  readonly expenses: ReportMoney;
  readonly profit: ReportMoney;
}

export interface ProfitReportData {
  readonly report: "profit";
  readonly period: { readonly from: IsoDate; readonly to: IsoDate };
  readonly rows: ReadonlyArray<ProfitReportRow>;
  readonly totals: {
    readonly revenue: ReportMoney;
    readonly expenses: ReportMoney;
    readonly profit: ReportMoney;
  };
}

export interface CashflowReportPoint {
  readonly month: string;
  readonly in: ReportMoney;
  readonly out: ReportMoney;
  readonly net: ReportMoney;
}

export interface CashflowReportData {
  readonly report: "cashflow";
  readonly period: { readonly from: IsoDate; readonly to: IsoDate };
  readonly points: ReadonlyArray<CashflowReportPoint>;
  readonly totals: {
    readonly in: ReportMoney;
    readonly out: ReportMoney;
    readonly net: ReportMoney;
  };
}

export type AgingBucketKey = "not_due" | "1_30" | "31_60" | "61_90" | "over_90";

export interface ReceivableDocumentRow {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly number: string | null;
  readonly contact: { readonly id: ContactId | null; readonly name: string };
  readonly currency: CurrencyCode;
  readonly dueOn: IsoDate | null;
  readonly daysOverdue: number;
  readonly outstanding: ReportMoney;
  readonly outstandingCzk: ReportMoney;
}

export interface ReceivablesReportData {
  readonly report: "receivables";
  readonly period: { readonly from: IsoDate; readonly to: IsoDate };
  readonly asOf: IsoDate;
  readonly buckets: ReadonlyArray<{
    readonly bucket: AgingBucketKey;
    readonly count: number;
    readonly total: ReportMoney;
    readonly documents: ReadonlyArray<ReceivableDocumentRow>;
  }>;
  readonly total: ReportMoney;
  readonly overdue: { readonly total: ReportMoney; readonly count: number };
}

export type VatSourceRef =
  | { readonly _tag: "Document"; readonly id: DocumentId }
  | { readonly _tag: "Expense"; readonly id: ExpenseId };

export interface VatLineData {
  readonly month: string;
  readonly treatment: VatTreatment;
  readonly ratePercent: string;
  readonly base: ReportMoney;
  readonly vat: ReportMoney;
  readonly documents: ReadonlyArray<VatSourceRef>;
}

export interface VatSummaryReportData {
  readonly report: "vat_summary";
  readonly period: { readonly from: IsoDate; readonly to: IsoDate };
  readonly output: ReadonlyArray<VatLineData>;
  readonly input: ReadonlyArray<VatLineData>;
  readonly totals: {
    readonly output: ReportMoney;
    readonly input: ReportMoney;
    readonly payable: ReportMoney;
  };
}

export type DecodedReport =
  | RevenueReportData
  | ExpensesReportData
  | ProfitReportData
  | CashflowReportData
  | ReceivablesReportData
  | VatSummaryReportData;

export const REPORT_TABS: ReadonlyArray<ReportKind> = [
  "vat_summary",
  "profit",
  "receivables",
  "revenue",
  "expenses",
  "cashflow",
];

// --- Route & Period helpers -----------------------------------------------------------------------

const REPORT_BY_SEGMENT: Readonly<Record<string, ReportKind>> = {
  revenue: "revenue",
  "vat-summary": "vat_summary",
  vat_summary: "vat_summary",
  receivables: "receivables",
  expenses: "expenses",
  profit: "profit",
  cashflow: "cashflow",
};

export const parseReportKind = (segment: string | undefined): ReportKind =>
  (segment !== undefined ? REPORT_BY_SEGMENT[segment] : undefined) ?? "vat_summary";

const pad2 = (n: number): string => String(n).padStart(2, "0");

const daysInMonth = (year: number, month1: number): number => new Date(year, month1, 0).getDate();

export const isValidPeriod = (raw: string | undefined): raw is Period =>
  raw !== undefined && /^\d{4}(?:-Q[1-4]|-(?:0[1-9]|1[0-2]))?$/.test(raw);

export const currentMonthPeriod = (now: Date = new Date()): Period =>
  `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}` as Period;

export const periodPresets = (
  now: Date = new Date(),
): {
  readonly thisMonth: Period;
  readonly lastMonth: Period;
  readonly thisQuarter: Period;
  readonly thisYear: Period;
  readonly lastYear: Period;
} => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const q = Math.floor((m - 1) / 3) + 1;
  return {
    thisMonth: `${y}-${pad2(m)}` as Period,
    lastMonth: `${prevY}-${pad2(prevM)}` as Period,
    thisQuarter: `${y}-Q${q}` as Period,
    thisYear: `${y}` as Period,
    lastYear: `${y - 1}` as Period,
  };
};

/** Converts a Period (`2026`, `2026-Q4`, `2026-11`) into inclusive `{ from, to }` IsoDates. */
export const periodToRange = (period: Period): { readonly from: IsoDate; readonly to: IsoDate } => {
  const year = Number.parseInt(period.slice(0, 4), 10);
  if (period.length === 4) {
    return { from: `${year}-01-01` as IsoDate, to: `${year}-12-31` as IsoDate };
  }
  if (period.includes("-Q")) {
    const q = Number.parseInt(period.slice(6), 10);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      from: `${year}-${pad2(startMonth)}-01` as IsoDate,
      to: `${year}-${pad2(endMonth)}-${pad2(daysInMonth(year, endMonth))}` as IsoDate,
    };
  }
  const month = Number.parseInt(period.slice(5, 7), 10);
  return {
    from: `${year}-${pad2(month)}-01` as IsoDate,
    to: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}` as IsoDate,
  };
};

/** Steps a Period backwards (`delta = -1`) or forwards (`delta = 1`) in its own granularity. */
export const shiftPeriod = (period: Period, delta: -1 | 1): Period => {
  const year = Number.parseInt(period.slice(0, 4), 10);
  if (period.length === 4) return `${year + delta}` as Period;
  if (period.includes("-Q")) {
    const q = Number.parseInt(period.slice(6), 10);
    const total = year * 4 + (q - 1) + delta;
    const ny = Math.floor(total / 4);
    const nq = (total % 4) + 1;
    return `${ny}-Q${nq}` as Period;
  }
  const month = Number.parseInt(period.slice(5, 7), 10);
  const total = year * 12 + (month - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad2(nm)}` as Period;
};

// --- Export request builder -----------------------------------------------------------------------

export const buildReportExportRequest = (params: {
  readonly workspaceId: string;
  readonly report: ReportKind;
  readonly period: Period;
  readonly format: ExportFormat;
  readonly groupBy?: ReportGroupBy;
}): DownloadRequest => {
  const range = periodToRange(params.period);
  const ext = params.format === "csv" ? "csv" : "pdf";
  const contentType = params.format === "csv" ? "text/csv; charset=utf-8" : "application/pdf";
  return {
    path: `/workspaces/${params.workspaceId}/reports/${params.report}/export`,
    query: {
      format: params.format,
      from: range.from,
      to: range.to,
      groupBy: params.groupBy,
    },
    filename: safeFileName(`kvitbit-${params.report}-${params.period}.${ext}`),
    contentType,
  };
};

// --- Safe ReportView decoder ----------------------------------------------------------------------

const CZK = "CZK" as CurrencyCode;
const ZERO_CZK: ReportMoney = { amount: "0", currency: CZK };

const asRecord = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : {};

const asString = (u: unknown): string | null => (typeof u === "string" ? u : null);

const asNumber = (u: unknown): number => (typeof u === "number" && Number.isFinite(u) ? u : 0);

const asDecimal = (u: unknown): string => {
  if (typeof u === "string" && u.trim() !== "") return u.trim();
  if (typeof u === "number" && Number.isFinite(u)) return String(u);
  return "0";
};

const decodeMoney = (u: unknown): ReportMoney => {
  const r = asRecord(u);
  const amount = asDecimal(r.amount);
  const currency = (asString(r.currency) ?? "CZK") as CurrencyCode;
  return { amount, currency };
};

const decodeOptionalMoney = (u: unknown): ReportMoney | null =>
  u === null || u === undefined ? null : decodeMoney(u);

const decodePeriod = (u: unknown): { readonly from: IsoDate; readonly to: IsoDate } => {
  const r = asRecord(u);
  return {
    from: (asString(r.from) ?? "") as IsoDate,
    to: (asString(r.to) ?? "") as IsoDate,
  };
};

const decodeAmountRow = (u: unknown): ReportAmountRow => {
  const r = asRecord(u);
  return {
    key: asString(r.key) ?? "",
    label: asString(r.label),
    count: asNumber(r.count),
    net: decodeMoney(r.net),
    vat: decodeMoney(r.vat),
    gross: decodeMoney(r.gross),
    original: decodeOptionalMoney(r.original),
  };
};

const decodeAmountTotals = (u: unknown): ReportAmountTotals => {
  const r = asRecord(u);
  return {
    count: asNumber(r.count),
    net: decodeMoney(r.net),
    vat: decodeMoney(r.vat),
    gross: decodeMoney(r.gross),
  };
};

const decodeVatLine = (u: unknown): VatLineData => {
  const r = asRecord(u);
  const docs = Array.isArray(r.documents) ? r.documents : [];
  return {
    month: asString(r.month) ?? "",
    treatment: (asString(r.treatment) ?? "standard") as VatTreatment,
    ratePercent: asDecimal(r.ratePercent),
    base: decodeMoney(r.base),
    vat: decodeMoney(r.vat),
    documents: docs
      .map((d): VatSourceRef | null => {
        const rec = asRecord(d);
        const id = asString(rec.id);
        if (id === null) return null;
        if (rec._tag === "Expense") return { _tag: "Expense", id: id as ExpenseId };
        return { _tag: "Document", id: id as DocumentId };
      })
      .filter((x): x is VatSourceRef => x !== null),
  };
};

export const decodeReportView = (u: unknown, fallbackReport: ReportKind): DecodedReport => {
  const r = asRecord(u);
  const kind = (asString(r.report) ?? fallbackReport) as ReportKind;
  const period = decodePeriod(r.period);

  switch (kind) {
    case "revenue":
      return {
        report: "revenue",
        period,
        groupBy: r.groupBy === "contact" || r.groupBy === "currency" ? r.groupBy : "month",
        rows: Array.isArray(r.rows) ? r.rows.map(decodeAmountRow) : [],
        totals: decodeAmountTotals(r.totals),
      };
    case "expenses":
      return {
        report: "expenses",
        period,
        groupBy:
          r.groupBy === "contact" || r.groupBy === "currency" || r.groupBy === "category"
            ? r.groupBy
            : "month",
        rows: Array.isArray(r.rows) ? r.rows.map(decodeAmountRow) : [],
        totals: decodeAmountTotals(r.totals),
        incomplete: asNumber(r.incomplete),
      };
    case "profit": {
      const totals = asRecord(r.totals);
      const rows = Array.isArray(r.rows) ? r.rows : [];
      return {
        report: "profit",
        period,
        rows: rows.map((entry) => {
          const row = asRecord(entry);
          return {
            month: asString(row.month) ?? "",
            revenue: decodeMoney(row.revenue),
            expenses: decodeMoney(row.expenses),
            profit: decodeMoney(row.profit),
          };
        }),
        totals: {
          revenue: decodeMoney(totals.revenue),
          expenses: decodeMoney(totals.expenses),
          profit: decodeMoney(totals.profit),
        },
      };
    }
    case "cashflow": {
      const totals = asRecord(r.totals);
      const points = Array.isArray(r.points) ? r.points : [];
      return {
        report: "cashflow",
        period,
        points: points.map((entry) => {
          const pt = asRecord(entry);
          return {
            month: asString(pt.month) ?? "",
            in: decodeMoney(pt.in),
            out: decodeMoney(pt.out),
            net: decodeMoney(pt.net),
          };
        }),
        totals: {
          in: decodeMoney(totals.in),
          out: decodeMoney(totals.out),
          net: decodeMoney(totals.net),
        },
      };
    }
    case "receivables": {
      const overdue = asRecord(r.overdue);
      const buckets = Array.isArray(r.buckets) ? r.buckets : [];
      return {
        report: "receivables",
        period,
        asOf: (asString(r.asOf) ?? period.to) as IsoDate,
        buckets: buckets.map((entry) => {
          const b = asRecord(entry);
          const docs = Array.isArray(b.documents) ? b.documents : [];
          return {
            bucket: (asString(b.bucket) ?? "not_due") as AgingBucketKey,
            count: asNumber(b.count),
            total: decodeMoney(b.total),
            documents: docs.map((d) => {
              const doc = asRecord(d);
              const contact = asRecord(doc.contact);
              return {
                id: (asString(doc.id) ?? "") as DocumentId,
                kind: (asString(doc.kind) ?? "invoice") as DocumentKind,
                number: asString(doc.number),
                contact: {
                  id: asString(contact.id) as ContactId | null,
                  name: asString(contact.name) ?? "",
                },
                currency: (asString(doc.currency) ?? "CZK") as CurrencyCode,
                dueOn: asString(doc.dueOn) as IsoDate | null,
                daysOverdue: asNumber(doc.daysOverdue),
                outstanding: decodeMoney(doc.outstanding),
                outstandingCzk: decodeMoney(doc.outstandingCzk),
              };
            }),
          };
        }),
        total: r.total !== undefined ? decodeMoney(r.total) : ZERO_CZK,
        overdue: {
          total: overdue.total !== undefined ? decodeMoney(overdue.total) : ZERO_CZK,
          count: asNumber(overdue.count),
        },
      };
    }
    case "vat_summary": {
      const totals = asRecord(r.totals);
      return {
        report: "vat_summary",
        period,
        output: Array.isArray(r.output) ? r.output.map(decodeVatLine) : [],
        input: Array.isArray(r.input) ? r.input.map(decodeVatLine) : [],
        totals: {
          output: decodeMoney(totals.output),
          input: decodeMoney(totals.input),
          payable: decodeMoney(totals.payable),
        },
      };
    }
  }
};
