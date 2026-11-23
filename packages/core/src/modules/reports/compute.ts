/**
 * Pure report builders (core-ports 4.9, user-flows group 9). Inputs are `ReportsSource` rows;
 * every figure is CZK from the fixing stored on the row (`Fx.toCzk`, rounded half away from
 * zero to haléře), and VAT stays per rate bucket: a bucket's CZK VAT is its stored `vatCzk`,
 * never recomputed from a document total (board #377).
 */
import type {
  CashflowPoint,
  CurrencyCode,
  DashboardView,
  DocumentId,
  ExpenseId,
  IsoDate,
  Money,
  VatBucket,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { addMonths, daysBetween } from "../../engines/calendar";
import { HUNDRED, roundAt, sumAll, ZERO } from "../../engines/decimal";
import { Fx } from "../../engines/fx";
import { TREATMENTS } from "../../engines/vat";
import type { ReportDocument, ReportExpense, ReportPayment, StoredFx } from "./source";
import type {
  AgingBucket,
  AmountRow,
  CashflowView,
  ExpensesView,
  ProfitView,
  ReceivableRow,
  ReceivablesView,
  RevenueView,
  VatLine,
  VatSummaryView,
} from "./views";

export const CZK = "CZK" as CurrencyCode;
export const czk = (amount: BigDecimal.BigDecimal): Money => ({
  amount: BigDecimal.normalize(amount),
  currency: CZK,
});

export interface Period {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

// CZK conversion ------------------------------------------------------------------------------

/** `amount` (in `currency`) in CZK with the row's stored fixing. */
export const toCzk = (
  amount: BigDecimal.BigDecimal,
  currency: CurrencyCode,
  fx: StoredFx | null,
): BigDecimal.BigDecimal => {
  if (currency === CZK) return roundAt(amount, 2);
  if (fx === null) {
    // ReportsSource guarantees a stored fixing on every non-CZK row (Documents/Payments resolve
    // it before persisting, board #360); a missing one is a bug, not a user error.
    throw new Error(`reports: ${currency} row without a stored fixing`);
  }
  return Fx.toCzk(amount, fx);
};

const bucketBaseCzk = (b: VatBucket, currency: CurrencyCode, fx: StoredFx | null) =>
  toCzk(b.base, currency, fx);

/** The bucket's stored CZK VAT; converted only when the row predates stored `vatCzk`. */
const bucketVatCzk = (b: VatBucket, currency: CurrencyCode, fx: StoredFx | null) =>
  currency === CZK ? roundAt(b.vat, 2) : (b.vatCzk ?? toCzk(b.vat, currency, fx));

const documentNetVatCzk = (d: ReportDocument) => {
  const net = sumAll(d.totals.buckets.map((b) => bucketBaseCzk(b, d.currency, d.fx)));
  const vat = sumAll(d.totals.buckets.map((b) => bucketVatCzk(b, d.currency, d.fx)));
  return { net, vat };
};

const expenseNetVatCzk = (e: ReportExpense) => {
  const net = sumAll(e.totals.buckets.map((b) => bucketBaseCzk(b, e.currency, e.fx)));
  const vat = sumAll(e.totals.buckets.map((b) => bucketVatCzk(b, e.currency, e.fx)));
  return { net, vat };
};

// Ordering helpers ----------------------------------------------------------------------------

/** Code-unit order (locale independent, so output is byte-identical everywhere). */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const monthOf = (date: IsoDate): string => date.slice(0, 7);

/** Every month `YYYY-MM` from `from`'s month to `to`'s month, oldest first. */
export const monthsBetween = (from: IsoDate, to: IsoDate): ReadonlyArray<string> => {
  const months: Array<string> = [];
  let cursor = `${monthOf(from)}-01` as IsoDate;
  const last = monthOf(to);
  while (monthOf(cursor) <= last) {
    months.push(monthOf(cursor));
    cursor = addMonths(cursor, 1);
  }
  return months;
};

// Revenue and expenses ------------------------------------------------------------------------

interface Grouped {
  key: string;
  label: string | null;
  count: number;
  net: Array<BigDecimal.BigDecimal>;
  vat: Array<BigDecimal.BigDecimal>;
  original: Array<BigDecimal.BigDecimal>;
}

const groupRows = (
  items: ReadonlyArray<{
    readonly key: string;
    readonly label: string | null;
    readonly net: BigDecimal.BigDecimal;
    readonly vat: BigDecimal.BigDecimal;
    readonly gross: BigDecimal.BigDecimal;
    readonly currency: CurrencyCode;
  }>,
  byCurrency: boolean,
): ReadonlyArray<AmountRow> => {
  const groups = new Map<string, Grouped>();
  for (const item of items) {
    const group = groups.get(item.key) ?? {
      key: item.key,
      label: item.label,
      count: 0,
      net: [],
      vat: [],
      original: [],
    };
    group.count += 1;
    group.net.push(item.net);
    group.vat.push(item.vat);
    group.original.push(item.gross);
    groups.set(item.key, group);
  }
  return [...groups.values()]
    .sort((a, b) => compareStrings(a.key, b.key))
    .map((g) => {
      const net = sumAll(g.net);
      const vat = sumAll(g.vat);
      return {
        key: g.key,
        label: g.label,
        count: g.count,
        net: czk(net),
        vat: czk(vat),
        gross: czk(BigDecimal.sum(net, vat)),
        original: byCurrency
          ? {
              amount: BigDecimal.normalize(sumAll(g.original)),
              currency: g.key as CurrencyCode,
            }
          : null,
      };
    });
};

const totalsOf = (rows: ReadonlyArray<AmountRow>) => {
  const net = sumAll(rows.map((r) => r.net.amount));
  const vat = sumAll(rows.map((r) => r.vat.amount));
  return {
    count: rows.reduce((n, r) => n + r.count, 0),
    net: czk(net),
    vat: czk(vat),
    gross: czk(BigDecimal.sum(net, vat)),
  };
};

/** Documents that count as revenue: issued Invoices (Final Invoices once, in full) and Credit Notes. */
export const isRevenueDocument = (d: ReportDocument): boolean =>
  d.status === "issued" && (d.kind === "invoice" || d.kind === "credit_note");

export const revenue = (
  documents: ReadonlyArray<ReportDocument>,
  period: Period,
  groupBy: RevenueView["groupBy"],
): RevenueView => {
  const items = documents
    .filter((d) => isRevenueDocument(d) && period.from <= d.issuedOn && d.issuedOn <= period.to)
    .map((d) => {
      const { net, vat } = documentNetVatCzk(d);
      const key =
        groupBy === "month"
          ? monthOf(d.issuedOn)
          : groupBy === "currency"
            ? d.currency
            : (d.contact.id ?? `name:${d.contact.name}`);
      const label = groupBy === "contact" ? d.contact.name : null;
      return { key, label, net, vat, gross: d.totals.gross.amount, currency: d.currency };
    });
  const rows = groupRows(items, groupBy === "currency");
  return { report: "revenue", period, groupBy, rows, totals: totalsOf(rows) };
};

export const expenses = (
  records: ReadonlyArray<ReportExpense>,
  period: Period,
  groupBy: ExpensesView["groupBy"],
  incomplete: number,
): ExpensesView => {
  const items = records
    .filter((e) => period.from <= e.issuedOn && e.issuedOn <= period.to)
    .map((e) => {
      const { net, vat } = expenseNetVatCzk(e);
      const supplierKey =
        e.supplier === null
          ? ""
          : (e.supplier.contactId ?? (e.supplier.name === null ? "" : `name:${e.supplier.name}`));
      const key =
        groupBy === "month"
          ? monthOf(e.issuedOn)
          : groupBy === "currency"
            ? e.currency
            : groupBy === "category"
              ? (e.category ?? "")
              : supplierKey;
      const label =
        groupBy === "contact"
          ? (e.supplier?.name ?? null)
          : groupBy === "category"
            ? e.category
            : null;
      return { key, label, net, vat, gross: e.totals.gross.amount, currency: e.currency };
    });
  const rows = groupRows(items, groupBy === "currency");
  return { report: "expenses", period, groupBy, rows, totals: totalsOf(rows), incomplete };
};

export const profit = (
  documents: ReadonlyArray<ReportDocument>,
  records: ReadonlyArray<ReportExpense>,
  period: Period,
): ProfitView => {
  const rev = revenue(documents, period, "month");
  const exp = expenses(records, period, "month", 0);
  const revByMonth = new Map(rev.rows.map((r) => [r.key, r.net.amount]));
  const expByMonth = new Map(exp.rows.map((r) => [r.key, r.net.amount]));
  const rows = monthsBetween(period.from, period.to).map((month) => {
    const r = revByMonth.get(month) ?? ZERO;
    const e = expByMonth.get(month) ?? ZERO;
    return { month, revenue: czk(r), expenses: czk(e), profit: czk(BigDecimal.subtract(r, e)) };
  });
  const r = rev.totals.net.amount;
  const e = exp.totals.net.amount;
  return {
    report: "profit",
    period,
    rows,
    totals: { revenue: czk(r), expenses: czk(e), profit: czk(BigDecimal.subtract(r, e)) },
  };
};

// Cashflow ------------------------------------------------------------------------------------

export const cashflowPoints = (
  payments: ReadonlyArray<ReportPayment>,
  months: ReadonlyArray<string>,
): ReadonlyArray<CashflowPoint> => {
  const sums = new Map(
    months.map((m) => [
      m,
      { in: [] as Array<BigDecimal.BigDecimal>, out: [] as Array<BigDecimal.BigDecimal> },
    ]),
  );
  for (const p of payments) {
    const slot = sums.get(monthOf(p.paidOn));
    if (slot === undefined) continue;
    slot[p.direction].push(toCzk(p.amount.amount, p.amount.currency, p.fx));
  }
  return months.map((month) => {
    const slot = sums.get(month);
    const inflow = sumAll(slot?.in ?? []);
    const outflow = sumAll(slot?.out ?? []);
    return {
      month,
      in: czk(inflow),
      out: czk(outflow),
      net: czk(BigDecimal.subtract(inflow, outflow)),
    };
  });
};

export const cashflow = (payments: ReadonlyArray<ReportPayment>, period: Period): CashflowView => {
  const points = cashflowPoints(
    payments.filter((p) => period.from <= p.paidOn && p.paidOn <= period.to),
    monthsBetween(period.from, period.to),
  );
  const inflow = sumAll(points.map((p) => p.in.amount));
  const outflow = sumAll(points.map((p) => p.out.amount));
  return {
    report: "cashflow",
    period,
    points,
    totals: { in: czk(inflow), out: czk(outflow), net: czk(BigDecimal.subtract(inflow, outflow)) },
  };
};

// Receivables aging ---------------------------------------------------------------------------

export const AGING_BUCKETS: ReadonlyArray<AgingBucket> = [
  "not_due",
  "1_30",
  "31_60",
  "61_90",
  "over_90",
];

/** Flow 9.5: not due, 1 to 30, 31 to 60, 61 to 90, over 90 days past due. */
export const agingBucket = (daysOverdue: number): AgingBucket =>
  daysOverdue <= 0
    ? "not_due"
    : daysOverdue <= 30
      ? "1_30"
      : daysOverdue <= 60
        ? "31_60"
        : daysOverdue <= 90
          ? "61_90"
          : "over_90";

const receivableRow = (d: ReportDocument, asOf: IsoDate): ReceivableRow => ({
  id: d.id,
  kind: d.kind,
  number: d.number,
  contact: { id: d.contact.id, name: d.contact.name },
  currency: d.currency,
  dueOn: d.dueOn,
  daysOverdue: d.dueOn === null ? 0 : Math.max(0, daysBetween(d.dueOn, asOf)),
  outstanding: { amount: BigDecimal.normalize(d.outstanding), currency: d.currency },
  outstandingCzk: czk(toCzk(d.outstanding, d.currency, d.fx)),
});

/** Most overdue first, then number, then id. */
const compareReceivables = (a: ReceivableRow, b: ReceivableRow) =>
  b.daysOverdue - a.daysOverdue ||
  compareStrings(a.number ?? "", b.number ?? "") ||
  compareStrings(a.id, b.id);

export const receivables = (
  open: ReadonlyArray<ReportDocument>,
  period: Period,
  asOf: IsoDate,
): ReceivablesView => {
  const rows = open
    .filter((d) => d.status === "issued" && BigDecimal.isPositive(d.outstanding))
    .map((d) => receivableRow(d, asOf))
    .sort(compareReceivables);
  const buckets = AGING_BUCKETS.map((bucket) => {
    const documents = rows.filter((r) => agingBucket(r.daysOverdue) === bucket);
    return {
      bucket,
      count: documents.length,
      total: czk(sumAll(documents.map((r) => r.outstandingCzk.amount))),
      documents,
    };
  });
  const overdue = rows.filter((r) => r.daysOverdue > 0);
  return {
    report: "receivables",
    period,
    asOf,
    buckets,
    total: czk(sumAll(rows.map((r) => r.outstandingCzk.amount))),
    overdue: {
      total: czk(sumAll(overdue.map((r) => r.outstandingCzk.amount))),
      count: overdue.length,
    },
  };
};

// VAT summary ---------------------------------------------------------------------------------

/** Kinds whose VAT enters the summary (Proformas are not tax documents). */
const TAX_DOCUMENT_KINDS = new Set(["invoice", "payment_tax_document", "credit_note"]);

interface VatAccumulator {
  month: string;
  treatment: VatTreatment;
  ratePercent: BigDecimal.BigDecimal;
  base: Array<BigDecimal.BigDecimal>;
  vat: Array<BigDecimal.BigDecimal>;
  documents: Set<DocumentId | ExpenseId>;
}

const bucketKey = (month: string, treatment: VatTreatment, rate: BigDecimal.BigDecimal) =>
  `${month}|${treatment}|${BigDecimal.format(BigDecimal.normalize(rate))}`;

const addLine = (
  lines: Map<string, VatAccumulator>,
  month: string,
  b: VatBucket,
  base: BigDecimal.BigDecimal,
  vat: BigDecimal.BigDecimal,
  documentId: DocumentId | ExpenseId,
) => {
  const key = bucketKey(month, b.treatment, b.ratePercent);
  const line = lines.get(key) ?? {
    month,
    treatment: b.treatment,
    ratePercent: BigDecimal.normalize(b.ratePercent),
    base: [],
    vat: [],
    documents: new Set<DocumentId | ExpenseId>(),
  };
  line.base.push(base);
  line.vat.push(vat);
  line.documents.add(documentId);
  lines.set(key, line);
};

const treatmentOrder = (t: VatTreatment) => TREATMENTS.indexOf(t);

/** Month, then treatment in `TREATMENTS` order, then rate descending. */
const finish = (lines: Map<string, VatAccumulator>): ReadonlyArray<VatLine> =>
  [...lines.values()]
    .sort(
      (a, b) =>
        compareStrings(a.month, b.month) ||
        treatmentOrder(a.treatment) - treatmentOrder(b.treatment) ||
        (BigDecimal.isLessThan(a.ratePercent, b.ratePercent)
          ? 1
          : BigDecimal.isGreaterThan(a.ratePercent, b.ratePercent)
            ? -1
            : 0),
    )
    .map((l) => ({
      month: l.month,
      treatment: l.treatment,
      ratePercent: l.ratePercent,
      base: czk(sumAll(l.base)),
      vat: czk(sumAll(l.vat)),
      documents: [...l.documents].sort(compareStrings),
    }));

const deductible = (vatCzk: BigDecimal.BigDecimal, percent: number) =>
  percent >= 100
    ? vatCzk
    : roundAt(
        BigDecimal.divideUnsafe(
          BigDecimal.multiply(vatCzk, BigDecimal.fromBigInt(BigInt(Math.round(percent)))),
          HUNDRED,
        ),
        2,
      );

/**
 * Output VAT per tax-point month and rate bucket from issued tax documents (Credit Notes signed
 * negative, Final Invoice advances netted) plus self-assessed reverse charge on Expenses; input
 * VAT from Expenses, deductible share rounded once per bucket.
 */
export const vatSummary = (
  documents: ReadonlyArray<ReportDocument>,
  records: ReadonlyArray<ReportExpense>,
  period: Period,
): VatSummaryView => {
  const output = new Map<string, VatAccumulator>();
  const input = new Map<string, VatAccumulator>();
  const inPeriod = (date: IsoDate | null): date is IsoDate =>
    date !== null && period.from <= date && date <= period.to;

  for (const d of documents) {
    if (d.status !== "issued" || !TAX_DOCUMENT_KINDS.has(d.kind) || !inPeriod(d.taxPoint)) {
      continue;
    }
    const month = monthOf(d.taxPoint);
    for (const b of d.totals.buckets) {
      addLine(
        output,
        month,
        b,
        bucketBaseCzk(b, d.currency, d.fx),
        bucketVatCzk(b, d.currency, d.fx),
        d.id,
      );
    }
    if (d.finalInvoice) {
      for (const b of d.advanceDeductions) {
        addLine(
          output,
          month,
          b,
          BigDecimal.negate(bucketBaseCzk(b, d.currency, d.fx)),
          BigDecimal.negate(bucketVatCzk(b, d.currency, d.fx)),
          d.id,
        );
      }
    }
  }

  for (const e of records) {
    if (!inPeriod(e.taxPoint)) continue;
    const month = monthOf(e.taxPoint);
    for (const b of e.totals.buckets) {
      if (b.treatment === "outside_scope" || b.treatment === "reverse_charge") continue;
      const vat = bucketVatCzk(b, e.currency, e.fx);
      addLine(
        input,
        month,
        b,
        bucketBaseCzk(b, e.currency, e.fx),
        deductible(vat, e.deductiblePercent),
        e.id,
      );
    }
    for (const b of e.selfAssessed) {
      const base = bucketBaseCzk(b, e.currency, e.fx);
      const vat = bucketVatCzk(b, e.currency, e.fx);
      addLine(output, month, b, base, vat, e.id);
      addLine(input, month, b, base, deductible(vat, e.deductiblePercent), e.id);
    }
  }

  const outputLines = finish(output);
  const inputLines = finish(input);
  const outputVat = sumAll(outputLines.map((l) => l.vat.amount));
  const inputVat = sumAll(inputLines.map((l) => l.vat.amount));
  return {
    report: "vat_summary",
    period,
    output: outputLines,
    input: inputLines,
    totals: {
      output: czk(outputVat),
      input: czk(inputVat),
      payable: czk(BigDecimal.subtract(outputVat, inputVat)),
    },
  };
};

// Dashboard -----------------------------------------------------------------------------------

export const dashboard = (input: {
  readonly period: Period;
  readonly today: IsoDate;
  readonly issued: ReadonlyArray<ReportDocument>;
  readonly open: ReadonlyArray<ReportDocument>;
  readonly expenses: ReadonlyArray<ReportExpense>;
  readonly incompleteExpenses: number;
  readonly payments: ReadonlyArray<ReportPayment>;
  readonly months: ReadonlyArray<string>;
}): DashboardView => {
  const aging = receivables(input.open, input.period, input.today);
  return {
    period: input.period,
    revenue: revenue(input.issued, input.period, "month").totals.net,
    unpaid: aging.total,
    overdue: aging.overdue,
    expenses: expenses(input.expenses, input.period, "month", 0).totals.net,
    incompleteExpenses: input.incompleteExpenses,
    cashflow: cashflowPoints(input.payments, input.months),
  };
};

/** The 12 months ending at `to`'s month, oldest first, and the date range they span. */
export const twelveMonthsEnding = (to: IsoDate) => {
  const first = addMonths(`${monthOf(to)}-01` as IsoDate, -11);
  const months = monthsBetween(first, to);
  return { months, from: first };
};
