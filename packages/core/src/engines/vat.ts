/**
 * VatMath (core-ports 5.1): per-rate-bucket VAT for Czech documents.
 *
 * Rounding rules, the one place they live:
 * 1. Line amounts keep full precision (quantity x unit price is never rounded).
 * 2. Lines group into buckets by (treatment, ratePercent), in `VatTreatment` order.
 * 3. Bottom-up (§37(a)): base = round(sum of line nets); vat = round(base x rate / 100);
 *    gross = base + vat.
 * 4. Top-down (§37(b), pricesIncludeVat): gross = round(sum of line grosses);
 *    vat = round(gross x rate / (100 + rate)); base = gross - vat.
 * 5. round = half away from zero at the document currency's minor unit (2 for CZK and EUR).
 * 6. Foreign currency: bucket vatCzk = round2(vat x fx.rate / fx.quantity); the document's
 *    vatCzk is the sum of the bucket values (no second rounding). CZK documents: null.
 * 7. paymentRounding "whole_unit" rounds only the amount to pay to a whole unit (half away
 *    from zero); the difference is `roundingAdjustment`, outside every bucket (§36(5)).
 * 8. Rates come from an effective-dated table; a tax point before its first entry is a defect.
 * Non-rated treatments (exempt_intra_eu_goods, reverse_charge, outside_scope) have rate 0 and
 * vat 0. Negative lines (discounts, credit notes) follow the same rules; because rounding is
 * symmetric, `calculate` of negated lines equals `negate` of the breakdown.
 */
import type { CurrencyCode, IsoDate, VatTreatment } from "@kvitbit/domain/contract";
import { MoneyMath, type VatBreakdown, type VatBucket } from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { divideRound, HUNDRED, roundAt, sumAll, ZERO } from "./decimal";
import type { FxRate } from "./fx";
import { toCzk } from "./fx";

export type { VatBreakdown, VatBucket };

export interface VatInputLine {
  readonly quantity: BigDecimal.BigDecimal;
  /** Document currency; excluding VAT unless `pricesIncludeVat`. */
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly treatment: VatTreatment;
}

export interface VatInput {
  readonly lines: ReadonlyArray<VatInputLine>;
  readonly currency: CurrencyCode;
  readonly taxPoint: IsoDate;
  readonly pricesIncludeVat: boolean;
  /** `quantity` units of `currency` = `rate` CZK; null for CZK (ignored when currency is CZK). */
  readonly fx: null | Pick<FxRate, "rate" | "quantity">;
  readonly paymentRounding: "none" | "whole_unit";
}

/** Bucket order: the `VatTreatment` literal order. */
export const TREATMENTS: ReadonlyArray<VatTreatment> = [
  "standard",
  "reduced",
  "exempt_intra_eu_goods",
  "reverse_charge",
  "outside_scope",
];

/** Effective-dated rates (§47). Newest last; each entry applies from `from` until the next. */
export const VAT_RATE_TABLE: ReadonlyArray<{
  readonly from: IsoDate;
  readonly standard: number;
  readonly reduced: number;
}> = [{ from: "2024-01-01" as IsoDate, standard: 21, reduced: 12 }];

/** Rate in force on the tax point; a tax point before the table is a defect (throws). */
export const rateFor = (treatment: VatTreatment, taxPoint: IsoDate): BigDecimal.BigDecimal => {
  let entry: (typeof VAT_RATE_TABLE)[number] | undefined;
  for (const e of VAT_RATE_TABLE) if (e.from <= taxPoint) entry = e;
  if (entry === undefined) {
    throw new Error(`VatMath: no VAT rate table entry for tax point ${taxPoint}`);
  }
  switch (treatment) {
    case "standard":
      return BigDecimal.fromBigInt(BigInt(entry.standard));
    case "reduced":
      return BigDecimal.fromBigInt(BigInt(entry.reduced));
    default:
      return ZERO;
  }
};

/** VAT included in a gross amount at `ratePercent`, rounded (rule 4). */
const vatOfGross = (gross: BigDecimal.BigDecimal, rate: BigDecimal.BigDecimal, scale: number) =>
  BigDecimal.isZero(rate)
    ? ZERO
    : divideRound(BigDecimal.multiply(gross, rate), BigDecimal.sum(HUNDRED, rate), scale);

const czkOrNull = (
  vat: BigDecimal.BigDecimal,
  currency: CurrencyCode,
  fx: VatInput["fx"],
): BigDecimal.BigDecimal | null => (currency === "CZK" || fx === null ? null : toCzk(vat, fx));

/** Document totals from finished buckets (rules 6 and 7). */
const assemble = (
  buckets: ReadonlyArray<VatBucket>,
  currency: CurrencyCode,
  paymentRounding: VatInput["paymentRounding"],
  foreign: boolean,
): VatBreakdown => {
  const net = sumAll(buckets.map((b) => b.base));
  const vat = sumAll(buckets.map((b) => b.vat));
  const total = BigDecimal.sum(net, vat);
  const toPay = paymentRounding === "whole_unit" ? roundAt(total, 0) : total;
  const money = (amount: BigDecimal.BigDecimal) =>
    MoneyMath.make(BigDecimal.normalize(amount), currency);
  return {
    buckets,
    net: money(net),
    vat: money(vat),
    roundingAdjustment: money(BigDecimal.subtract(toPay, total)),
    gross: money(toPay),
    vatCzk: foreign
      ? MoneyMath.make(sumAll(buckets.map((b) => b.vatCzk ?? ZERO)), "CZK" as CurrencyCode)
      : null,
  };
};

export const calculate = (input: VatInput): VatBreakdown => {
  const scale = MoneyMath.minorUnitScale(input.currency);
  const foreign = input.currency !== "CZK" && input.fx !== null;
  const groups = new Map<VatTreatment, BigDecimal.BigDecimal>();
  for (const line of input.lines) {
    const amount = BigDecimal.multiply(line.quantity, line.unitPrice);
    groups.set(line.treatment, BigDecimal.sum(groups.get(line.treatment) ?? ZERO, amount));
  }
  // One rate per treatment on a tax point, so (treatment, ratePercent) groups by treatment.
  const buckets: Array<VatBucket> = [];
  for (const treatment of TREATMENTS) {
    const sum = groups.get(treatment);
    if (sum === undefined) continue;
    const ratePercent = rateFor(treatment, input.taxPoint);
    let base: BigDecimal.BigDecimal;
    let vat: BigDecimal.BigDecimal;
    let gross: BigDecimal.BigDecimal;
    if (input.pricesIncludeVat) {
      gross = roundAt(sum, scale);
      vat = vatOfGross(gross, ratePercent, scale);
      base = BigDecimal.normalize(BigDecimal.subtract(gross, vat));
    } else {
      base = roundAt(sum, scale);
      vat = divideRound(BigDecimal.multiply(base, ratePercent), HUNDRED, scale);
      gross = BigDecimal.normalize(BigDecimal.sum(base, vat));
    }
    buckets.push({
      treatment,
      ratePercent,
      base,
      vat,
      gross,
      vatCzk: czkOrNull(vat, input.currency, input.fx),
    });
  }
  return assemble(buckets, input.currency, input.paymentRounding, foreign);
};

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));

/**
 * Credit-note helper: every amount of the breakdown negated (buckets, totals, rounding
 * adjustment, CZK VAT). `negate(calculate(x))` equals `calculate` of x with negated quantities.
 */
export const negate = (breakdown: VatBreakdown): VatBreakdown => ({
  buckets: breakdown.buckets.map((b) => ({
    ...b,
    base: neg(b.base),
    vat: neg(b.vat),
    gross: neg(b.gross),
    vatCzk: b.vatCzk === null ? null : neg(b.vatCzk),
  })),
  net: MoneyMath.make(neg(breakdown.net.amount), breakdown.net.currency),
  vat: MoneyMath.make(neg(breakdown.vat.amount), breakdown.vat.currency),
  roundingAdjustment: MoneyMath.make(
    neg(breakdown.roundingAdjustment.amount),
    breakdown.roundingAdjustment.currency,
  ),
  gross: MoneyMath.make(neg(breakdown.gross.amount), breakdown.gross.currency),
  vatCzk:
    breakdown.vatCzk === null
      ? null
      : MoneyMath.make(neg(breakdown.vatCzk.amount), breakdown.vatCzk.currency),
});

/**
 * Splits a received advance across a Proforma's buckets by gross share (Payment Tax Document).
 * Each share is round(paid x bucket gross / sum of bucket grosses); the largest bucket takes
 * the remainder so the shares sum to `paid` exactly. Within a share VAT is top-down (rule 4).
 * `fx` is the rate for the payment's tax point (the receipt date); omit it for CZK.
 * A Proforma whose buckets sum to zero gross cannot be split (defect).
 */
export const splitAdvance = (
  proforma: VatBreakdown,
  paid: BigDecimal.BigDecimal,
  fx: VatInput["fx"] = null,
): ReadonlyArray<VatBucket> => {
  const currency = proforma.gross.currency;
  const scale = MoneyMath.minorUnitScale(currency);
  const total = sumAll(proforma.buckets.map((b) => b.gross));
  if (BigDecimal.isZero(total)) {
    throw new Error("VatMath.splitAdvance: the proforma has no gross amount to split");
  }
  const amount = roundAt(paid, scale);
  let largest = 0;
  proforma.buckets.forEach((b, i) => {
    const current = proforma.buckets[largest];
    if (current && BigDecimal.isGreaterThan(BigDecimal.abs(b.gross), BigDecimal.abs(current.gross)))
      largest = i;
  });
  const shares = proforma.buckets.map((b) =>
    divideRound(BigDecimal.multiply(amount, b.gross), total, scale),
  );
  const others = sumAll(shares.filter((_, i) => i !== largest));
  shares[largest] = BigDecimal.normalize(BigDecimal.subtract(amount, others));
  return proforma.buckets.map((b, i) => {
    const gross = shares[i] ?? ZERO;
    const vat = vatOfGross(gross, b.ratePercent, scale);
    return {
      treatment: b.treatment,
      ratePercent: b.ratePercent,
      base: BigDecimal.normalize(BigDecimal.subtract(gross, vat)),
      vat,
      gross,
      vatCzk: czkOrNull(vat, currency, fx),
    };
  });
};

/** Sums buckets back into a breakdown (e.g. a Payment Tax Document from `splitAdvance`). */
export const fromBuckets = (
  buckets: ReadonlyArray<VatBucket>,
  currency: CurrencyCode,
  paymentRounding: VatInput["paymentRounding"] = "none",
): VatBreakdown =>
  assemble(
    buckets,
    currency,
    paymentRounding,
    currency !== "CZK" && buckets.some((b) => b.vatCzk !== null),
  );

export const VatMath = { rateFor, calculate, negate, splitAdvance, fromBuckets } as const;
