import {
  CurrencyCode,
  type DashboardView,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  type DocumentView,
  IsoDate,
  type ShareViewEvent,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import type { Remote } from "@kvitbit/ui-port/api";
import { BUSINESS_TIME_ZONE, parseIsoDate } from "@kvitbit/ui-port/format";
import { Period } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { ReceivablesReportData } from "../reports/model";

export const DASHBOARD_LIST_LIMIT = 5;

export type DashboardPeriodPreset = "this_month" | "last_month" | "this_quarter" | "this_year";

export interface DashboardPeriodRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly reportPeriod: Period;
}

export interface DashboardDocument {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly number: string | null;
  readonly status: DocumentStatus;
  readonly locked: boolean;
  readonly settlement: DocumentSettlement;
  readonly overdue: boolean;
  readonly contactName: string;
  readonly issuedOn: IsoDate;
  readonly dueOn: IsoDate;
  readonly total: { readonly amount: BigDecimal.BigDecimal; readonly currency: CurrencyCode };
}

export interface RecentDashboardDocuments {
  readonly items: ReadonlyArray<DashboardDocument>;
  readonly hasDocuments: boolean;
}

export interface DashboardActivity {
  readonly id: string;
  readonly document: DashboardDocument;
  readonly kind: "sent" | "viewed" | "paid";
  readonly at: string;
}

const pad2 = (n: number): string => Str.padStart(2, "0")(String(n));

const isoOf = (year: number, month: number, day: number): IsoDate =>
  IsoDate.make(`${Str.padStart(4, "0")(String(year))}-${pad2(month)}-${pad2(day)}`);

const lastDayOfMonth = (year: number, month: number): number =>
  DateTime.toPartsUtc(DateTime.endOf(DateTime.makeUnsafe({ year, month, day: 1 }), "month")).day;

/** Current calendar date in Europe/Prague (`YYYY-MM-DD`). */
export const pragueToday = (now: Date = DateTime.toDateUtc(DateTime.nowUnsafe())): IsoDate => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year =
    Option.getOrUndefined(Arr.findFirst(parts, (p) => p.type === "year"))?.value ?? "2026";
  const month =
    Option.getOrUndefined(Arr.findFirst(parts, (p) => p.type === "month"))?.value ?? "01";
  const day = Option.getOrUndefined(Arr.findFirst(parts, (p) => p.type === "day"))?.value ?? "01";
  return IsoDate.make(`${year}-${month}-${day}`);
};

/** Inclusive `[from, to]` ISO dates and canonical `Period` string for a dashboard preset. */
export const periodRange: {
  (today: IsoDate): (preset: DashboardPeriodPreset) => DashboardPeriodRange;
  (preset: DashboardPeriodPreset, today: IsoDate): DashboardPeriodRange;
} = Fn.dual(2, (preset: DashboardPeriodPreset, today: IsoDate): DashboardPeriodRange => {
  const parsed = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 };
  const { year, month } = parsed;
  switch (preset) {
    case "this_month":
      return {
        from: isoOf(year, month, 1),
        to: isoOf(year, month, lastDayOfMonth(year, month)),
        reportPeriod: Period.make(`${year}-${pad2(month)}`),
      };
    case "last_month": {
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonth = month === 1 ? 12 : month - 1;
      return {
        from: isoOf(prevYear, prevMonth, 1),
        to: isoOf(prevYear, prevMonth, lastDayOfMonth(prevYear, prevMonth)),
        reportPeriod: Period.make(`${prevYear}-${pad2(prevMonth)}`),
      };
    }
    case "this_quarter": {
      const quarter = Math.floor((month - 1) / 3) + 1;
      const startMonth = (quarter - 1) * 3 + 1;
      const endMonth = startMonth + 2;
      return {
        from: isoOf(year, startMonth, 1),
        to: isoOf(year, endMonth, lastDayOfMonth(year, endMonth)),
        reportPeriod: Period.make(`${year}-Q${quarter}`),
      };
    }
    case "this_year":
      return {
        from: isoOf(year, 1, 1),
        to: isoOf(year, 12, 31),
        reportPeriod: Period.make(`${year}`),
      };
  }
});

const decodeDocumentSummary = Schema.decodeUnknownOption(
  Schema.Struct({
    id: DocumentId,
    kind: DocumentKind,
    status: DocumentStatus,
    settlement: DocumentSettlement,
    issuedOn: IsoDate,
    dueOn: IsoDate,
    total: Schema.Struct({
      amount: Schema.Union([Schema.BigDecimal, Schema.BigDecimalFromString, Schema.Finite]),
      currency: CurrencyCode,
    }),
    number: Schema.optional(Schema.Unknown),
    contact: Schema.optional(Schema.Unknown),
    locked: Schema.optional(Schema.Unknown),
    overdue: Schema.optional(Schema.Unknown),
  }),
);
const decodeContactName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }));
const decodeDocumentNumber = Schema.decodeUnknownOption(Schema.String);
const decodePaymentActivity = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.String, createdAt: Schema.String }),
);

export const parseDocumentSummaries = (
  items: ReadonlyArray<unknown>,
): ReadonlyArray<DashboardDocument> =>
  Arr.flatMap(items, (item) => {
    const decoded = decodeDocumentSummary(item);
    if (decoded._tag === "None") return [];
    const row = decoded.value;
    return [
      {
        id: row.id,
        kind: row.kind,
        number: Option.getOrNull(decodeDocumentNumber(row.number)),
        status: row.status,
        locked: row.locked === true,
        settlement: row.settlement,
        overdue: row.overdue === true,
        contactName: Option.match(decodeContactName(row.contact), {
          onNone: () => "",
          onSome: (contact) => contact.name,
        }),
        issuedOn: row.issuedOn,
        dueOn: row.dueOn,
        total: {
          amount: BigDecimal.isBigDecimal(row.total.amount)
            ? row.total.amount
            : BigDecimal.fromNumberUnsafe(row.total.amount),
          currency: row.total.currency,
        },
      },
    ];
  });

export const mostOverdueDocuments = (report: ReceivablesReportData) =>
  Arr.flatMap(report.buckets, (bucket) =>
    Arr.filter(bucket.documents, (document) => document.daysOverdue > 0),
  )
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, DASHBOARD_LIST_LIMIT);

export const documentActivity: {
  (
    detail: Pick<DocumentView, "deliveries">,
    payments: ReadonlyArray<unknown>,
    views: ReadonlyArray<ShareViewEvent>,
  ): (document: DashboardDocument) => ReadonlyArray<DashboardActivity>;
  (
    document: DashboardDocument,
    detail: Pick<DocumentView, "deliveries">,
    payments: ReadonlyArray<unknown>,
    views: ReadonlyArray<ShareViewEvent>,
  ): ReadonlyArray<DashboardActivity>;
} = Fn.dual(
  4,
  (
    document: DashboardDocument,
    detail: Pick<DocumentView, "deliveries">,
    payments: ReadonlyArray<unknown>,
    views: ReadonlyArray<ShareViewEvent>,
  ): ReadonlyArray<DashboardActivity> => {
    const events: DashboardActivity[] = [];
    for (const delivery of detail.deliveries) {
      if (delivery.status === "sent" && delivery.purpose === "document") {
        events.push({ id: `sent:${delivery.id}`, document, kind: "sent", at: delivery.at });
      }
    }
    for (const view of views) {
      if (view.kind === "view") {
        events.push({ id: `viewed:${view.id}`, document, kind: "viewed", at: view.at });
      }
    }
    for (const payment of payments) {
      const decoded = decodePaymentActivity(payment);
      if (decoded._tag === "Some") {
        const { id, createdAt } = decoded.value;
        events.push({ id: `paid:${id}`, document, kind: "paid", at: createdAt });
      }
    }
    return Arr.filter(events, ({ at }) => Option.isSome(DateTime.make(at)));
  },
);

/** Returns a clamped 0..1 ratio for rendering cashflow bars without NaN/Infinity. */
export const cashflowBarRatio: {
  (max: BigDecimal.BigDecimal): (value: BigDecimal.BigDecimal) => number;
  (value: BigDecimal.BigDecimal, max: BigDecimal.BigDecimal): number;
} = Fn.dual(2, (value: BigDecimal.BigDecimal, max: BigDecimal.BigDecimal): number => {
  const num = Math.abs(BigDecimal.toNumberUnsafe(value));
  const denom = Math.abs(BigDecimal.toNumberUnsafe(max));
  if (!(Number.isFinite(num) && Number.isFinite(denom)) || denom <= 0) return 0;
  return Math.max(0, Math.min(1, num / denom));
});

export const maxCashflowAmount = (points: DashboardView["cashflow"]): BigDecimal.BigDecimal => {
  let max = BigDecimal.fromNumberUnsafe(0);
  for (const point of points) {
    const absIn = BigDecimal.abs(point.in.amount);
    const absOut = BigDecimal.abs(point.out.amount);
    if (BigDecimal.isGreaterThan(absIn, max)) max = absIn;
    if (BigDecimal.isGreaterThan(absOut, max)) max = absOut;
  }
  return max;
};

export const isWorkspaceEmpty: {
  (hasExpenses: Remote<boolean>): (documents: Remote<RecentDashboardDocuments>) => boolean;
  (documents: Remote<RecentDashboardDocuments>, hasExpenses: Remote<boolean>): boolean;
} = Fn.dual(
  2,
  (documents: Remote<RecentDashboardDocuments>, hasExpenses: Remote<boolean>): boolean =>
    documents._tag === "Ready" &&
    !documents.refreshing &&
    !documents.value.hasDocuments &&
    hasExpenses._tag === "Ready" &&
    !hasExpenses.refreshing &&
    !hasExpenses.value,
);

export const canWriteWorkspace = (workspace: WorkspaceSummary): boolean =>
  !workspace.closed && workspace.role !== "accountant";
