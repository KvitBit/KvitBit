/**
 * `ExchangeRates` over a fixed set of fixings, for tests and offline development. Same
 * contract as the live adapter: the latest fixing dated on or before the requested date,
 * else `RatesUnavailable`.
 */

import { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export class NoFixingOnOrBefore extends Schema.TaggedError<
  NoFixingOnOrBefore,
  { readonly brand: unique symbol }
>()("NoFixingOnOrBefore", { message: Schema.String }) {}

export const make = (fixings: Iterable<CnbFixing>): ExchangeRates["Service"] => {
  const newestFirst = [...fixings].sort((a, b) => Str.localeCompare(a.fixingDate)(b.fixingDate));
  return {
    fixing: Effect.fnUntraced(function* (date) {
      const found = Arr.findFirst(newestFirst, (candidate) => candidate.fixingDate <= date);
      const latest = yield* Effect.fromOption(found).pipe(
        Effect.mapError(() =>
          RatesUnavailable.make({ cause: NoFixingOnOrBefore.make({ message: date }) }),
        ),
      );
      return latest;
    }),
  };
};

export const layer = (fixings: Iterable<CnbFixing>): Layer.Layer<ExchangeRates> =>
  Layer.succeed(ExchangeRates, make(fixings));

/**
 * A fixing from plain values: `fixing("2026-11-20", 225, { EUR: [1, "24.335"], JPY: [100, "15.123"] })`.
 * Rates use a decimal point. Throws on an invalid date or currency code.
 */
type FixtureRates = Readonly<Record<string, readonly [quantity: number, rate: string]>>;

export const fixing: {
  (sequence: number, rates: FixtureRates): (fixingDate: string) => CnbFixing;
  (fixingDate: string, sequence: number, rates: FixtureRates): CnbFixing;
} = Fn.dual(
  3,
  (fixingDate: string, sequence: number, rates: FixtureRates): CnbFixing => ({
    fixingDate: IsoDate.make(fixingDate),
    sequence,
    rates: Arr.map(Rec.toEntries(rates), ([code, [quantity, rate]]) => ({
      code: CurrencyCode.make(code),
      quantity,
      rate: BigDecimal.fromStringUnsafe(rate),
    })),
  }),
);
