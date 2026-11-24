import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { ExchangeRates, RatesUnavailable } from "@kvitbit/domain/ports";
import { BigDecimal, Effect } from "effect";
import { FixtureRates } from "../../src/fx";

const thursday = FixtureRates.fixing("2026-11-19", 224, { EUR: [1, "24.300"] });
const friday = FixtureRates.fixing("2026-11-20", 225, { EUR: [1, "24.335"], JPY: [100, "15.123"] });

const lookup = (date: string) =>
  Effect.gen(function* () {
    return yield* (yield* ExchangeRates).fixing(date as IsoDate);
  }).pipe(Effect.provide(FixtureRates.layer([friday, thursday])), Effect.flip, Effect.option);

const fixingOn = (date: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* ExchangeRates).fixing(date as IsoDate);
    }).pipe(Effect.provide(FixtureRates.layer([friday, thursday]))),
  );

describe("FixtureRates", () => {
  test("returns the fixing dated on the requested date", async () => {
    expect((await fixingOn("2026-11-19")).sequence).toBe(224);
    expect((await fixingOn("2026-11-20")).sequence).toBe(225);
  });

  test("carries back to the latest fixing before the requested date", async () => {
    expect<unknown>((await fixingOn("2026-11-22")).fixingDate).toBe("2026-11-20");
  });

  test("fails with RatesUnavailable before the first fixing", async () => {
    const error = await Effect.runPromise(lookup("2026-11-18"));
    expect(error._tag).toBe("Some");
    if (error._tag === "Some") expect(error.value).toBeInstanceOf(RatesUnavailable);
  });

  test("fixing() builds rates from plain values and rejects bad input", () => {
    const jpy = friday.rates.find((r) => r.code === "JPY");
    expect(jpy?.quantity).toBe(100);
    expect(jpy && BigDecimal.format(jpy.rate)).toBe("15.123");
    expect(() => FixtureRates.fixing("2026-02-30", 1, {})).toThrow();
    expect(() => FixtureRates.fixing("2026-11-20", 1, { eur: [1, "1"] })).toThrow();
  });
});
