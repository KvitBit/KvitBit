/**
 * Pure Money helpers over `BigDecimal` (core-ports section 1, VatMath rules 1 and 5).
 *
 * Amounts keep full precision; `round` applies half-away-from-zero at the currency's minor
 * unit. Mixing currencies is never silently allowed: binary operations return a `Result`
 * that fails with `CurrencyMismatch`.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Data from "effect/Data";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import type { CurrencyCode, Money } from "./vocabulary";

// Money arithmetic returns a local Result. The error has no encoded representation.
// @effect-diagnostics-next-line preferSchemaTaggedError:off
export class CurrencyMismatch extends Data.TaggedError("CurrencyMismatch")<{
  readonly expected: CurrencyCode;
  readonly actual: CurrencyCode;
}> {}

/**
 * ISO 4217 minor-unit exponents that differ from 2. Any other three-letter code uses 2
 * decimals: a product fallback, since CurrencyCode accepts any upper-case three-letter code.
 */
const MINOR_UNIT_EXCEPTIONS: ReadonlyMap<string, number> = new Map([
  ...Arr.map(
    [
      "BIF",
      "CLP",
      "DJF",
      "GNF",
      "ISK",
      "JPY",
      "KMF",
      "KRW",
      "PYG",
      "RWF",
      "UGX",
      "VND",
      "UYI",
      "VUV",
      "XAF",
      "XOF",
      "XPF",
    ],
    (code) => [code, 0] as const,
  ),
  ...Arr.map(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"], (code) => [code, 3] as const),
  ...Arr.map(["CLF", "UYW"], (code) => [code, 4] as const),
]);

/** Number of decimals of the currency's minor unit (CZK and EUR: 2). */
export const minorUnitScale = (currency: CurrencyCode): number =>
  MINOR_UNIT_EXCEPTIONS.get(currency) ?? 2;

export const make: {
  (currency: CurrencyCode): (amount: BigDecimal.BigDecimal) => Money;
  (amount: BigDecimal.BigDecimal, currency: CurrencyCode): Money;
} = Fn.dual(
  2,
  (amount: BigDecimal.BigDecimal, currency: CurrencyCode): Money => ({
    amount,
    currency,
  }),
);

export const zero = (currency: CurrencyCode): Money => make(BigDecimal.fromBigInt(0n), currency);

/** Builds Money from an integer count of minor units (e.g. haléře for CZK). */
export const fromMinorUnits: {
  (currency: CurrencyCode): (units: bigint) => Money;
  (units: bigint, currency: CurrencyCode): Money;
} = Fn.dual(
  2,
  (units: bigint, currency: CurrencyCode): Money =>
    make(BigDecimal.normalize(BigDecimal.make(units, minorUnitScale(currency))), currency),
);

/** Rounds half away from zero to the currency's minor unit, then returns the minor unit count. */
export const toMinorUnits = (money: Money): bigint => {
  const scale = minorUnitScale(money.currency);
  return BigDecimal.scale(round(money).amount, scale).value;
};

/** Half-away-from-zero rounding to `scale` decimals (default: the currency's minor unit). */
export const round: {
  (scale?: number): (money: Money) => Money;
  (money: Money, scale?: number): Money;
} = Fn.dual(
  (args) => typeof args[0] === "object",
  (money: Money, scale = minorUnitScale(money.currency)): Money =>
    make(
      BigDecimal.normalize(BigDecimal.round(money.amount, { scale, mode: "half-from-zero" })),
      money.currency,
    ),
);

export const negate = (money: Money): Money =>
  make(BigDecimal.negate(money.amount), money.currency);

export const isZero = (money: Money): boolean => BigDecimal.isZero(money.amount);

export const isNegative = (money: Money): boolean => BigDecimal.isNegative(money.amount);

/** Same currency and numerically equal amounts (scale-insensitive: 1.5 equals 1.50). */
export const equals: {
  (b: Money): (a: Money) => boolean;
  (a: Money, b: Money): boolean;
} = Fn.dual(
  2,
  (a: Money, b: Money): boolean =>
    a.currency === b.currency && BigDecimal.equals(a.amount, b.amount),
);

const sameCurrency = (a: Money, b: Money): Result.Result<CurrencyCode, CurrencyMismatch> =>
  a.currency === b.currency
    ? Result.succeed(a.currency)
    : Result.fail(new CurrencyMismatch({ expected: a.currency, actual: b.currency }));

export const add: {
  (b: Money): (a: Money) => Result.Result<Money, CurrencyMismatch>;
  (a: Money, b: Money): Result.Result<Money, CurrencyMismatch>;
} = Fn.dual(2, (a: Money, b: Money) =>
  Result.map(sameCurrency(a, b), (currency) => make(BigDecimal.sum(a.amount, b.amount), currency)),
);

export const subtract: {
  (b: Money): (a: Money) => Result.Result<Money, CurrencyMismatch>;
  (a: Money, b: Money): Result.Result<Money, CurrencyMismatch>;
} = Fn.dual(2, (a: Money, b: Money) =>
  Result.map(sameCurrency(a, b), (currency) =>
    make(BigDecimal.subtract(a.amount, b.amount), currency),
  ),
);

/** Multiplies by a decimal factor (quantity, rate). Full precision; round explicitly. */
export const multiply: {
  (factor: BigDecimal.BigDecimal): (money: Money) => Money;
  (money: Money, factor: BigDecimal.BigDecimal): Money;
} = Fn.dual(
  2,
  (money: Money, factor: BigDecimal.BigDecimal): Money =>
    make(BigDecimal.multiply(money.amount, factor), money.currency),
);

/** Sums amounts in `currency`. An empty list is zero; any other currency fails. */
export const sum: {
  (items: Iterable<Money>): (currency: CurrencyCode) => Result.Result<Money, CurrencyMismatch>;
  (currency: CurrencyCode, items: Iterable<Money>): Result.Result<Money, CurrencyMismatch>;
} = Fn.dual(
  2,
  (currency: CurrencyCode, items: Iterable<Money>): Result.Result<Money, CurrencyMismatch> => {
    let total = BigDecimal.fromBigInt(0n);
    for (const item of items) {
      if (item.currency !== currency) {
        return Result.fail(new CurrencyMismatch({ expected: currency, actual: item.currency }));
      }
      total = BigDecimal.sum(total, item.amount);
    }
    return Result.succeed(make(total, currency));
  },
);

/** Orders two amounts of the same currency: -1, 0 or 1. */
export const compare: {
  (b: Money): (a: Money) => Result.Result<-1 | 0 | 1, CurrencyMismatch>;
  (a: Money, b: Money): Result.Result<-1 | 0 | 1, CurrencyMismatch>;
} = Fn.dual(2, (a: Money, b: Money) =>
  Result.map(sameCurrency(a, b), () => BigDecimal.Order(a.amount, b.amount)),
);
