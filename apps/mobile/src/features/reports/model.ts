import type { ExportFormat, ReportGroupBy } from "@kvitbit/api-contract";
import {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  ExpenseId,
  IsoDate,
  ReportKind,
  type ReportView,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { Period } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { DownloadRequest } from "../../platform/transfer";
import { safeFileName } from "../../platform/transfer/http";

interface ReportPeriod {
  readonly from: IsoDate | null;
  readonly to: IsoDate | null;
}

interface ReportMoney {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

interface ReportAmountRow {
  readonly key: string;
  readonly label: string | null;
  readonly count: number;
  readonly net: ReportMoney;
  readonly vat: ReportMoney;
  readonly gross: ReportMoney;
  readonly original: ReportMoney | null;
}

interface ReportAmountTotals {
  readonly count: number;
  readonly net: ReportMoney;
  readonly vat: ReportMoney;
  readonly gross: ReportMoney;
}

interface RevenueReportData {
  readonly report: "revenue";
  readonly period: ReportPeriod;
  readonly groupBy: "month" | "contact" | "currency";
  readonly rows: ReadonlyArray<ReportAmountRow>;
  readonly totals: ReportAmountTotals;
}

interface ExpensesReportData {
  readonly report: "expenses";
  readonly period: ReportPeriod;
  readonly groupBy: "month" | "contact" | "currency" | "category";
  readonly rows: ReadonlyArray<ReportAmountRow>;
  readonly totals: ReportAmountTotals;
  readonly incomplete: number;
}

interface ProfitReportRow {
  readonly month: string;
  readonly revenue: ReportMoney;
  readonly expenses: ReportMoney;
  readonly profit: ReportMoney;
}

interface ProfitReportData {
  readonly report: "profit";
  readonly period: ReportPeriod;
  readonly rows: ReadonlyArray<ProfitReportRow>;
  readonly totals: {
    readonly revenue: ReportMoney;
    readonly expenses: ReportMoney;
    readonly profit: ReportMoney;
  };
}

interface CashflowReportPoint {
  readonly month: string;
  readonly in: ReportMoney;
  readonly out: ReportMoney;
  readonly net: ReportMoney;
}

interface CashflowReportData {
  readonly report: "cashflow";
  readonly period: ReportPeriod;
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
  readonly period: ReportPeriod;
  readonly asOf: IsoDate | null;
  readonly buckets: ReadonlyArray<{
    readonly bucket: AgingBucketKey;
    readonly count: number;
    readonly total: ReportMoney;
    readonly documents: ReadonlyArray<ReceivableDocumentRow>;
  }>;
  readonly total: ReportMoney;
  readonly overdue: { readonly total: ReportMoney; readonly count: number };
}

type VatSourceRef =
  | { readonly _tag: "Document"; readonly id: DocumentId }
  | { readonly _tag: "Expense"; readonly id: ExpenseId };

interface VatLineData {
  readonly month: string;
  readonly treatment: VatTreatment;
  readonly ratePercent: string;
  readonly base: ReportMoney;
  readonly vat: ReportMoney;
  readonly documents: ReadonlyArray<VatSourceRef>;
}

interface VatSummaryReportData {
  readonly report: "vat_summary";
  readonly period: ReportPeriod;
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

const pad2 = (n: number): string => Str.padStart(2, "0")(String(n));
const yearText = (year: number): string => Str.padStart(4, "0")(String(year));

const daysInMonth = (year: number, month1: number): number =>
  DateTime.toPartsUtc(DateTime.endOf(DateTime.makeUnsafe({ year, month: month1, day: 1 }), "month"))
    .day;

export const isValidPeriod = Schema.is(Period);

export const currentMonthPeriod = (now: Date = DateTime.toDateUtc(DateTime.nowUnsafe())): Period =>
  Period.make(`${yearText(now.getUTCFullYear())}-${pad2(now.getUTCMonth() + 1)}`);

export const periodPresets = (
  now: Date = DateTime.toDateUtc(DateTime.nowUnsafe()),
): {
  readonly thisMonth: Period;
  readonly lastMonth: Period;
  readonly thisQuarter: Period;
  readonly thisYear: Period;
  readonly lastYear: Period;
} => {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const firstSupportedMonth = y === 0 && m === 1;
  const prevY = m === 1 && !firstSupportedMonth ? y - 1 : y;
  const prevM = firstSupportedMonth ? m : m === 1 ? 12 : m - 1;
  const q = Math.floor((m - 1) / 3) + 1;
  return {
    thisMonth: Period.make(`${yearText(y)}-${pad2(m)}`),
    lastMonth: Period.make(`${yearText(prevY)}-${pad2(prevM)}`),
    thisQuarter: Period.make(`${yearText(y)}-Q${q}`),
    thisYear: Period.make(yearText(y)),
    lastYear: Period.make(yearText(Math.max(0, y - 1))),
  };
};

/** Converts a Period (`2026`, `2026-Q4`, `2026-11`) into inclusive `{ from, to }` IsoDates. */
export const periodToRange = (period: Period): { readonly from: IsoDate; readonly to: IsoDate } => {
  const yearPart = Str.slice(0, 4)(period);
  const year = Number.parseInt(yearPart, 10);
  if (period.length === 4) {
    return { from: IsoDate.make(`${yearPart}-01-01`), to: IsoDate.make(`${yearPart}-12-31`) };
  }
  if (Str.includes("-Q")(period)) {
    const q = Number.parseInt(Str.slice(6)(period), 10);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      from: IsoDate.make(`${yearPart}-${pad2(startMonth)}-01`),
      to: IsoDate.make(`${yearPart}-${pad2(endMonth)}-${pad2(daysInMonth(year, endMonth))}`),
    };
  }
  const month = Number.parseInt(Str.slice(5, 7)(period), 10);
  return {
    from: IsoDate.make(`${yearPart}-${pad2(month)}-01`),
    to: IsoDate.make(`${yearPart}-${pad2(month)}-${pad2(daysInMonth(year, month))}`),
  };
};

/** Steps a Period backwards (`delta = -1`) or forwards (`delta = 1`) in its own granularity. */
export const shiftPeriod: {
  (delta: -1 | 1): (period: Period) => Period;
  (period: Period, delta: -1 | 1): Period;
} = Fn.dual(2, (period: Period, delta: -1 | 1): Period => {
  const year = Number.parseInt(Str.slice(0, 4)(period), 10);
  const inRange = (nextYear: number, suffix = "") =>
    nextYear < 0 || nextYear > 9999 ? period : Period.make(`${yearText(nextYear)}${suffix}`);
  if (period.length === 4) return inRange(year + delta);
  if (Str.includes("-Q")(period)) {
    const q = Number.parseInt(Str.slice(6)(period), 10);
    const total = year * 4 + (q - 1) + delta;
    const ny = Math.floor(total / 4);
    const nq = (total % 4) + 1;
    return inRange(ny, `-Q${nq}`);
  }
  const month = Number.parseInt(Str.slice(5, 7)(period), 10);
  const total = year * 12 + (month - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return inRange(ny, `-${pad2(nm)}`);
});

// --- Export request builder -----------------------------------------------------------------------

export const buildReportExportRequest = (params: {
  readonly workspaceId: string;
  readonly report: ReportKind;
  readonly period: Period;
  readonly format: ExportFormat;
  readonly groupBy?: ReportGroupBy | undefined;
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

const CZK = CurrencyCode.make("CZK");
const ZERO_CZK: ReportMoney = { amount: "0", currency: CZK };

const ReportRecord = Schema.Record(Schema.String, Schema.Unknown);
const emptyReportRecord = (): typeof ReportRecord.Type => ({});
const asRecord = Fn.flow(
  Schema.decodeUnknownOption(ReportRecord),
  Option.getOrElse(emptyReportRecord),
);
const asString = Fn.flow(Schema.decodeUnknownOption(Schema.String), Option.getOrNull);
const asNumber = Fn.flow(
  Schema.decodeUnknownOption(Schema.Finite),
  Option.getOrElse(() => 0),
);
const asDate = Fn.flow(Schema.decodeUnknownOption(IsoDate), Option.getOrNull);
const asCurrency = Fn.flow(
  Schema.decodeUnknownOption(CurrencyCode),
  Option.getOrElse(() => CZK),
);
const asContactId = Fn.flow(Schema.decodeUnknownOption(ContactId), Option.getOrNull);
const asDocumentId = Fn.flow(Schema.decodeUnknownOption(DocumentId), Option.getOrNull);
const asDocumentKind = Fn.flow(
  Schema.decodeUnknownOption(DocumentKind),
  Option.getOrElse(() => "invoice" as const),
);
const asDecimal = Fn.flow(
  Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Finite])),
  Option.map((value) => Str.trim(String(value))),
  Option.filter((value) => value !== ""),
  Option.getOrElse(() => "0"),
);
const asVat = Fn.flow(
  Schema.decodeUnknownOption(VatTreatment),
  Option.getOrElse(() => "standard" as const),
);
const decodeReportKind = Schema.decodeUnknownOption(ReportKind);
const decodeAgingBucket = Schema.decodeUnknownOption(
  Schema.Literals(["not_due", "1_30", "31_60", "61_90", "over_90"]),
);
const decodeVatSource = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.TaggedStruct("Document", { id: DocumentId }),
    Schema.TaggedStruct("Expense", { id: ExpenseId }),
  ]),
);

const decodeMoney = Fn.flow(
  asRecord,
  (row): ReportMoney => ({
    amount: asDecimal(row["amount"]),
    currency: asCurrency(row["currency"]),
  }),
);

const decodePeriod = Fn.flow(
  asRecord,
  (row): ReportPeriod => ({
    from: asDate(row["from"]),
    to: asDate(row["to"]),
  }),
);

const decodeAmountRow = Fn.flow(
  asRecord,
  (row): ReportAmountRow => ({
    key: asString(row["key"]) ?? "",
    label: asString(row["label"]),
    count: asNumber(row["count"]),
    net: decodeMoney(row["net"]),
    vat: decodeMoney(row["vat"]),
    gross: decodeMoney(row["gross"]),
    original:
      row["original"] === null || row["original"] === undefined
        ? null
        : decodeMoney(row["original"]),
  }),
);

const decodeAmountTotals = Fn.flow(
  asRecord,
  (row): ReportAmountTotals => ({
    count: asNumber(row["count"]),
    net: decodeMoney(row["net"]),
    vat: decodeMoney(row["vat"]),
    gross: decodeMoney(row["gross"]),
  }),
);

const decodeVatLine = Fn.flow(asRecord, (row): VatLineData => {
  const docs = Arr.isArray(row["documents"]) ? row["documents"] : [];
  return {
    month: asString(row["month"]) ?? "",
    treatment: asVat(row["treatment"]),
    ratePercent: asDecimal(row["ratePercent"]),
    base: decodeMoney(row["base"]),
    vat: decodeMoney(row["vat"]),
    documents: Arr.flatMap(docs, (value) => {
      const decoded = decodeVatSource(value);
      return decoded._tag === "Some" ? [decoded.value] : [];
    }),
  };
});

export const decodeReportView: {
  (fallbackReport: ReportKind): (value: ReportView) => DecodedReport;
  (value: ReportView, fallbackReport: ReportKind): DecodedReport;
} = Fn.dual(2, (value: ReportView, fallbackReport: ReportKind): DecodedReport => {
  const r = asRecord(value);
  const kind = Option.getOrElse(decodeReportKind(r["report"]), () => fallbackReport);
  const period = decodePeriod(r["period"]);
  switch (kind) {
    case "revenue":
      return {
        report: "revenue",
        period,
        groupBy: r["groupBy"] === "contact" || r["groupBy"] === "currency" ? r["groupBy"] : "month",
        rows: Arr.isArray(r["rows"]) ? Arr.map(r["rows"], (row) => decodeAmountRow(row)) : [],
        totals: decodeAmountTotals(r["totals"]),
      };
    case "expenses":
      return {
        report: "expenses",
        period,
        groupBy:
          r["groupBy"] === "contact" || r["groupBy"] === "currency" || r["groupBy"] === "category"
            ? r["groupBy"]
            : "month",
        rows: Arr.isArray(r["rows"]) ? Arr.map(r["rows"], (row) => decodeAmountRow(row)) : [],
        totals: decodeAmountTotals(r["totals"]),
        incomplete: asNumber(r["incomplete"]),
      };
    case "profit": {
      const totals = asRecord(r["totals"]);
      const rows = Arr.isArray(r["rows"]) ? r["rows"] : [];
      return {
        report: "profit",
        period,
        rows: Arr.map(rows, (entry) => {
          const row = asRecord(entry);
          return {
            month: asString(row["month"]) ?? "",
            revenue: decodeMoney(row["revenue"]),
            expenses: decodeMoney(row["expenses"]),
            profit: decodeMoney(row["profit"]),
          };
        }),
        totals: {
          revenue: decodeMoney(totals["revenue"]),
          expenses: decodeMoney(totals["expenses"]),
          profit: decodeMoney(totals["profit"]),
        },
      };
    }
    case "cashflow": {
      const totals = asRecord(r["totals"]);
      const points = Arr.isArray(r["points"]) ? r["points"] : [];
      return {
        report: "cashflow",
        period,
        points: Arr.map(points, (entry) => {
          const pt = asRecord(entry);
          return {
            month: asString(pt["month"]) ?? "",
            in: decodeMoney(pt["in"]),
            out: decodeMoney(pt["out"]),
            net: decodeMoney(pt["net"]),
          };
        }),
        totals: {
          in: decodeMoney(totals["in"]),
          out: decodeMoney(totals["out"]),
          net: decodeMoney(totals["net"]),
        },
      };
    }
    case "receivables": {
      const overdue = asRecord(r["overdue"]);
      const buckets = Arr.isArray(r["buckets"]) ? r["buckets"] : [];
      return {
        report: "receivables",
        period,
        asOf: asDate(r["asOf"]) ?? period.to,
        buckets: Arr.map(buckets, (entry) => {
          const b = asRecord(entry);
          const docs = Arr.isArray(b["documents"]) ? b["documents"] : [];
          return {
            bucket: Option.getOrElse(decodeAgingBucket(b["bucket"]), () => "not_due" as const),
            count: asNumber(b["count"]),
            total: decodeMoney(b["total"]),
            documents: Arr.flatMap(docs, (d) => {
              const doc = asRecord(d);
              const id = asDocumentId(doc["id"]);
              if (id === null) return [];
              const contact = asRecord(doc["contact"]);
              return [
                {
                  id,
                  kind: asDocumentKind(doc["kind"]),
                  number: asString(doc["number"]),
                  contact: {
                    id: asContactId(contact["id"]),
                    name: asString(contact["name"]) ?? "",
                  },
                  currency: asCurrency(doc["currency"]),
                  dueOn: asDate(doc["dueOn"]),
                  daysOverdue: asNumber(doc["daysOverdue"]),
                  outstanding: decodeMoney(doc["outstanding"]),
                  outstandingCzk: decodeMoney(doc["outstandingCzk"]),
                },
              ];
            }),
          };
        }),
        total: r["total"] !== undefined ? decodeMoney(r["total"]) : ZERO_CZK,
        overdue: {
          total: overdue["total"] !== undefined ? decodeMoney(overdue["total"]) : ZERO_CZK,
          count: asNumber(overdue["count"]),
        },
      };
    }
    case "vat_summary": {
      const totals = asRecord(r["totals"]);
      return {
        report: "vat_summary",
        period,
        output: Arr.isArray(r["output"]) ? Arr.map(r["output"], (row) => decodeVatLine(row)) : [],
        input: Arr.isArray(r["input"]) ? Arr.map(r["input"], (row) => decodeVatLine(row)) : [],
        totals: {
          output: decodeMoney(totals["output"]),
          input: decodeMoney(totals["input"]),
          payable: decodeMoney(totals["payable"]),
        },
      };
    }
  }
});
