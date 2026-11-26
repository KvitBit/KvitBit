/**
 * Live `ExchangeRates` port: in-memory cache over `fx_fixings` SQL cache over CNB daily txt.
 */
import { CnbDailyTxt, MemoryCache, SqlCache } from "@kvitbit/adapters/fx";
import type { ExchangeRates } from "@kvitbit/domain/ports";
import { Layer } from "effect";
import type { SqlClient } from "effect/sql";

export const ExchangeRatesLive: Layer.Layer<ExchangeRates, never, SqlClient.SqlClient> =
  MemoryCache.layer.pipe(Layer.provide(SqlCache.layer), Layer.provide(CnbDailyTxt.layerFetch()));
