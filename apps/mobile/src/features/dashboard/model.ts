import type {
  CurrencyCode,
  DashboardView,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  DocumentView,
  IsoDate,
  ShareViewEvent,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import type { Remote } from "@kvitbit/ui-port/api";
import { BUSINESS_TIME_ZONE, parseIsoDate } from "@kvitbit/ui-port/format";
import type { Period } from "@kvitbit/ui-port/view-models";
import { BigDecimal, Option } from "effect";
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

const pad2 = (n: number): string => String(n).padStart(2, "0");

const isoOf = (year: number, month: number, day: number): IsoDate =>
  `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}` as IsoDate;

const lastDayOfMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Current calendar date in Europe/Prague (`YYYY-MM-DD`). */
export const pragueToday = (now: Date = new Date()): IsoDate => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "2026";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}` as IsoDate;
};

/** Inclusive `[from, to]` ISO dates and canonical `Period` string for a dashboard preset. */
export const periodRange = (
  preset: DashboardPeriodPreset,
  today: IsoDate,
): DashboardPeriodRange => {
  const parsed = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 };
  const { year, month } = parsed;
  switch (preset) {
    case "this_month":
      return {
        from: isoOf(year, month, 1),
        to: isoOf(year, month, lastDayOfMonth(year, month)),
        reportPeriod: `${year}-${pad2(month)}` as Period,
      };
    case "last_month": {
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonth = month === 1 ? 12 : month - 1;
      return {
        from: isoOf(prevYear, prevMonth, 1),
        to: isoOf(prevYear, prevMonth, lastDayOfMonth(prevYear, prevMonth)),
        reportPeriod: `${prevYear}-${pad2(prevMonth)}` as Period,
      };
    }
    case "this_quarter": {
      const quarter = Math.floor((month - 1) / 3) + 1;
      const startMonth = (quarter - 1) * 3 + 1;
      const endMonth = startMonth + 2;
      return {
        from: isoOf(year, startMonth, 1),
        to: isoOf(year, endMonth, lastDayOfMonth(year, endMonth)),
        reportPeriod: `${year}-Q${quarter}` as Period,
      };
    }
    case "this_year":
      return {
        from: isoOf(year, 1, 1),
        to: isoOf(year, 12, 31),
        reportPeriod: `${year}` as Period,
      };
  }
};

const toBigDecimal = (value: unknown): BigDecimal.BigDecimal | null => {
  if (BigDecimal.isBigDecimal(value)) return value;
  if (typeof value === "string") {
    return Option.getOrNull(BigDecimal.fromString(value));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigDecimal.fromNumberUnsafe(value);
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DOCUMENT_KINDS = new Set<string>([
  "invoice",
  "proforma",
  "payment_tax_document",
  "credit_note",
]);
const DOCUMENT_STATUSES = new Set<string>(["draft", "issued", "cancelled"]);
const DOCUMENT_SETTLEMENTS = new Set<string>([
  "unpaid",
  "partially_paid",
  "paid",
  "overpaid",
  "credited",
]);

/** Safely extracts a displayable document row from the branded `DocumentSummary` payload. */
export const parseDocumentSummary = (raw: unknown): DashboardDocument | null => {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? (raw.id as DocumentId) : null;
  const kind =
    typeof raw.kind === "string" && DOCUMENT_KINDS.has(raw.kind)
      ? (raw.kind as DocumentKind)
      : null;
  const status =
    typeof raw.status === "string" && DOCUMENT_STATUSES.has(raw.status)
      ? (raw.status as DocumentStatus)
      : null;
  const settlement =
    typeof raw.settlement === "string" && DOCUMENT_SETTLEMENTS.has(raw.settlement)
      ? (raw.settlement as DocumentSettlement)
      : null;
  const issuedOn = typeof raw.issuedOn === "string" ? (raw.issuedOn as IsoDate) : null;
  const dueOn = typeof raw.dueOn === "string" ? (raw.dueOn as IsoDate) : null;
  const contact = isRecord(raw.contact) ? raw.contact : null;
  const contactName = typeof contact?.name === "string" ? contact.name : "";
  const total = isRecord(raw.total) ? raw.total : null;
  const amount = toBigDecimal(total?.amount);
  const currency = typeof total?.currency === "string" ? (total.currency as CurrencyCode) : null;

  if (
    id === null ||
    kind === null ||
    status === null ||
    settlement === null ||
    issuedOn === null ||
    dueOn === null ||
    amount === null ||
    currency === null
  ) {
    return null;
  }

  return {
    id,
    kind,
    number: typeof raw.number === "string" ? raw.number : null,
    status,
    locked: raw.locked === true,
    settlement,
    overdue: raw.overdue === true,
    contactName,
    issuedOn,
    dueOn,
    total: { amount, currency },
  };
};

export const parseDocumentSummaries = (
  items: ReadonlyArray<unknown>,
): ReadonlyArray<DashboardDocument> =>
  items.flatMap((item) => {
    const parsed = parseDocumentSummary(item);
    return parsed === null ? [] : [parsed];
  });

export const mostOverdueDocuments = (report: ReceivablesReportData) =>
  report.buckets
    .flatMap((bucket) => bucket.documents.filter((document) => document.daysOverdue > 0))
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, DASHBOARD_LIST_LIMIT);

export const documentActivity = (
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
    if (
      isRecord(payment) &&
      typeof payment.id === "string" &&
      typeof payment.createdAt === "string"
    ) {
      events.push({ id: `paid:${payment.id}`, document, kind: "paid", at: payment.createdAt });
    }
  }
  return events.filter(({ at }) => Number.isFinite(Date.parse(at)));
};

/** Returns a clamped 0..1 ratio for rendering cashflow bars without NaN/Infinity. */
export const cashflowBarRatio = (
  value: BigDecimal.BigDecimal,
  max: BigDecimal.BigDecimal,
): number => {
  const num = Math.abs(BigDecimal.toNumberUnsafe(value));
  const denom = Math.abs(BigDecimal.toNumberUnsafe(max));
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return 0;
  return Math.max(0, Math.min(1, num / denom));
};

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

export const isWorkspaceEmpty = (
  documents: Remote<RecentDashboardDocuments>,
  hasExpenses: Remote<boolean>,
): boolean =>
  documents._tag === "Ready" &&
  !documents.refreshing &&
  !documents.value.hasDocuments &&
  hasExpenses._tag === "Ready" &&
  !hasExpenses.refreshing &&
  !hasExpenses.value;

export const canWriteWorkspace = (workspace: WorkspaceSummary): boolean =>
  !workspace.closed && workspace.role !== "accountant";
