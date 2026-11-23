import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { type CnbFixing, ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { FixtureRates, MemoryCache } from "../../src/fx";
import { counting } from "./support";

const friday = FixtureRates.fixing("2026-11-20", 225, { EUR: [1, "24.335"] });
const monday = FixtureRates.fixing("2026-11-23", 226, { EUR: [1, "24.310"] });

/** 2026-11-23 10:00 in Prague (UTC+1), before the 14:30 publication. */
const MONDAY_MORNING = Date.UTC(2026, 10, 23, 9, 0);

const withCache = <A, E>(
  inner: Layer.Layer<ExchangeRates>,
  body: Effect.Effect<A, E, ExchangeRates>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(MONDAY_MORNING);
      return yield* body;
    }).pipe(
      Effect.provide(MemoryCache.layer.pipe(Layer.provide(inner))),
      Effect.provide(TestClock.layer()),
    ),
  );

const fixing = (date: string) =>
  Effect.gen(function* () {
    return yield* (yield* ExchangeRates).fixing(date as IsoDate);
  });

describe("MemoryCache", () => {
  test("a repeated past date is served without a second inner call", async () => {
    const inner = counting(FixtureRates.make([friday]));
    await withCache(
      inner.layer,
      Effect.gen(function* () {
        expect((yield* fixing("2026-11-20")).sequence).toBe(225);
        expect((yield* fixing("2026-11-20")).sequence).toBe(225);
        // A carried-back weekend answer for a finished day is final too.
        expect<unknown>((yield* fixing("2026-11-22")).fixingDate).toBe("2026-11-20");
        expect<unknown>((yield* fixing("2026-11-22")).fixingDate).toBe("2026-11-20");
      }),
    );
    expect(inner.state.calls).toBe(2);
  });

  test("today's carried-back answer is not cached, so the 14:30 fixing is picked up", async () => {
    let published: ReadonlyArray<CnbFixing> = [friday];
    const inner = counting({
      fixing: (date) => Effect.suspend(() => FixtureRates.make(published).fixing(date)),
    });
    await withCache(
      inner.layer,
      Effect.gen(function* () {
        expect<unknown>((yield* fixing("2026-11-23")).fixingDate).toBe("2026-11-20");
        published = [friday, monday];
        expect<unknown>((yield* fixing("2026-11-23")).fixingDate).toBe("2026-11-23");
        // Now dated on the requested day: final.
        expect<unknown>((yield* fixing("2026-11-23")).fixingDate).toBe("2026-11-23");
      }),
    );
    expect(inner.state.calls).toBe(2);
  });

  test("failures are not cached", async () => {
    let fail = true;
    const inner = counting({
      fixing: (date) =>
        Effect.suspend(() =>
          fail ? Effect.fail(new RatesUnavailable({})) : FixtureRates.make([friday]).fixing(date),
        ),
    });
    await withCache(
      inner.layer,
      Effect.gen(function* () {
        expect(yield* Effect.flip(fixing("2026-11-20"))).toBeInstanceOf(RatesUnavailable);
        fail = false;
        expect((yield* fixing("2026-11-20")).sequence).toBe(225);
      }),
    );
    expect(inner.state.calls).toBe(2);
  });
});
