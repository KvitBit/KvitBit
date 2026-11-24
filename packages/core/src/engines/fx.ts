/**
 * FX (rule D11, §4(8)): the CZK rate a non-CZK document uses, and conversion to CZK.
 *
 * - A CNB fixing quotes `rate` CZK per `quantity` units (množství); conversion is always
 *   amount x rate / quantity, rounded half away from zero to 2 decimals (haléře).
 * - The fixing for a tax point is the latest one published on or before it: a weekend or
 *   holiday carries the previous working day's fixing (`selectFixing`). Among fixings of the
 *   same date the highest `sequence` wins.
 * - A manual override (`FxOverride`, decision Q4) replaces the fixing, needs `rate > 0` and an
 *   integer `quantity >= 1`, and is refused for CZK documents.
 */

import type { CurrencyCode, FxOverride, IsoDate } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { BigDecimal, Option, Result } from "effect";
import { divideRound } from "./decimal";

/** The rate a document shows (`DocumentView.fx`). */
export interface FxRate {
  readonly rate: BigDecimal.BigDecimal;
  readonly quantity: number;
  /** null for a manual rate. */
  readonly fixingDate: IsoDate | null;
  readonly source: "cnb" | "manual";
}

const CZK = "CZK" as CurrencyCode;

const invalid = (
  code: "fx.rate_missing" | "fx.manual_rate_invalid" | "fx.manual_not_allowed_for_czk",
  params?: Record<string, string>,
) => new Invalid({ issues: [{ path: ["fx"], code, ...(params ? { params } : {}) }] });

/** Converts `amount` (in the rate's currency) to CZK, rounded to haléře. */
export const toCzk = (
  amount: BigDecimal.BigDecimal,
  fx: Pick<FxRate, "rate" | "quantity">,
): BigDecimal.BigDecimal =>
  divideRound(BigDecimal.multiply(amount, fx.rate), BigDecimal.fromBigInt(BigInt(fx.quantity)), 2);

/** The fixing valid on `date` among cached fixings: latest `fixingDate <= date`. */
export const selectFixing = (
  fixings: Iterable<CnbFixing>,
  date: IsoDate,
): Option.Option<CnbFixing> => {
  let best: CnbFixing | undefined;
  for (const f of fixings) {
    if (f.fixingDate > date) continue;
    if (
      best === undefined ||
      f.fixingDate > best.fixingDate ||
      (f.fixingDate === best.fixingDate && f.sequence > best.sequence)
    ) {
      best = f;
    }
  }
  return Option.fromNullishOr(best);
};

/** The currency's rate in a fixing; `Invalid{fx.rate_missing}` when CNB does not quote it. */
export const fromFixing = (
  fixing: CnbFixing,
  currency: CurrencyCode,
): Result.Result<FxRate, Invalid> => {
  const quote = fixing.rates.find((r) => r.code === currency);
  return quote === undefined
    ? Result.fail(invalid("fx.rate_missing", { currency }))
    : Result.succeed({
        rate: quote.rate,
        quantity: quote.quantity,
        fixingDate: fixing.fixingDate,
        source: "cnb",
      });
};

/** Validates a manual rate for a document in `currency`. */
export const fromOverride = (
  override: FxOverride,
  currency: CurrencyCode,
): Result.Result<FxRate, Invalid> => {
  if (currency === CZK) return Result.fail(invalid("fx.manual_not_allowed_for_czk"));
  const { rate, quantity } = override.manual;
  if (!BigDecimal.isPositive(rate) || !Number.isInteger(quantity) || quantity < 1) {
    return Result.fail(invalid("fx.manual_rate_invalid"));
  }
  return Result.succeed({ rate, quantity, fixingDate: null, source: "manual" });
};

/**
 * The document's rate: null for CZK, the manual override when set, else the CNB fixing (the
 * caller fetches it with `ExchangeRates.fixing(taxPoint)`, which already carries back).
 * A CZK document with an override fails `fx.manual_not_allowed_for_czk`.
 */
export const resolve = (input: {
  readonly currency: CurrencyCode;
  readonly override: FxOverride | null | undefined;
  readonly fixing: CnbFixing | null;
}): Result.Result<FxRate | null, Invalid> => {
  if (input.override != null) return fromOverride(input.override, input.currency);
  if (input.currency === CZK) return Result.succeed(null);
  if (input.fixing === null)
    return Result.fail(invalid("fx.rate_missing", { currency: input.currency }));
  return fromFixing(input.fixing, input.currency);
};

/** Whether a document in `currency` needs a fixing fetched (non-CZK without an override). */
export const needsFixing = (currency: CurrencyCode, override: FxOverride | null | undefined) =>
  currency !== CZK && override == null;

export const Fx = { toCzk, selectFixing, fromFixing, fromOverride, resolve, needsFixing } as const;
