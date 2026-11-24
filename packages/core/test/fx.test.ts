/**
 * The shared FX read-through (src/shared/fx.ts): CNB down and a failing fixing cache stay
 * distinct (`RatesUnavailable` vs `StoreUnavailable`); `orUnavailable` maps them to
 * Unavailable{exchange_rates} and Unavailable{database}. A cache failure is never swallowed.
 */
import { describe, expect, test } from "bun:test";
import type { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import { Unavailable } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { RatesUnavailable } from "@kvitbit/domain/ports";
import { BigDecimal, Cause, Effect, Exit, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { orUnavailable } from "../src/shared/errors";
import { FxFixingCache, FxFixings, FxFixingsLive } from "../src/shared/fx";
import { StoreUnavailable } from "../src/store/CoreStore";
import { FixtureRates } from "../src/testing";
import { TEST_NOW } from "./helpers";

const FRIDAY: CnbFixing = {
  fixingDate: "2026-11-20" as IsoDate,
  sequence: 225,
  rates: [
    { code: "EUR" as CurrencyCode, quantity: 1, rate: BigDecimal.fromStringUnsafe("25.115") },
  ],
};
const SATURDAY = "2026-11-21" as IsoDate;

/** A cache whose reads or writes fail on demand, recording what was put. */
const flakyCache = (fail: { readonly get?: boolean; readonly put?: boolean }) =>
  Layer.effect(
    FxFixingCache,
    Effect.map(Ref.make<ReadonlyArray<IsoDate>>([]), (puts) =>
      FxFixingCache.of({
        get: () =>
          fail.get === true ? Effect.fail(new StoreUnavailable({})) : Effect.succeed(Option.none()),
        put: (on) =>
          fail.put === true
            ? Effect.fail(new StoreUnavailable({}))
            : Ref.update(puts, (p) => [...p, on]),
      }),
    ),
  );

const fixingOn = (
  on: IsoDate,
  cache: Layer.Layer<FxFixingCache>,
  { ratesDown = false }: { readonly ratesDown?: boolean } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(TEST_NOW);
      if (ratesDown) yield* Ref.set((yield* FixtureRates).unavailable, true);
      const fx = yield* FxFixings;
      return {
        raw: yield* Effect.exit(fx.fixing(on)),
        mapped: yield* Effect.exit(orUnavailable(fx.fixing(on))),
      };
    }).pipe(
      Effect.provide(
        FxFixingsLive.pipe(
          Layer.provideMerge(Layer.merge(cache, FixtureRates.layer([FRIDAY]))),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  );

const database = Exit.fail(new Unavailable({ dependency: "database" }));

describe("FxFixings (shared read-through)", () => {
  test("a failing cache read is StoreUnavailable, even while CNB is also down", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({ get: true }), { ratesDown: true });
    expect(r.raw).toEqual(Exit.fail(new StoreUnavailable({})));
    expect(r.mapped).toEqual(database);
  });

  test("a failing cache write is StoreUnavailable, though CNB answered", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({ put: true }));
    expect(r.raw).toEqual(Exit.fail(new StoreUnavailable({})));
    expect(r.mapped).toEqual(database);
  });

  test("CNB down on an empty cache is RatesUnavailable", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({}), { ratesDown: true });
    expect(Exit.isFailure(r.raw) ? Cause.squash(r.raw.cause) : null).toBeInstanceOf(
      RatesUnavailable,
    );
    expect(r.mapped).toEqual(Exit.fail(new Unavailable({ dependency: "exchange_rates" })));
  });

  test("a working cache serves CNB's answer carried back", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({}));
    expect(r.raw).toEqual(Exit.succeed(FRIDAY));
  });
});
