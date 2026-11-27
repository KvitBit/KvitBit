/**
 * Pure report builders (core-ports 4.9, user-flows group 9). Inputs are `ReportsSource` rows;
 * every figure is CZK from the fixing stored on the row (`Fx.toCzk`, rounded half away from
 * zero to haléře), and VAT stays per rate bucket: a bucket's CZK VAT is its stored `vatCzk`,
 * never recomputed from a document total (board #377).
 */

import type {
  CashflowPoint,
  DashboardView,
  Money,
  TaxRegime,
  VatBucket,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectString from "effect/String";
import { daysBetween } from "../../engines/calendar";
import { HUNDRED, roundAt, sumAll, ZERO } from "../../engines/decimal";
import { Fx } from "../../engines/fx";
import { TREATMENTS } from "../../engines/vat";
import type {
  ReportDocument,
  ReportExpense,
  ReportPayment,
  StoredFx,
  TaxRegimePeriod,
} from "./source";
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
  VatSource,
  VatSummaryView,
} from "./views";

export const CZK = CurrencyCode.make("CZK");
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
export const toCzk: {
  (
    currency: CurrencyCode,
    fx: StoredFx | null,
  ): (amount: BigDecimal.BigDecimal) => BigDecimal.BigDecimal;
  (
    amount: BigDecimal.BigDecimal,
    currency: CurrencyCode,
    fx: StoredFx | null,
  ): BigDecimal.BigDecimal;
} = Fn.dual(
  3,
  (
    amount: BigDecimal.BigDecimal,
    currency: CurrencyCode,
    fx: StoredFx | null,
  ): BigDecimal.BigDecimal => {
    if (currency === CZK) return roundAt(amount, 2);
    // ReportsSource guarantees a stored fixing on every non-CZK row.
    const fixing = Option.getOrThrowWith(
      Option.fromNullOr(fx),
      () => new Error(`reports: ${currency} row without a stored fixing`),
    );
    return Fx.toCzk(amount, fixing);
  },
);

const bucketBaseCzk = (b: VatBucket, currency: CurrencyCode, fx: StoredFx | null) =>
  toCzk(b.base, currency, fx);

/** The bucket's stored CZK VAT; converted only when the row predates stored `vatCzk`. */
const bucketVatCzk = (b: VatBucket, currency: CurrencyCode, fx: StoredFx | null) =>
  currency === CZK ? roundAt(b.vat, 2) : (b.vatCzk ?? toCzk(b.vat, currency, fx));

/** A rate bucket's CZK figures. */
interface CzkBucket {
  readonly treatment: VatTreatment;
  readonly ratePercent: BigDecimal.BigDecimal;
  readonly base: BigDecimal.BigDecimal;
  readonly vat: BigDecimal.BigDecimal;
}

const rateKey = (treatment: VatTreatment, rate: BigDecimal.BigDecimal) =>
  `${treatment}|${rate.pipe(BigDecimal.normalize, BigDecimal.format)}`;

/** The full supply per bucket in CZK (revenue, expenses: no advance netting). */
const fullBucketsCzk = (
  buckets: ReadonlyArray<VatBucket>,
  currency: CurrencyCode,
  fx: StoredFx | null,
): ReadonlyArray<CzkBucket> =>
  EffectArray.map(buckets, (b) => ({
    treatment: b.treatment,
    ratePercent: b.ratePercent,
    base: bucketBaseCzk(b, currency, fx),
    vat: bucketVatCzk(b, currency, fx),
  }));

/**
 * The document's taxable amounts per bucket in CZK after advance deductions. Without
 * deductions each bucket keeps its stored `vatCzk`. With deductions (Final Invoice, or a Credit
 * Note reversing one) base, VAT and CZK VAT are netted per bucket: the deductions carry their
 * CZK VAT at the document's own fixing (`reportFigures`), so the net CZK VAT is exactly the
 * document's stored net CZK VAT, which Documents' compose converts once at that fixing
 * (D8, VatMath rule 9; the advances keep theirs on their PTDs). Without CZK VAT on a bucket the
 * net VAT is converted at the document's fixing.
 */
export const taxableBucketsCzk = (d: ReportDocument): ReadonlyArray<CzkBucket> => {
  if (d.advanceDeductions.length === 0) return fullBucketsCzk(d.totals.buckets, d.currency, d.fx);
  const net = new Map<
    string,
    {
      treatment: VatTreatment;
      ratePercent: BigDecimal.BigDecimal;
      base: BigDecimal.BigDecimal;
      vat: BigDecimal.BigDecimal;
      vatCzk: BigDecimal.BigDecimal | null;
    }
  >();
  const add = (b: VatBucket, sign: 1 | -1) => {
    const key = rateKey(b.treatment, b.ratePercent);
    const slot = net.get(key) ?? {
      treatment: b.treatment,
      ratePercent: b.ratePercent,
      base: ZERO,
      vat: ZERO,
      vatCzk: ZERO,
    };
    const signed = (v: BigDecimal.BigDecimal) => (sign === 1 ? v : BigDecimal.negate(v));
    slot.base = BigDecimal.sum(slot.base, signed(b.base));
    slot.vat = BigDecimal.sum(slot.vat, signed(b.vat));
    slot.vatCzk =
      slot.vatCzk === null || b.vatCzk === null
        ? null
        : BigDecimal.sum(slot.vatCzk, signed(b.vatCzk));
    net.set(key, slot);
  };
  for (const b of d.totals.buckets) add(b, 1);
  for (const b of d.advanceDeductions) add(b, -1);
  return EffectArray.map([...net.values()], (b) => ({
    treatment: b.treatment,
    ratePercent: b.ratePercent,
    base: toCzk(b.base, d.currency, d.fx),
    vat:
      d.currency === CZK || b.vatCzk === null
        ? toCzk(b.vat, d.currency, d.fx)
        : BigDecimal.normalize(b.vatCzk),
  }));
};

const sumCzk = (buckets: ReadonlyArray<CzkBucket>) => ({
  net: sumAll(EffectArray.map(buckets, (b) => b.base)),
  vat: sumAll(EffectArray.map(buckets, (b) => b.vat)),
});

// Tax Regime -----------------------------------------------------------------------------------

/**
 * The regime in force on `date` (W2), as Workspaces and Documents resolve it: the latest entry
 * effective on or before `date` (the last in stored order on a tie); before the first entry, the earliest entry's regime (a Workspace
 * has a regime from creation, so earlier tax points carry it); with none, non-payer.
 */
export const regimeOn: {
  (date: IsoDate): (periods: ReadonlyArray<TaxRegimePeriod>) => TaxRegime;
  (periods: ReadonlyArray<TaxRegimePeriod>, date: IsoDate): TaxRegime;
} = Fn.dual(2, (periods: ReadonlyArray<TaxRegimePeriod>, date: IsoDate): TaxRegime => {
  let best: TaxRegimePeriod | undefined;
  let earliest: TaxRegimePeriod | undefined;
  for (const p of periods) {
    if (earliest === undefined || p.effectiveFrom < earliest.effectiveFrom) earliest = p;
    // `>=`: of entries effective on the same day the last in stored order wins (Workspaces).
    if (p.effectiveFrom <= date && (best === undefined || p.effectiveFrom >= best.effectiveFrom)) {
      best = p;
    }
  }
  return (best ?? earliest)?.regime ?? "non_vat_payer";
});

const deductible = (vatCzk: BigDecimal.BigDecimal, percent: number) =>
  percent >= 100
    ? vatCzk
    : roundAt(
        BigDecimal.divideUnsafe(
          BigDecimal.multiply(
            vatCzk,
            BigDecimal.fromBigInt(BigInt(Math.max(0, Math.round(percent)))),
          ),
          HUNDRED,
        ),
        2,
      );

/** Supplier buckets that carry claimable input VAT. */
/**
 * Supplier buckets that carry claimable input VAT. Reverse-charge and intra-EU acquisition
 * buckets carry none from the supplier: their VAT is the self-assessed bucket, counted once.
 */
const claimsInputVat = (b: VatBucket) => b.treatment === "standard" || b.treatment === "reduced";

/**
 * VAT treatment of one Expense under the regime at its tax point: input VAT is deductible only
 * for a `vat_payer` (rounded once per bucket); self-assessed reverse charge is owed by a
 * `vat_payer` or an `identified_person`, and deductible only by the former.
 */
const expenseVatImpl = (e: ReportExpense, regime: TaxRegime) => {
  const input: Array<{
    readonly bucket: VatBucket;
    readonly base: BigDecimal.BigDecimal;
    readonly vat: BigDecimal.BigDecimal;
  }> = [];
  const output: Array<{
    readonly bucket: VatBucket;
    readonly base: BigDecimal.BigDecimal;
    readonly vat: BigDecimal.BigDecimal;
  }> = [];
  for (const b of e.totals.buckets) {
    if (regime !== "vat_payer" || !claimsInputVat(b)) continue;
    input.push({
      bucket: b,
      base: bucketBaseCzk(b, e.currency, e.fx),
      vat: deductible(bucketVatCzk(b, e.currency, e.fx), e.deductiblePercent),
    });
  }
  if (regime !== "non_vat_payer") {
    for (const b of e.selfAssessed) {
      const base = bucketBaseCzk(b, e.currency, e.fx);
      const vat = bucketVatCzk(b, e.currency, e.fx);
      output.push({ bucket: b, base, vat });
      if (regime === "vat_payer") {
        input.push({ bucket: b, base, vat: deductible(vat, e.deductiblePercent) });
      }
    }
  }
  return { input, output };
};
export const expenseVat: {
  (regime: TaxRegime): (e: ReportExpense) => ReturnType<typeof expenseVatImpl>;
  (e: ReportExpense, regime: TaxRegime): ReturnType<typeof expenseVatImpl>;
} = Fn.dual(2, expenseVatImpl);

/** What the Expense costs the Workspace in CZK: gross, plus self-assessed VAT owed, minus deductible input VAT. */
export const expenseCostCzk: {
  (regime: TaxRegime): (e: ReportExpense) => BigDecimal.BigDecimal;
  (e: ReportExpense, regime: TaxRegime): BigDecimal.BigDecimal;
} = Fn.dual(2, (e: ReportExpense, regime: TaxRegime): BigDecimal.BigDecimal => {
  const { input, output } = expenseVat(e, regime);
  const full = sumCzk(fullBucketsCzk(e.totals.buckets, e.currency, e.fx));
  return BigDecimal.subtract(
    sumAll([full.net, full.vat, ...EffectArray.map(output, (o) => o.vat)]),
    sumAll(EffectArray.map(input, (i) => i.vat)),
  );
});

// Ordering helpers ----------------------------------------------------------------------------

/** Code-unit order (locale independent, so output is byte-identical everywhere). */
export const compareStrings: {
  (b: string): (a: string) => number;
  (a: string, b: string): number;
} = Fn.dual(2, (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0));

export const monthOf = (date: IsoDate): string => EffectString.slice(0, 7)(date);

/** Months counted from year 0: `year * 12 + month - 1`. */
const monthIndex = (date: IsoDate | string): number =>
  Number(EffectString.slice(0, 4)(date)) * 12 + Number(EffectString.slice(5, 7)(date)) - 1;

const monthAt = (index: number): string =>
  `${EffectString.padStart(4, "0")(String(Math.floor(index / 12)))}-${EffectString.padStart(2, "0")(String((index % 12) + 1))}`;

/** Every month `YYYY-MM` from `from`'s month to `to`'s month, oldest first (no date arithmetic past 9999-12). */
export const monthsBetween: {
  (to: IsoDate): (from: IsoDate) => ReadonlyArray<string>;
  (from: IsoDate, to: IsoDate): ReadonlyArray<string>;
} = Fn.dual(2, (from: IsoDate, to: IsoDate): ReadonlyArray<string> => {
  const months: Array<string> = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) months.push(monthAt(i));
  return months;
});

// Revenue and expenses ------------------------------------------------------------------------

interface GroupItem {
  readonly key: string;
  readonly label: string | null;
  /**
   * Picks the group label when rows disagree (a renamed contact): the highest rank wins, so the
   * label is the latest snapshot whatever the source order (issue date, then id).
   */
  readonly labelRank: string;
  readonly net: BigDecimal.BigDecimal;
  readonly vat: BigDecimal.BigDecimal;
  /** Whole-unit payment rounding in CZK (outside the tax base, inside the amount to pay). */
  readonly adjustment: BigDecimal.BigDecimal;
  /** The amount to pay in the original currency. */
  readonly gross: BigDecimal.BigDecimal;
}

const groupRows = (
  items: ReadonlyArray<GroupItem>,
  byCurrency: boolean,
): ReadonlyArray<AmountRow> => {
  const groups = new Map<string, { label: string | null; rank: string; items: Array<GroupItem> }>();
  for (const item of items) {
    const group = groups.get(item.key) ?? { label: item.label, rank: item.labelRank, items: [] };
    if (item.labelRank > group.rank) {
      group.label = item.label;
      group.rank = item.labelRank;
    }
    group.items.push(item);
    groups.set(item.key, group);
  }
  return EffectArray.map(
    [...groups.entries()].sort(([a], [b]) => compareStrings(a, b)),
    ([key, g]) => {
      const net = sumAll(EffectArray.map(g.items, (i) => i.net));
      const vat = sumAll(EffectArray.map(g.items, (i) => i.vat));
      const adjustment = sumAll(EffectArray.map(g.items, (i) => i.adjustment));
      return {
        key,
        label: g.label,
        count: g.items.length,
        net: czk(net),
        vat: czk(vat),
        gross: czk(sumAll([net, vat, adjustment])),
        original: byCurrency
          ? {
              amount: BigDecimal.normalize(sumAll(EffectArray.map(g.items, (i) => i.gross))),
              currency: CurrencyCode.make(key),
            }
          : null,
      };
    },
  );
};

const totalsOf = (rows: ReadonlyArray<AmountRow>) => ({
  count: EffectArray.reduce(rows, 0, (n, r) => n + r.count),
  net: czk(sumAll(EffectArray.map(rows, (r) => r.net.amount))),
  vat: czk(sumAll(EffectArray.map(rows, (r) => r.vat.amount))),
  gross: czk(sumAll(EffectArray.map(rows, (r) => r.gross.amount))),
});

/**
 * Documents that count as revenue: issued Invoices (a Final Invoice once, in full) and Credit
 * Notes correcting them. Proformas, Payment Tax Documents and Credit Notes correcting those are
 * advances, never revenue (flow 9.2).
 */
export const isRevenueDocument = (d: ReportDocument): boolean =>
  d.status === "issued" &&
  (d.kind === "invoice" || (d.kind === "credit_note" && d.correctsKind === "invoice"));

export const revenue: {
  (
    period: Period,
    groupBy: RevenueView["groupBy"],
  ): (documents: ReadonlyArray<ReportDocument>) => RevenueView;
  (
    documents: ReadonlyArray<ReportDocument>,
    period: Period,
    groupBy: RevenueView["groupBy"],
  ): RevenueView;
} = Fn.dual(
  3,
  (
    documents: ReadonlyArray<ReportDocument>,
    period: Period,
    groupBy: RevenueView["groupBy"],
  ): RevenueView => {
    const items = EffectArray.map(
      EffectArray.filter(
        documents,
        (d) => isRevenueDocument(d) && period.from <= d.issuedOn && d.issuedOn <= period.to,
      ),
      (d): GroupItem => {
        const { net, vat } = sumCzk(fullBucketsCzk(d.totals.buckets, d.currency, d.fx));
        const key =
          groupBy === "month"
            ? monthOf(d.issuedOn)
            : groupBy === "currency"
              ? d.currency
              : (d.contact.id ?? `name:${d.contact.name}`);
        return {
          key,
          label: groupBy === "contact" ? d.contact.name : null,
          labelRank: `${d.issuedOn}|${d.id}`,
          net,
          vat,
          adjustment: toCzk(d.totals.roundingAdjustment.amount, d.currency, d.fx),
          gross: d.totals.gross.amount,
        };
      },
    );
    const rows = groupRows(items, groupBy === "currency");
    return { report: "revenue", period, groupBy, rows, totals: totalsOf(rows) };
  },
);

export const expenses: {
  (
    period: Period,
    groupBy: ExpensesView["groupBy"],
    incomplete: number,
  ): (records: ReadonlyArray<ReportExpense>) => ExpensesView;
  (
    records: ReadonlyArray<ReportExpense>,
    period: Period,
    groupBy: ExpensesView["groupBy"],
    incomplete: number,
  ): ExpensesView;
} = Fn.dual(
  4,
  (
    records: ReadonlyArray<ReportExpense>,
    period: Period,
    groupBy: ExpensesView["groupBy"],
    incomplete: number,
  ): ExpensesView => {
    const items = EffectArray.map(
      EffectArray.filter(records, (e) => period.from <= e.issuedOn && e.issuedOn <= period.to),
      (e): GroupItem => {
        const { net, vat } = sumCzk(fullBucketsCzk(e.totals.buckets, e.currency, e.fx));
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
        return {
          key,
          label,
          labelRank: `${e.issuedOn}|${e.id}`,
          net,
          vat,
          adjustment: toCzk(e.totals.roundingAdjustment.amount, e.currency, e.fx),
          gross: e.totals.gross.amount,
        };
      },
    );
    const rows = groupRows(items, groupBy === "currency");
    return { report: "expenses", period, groupBy, rows, totals: totalsOf(rows), incomplete };
  },
);

/** Expense cost per month (`expenseCostCzk` under the regime at each tax point). */
const costByMonth = (
  records: ReadonlyArray<ReportExpense>,
  regimes: ReadonlyArray<TaxRegimePeriod>,
  period: Period,
) => {
  const byMonth = new Map<string, Array<BigDecimal.BigDecimal>>();
  for (const e of records) {
    if (e.issuedOn < period.from || e.issuedOn > period.to) continue;
    const month = monthOf(e.issuedOn);
    const list = byMonth.get(month) ?? [];
    list.push(expenseCostCzk(e, regimeOn(regimes, e.taxPoint)));
    byMonth.set(month, list);
  }
  return new Map(EffectArray.map([...byMonth], ([m, list]) => [m, sumAll(list)]));
};

/** Revenue net of VAT minus Expense cost (net of deductible VAT under the Tax Regime), per month. */
export const profit: {
  (
    records: ReadonlyArray<ReportExpense>,
    regimes: ReadonlyArray<TaxRegimePeriod>,
    period: Period,
  ): (documents: ReadonlyArray<ReportDocument>) => ProfitView;
  (
    documents: ReadonlyArray<ReportDocument>,
    records: ReadonlyArray<ReportExpense>,
    regimes: ReadonlyArray<TaxRegimePeriod>,
    period: Period,
  ): ProfitView;
} = Fn.dual(
  4,
  (
    documents: ReadonlyArray<ReportDocument>,
    records: ReadonlyArray<ReportExpense>,
    regimes: ReadonlyArray<TaxRegimePeriod>,
    period: Period,
  ): ProfitView => {
    const rev = revenue(documents, period, "month");
    const revByMonth = new Map(EffectArray.map(rev.rows, (row) => [row.key, row.net.amount]));
    const expByMonth = costByMonth(records, regimes, period);
    const rows = EffectArray.map(monthsBetween(period.from, period.to), (month) => {
      const r = revByMonth.get(month) ?? ZERO;
      const e = expByMonth.get(month) ?? ZERO;
      return { month, revenue: czk(r), expenses: czk(e), profit: czk(BigDecimal.subtract(r, e)) };
    });
    const r = sumAll(EffectArray.map(rows, (row) => row.revenue.amount));
    const e = sumAll(EffectArray.map(rows, (row) => row.expenses.amount));
    return {
      report: "profit",
      period,
      rows,
      totals: { revenue: czk(r), expenses: czk(e), profit: czk(BigDecimal.subtract(r, e)) },
    };
  },
);

// Cashflow ------------------------------------------------------------------------------------

export const cashflowPoints: {
  (
    months: ReadonlyArray<string>,
  ): (payments: ReadonlyArray<ReportPayment>) => ReadonlyArray<CashflowPoint>;
  (
    payments: ReadonlyArray<ReportPayment>,
    months: ReadonlyArray<string>,
  ): ReadonlyArray<CashflowPoint>;
} = Fn.dual(
  2,
  (
    payments: ReadonlyArray<ReportPayment>,
    months: ReadonlyArray<string>,
  ): ReadonlyArray<CashflowPoint> => {
    const sums = new Map<
      string,
      { in: Array<BigDecimal.BigDecimal>; out: Array<BigDecimal.BigDecimal> }
    >(EffectArray.map(months, (month) => [month, { in: [], out: [] }]));
    for (const p of payments) {
      const slot = sums.get(monthOf(p.paidOn));
      if (slot === undefined) continue;
      slot[p.direction].push(toCzk(p.amount.amount, p.amount.currency, p.fx));
    }
    return EffectArray.map(months, (month) => {
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
  },
);

export const cashflow: {
  (period: Period): (payments: ReadonlyArray<ReportPayment>) => CashflowView;
  (payments: ReadonlyArray<ReportPayment>, period: Period): CashflowView;
} = Fn.dual(2, (payments: ReadonlyArray<ReportPayment>, period: Period): CashflowView => {
  const points = cashflowPoints(
    EffectArray.filter(payments, (p) => period.from <= p.paidOn && p.paidOn <= period.to),
    monthsBetween(period.from, period.to),
  );
  const inflow = sumAll(EffectArray.map(points, (p) => p.in.amount));
  const outflow = sumAll(EffectArray.map(points, (p) => p.out.amount));
  return {
    report: "cashflow",
    period,
    points,
    totals: { in: czk(inflow), out: czk(outflow), net: czk(BigDecimal.subtract(inflow, outflow)) },
  };
});

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

export const receivables: {
  (period: Period, asOf: IsoDate): (open: ReadonlyArray<ReportDocument>) => ReceivablesView;
  (open: ReadonlyArray<ReportDocument>, period: Period, asOf: IsoDate): ReceivablesView;
} = Fn.dual(
  3,
  (open: ReadonlyArray<ReportDocument>, period: Period, asOf: IsoDate): ReceivablesView => {
    const rows = EffectArray.map(
      EffectArray.filter(
        open,
        (d) => d.status === "issued" && BigDecimal.isPositive(d.outstanding),
      ),
      (d) => receivableRow(d, asOf),
    ).sort(compareReceivables);
    const buckets = EffectArray.map(AGING_BUCKETS, (bucket) => {
      const documents = EffectArray.filter(rows, (r) => agingBucket(r.daysOverdue) === bucket);
      return {
        bucket,
        count: documents.length,
        total: czk(sumAll(EffectArray.map(documents, (r) => r.outstandingCzk.amount))),
        documents,
      };
    });
    const overdue = EffectArray.filter(rows, (r) => r.daysOverdue > 0);
    return {
      report: "receivables",
      period,
      asOf,
      buckets,
      total: czk(sumAll(EffectArray.map(rows, (r) => r.outstandingCzk.amount))),
      overdue: {
        total: czk(sumAll(EffectArray.map(overdue, (r) => r.outstandingCzk.amount))),
        count: overdue.length,
      },
    };
  },
);

// VAT summary ---------------------------------------------------------------------------------

/** Kinds whose VAT enters the summary (Proformas are not tax documents). */
const TAX_DOCUMENT_KINDS = new Set(["invoice", "payment_tax_document", "credit_note"]);

interface VatAccumulator {
  month: string;
  treatment: VatTreatment;
  ratePercent: BigDecimal.BigDecimal;
  base: Array<BigDecimal.BigDecimal>;
  vat: Array<BigDecimal.BigDecimal>;
  sources: Map<string, VatSource>;
}

const addLine = (
  lines: Map<string, VatAccumulator>,
  month: string,
  b: { readonly treatment: VatTreatment; readonly ratePercent: BigDecimal.BigDecimal },
  base: BigDecimal.BigDecimal,
  vat: BigDecimal.BigDecimal,
  source: VatSource,
) => {
  const key = `${month}|${rateKey(b.treatment, b.ratePercent)}`;
  const line = lines.get(key) ?? {
    month,
    treatment: b.treatment,
    ratePercent: BigDecimal.normalize(b.ratePercent),
    base: [],
    vat: [],
    sources: new Map<string, VatSource>(),
  };
  line.base.push(base);
  line.vat.push(vat);
  line.sources.set(`${source._tag}:${source.id}`, source);
  lines.set(key, line);
};

const treatmentOrder = (t: VatTreatment) => TREATMENTS.indexOf(t);

/** Month, then treatment in `TREATMENTS` order, then rate descending; sources by kind then id. */
const finish = (lines: Map<string, VatAccumulator>): ReadonlyArray<VatLine> =>
  EffectArray.map(
    [...lines.values()].sort(
      (a, b) =>
        compareStrings(a.month, b.month) ||
        treatmentOrder(a.treatment) - treatmentOrder(b.treatment) ||
        (BigDecimal.isLessThan(a.ratePercent, b.ratePercent)
          ? 1
          : BigDecimal.isGreaterThan(a.ratePercent, b.ratePercent)
            ? -1
            : 0),
    ),
    (l) => ({
      month: l.month,
      treatment: l.treatment,
      ratePercent: l.ratePercent,
      base: czk(sumAll(l.base)),
      vat: czk(sumAll(l.vat)),
      documents: EffectArray.map(
        [...l.sources.entries()].sort(([a], [b]) => compareStrings(a, b)),
        ([, source]) => source,
      ),
    }),
  );

/**
 * Output VAT per tax-point month and rate bucket from issued tax documents (Credit Notes signed
 * negative, advance deductions netted, `taxableBucketsCzk`) plus self-assessed reverse charge on
 * Expenses; input VAT from Expenses, by the Tax Regime in force at each Expense's tax point
 * (`expenseVat`).
 */
export const vatSummary: {
  (
    records: ReadonlyArray<ReportExpense>,
    regimes: ReadonlyArray<TaxRegimePeriod>,
    period: Period,
  ): (documents: ReadonlyArray<ReportDocument>) => VatSummaryView;
  (
    documents: ReadonlyArray<ReportDocument>,
    records: ReadonlyArray<ReportExpense>,
    regimes: ReadonlyArray<TaxRegimePeriod>,
    period: Period,
  ): VatSummaryView;
} = Fn.dual(
  4,
  (
    documents: ReadonlyArray<ReportDocument>,
    records: ReadonlyArray<ReportExpense>,
    regimes: ReadonlyArray<TaxRegimePeriod>,
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
      for (const b of taxableBucketsCzk(d)) {
        addLine(output, month, b, b.base, b.vat, { _tag: "Document", id: d.id });
      }
    }

    for (const e of records) {
      if (!inPeriod(e.taxPoint)) continue;
      const month = monthOf(e.taxPoint);
      const source: VatSource = { _tag: "Expense", id: e.id };
      const vat = expenseVat(e, regimeOn(regimes, e.taxPoint));
      for (const l of vat.output) addLine(output, month, l.bucket, l.base, l.vat, source);
      for (const l of vat.input) addLine(input, month, l.bucket, l.base, l.vat, source);
    }

    const outputLines = finish(output);
    const inputLines = finish(input);
    const outputVat = sumAll(EffectArray.map(outputLines, (l) => l.vat.amount));
    const inputVat = sumAll(EffectArray.map(inputLines, (l) => l.vat.amount));
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
  },
);

// Dashboard -----------------------------------------------------------------------------------

export const dashboard = (input: {
  readonly period: Period;
  readonly today: IsoDate;
  readonly issued: ReadonlyArray<ReportDocument>;
  readonly open: ReadonlyArray<ReportDocument>;
  readonly expenses: ReadonlyArray<ReportExpense>;
  readonly regimes: ReadonlyArray<TaxRegimePeriod>;
  readonly incompleteExpenses: number;
  readonly payments: ReadonlyArray<ReportPayment>;
  readonly months: ReadonlyArray<string>;
}): DashboardView => {
  const aging = receivables(input.open, input.period, input.today);
  const cost = costByMonth(input.expenses, input.regimes, input.period);
  return {
    period: input.period,
    revenue: revenue(input.issued, input.period, "month").totals.net,
    unpaid: aging.total,
    overdue: aging.overdue,
    expenses: czk(sumAll(cost.values())),
    incompleteExpenses: input.incompleteExpenses,
    cashflow: cashflowPoints(input.payments, input.months),
  };
};

/**
 * The 12 months ending at `to`'s month, oldest first, and the first day they start on; null when
 * they would start before year 0000.
 */
export const twelveMonthsEnding = (
  to: IsoDate,
): { readonly months: ReadonlyArray<string>; readonly from: IsoDate } | null => {
  const first = monthIndex(to) - 11;
  if (first < 0) return null;
  const from = IsoDate.make(`${monthAt(first)}-01`);
  return { months: monthsBetween(from, to), from };
};
