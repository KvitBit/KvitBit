/** BigDecimal helpers shared by the engines. All rounding is half away from zero (VatMath rule 5). */
import { BigDecimal } from "effect";

export const ZERO = BigDecimal.fromBigInt(0n);
export const HUNDRED = BigDecimal.fromBigInt(100n);

export const dec = (value: string | number | bigint): BigDecimal.BigDecimal =>
  typeof value === "bigint"
    ? BigDecimal.fromBigInt(value)
    : typeof value === "number"
      ? BigDecimal.fromStringUnsafe(String(value))
      : BigDecimal.fromStringUnsafe(value);

/** Half away from zero at `scale` decimals, normalized (1.50 -> 1.5). */
export const roundAt = (value: BigDecimal.BigDecimal, scale: number): BigDecimal.BigDecimal =>
  BigDecimal.normalize(BigDecimal.round(value, { scale, mode: "half-from-zero" }));

/**
 * `round(numerator / denominator)` at `scale`. Division runs at Effect's default precision
 * (about 100 digits): an exact half is a terminating decimal and comes out exact, and no
 * non-terminating quotient lies close enough to a half to round the wrong way.
 */
export const divideRound = (
  numerator: BigDecimal.BigDecimal,
  denominator: BigDecimal.BigDecimal,
  scale: number,
): BigDecimal.BigDecimal => roundAt(BigDecimal.divideUnsafe(numerator, denominator), scale);

export const sumAll = (values: Iterable<BigDecimal.BigDecimal>): BigDecimal.BigDecimal => {
  let total = ZERO;
  for (const v of values) total = BigDecimal.sum(total, v);
  return BigDecimal.normalize(total);
};
