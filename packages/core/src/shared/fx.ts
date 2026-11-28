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
 * Dry runs (previews) write nothing (core-ports 4), the cache included: they run under
 * `fxDryRun`, which makes `FxFixings` read the cache and CNB without storing what it fetched.
 */

import type { IsoDate } from "@kvitbit/domain/contract";
import type { CnbFixing, RatesUnavailable } from "@kvitbit/domain/ports";
import { ExchangeRates } from "@kvitbit/domain/ports";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import { pragueDate } from "../engines/calendar";
import type { StoreUnavailable } from "../store/CoreStore";

/** Process-wide cache of public CNB answers (no Workspace data); never written by a dry run. */
export class FxFixingCache extends Context.Service<
  FxFixingCache,
  {
    /** The cached answer for requests on `on`. */
    readonly get: (on: IsoDate) => Effect.Effect<Option.Option<CnbFixing>, StoreUnavailable>;
    /** Records `fixing` as the answer for `on`; idempotent. */
    readonly put: (on: IsoDate, fixing: CnbFixing) => Effect.Effect<void, StoreUnavailable>;
  }
>()("@kvitbit/core/shared/fx/FxFixingCache") {}

/** In-memory `FxFixingCache` (tests and single-process dev). */
export const FxFixingCacheMemory: Layer.Layer<FxFixingCache> = Layer.effect(
  FxFixingCache,
  Effect.map(Ref.make<ReadonlyMap<IsoDate, CnbFixing>>(new Map()), (entries) => ({
    get: (on: IsoDate) => Effect.map(Ref.get(entries), (all) => Option.fromNullishOr(all.get(on))),
    put: (on: IsoDate, fixing: CnbFixing) =>
      Ref.update(entries, (all) => (all.has(on) ? all : new Map(all).set(on, fixing))),
  })),
);

type FixingEffect = Effect.Effect<
  CnbFixing,
  RatesUnavailable | StoreUnavailable,
  FxFixingCache | ExchangeRates
>;

/**
 * The fixing valid on `on`: from the cache, else from `ExchangeRates`. A fetched fixing is cached
 * under its own publication date, and under `on` too when that answer is final (`on` before
 * `today`; today's fixing may not be published yet). With `persist: false` (a dry run) a fetched
 * fixing is returned without being cached.
 */
export const cachedFixing: {
  (today: IsoDate, persist?: boolean): (on: IsoDate) => FixingEffect;
  (on: IsoDate, today: IsoDate, persist?: boolean): FixingEffect;
} = Fn.dual(
  (args) => Predicate.isString(args[1]),
  Effect.fnUntraced(function* (on: IsoDate, today: IsoDate, persist?: boolean) {
    const cache = yield* FxFixingCache;
    const hit = yield* cache.get(on);
    if (Option.isSome(hit)) return hit.value;
    const fixing = yield* (yield* ExchangeRates).fixing(on);
    if (persist === false) return fixing;
    // A fixing is always the final answer for its own publication date.
    yield* cache.put(fixing.fixingDate, fixing);
    if (on !== fixing.fixingDate && on < today) yield* cache.put(on, fixing);
    return fixing;
  }),
);

/**
 * Whether the current call is a dry run: `FxFixings` then stores nothing. Set with `fxDryRun`;
 * read at call time, so it reaches the fixing reads deep inside a preview's composition.
 */
const FxDryRun = Context.Reference<boolean>("kvitbit/core/FxDryRun", {
  defaultValue: () => false,
});

/** Runs `effect` as a dry run: its CNB fixings come from the cache or CNB, never stored. */
export const fxDryRun = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, FxDryRun, true);

/**
 * The core's one way to a CNB fixing (read through `FxFixingCache`). Under `fxDryRun` a miss is
 * fetched but not cached.
 */
export class FxFixings extends Context.Service<
  FxFixings,
  {
    /** The fixing valid on `on` (carried back), like `ExchangeRates.fixing`. */
    readonly fixing: (on: IsoDate) => Effect.Effect<CnbFixing, RatesUnavailable | StoreUnavailable>;
  }
>()("@kvitbit/core/shared/fx/FxFixings") {}

/** `FxFixings` over `ExchangeRates` and `FxFixingCache`; "today" is the Prague date. */
export const FxFixingsLive: Layer.Layer<FxFixings, never, ExchangeRates | FxFixingCache> =
  Layer.effect(
    FxFixings,
    Effect.gen(function* () {
      const rates = yield* ExchangeRates;
      const cache = yield* FxFixingCache;
      return FxFixings.of({
        fixing: Effect.fn("FxFixings.fixing")(function* (on) {
          const now = yield* Clock.currentTimeMillis;
          const dryRun = yield* FxDryRun;
          return yield* cachedFixing(on, pragueDate(now), !dryRun).pipe(
            Effect.provideService(ExchangeRates, rates),
            Effect.provideService(FxFixingCache, cache),
          );
        }),
      });
    }),
  );

/** `FxFixingsLive` with its own in-memory cache (module test layers). */
export const FxFixingsMemory: Layer.Layer<FxFixings, never, ExchangeRates> = FxFixingsLive.pipe(
  Layer.provide(FxFixingCacheMemory),
);
