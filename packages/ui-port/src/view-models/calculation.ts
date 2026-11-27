/**
 * Live line-item calculation for the Document Editor (screen 10) and Expense editor (14),
 * ui-port-contracts 2.8. A pure re-implementation of core-ports 5.1 `VatMath` until
 * `@kvitbit/core/engines` can be imported (phase 2 decision 3); the result has the domain
 * `VatBreakdown` shape, so a server `preview` result replaces it one to one (see `PreviewSync`).
 *
 * Rounding (core-ports 5.1): line amounts keep full precision; one bucket per treatment (one rate
 * per treatment per tax point), in `TREATMENT_ORDER`; bottom-up base = round(sum of nets), VAT = round(base × rate / 100);
 * top-down (`pricesIncludeVat`) gross = round(sum of grosses), VAT = round(gross × rate /
 * (100 + rate)), base = gross − VAT; half away from zero to 2 decimals (round2, whatever the currency's minor unit); CZK VAT per
 * bucket = round2(VAT × fx.rate / fx.quantity); `whole_unit` rounding only touches the amount to pay.
 */

import {
  CurrencyCode,
  type DocumentKind,
  IsoDate,
  type Money,
  MoneyMath,
  type TaxRegime,
  type VatBreakdown,
  type VatBucket,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const ZERO = BigDecimal.fromBigInt(0n);
const HUNDRED = BigDecimal.fromBigInt(100n);
/** core-ports 5.1 rounds every bucket amount with round2, for any document currency. */
const SCALE = 2;

const roundAt = (value: BigDecimal.BigDecimal, scale: number): BigDecimal.BigDecimal =>
  BigDecimal.normalize(BigDecimal.round(value, { scale, mode: "half-from-zero" }));

/** Division by a divisor the caller knows is non-zero (100 + rate, fx quantity >= 1). */
const divide = (a: BigDecimal.BigDecimal, b: BigDecimal.BigDecimal): BigDecimal.BigDecimal =>
  Option.getOrElse(BigDecimal.divide(a, b), () => ZERO);

// --- Rates ---------------------------------------------------------------------------------------

/** A tax point before the rate table starts: a defect, not a user error (core-ports 5.1 rule 8). */
export class VatRateUnavailable extends Schema.TaggedError<
  VatRateUnavailable,
  { readonly brand: unique symbol }
>()("VatRateUnavailable", { treatment: VatTreatment, taxPoint: IsoDate }) {}

interface RateTableEntry {
  readonly from: string;
  readonly standard: number;
  readonly reduced: number;
}

/** Effective-dated rates, newest last. 21 % and 12 % since 2024-01-01 (zákon 349/2023 Sb.). */
const RATE_TABLE: ReadonlyArray<RateTableEntry> = [
  { from: "2024-01-01", standard: 21, reduced: 12 },
];

/** Non-rated treatments always carry 0 %. */
const isRatedTreatment = (treatment: VatTreatment): boolean =>
  treatment === "standard" || treatment === "reduced";

/** `VatMath.rateFor`: the percentage in force on the tax point. */
export const rateFor: {
  (
    taxPoint: IsoDate,
  ): (treatment: VatTreatment) => Result.Result<BigDecimal.BigDecimal, VatRateUnavailable>;
  (
    treatment: VatTreatment,
    taxPoint: IsoDate,
  ): Result.Result<BigDecimal.BigDecimal, VatRateUnavailable>;
} = Fn.dual(
  2,
  (
    treatment: VatTreatment,
    taxPoint: IsoDate,
  ): Result.Result<BigDecimal.BigDecimal, VatRateUnavailable> => {
    let entry: RateTableEntry | undefined;
    for (const candidate of RATE_TABLE) if (candidate.from <= taxPoint) entry = candidate;
    // Coverage first: core rejects a tax point before the table for every treatment.
    if (entry === undefined) return Result.fail(VatRateUnavailable.make({ treatment, taxPoint }));
    if (!isRatedTreatment(treatment)) return Result.succeed(ZERO);
    return Result.succeed(
      BigDecimal.fromBigInt(BigInt(treatment === "standard" ? entry.standard : entry.reduced)),
    );
  },
);

/**
 * The treatment the math uses for the Issuing Entity's Tax Regime: a `non_vat_payer` charges no
 * VAT on anything, and an `identified_person` charges none on domestic supplies, so rated
 * treatments become `outside_scope` for both. Non-rated treatments are kept. Outgoing documents
 * only: an expense keeps the supplier's treatment whatever the receiver's regime.
 */
const effectiveTreatment = (regime: TaxRegime, treatment: VatTreatment): VatTreatment =>
  regime !== "vat_payer" && isRatedTreatment(treatment) ? "outside_scope" : treatment;

/** core-ports 5.1 bucket order. */
const TREATMENT_ORDER: ReadonlyArray<VatTreatment> = [
  "standard",
  "reduced",
  "exempt_intra_eu_goods",
  "reverse_charge",
  "outside_scope",
];

// --- Input and output ----------------------------------------------------------------------------

export interface PreviewLine {
  readonly quantity: BigDecimal.BigDecimal;
  /** Document currency; excl. VAT unless `pricesIncludeVat`. */
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly treatment: VatTreatment;
  /**
   * Percentage off the line amount, full precision. ui-only: `LineInput` has no discount field,
   * so an editor that offers one folds it into `unitPrice` before saving.
   */
  readonly discountPercent?: BigDecimal.BigDecimal;
}

export interface FxRate {
  /** `quantity` units of the document currency = `rate` CZK (CNB fixing or manual rate). */
  readonly rate: BigDecimal.BigDecimal;
  readonly quantity: number;
}

export interface PreviewInput {
  readonly lines: ReadonlyArray<PreviewLine>;
  readonly currency: CurrencyCode;
  readonly taxPoint: IsoDate;
  readonly pricesIncludeVat: boolean;
  /** null for CZK documents and while no rate is known yet. Ignored for CZK. */
  readonly fx: FxRate | null;
  readonly paymentRounding: "none" | "whole_unit";
  /**
   * `outgoing`: a document the Workspace issues, so `taxRegime` decides what it may charge.
   * `incoming`: an expense, whose lines keep the treatment the supplier charged.
   */
  readonly direction: "outgoing" | "incoming";
  /** The Workspace's Tax Regime; applied to `outgoing` documents only. */
  readonly taxRegime: TaxRegime;
  /** `credit_note` negates every line (a Credit Note reverses the corrected amounts). */
  readonly kind?: DocumentKind;
}

/** One line at full precision; round for display only (rule 1). */
interface LineAmounts {
  readonly treatment: VatTreatment;
  readonly ratePercent: BigDecimal.BigDecimal;
  readonly net: BigDecimal.BigDecimal;
  readonly vat: BigDecimal.BigDecimal;
  readonly gross: BigDecimal.BigDecimal;
}

export interface LivePreview {
  readonly lines: ReadonlyArray<LineAmounts>;
  readonly breakdown: VatBreakdown;
}

// --- Calculation ---------------------------------------------------------------------------------

const lineAmounts = (
  line: PreviewLine,
  treatment: VatTreatment,
  rate: BigDecimal.BigDecimal,
  input: PreviewInput,
): LineAmounts => {
  const discount = line.discountPercent ?? ZERO;
  const factor = divide(BigDecimal.subtract(HUNDRED, discount), HUNDRED);
  const signed = input.kind === "credit_note" ? BigDecimal.negate(line.quantity) : line.quantity;
  const amount = BigDecimal.multiply(BigDecimal.multiply(signed, line.unitPrice), factor);
  if (input.pricesIncludeVat) {
    const vat = divide(BigDecimal.multiply(amount, rate), BigDecimal.sum(HUNDRED, rate));
    return {
      treatment,
      ratePercent: rate,
      net: BigDecimal.subtract(amount, vat),
      vat,
      gross: amount,
    };
  }
  const vat = divide(BigDecimal.multiply(amount, rate), HUNDRED);
  return { treatment, ratePercent: rate, net: amount, vat, gross: BigDecimal.sum(amount, vat) };
};

const isCzk = (currency: CurrencyCode): boolean => currency === "CZK";

/** `VatMath.calculate` plus the per-line amounts the editor shows beside each line. */
export const calculate = (input: PreviewInput): Result.Result<LivePreview, VatRateUnavailable> => {
  const fx = isCzk(input.currency) ? null : input.fx;
  const lines: Array<LineAmounts> = [];
  const groups = new Map<VatTreatment, [LineAmounts, ...Array<LineAmounts>]>();
  for (const line of input.lines) {
    const treatment =
      input.direction === "outgoing"
        ? effectiveTreatment(input.taxRegime, line.treatment)
        : line.treatment;
    const rate = rateFor(treatment, input.taxPoint);
    if (Result.isFailure(rate)) return Result.fail(rate.failure);
    const amounts = lineAmounts(line, treatment, rate.success, input);
    lines.push(amounts);
    const group = groups.get(treatment);
    if (group === undefined) groups.set(treatment, [amounts]);
    else group.push(amounts);
  }

  const buckets: Array<VatBucket> = [];
  for (const treatment of TREATMENT_ORDER) {
    const group = groups.get(treatment);
    if (group === undefined) continue;
    const [first] = group;
    const rate = first.ratePercent;
    let base: BigDecimal.BigDecimal;
    let vat: BigDecimal.BigDecimal;
    let gross: BigDecimal.BigDecimal;
    if (input.pricesIncludeVat) {
      gross = roundAt(BigDecimal.sumAll(Arr.map(group, (l) => l.gross)), SCALE);
      vat = roundAt(divide(BigDecimal.multiply(gross, rate), BigDecimal.sum(HUNDRED, rate)), SCALE);
      base = BigDecimal.subtract(gross, vat);
    } else {
      base = roundAt(BigDecimal.sumAll(Arr.map(group, (l) => l.net)), SCALE);
      vat = roundAt(divide(BigDecimal.multiply(base, rate), HUNDRED), SCALE);
      gross = BigDecimal.sum(base, vat);
    }
    const vatCzk =
      fx === null
        ? null
        : roundAt(
            divide(BigDecimal.multiply(vat, fx.rate), BigDecimal.fromBigInt(BigInt(fx.quantity))),
            SCALE,
          );
    buckets.push({
      treatment: first.treatment,
      ratePercent: rate,
      base: BigDecimal.normalize(base),
      vat,
      gross: BigDecimal.normalize(gross),
      vatCzk,
    });
  }

  const money = (amount: BigDecimal.BigDecimal): Money =>
    MoneyMath.make(BigDecimal.normalize(amount), input.currency);
  const net = BigDecimal.sumAll(Arr.map(buckets, (b) => b.base));
  const vat = BigDecimal.sumAll(Arr.map(buckets, (b) => b.vat));
  const exact = BigDecimal.sum(net, vat);
  const toPay = input.paymentRounding === "whole_unit" ? roundAt(exact, 0) : exact;
  const vatCzk =
    fx === null
      ? null
      : MoneyMath.make(
          BigDecimal.normalize(BigDecimal.sumAll(Arr.map(buckets, (b) => b.vatCzk ?? ZERO))),
          CurrencyCode.make("CZK"),
        );
  return Result.succeed({
    lines,
    breakdown: {
      buckets,
      net: money(net),
      vat: money(vat),
      roundingAdjustment: money(BigDecimal.subtract(toPay, exact)),
      gross: money(toPay),
      vatCzk,
    },
  });
};

/** Rounds a full-precision line amount for display (rule 1: 2 decimals). */
export const displayAmount = (amount: BigDecimal.BigDecimal): BigDecimal.BigDecimal =>
  roundAt(amount, SCALE);

// --- Instant preview vs server preview ------------------------------------------------------------

/**
 * Local breakdown shown instantly, replaced by the server `preview` result for the same edit.
 * Every edit bumps `seq`; a server result is applied only when it answers the current `seq`, so a
 * late answer for an older edit never overwrites newer local totals.
 */
export interface PreviewSync {
  readonly seq: number;
  readonly local: VatBreakdown;
  readonly server: Option.Option<{ readonly seq: number; readonly breakdown: VatBreakdown }>;
  /** Local and server totals differ for the same edit: an engine version mismatch (telemetry). */
  readonly calcDrift: boolean;
}

const sameBucket = (a: VatBucket, b: VatBucket): boolean =>
  a.treatment === b.treatment &&
  BigDecimal.equals(a.ratePercent, b.ratePercent) &&
  BigDecimal.equals(a.base, b.base) &&
  BigDecimal.equals(a.vat, b.vat) &&
  BigDecimal.equals(a.gross, b.gross) &&
  (a.vatCzk === null
    ? b.vatCzk === null
    : b.vatCzk !== null && BigDecimal.equals(a.vatCzk, b.vatCzk));

const sameNullableMoney = (a: Money | null, b: Money | null): boolean =>
  a === null ? b === null : b !== null && MoneyMath.equals(a, b);

/** Same totals and buckets (bucket order ignored). */
export const sameBreakdown: {
  (b: VatBreakdown): (a: VatBreakdown) => boolean;
  (a: VatBreakdown, b: VatBreakdown): boolean;
} = Fn.dual(
  2,
  (a: VatBreakdown, b: VatBreakdown): boolean =>
    MoneyMath.equals(a.net, b.net) &&
    MoneyMath.equals(a.vat, b.vat) &&
    MoneyMath.equals(a.gross, b.gross) &&
    MoneyMath.equals(a.roundingAdjustment, b.roundingAdjustment) &&
    sameNullableMoney(a.vatCzk, b.vatCzk) &&
    a.buckets.length === b.buckets.length &&
    Arr.every(a.buckets, (bucket) => Arr.some(b.buckets, (other) => sameBucket(bucket, other))),
);

export const PreviewSync = {
  init: (local: VatBreakdown): PreviewSync => ({
    seq: 0,
    local,
    server: Option.none(),
    calcDrift: false,
  }),
  /** A local edit: new local totals and the next sequence number for the debounced request. */
  edit: (state: PreviewSync, local: VatBreakdown): PreviewSync => ({
    ...state,
    seq: state.seq + 1,
    local,
    calcDrift: false,
  }),
  /** A server preview answered request `seq`; stale answers are ignored. */
  receive: (state: PreviewSync, seq: number, breakdown: VatBreakdown): PreviewSync =>
    seq !== state.seq
      ? state
      : {
          ...state,
          server: Option.some({ seq, breakdown }),
          calcDrift: !sameBreakdown(state.local, breakdown),
        },
  /** What the view shows: the server result for the current edit, else the local one. */
  displayed: (state: PreviewSync): VatBreakdown =>
    Option.match(state.server, {
      onNone: () => state.local,
      onSome: (server) => (server.seq === state.seq ? server.breakdown : state.local),
    }),
  /** True while the shown totals are local only (no server answer for this edit yet). */
  isProvisional: (state: PreviewSync): boolean =>
    Option.match(state.server, { onNone: () => true, onSome: (s) => s.seq !== state.seq }),
};
