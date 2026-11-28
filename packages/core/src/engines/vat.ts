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
 * 5. round = round2: half away from zero at 2 decimals, whatever the currency (spec 5.1 says
 *    round2; for 0- or 3-decimal currencies amounts can carry more precision than the minor
 *    unit, and the payment amount is the caller's to round).
 * 6. Foreign currency: bucket vatCzk = round2(vat x fx.rate / fx.quantity); the document's
 *    vatCzk is the sum of the bucket values (no second rounding). CZK documents: null.
 * 7. paymentRounding "whole_unit" rounds only the amount to pay to a whole unit (half away
 *    from zero); the difference is `roundingAdjustment`, outside every bucket (§36(5)).
 * 8. Rates come from an effective-dated table; a tax point before its first entry is a defect.
 * 9. Advance deductions (D8, §37a ZDPH): a document that deducts advances nets base, VAT and
 *    gross per bucket in the document currency first, then converts each net bucket's VAT once
 *    at its own fixing (rule 6). The advances keep the CZK VAT declared on their PTDs; the
 *    Final Invoice declares only its remainder (`netDeductions`, called by Documents' compose).
 *    ReportCompute declares the net CZK VAT the document stores, so report and document agree.
 * Non-rated treatments (exempt_intra_eu_goods, reverse_charge, outside_scope) have rate 0 and
 * vat 0. Negative lines (discounts, credit notes) follow the same rules; because rounding is
 * symmetric, `calculate` of negated lines equals `negate` of the breakdown.
 */

import type { VatTreatment } from "@kvitbit/domain/contract";
import {
  CurrencyCode,
  IsoDate,
  MoneyMath,
  type VatBreakdown,
  type VatBucket,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { divideRound, HUNDRED, roundAt, sumAll, ZERO } from "./decimal";
import type { FxRate } from "./fx";
import { toCzk } from "./fx";

export type { VatBreakdown, VatBucket } from "@kvitbit/domain/contract";

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
  /**
   * `quantity` units of `currency` = `rate` CZK; ignored for CZK. null on a non-CZK document
   * means the CZK VAT is not known yet (ui-port live preview before the rate arrives): every
   * `vatCzk` is then null. Documents and Payments resolve the rate with `Fx.resolve` before
   * persisting, so a stored foreign VAT document always has CZK VAT (rule D9).
   */
  readonly fx: null | Pick<FxRate, "rate" | "quantity">;
  readonly paymentRounding: "none" | "whole_unit";
}

/** Decimals of every rounded VatMath amount (rules 3-6: round2). */
const VAT_SCALE = 2;

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
}> = [{ from: IsoDate.make("2024-01-01"), standard: 21, reduced: 12 }];

/** Rate in force on the tax point; a tax point before the table is a defect (throws). */
const rateFor: {
  (taxPoint: IsoDate): (treatment: VatTreatment) => BigDecimal.BigDecimal;
  (treatment: VatTreatment, taxPoint: IsoDate): BigDecimal.BigDecimal;
} = Fn.dual(2, (treatment: VatTreatment, taxPoint: IsoDate): BigDecimal.BigDecimal => {
  let entry: (typeof VAT_RATE_TABLE)[number] | undefined;
  for (const e of VAT_RATE_TABLE) if (e.from <= taxPoint) entry = e;
  const rates = Option.getOrThrowWith(
    Option.fromNullishOr(entry),
    () => new Error(`VatMath: no VAT rate table entry for tax point ${taxPoint}`),
  );
  switch (treatment) {
    case "standard":
      return BigDecimal.fromBigInt(BigInt(rates.standard));
    case "reduced":
      return BigDecimal.fromBigInt(BigInt(rates.reduced));
    default:
      return ZERO;
  }
});

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
  const net = sumAll(EffectArray.map(buckets, (b) => b.base));
  const vat = sumAll(EffectArray.map(buckets, (b) => b.vat));
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
      ? MoneyMath.make(
          sumAll(EffectArray.map(buckets, (b) => b.vatCzk ?? ZERO)),
          CurrencyCode.make("CZK"),
        )
      : null,
  };
};

const calculate = (input: VatInput): VatBreakdown => {
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
      gross = roundAt(sum, VAT_SCALE);
      vat = vatOfGross(gross, ratePercent, VAT_SCALE);
      base = BigDecimal.normalize(BigDecimal.subtract(gross, vat));
    } else {
      base = roundAt(sum, VAT_SCALE);
      vat = divideRound(BigDecimal.multiply(base, ratePercent), HUNDRED, VAT_SCALE);
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

const neg = (v: BigDecimal.BigDecimal) => v.pipe(BigDecimal.negate, BigDecimal.normalize);

/**
 * Credit-note helper: every amount of the breakdown negated (buckets, totals, rounding
 * adjustment, CZK VAT). `negate(calculate(x))` equals `calculate` of x with negated quantities.
 */
const negate = (breakdown: VatBreakdown): VatBreakdown => ({
  buckets: EffectArray.map(breakdown.buckets, (b) => ({
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
 * Largest-remainder allocation in units of the finest of the payment's own precision, the
 * currency's minor unit (3 for BHD) and 2 decimals; the payment is never rounded. Each bucket
 * gets floor(paid x gross / total),
 * then the leftover units go one each to the largest fractional parts (ties: bucket order), so
 * the shares sum to `paid` exactly and none flips sign. Within a share VAT is top-down
 * (rule 4, round2) at the rate in force on `taxPoint` (the receipt date, rule P2; default: the
 * Proforma's rates). `fx` is the rate for that tax point; null leaves CZK VAT unknown.
 * A Proforma whose buckets sum to zero gross cannot be split (defect).
 */
const splitAdvance = (
  proforma: VatBreakdown,
  paid: BigDecimal.BigDecimal,
  options: { readonly fx?: VatInput["fx"]; readonly taxPoint?: IsoDate } = {},
): ReadonlyArray<VatBucket> => {
  const currency = proforma.gross.currency;
  // Never round the payment itself: shares carry the payment's own precision, at least the
  // currency's minor unit and VAT_SCALE (a JPY proforma's gross can be 1.21).
  const paidScale = Math.max(0, BigDecimal.normalize(paid).scale);
  const shareScale = Math.max(MoneyMath.minorUnitScale(currency), VAT_SCALE, paidScale);
  const gross = sumAll(EffectArray.map(proforma.buckets, (b) => b.gross));
  const total = Option.getOrThrowWith(
    Option.liftPredicate((value: BigDecimal.BigDecimal) => !BigDecimal.isZero(value))(gross),
    () => new Error("VatMath.splitAdvance: the proforma has no gross amount to split"),
  );
  const units = BigDecimal.scale(roundAt(paid, shareScale), shareScale).value;
  // Exact share in minor units = units x gross / total, as floor + fractional remainder.
  const raw = EffectArray.map(proforma.buckets, (b) => {
    const exact = BigDecimal.divideUnsafe(
      BigDecimal.multiply(BigDecimal.fromBigInt(units), b.gross),
      total,
    );
    const floor = BigDecimal.scale(BigDecimal.floor(exact, 0), 0).value;
    return { floor, fraction: BigDecimal.subtract(exact, BigDecimal.fromBigInt(floor)) };
  });
  let leftover = units - EffectArray.reduce(raw, 0n, (acc, r) => acc + r.floor);
  const order = EffectArray.map(raw, (r, i) => ({ i, fraction: r.fraction })).sort(
    (a, b) => BigDecimal.Order(b.fraction, a.fraction) || a.i - b.i,
  );
  const shares = EffectArray.map(raw, (r) => r.floor);
  for (const { i } of order) {
    if (leftover <= 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    leftover--;
  }
  const fx = options.fx ?? null;
  return EffectArray.map(proforma.buckets, (b, i) => {
    const shareGross = BigDecimal.normalize(BigDecimal.make(shares[i] ?? 0n, shareScale));
    const ratePercent =
      options.taxPoint === undefined ? b.ratePercent : rateFor(b.treatment, options.taxPoint);
    const vat = vatOfGross(shareGross, ratePercent, VAT_SCALE);
    return {
      treatment: b.treatment,
      ratePercent,
      base: BigDecimal.normalize(BigDecimal.subtract(shareGross, vat)),
      vat,
      gross: shareGross,
      vatCzk: czkOrNull(vat, currency, fx),
    };
  });
};

/**
 * Rule 9: `supply` net of `deducted` (signed amounts: a Final Invoice deducts negative
 * buckets), summed per (treatment, ratePercent) in first-seen order. Each net bucket's `vatCzk`
 * is its own VAT converted at `fx` (null for CZK or without a fixing), never the sum of the
 * inputs' stored CZK VAT.
 */
const netDeductions: {
  (
    deducted: ReadonlyArray<VatBucket>,
    currency: CurrencyCode,
    fx: VatInput["fx"],
  ): (supply: ReadonlyArray<VatBucket>) => ReadonlyArray<VatBucket>;
  (
    supply: ReadonlyArray<VatBucket>,
    deducted: ReadonlyArray<VatBucket>,
    currency: CurrencyCode,
    fx: VatInput["fx"],
  ): ReadonlyArray<VatBucket>;
} = Fn.dual(
  4,
  (
    supply: ReadonlyArray<VatBucket>,
    deducted: ReadonlyArray<VatBucket>,
    currency: CurrencyCode,
    fx: VatInput["fx"],
  ): ReadonlyArray<VatBucket> => {
    const byKey = new Map<string, VatBucket>();
    for (const b of [...supply, ...deducted]) {
      const key = `${b.treatment}|${b.ratePercent.pipe(BigDecimal.normalize, BigDecimal.format)}`;
      const prev = byKey.get(key);
      byKey.set(
        key,
        prev === undefined
          ? b
          : {
              ...prev,
              base: BigDecimal.normalize(BigDecimal.sum(prev.base, b.base)),
              vat: BigDecimal.normalize(BigDecimal.sum(prev.vat, b.vat)),
              gross: BigDecimal.normalize(BigDecimal.sum(prev.gross, b.gross)),
            },
      );
    }
    return EffectArray.map([...byKey.values()], (b) => ({
      ...b,
      vatCzk: czkOrNull(b.vat, currency, fx),
    }));
  },
);

/** Sums buckets back into a breakdown (e.g. a Payment Tax Document from `splitAdvance`). */
const fromBuckets = (
  buckets: ReadonlyArray<VatBucket>,
  currency: CurrencyCode,
  paymentRounding: VatInput["paymentRounding"] = "none",
): VatBreakdown =>
  assemble(
    buckets,
    currency,
    paymentRounding,
    currency !== "CZK" && EffectArray.some(buckets, (b) => b.vatCzk !== null),
  );

export const VatMath = {
  rateFor,
  calculate,
  negate,
  splitAdvance,
  fromBuckets,
  netDeductions,
} as const;
