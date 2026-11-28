/**
 * The shared FX read-through (src/shared/fx.ts): CNB down and a failing fixing cache stay
 * distinct (`RatesUnavailable` vs `StoreUnavailable`); `orUnavailable` maps them to
 * Unavailable{exchange_rates} and Unavailable{database}. A cache failure is never swallowed.
 */
import { describe, expect, test } from "bun:test";
import { CurrencyCode, IsoDate, Unavailable } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { RatesUnavailable } from "@kvitbit/domain/ports";
import * as BigDecimal from "effect/BigDecimal";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as CoreRoot from "../src";
import { orUnavailable } from "../src/shared/errors";
import { FxFixingCache, FxFixings, FxFixingsLive, fxDryRun } from "../src/shared/fx";
import { StoreUnavailable } from "../src/store/CoreStore";
import * as CoreTesting from "../src/testing";
import { FixtureRates } from "../src/testing";
import { TEST_NOW } from "./helpers";
import { withoutStackTrace } from "./helpers/run";

const FRIDAY: CnbFixing = {
  fixingDate: IsoDate.make("2026-11-20"),
  sequence: 225,
  rates: [
    { code: CurrencyCode.make("EUR"), quantity: 1, rate: BigDecimal.fromStringUnsafe("25.115") },
  ],
};
const SATURDAY = IsoDate.make("2026-11-21");

/** A cache whose reads or writes fail on demand, recording what was put. */
const flakyCache = (fail: { readonly get?: boolean; readonly put?: boolean }) =>
  Layer.effect(
    FxFixingCache,
    Effect.map(Ref.make<ReadonlyArray<IsoDate>>([]), (puts) =>
      FxFixingCache.of({
        get: () =>
          fail.get === true ? Effect.fail(StoreUnavailable.make({})) : Effect.succeedNone,
        put: (on) =>
          fail.put === true
            ? Effect.fail(StoreUnavailable.make({}))
            : Ref.update(puts, (p) => [...p, on]),
      }),
    ),
  );

const fixingOn = (
  on: IsoDate,
  cache: Layer.Layer<FxFixingCache>,
  {
    ratesDown = false,
    dryRun = false,
  }: { readonly ratesDown?: boolean; readonly dryRun?: boolean } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(TEST_NOW);
      if (ratesDown === true) yield* Ref.set((yield* FixtureRates).unavailable, true);
      const fx = yield* FxFixings;
      const read = (e: ReturnType<typeof fx.fixing>) => (dryRun === true ? fxDryRun(e) : e);
      return {
        raw: yield* fx.fixing(on).pipe(read, Effect.exit),
        mapped: yield* fx.fixing(on).pipe(read, orUnavailable, Effect.exit),
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

const database = Exit.fail(Unavailable.make({ dependency: "database" }));

describe("FxFixings (shared read-through)", () => {
  test("a failing cache read is StoreUnavailable, even while CNB is also down", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({ get: true }), { ratesDown: true });
    expect(r.raw.pipe(withoutStackTrace)).toEqual(Exit.fail(StoreUnavailable.make({})));
    expect(r.mapped.pipe(withoutStackTrace)).toEqual(database);
  });

  test("a failing cache write is StoreUnavailable, though CNB answered", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({ put: true }));
    expect(r.raw.pipe(withoutStackTrace)).toEqual(Exit.fail(StoreUnavailable.make({})));
    expect(r.mapped.pipe(withoutStackTrace)).toEqual(database);
  });

  test("CNB down on an empty cache is RatesUnavailable", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({}), { ratesDown: true });
    expect(Exit.isFailure(r.raw) ? Cause.squash(r.raw.cause) : null).toBeInstanceOf(
      RatesUnavailable,
    );
    expect(r.mapped.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Unavailable.make({ dependency: "exchange_rates" })),
    );
  });

  test("a dry run returns CNB's answer without writing the cache", async () => {
    // A failing write would surface as StoreUnavailable; a dry run never writes.
    const r = await fixingOn(SATURDAY, flakyCache({ put: true }), { dryRun: true });
    expect(r.raw).toEqual(Exit.succeed(FRIDAY));
    expect(r.mapped).toEqual(Exit.succeed(FRIDAY));
  });

  test("a working cache serves CNB's answer carried back", async () => {
    const r = await fixingOn(SATURDAY, flakyCache({}));
    expect(r.raw).toEqual(Exit.succeed(FRIDAY));
  });
});

describe("FxFixings entry points", () => {
  test("the package root and testing entry export the seam a standalone module layer needs", async () => {
    expect(CoreRoot.FxFixings).toBe(FxFixings);
    expect(CoreRoot.FxFixingsLive).toBe(FxFixingsLive);
    const fixing = await Effect.runPromise(
      Effect.flatMap(CoreRoot.FxFixings, (fx) => fx.fixing(SATURDAY)).pipe(
        Effect.provide(
          CoreTesting.FxFixingsMemory.pipe(
            Layer.provideMerge(FixtureRates.layer([FRIDAY])),
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    );
    expect(fixing).toEqual(FRIDAY);
  });
});
