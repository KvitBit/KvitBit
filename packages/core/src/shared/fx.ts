/**
 * CNB fixings for the whole core, read through the `fx_fixings` cache (core-ports 6, L1230,
 * L1438): Documents (issue, D2), DocumentPayments (PTD on receipt, P2), Expenses (tax point) and
 * Reports (`fxRate`) all ask `FxFixings`, never `ExchangeRates` directly, so a fixing once
 * fetched stays readable while CNB is down.
 *
 * - `FxFixingCache`: the persistence port. It stores the ANSWER for a requested date (the
 *   fixing valid on it, carried back over weekends and holidays); the SQL adapter maps that onto
 *   fx_fixings (keyed by fixing date) plus the request-date resolution. Only final answers are
 *   cached: a fixing under its publication date, and a past requested date.
 * - `FxFixings`: the read-through service. Both failures stay distinct and raw: CNB down is
 *   `RatesUnavailable`, a cache read or write failure is `StoreUnavailable` (never swallowed: in
 *   Postgres it can abort the caller's transaction); callers map them with `orUnavailable`.
 *
 * Dry runs (previews) read through the cache too, so they may write to it. That is an accepted
 * exception to "dry runs write nothing" (core-ports 4): the cache holds public CNB data, not
 * Workspace state, and a cached answer is the same answer CNB would give again.
 */
import type { IsoDate } from "@kvitbit/domain/contract";
import type { CnbFixing, RatesUnavailable } from "@kvitbit/domain/ports";
import { ExchangeRates } from "@kvitbit/domain/ports";
import { Clock, Context, Effect, Layer, Option, Ref } from "effect";
import { pragueDate } from "../engines/calendar";
import type { StoreUnavailable } from "../store/CoreStore";

/**
 * Process-wide cache of public CNB answers (no Workspace data). Written on any read-through,
 * dry runs included: the one write a preview may make (see the module comment).
 */
export class FxFixingCache extends Context.Service<
  FxFixingCache,
  {
    /** The cached answer for requests on `on`. */
    readonly get: (on: IsoDate) => Effect.Effect<Option.Option<CnbFixing>, StoreUnavailable>;
    /** Records `fixing` as the answer for `on`; idempotent. */
    readonly put: (on: IsoDate, fixing: CnbFixing) => Effect.Effect<void, StoreUnavailable>;
  }
>()("kvitbit/core/FxFixingCache") {}

/** In-memory `FxFixingCache` (tests and single-process dev). */
export const FxFixingCacheMemory: Layer.Layer<FxFixingCache> = Layer.effect(
  FxFixingCache,
  Effect.map(Ref.make<ReadonlyMap<IsoDate, CnbFixing>>(new Map()), (entries) => ({
    get: (on: IsoDate) => Effect.map(Ref.get(entries), (all) => Option.fromNullishOr(all.get(on))),
    put: (on: IsoDate, fixing: CnbFixing) =>
      Ref.update(entries, (all) => (all.has(on) ? all : new Map(all).set(on, fixing))),
  })),
);

/**
 * The fixing valid on `on`: from the cache, else from `ExchangeRates`. A fetched fixing is cached
 * under its own publication date, and under `on` too when that answer is final (`on` before
 * `today`; today's fixing may not be published yet).
 */
export const cachedFixing = (
  on: IsoDate,
  today: IsoDate,
): Effect.Effect<CnbFixing, RatesUnavailable | StoreUnavailable, FxFixingCache | ExchangeRates> =>
  Effect.gen(function* () {
    const cache = yield* FxFixingCache;
    const hit = yield* cache.get(on);
    if (Option.isSome(hit)) return hit.value;
    const fixing = yield* (yield* ExchangeRates).fixing(on);
    // A fixing is always the final answer for its own publication date.
    yield* cache.put(fixing.fixingDate, fixing);
    if (on !== fixing.fixingDate && on < today) yield* cache.put(on, fixing);
    return fixing;
  });

/**
 * The core's one way to a CNB fixing (read through `FxFixingCache`). A miss caches the answer
 * even in a dry run (accepted: public data, not Workspace state).
 */
export class FxFixings extends Context.Service<
  FxFixings,
  {
    /** The fixing valid on `on` (carried back), like `ExchangeRates.fixing`. */
    readonly fixing: (on: IsoDate) => Effect.Effect<CnbFixing, RatesUnavailable | StoreUnavailable>;
  }
>()("kvitbit/core/FxFixings") {}

/** `FxFixings` over `ExchangeRates` and `FxFixingCache`; "today" is the Prague date. */
export const FxFixingsLive: Layer.Layer<FxFixings, never, ExchangeRates | FxFixingCache> =
  Layer.effect(
    FxFixings,
    Effect.gen(function* () {
      const rates = yield* ExchangeRates;
      const cache = yield* FxFixingCache;
      return FxFixings.of({
        fixing: (on) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            cachedFixing(on, pragueDate(now)).pipe(
              Effect.provideService(ExchangeRates, rates),
              Effect.provideService(FxFixingCache, cache),
            ),
          ),
      });
    }),
  );

/** `FxFixingsLive` with its own in-memory cache (module test layers). */
export const FxFixingsMemory: Layer.Layer<FxFixings, never, ExchangeRates> = FxFixingsLive.pipe(
  Layer.provide(FxFixingCacheMemory),
);
