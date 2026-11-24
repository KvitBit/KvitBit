/**
 * `ExchangeRates` adapters (core-ports.md section 6).
 *
 * - `CnbDailyTxt`: the live CNB daily fixing over `HttpClient`.
 * - `FixtureRates`: fixed fixings for tests and offline development.
 * - `SqlCache`, `MemoryCache`: read-through caches that wrap another `ExchangeRates`.
 *
 * Production stacks them memory over SQL over CNB:
 *
 *   MemoryCache.layer.pipe(
 *     Layer.provide(SqlCache.layer),
 *     Layer.provide(CnbDailyTxt.layerFetch()),
 *   ) // still needs SqlClient
 */
export * as CnbDailyTxt from "./CnbDailyTxt";
export * as FixtureRates from "./FixtureRates";
export * as MemoryCache from "./MemoryCache";
export { MalformedFeed, parseDailyTxt } from "./parse";
export * as SqlCache from "./SqlCache";
