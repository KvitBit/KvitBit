/**
 * `ExchangeRates` over the live CNB daily fixing (core-ports.md section 6):
 * `GET denni_kurz.txt?date=DD.MM.YYYY`.
 *
 * For a weekend, holiday or a day before the 14:30 publication CNB answers with the last
 * fixing published before the requested date, so the fixing date comes from the feed header,
 * never from the request. A fixing dated after the requested date breaks the port contract
 * and fails. Every HTTP, network, timeout or parse failure is `RatesUnavailable`.
 */

import type { IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { parseDailyTxt } from "./parse";

export const DEFAULT_URL =
  "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt";

export interface Options {
  /** Feed URL without the `date` parameter. Default: `DEFAULT_URL`. */
  readonly url?: string;
  /** Limit for the whole request, body included. Default: 10 seconds. */
  readonly timeout?: Duration.Input;
}

/** `2026-11-21` → `21.11.2026` */
const czechDate = (date: IsoDate): string => {
  const [year, month, day] = Str.split(date, "-");
  return `${day}.${month}.${year}`;
};

export class FixingAfterRequestedDate extends Schema.TaggedError<
  FixingAfterRequestedDate,
  { readonly brand: unique symbol }
>()("FixingAfterRequestedDate", { message: Schema.String }) {}

export const make = Effect.fn("CnbDailyTxt.make")(function* (options: Options = {}) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const url = options.url ?? DEFAULT_URL;
  const timeout = options.timeout ?? Duration.seconds(10);

  const fixing = (date: IsoDate): Effect.Effect<CnbFixing, RatesUnavailable> =>
    client.get(url, { urlParams: { date: czechDate(date) } }).pipe(
      Effect.flatMap((response) => response.text),
      Effect.timeout(timeout),
      Effect.flatMap(parseDailyTxt),
      Effect.filterOrFail(
        (result) => result.fixingDate <= date,
        (result) =>
          FixingAfterRequestedDate.make({
            message: `fixing ${result.fixingDate} is after ${date}`,
          }),
      ),
      Effect.mapError((cause) => RatesUnavailable.make({ cause })),
      Effect.withSpan("CnbDailyTxt.fixing", { attributes: { date } }),
    );

  return { fixing };
});

/** Needs an `HttpClient`; see `layerFetch` for the fetch-backed one. */
export const layer = (
  options?: Options,
): Layer.Layer<ExchangeRates, never, HttpClient.HttpClient> =>
  Layer.effect(ExchangeRates, make(options));

/** `layer` over the global `fetch`. */
export const layerFetch = (options?: Options): Layer.Layer<ExchangeRates> =>
  layer(options).pipe(Layer.provide(FetchHttpClient.layer));
