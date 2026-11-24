/**
 * `ExchangeRates` over a fixed set of fixings, for tests and offline development. Same
 * contract as the live adapter: the latest fixing dated on or before the requested date,
 * else `RatesUnavailable`.
 */

import { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Layer, Schema } from "effect";

export class NoFixingOnOrBefore extends Error {
  override readonly name = "NoFixingOnOrBefore";
}

export const make = (fixings: Iterable<CnbFixing>): ExchangeRates["Service"] => {
  const newestFirst = [...fixings].sort((a, b) => b.fixingDate.localeCompare(a.fixingDate));
  return {
    fixing: (date) => {
      const found = newestFirst.find((f) => f.fixingDate <= date);
      return found
        ? Effect.succeed(found)
        : Effect.fail(new RatesUnavailable({ cause: new NoFixingOnOrBefore(date) }));
    },
  };
};

export const layer = (fixings: Iterable<CnbFixing>): Layer.Layer<ExchangeRates> =>
  Layer.succeed(ExchangeRates, make(fixings));

/**
 * A fixing from plain values: `fixing("2026-11-20", 225, { EUR: [1, "24.335"], JPY: [100, "15.123"] })`.
 * Rates use a decimal point. Throws on an invalid date or currency code.
 */
export const fixing = (
  fixingDate: string,
  sequence: number,
  rates: Readonly<Record<string, readonly [quantity: number, rate: string]>>,
): CnbFixing => ({
  fixingDate: Schema.decodeUnknownSync(IsoDate)(fixingDate),
  sequence,
  rates: Object.entries(rates).map(([code, [quantity, rate]]) => ({
    code: Schema.decodeUnknownSync(CurrencyCode)(code),
    quantity,
    rate: BigDecimal.fromStringUnsafe(rate),
  })),
});
