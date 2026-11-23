/**
 * `FxFixingCache`: the fx_fixings cache that `ExchangeRates` is read through (core-ports 6,
 * L1230, L1438), so a fixing once fetched stays readable while CNB is down. The port stores the
 * ANSWER for a requested date (the fixing valid on it, carried back over weekends and holidays);
 * the SQL adapter maps that onto fx_fixings (keyed by fixing date) plus the request-date
 * resolution. Only final answers are cached: a past date, or a date whose own fixing is out.
 */
import type { IsoDate } from "@kvitbit/domain/contract";
import type { CnbFixing, RatesUnavailable } from "@kvitbit/domain/ports";
import { ExchangeRates } from "@kvitbit/domain/ports";
import { Context, Effect, Layer, Option, Ref } from "effect";
import type { StoreUnavailable } from "../../store/CoreStore";

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
 * The fixing valid on `on`: from the cache, else from `ExchangeRates` (then cached when final:
 * `on` is before `today`, or the fixing is `on`'s own).
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
    if (on < today || fixing.fixingDate === on) yield* cache.put(on, fixing);
    return fixing;
  });
