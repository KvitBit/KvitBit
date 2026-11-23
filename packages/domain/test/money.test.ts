import { describe, expect, test } from "bun:test";
import { BigDecimal, Result, Schema } from "effect";
import { CurrencyCode, type Money, MoneyMath } from "../src/index";

const cur = Schema.decodeUnknownSync(CurrencyCode);
const CZK = cur("CZK");
const EUR = cur("EUR");
const JPY = cur("JPY");
const m = (amount: string, currency = CZK): Money =>
  MoneyMath.make(BigDecimal.fromStringUnsafe(amount), currency);
const str = (money: Money) => BigDecimal.format(money.amount);
const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error("expected success");
  return r.success;
};

describe("rounding", () => {
  test.each([
    ["1.005", "1.01"],
    ["1.004", "1"],
    ["-2.345", "-2.35"], // half away from zero, not half-up
    ["-2.344", "-2.34"],
    ["0.125", "0.13"],
    ["7", "7"],
  ])("round(%p) = %p", (input, expected) => {
    expect(str(MoneyMath.round(m(input)))).toBe(expected);
  });
  test("zero-decimal currencies round to whole units", () => {
    expect(str(MoneyMath.round(m("100.5", JPY)))).toBe("101");
    expect(MoneyMath.minorUnitScale(JPY)).toBe(0);
    expect(MoneyMath.minorUnitScale(CZK)).toBe(2);
  });
  test.each([
    ["KWD", 3, "1.0005", "1.001"],
    ["CLF", 4, "1.00005", "1.0001"],
    ["XYZ", 2, "1.005", "1.01"], // unknown codes fall back to 2
  ])("%s uses %p decimals", (code, scale, input, expected) => {
    const c = cur(code);
    expect(MoneyMath.minorUnitScale(c)).toBe(scale);
    expect(str(MoneyMath.round(m(input, c)))).toBe(expected);
  });
});

describe("minor units", () => {
  test("CZK haléře round-trip", () => {
    expect(MoneyMath.toMinorUnits(m("1210.5"))).toBe(121050n);
    expect(MoneyMath.toMinorUnits(m("-0.005"))).toBe(-1n);
    expect(MoneyMath.equals(MoneyMath.fromMinorUnits(121050n, CZK), m("1210.50"))).toBe(true);
  });
  test("UYI has no minor unit", () => {
    const UYI = cur("UYI");
    expect(MoneyMath.toMinorUnits(m("1", UYI))).toBe(1n);
    expect(MoneyMath.equals(MoneyMath.fromMinorUnits(1n, UYI), m("1", UYI))).toBe(true);
  });
  test("JPY has no minor unit", () => {
    expect(MoneyMath.toMinorUnits(m("1234", JPY))).toBe(1234n);
    expect(MoneyMath.equals(MoneyMath.fromMinorUnits(5n, JPY), m("5", JPY))).toBe(true);
  });
});

describe("arithmetic", () => {
  test("add and subtract keep full precision", () => {
    expect(str(ok(MoneyMath.add(m("0.1"), m("0.2"))))).toBe("0.3");
    expect(str(ok(MoneyMath.subtract(m("1"), m("1.001"))))).toBe("-0.001");
  });
  test("mixing currencies fails instead of converting", () => {
    const r = MoneyMath.add(m("1"), m("1", EUR));
    expect(Result.isFailure(r)).toBe(true);
    if (Result.isFailure(r)) {
      expect(r.failure).toBeInstanceOf(MoneyMath.CurrencyMismatch);
      expect(r.failure.expected).toBe(CZK);
      expect(r.failure.actual).toBe(EUR);
    }
    expect(Result.isFailure(MoneyMath.compare(m("1"), m("1", EUR)))).toBe(true);
  });
  test("sum of nothing is zero; foreign item fails", () => {
    expect(MoneyMath.isZero(ok(MoneyMath.sum(CZK, [])))).toBe(true);
    expect(str(ok(MoneyMath.sum(CZK, [m("1.5"), m("2.25"), m("-0.75")])))).toBe("3");
    expect(Result.isFailure(MoneyMath.sum(CZK, [m("1"), m("1", EUR)]))).toBe(true);
  });
  test("multiply, negate, compare, equals", () => {
    expect(str(MoneyMath.multiply(m("100"), BigDecimal.fromStringUnsafe("0.21")))).toBe("21");
    expect(MoneyMath.isNegative(MoneyMath.negate(m("5")))).toBe(true);
    expect(ok(MoneyMath.compare(m("1.50"), m("1.5")))).toBe(0);
    expect(ok(MoneyMath.compare(m("1"), m("2")))).toBe(-1);
    expect(MoneyMath.equals(m("1"), m("1", EUR))).toBe(false);
  });
});
