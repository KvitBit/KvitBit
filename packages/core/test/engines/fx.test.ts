import { describe, expect, test } from "bun:test";
import { CurrencyCode, Invalid, IsoDate, type IssueCode } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Fx } from "../../src/engines";

const d = BigDecimal.fromStringUnsafe;
const EUR = CurrencyCode.make("EUR");
const CZK = CurrencyCode.make("CZK");

const fixing = (fixingDate: string, sequence: number, eur = "25.125"): CnbFixing => ({
  fixingDate: IsoDate.make(fixingDate),
  sequence,
  rates: [
    { code: EUR, quantity: 1, rate: d(eur) },
    { code: CurrencyCode.make("HUF"), quantity: 100, rate: d("6.512") },
  ],
});

const fxInvalid = (code: IssueCode, params?: Record<string, string>) => {
  const issue = { path: ["fx"], code };
  return Result.fail(
    Invalid.make({ issues: [params === undefined ? issue : { ...issue, params }] }),
  );
};

describe("Fx.toCzk", () => {
  test("amount x rate / quantity, half away from zero at haléře", () => {
    const hundred = Fx.toCzk(d("2100"), { rate: d("6.512"), quantity: 100 }).pipe(
      BigDecimal.format,
    );
    const positiveHalf = Fx.toCzk(d("0.2"), { rate: d("0.025"), quantity: 1 }).pipe(
      BigDecimal.format,
    );
    const negativeHalf = Fx.toCzk(d("-0.2"), { rate: d("0.025"), quantity: 1 }).pipe(
      BigDecimal.format,
    );
    expect(hundred).toBe("136.75");
    expect(positiveHalf).toBe("0.01");
    expect(negativeHalf).toBe("-0.01");
  });
});

describe("Fx.selectFixing", () => {
  // Friday 2026-11-20 (#225), Monday 2026-11-23 (#226); weekend has no fixing.
  const cache = [fixing("2026-11-23", 226), fixing("2026-11-20", 225), fixing("2026-11-24", 227)];

  test("the latest fixing on or before the date; weekends carry Friday's", () => {
    expect(
      Option.map(Fx.selectFixing(cache, IsoDate.make("2026-11-22")), (f) => f.sequence),
    ).toEqual(Option.some(225));
    expect(
      Option.map(Fx.selectFixing(cache, IsoDate.make("2026-11-23")), (f) => f.sequence),
    ).toEqual(Option.some(226));
  });
  test("none before the first cached fixing", () => {
    expect(Fx.selectFixing(cache, IsoDate.make("2026-11-19"))).toEqual(Option.none());
  });
  test("the higher sequence wins on the same date", () => {
    const f = Fx.selectFixing(
      [fixing("2026-11-20", 225, "1"), fixing("2026-11-20", 226, "2")],
      IsoDate.make("2026-11-20"),
    );
    expect(Option.map(f, (x) => BigDecimal.format(x.rates[0]?.rate ?? d("0")))).toEqual(
      Option.some("2"),
    );
  });
});

describe("Fx.resolve", () => {
  const f = fixing("2026-11-20", 225);

  test("CZK has no rate", () => {
    expect(Fx.resolve({ currency: CZK, override: undefined, fixing: null })).toEqual(
      Result.succeed(null),
    );
    expect(Fx.needsFixing(CZK, undefined)).toBe(false);
  });
  test("non-CZK takes the fixing's quote with its quantity", () => {
    expect(Fx.resolve({ currency: CurrencyCode.make("HUF"), override: null, fixing: f })).toEqual(
      Result.succeed({
        rate: d("6.512"),
        quantity: 100,
        fixingDate: IsoDate.make("2026-11-20"),
        source: "cnb",
      }),
    );
    expect(Fx.needsFixing(EUR, null)).toBe(true);
  });
  test("a currency the fixing does not quote is fx.rate_missing", () => {
    expect(Fx.resolve({ currency: CurrencyCode.make("XYZ"), override: null, fixing: f })).toEqual(
      fxInvalid("fx.rate_missing", { currency: "XYZ" }),
    );
    expect(Fx.resolve({ currency: EUR, override: null, fixing: null })).toEqual(
      fxInvalid("fx.rate_missing", { currency: "EUR" }),
    );
  });
  test("a manual rate replaces the fixing", () => {
    const override = { manual: { rate: d("24.5"), quantity: 1 } };
    expect(Fx.resolve({ currency: EUR, override, fixing: f })).toEqual(
      Result.succeed({ rate: d("24.5"), quantity: 1, fixingDate: null, source: "manual" }),
    );
    expect(Fx.needsFixing(EUR, override)).toBe(false);
  });
  test("manual rates are refused for CZK and need rate > 0, integer quantity >= 1", () => {
    expect(
      Fx.resolve({
        currency: CZK,
        override: { manual: { rate: d("1"), quantity: 1 } },
        fixing: null,
      }),
    ).toEqual(fxInvalid("fx.manual_not_allowed_for_czk"));
    for (const manual of [
      { rate: d("0"), quantity: 1 },
      { rate: d("-1"), quantity: 1 },
      { rate: d("25"), quantity: 0 },
      { rate: d("25"), quantity: 1.5 },
    ]) {
      expect(Fx.fromOverride({ manual }, EUR)).toEqual(fxInvalid("fx.manual_rate_invalid"));
    }
  });
});
