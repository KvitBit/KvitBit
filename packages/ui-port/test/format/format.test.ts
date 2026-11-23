import { describe, expect, test } from "bun:test";
import { BigDecimal } from "effect";
import {
  formatDate,
  formatDateRange,
  formatDateTime,
  formatMoney,
  formatMonth,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatVatRate,
  moneyDisplay,
  parseIsoDate,
} from "../../src/format";

const NBSP = " ";
const spaces = (s: string) => s.replace(/[  ]/g, " ");

describe("money", () => {
  test("cs: NBSP grouping, comma decimals, Kč suffix", () => {
    expect(formatMoney("cs", { amount: "1234.5", currency: "CZK" })).toBe(
      `1${NBSP}234,50${NBSP}Kč`,
    );
    expect(formatMoney("cs", { amount: "12345.50", currency: "CZK" })).toBe(
      `12${NBSP}345,50${NBSP}Kč`,
    );
    expect(spaces(formatMoney("cs", { amount: "-1234.5", currency: "EUR" }))).toBe("-1 234,50 €");
  });

  test("en: currency code or symbol prefix, comma grouping", () => {
    expect(spaces(formatMoney("en", { amount: "1234.5", currency: "CZK" }))).toBe("CZK 1,234.50");
    expect(formatMoney("en", { amount: "1234.5", currency: "EUR" })).toBe("€1,234.50");
  });

  test("accepts BigDecimal without float loss and never prints -0", () => {
    const amount = BigDecimal.fromStringUnsafe("12345678901234567.25");
    expect(spaces(formatMoney("cs", { amount, currency: "CZK" }))).toBe(
      "12 345 678 901 234 567,25 Kč",
    );
    expect(spaces(formatMoney("cs", { amount: "-0.00", currency: "CZK" }))).toBe("0,00 Kč");
  });

  test("zero-decimal currencies and signed deltas", () => {
    expect(spaces(formatMoney("en", { amount: "1500", currency: "JPY" }))).toBe("JP¥1,500");
    expect(spaces(formatMoney("cs", { amount: "12.5", currency: "CZK" }, { signed: true }))).toBe(
      "+12,50 Kč",
    );
  });

  test("moneyDisplay has the MoneyVM shape with tabular figures", () => {
    expect(moneyDisplay("cs", { amount: "-5", currency: "czk" })).toEqual({
      text: `-5,00${NBSP}Kč`,
      sign: "negative",
      tabular: true,
      currency: "CZK",
    });
    expect(moneyDisplay("en", { amount: 0, currency: "EUR" }).sign).toBe("zero");
  });

  test("rejects non-decimal input", () => {
    expect(() => formatMoney("cs", { amount: "1e5", currency: "CZK" })).toThrow(RangeError);
  });
});

describe("numbers, quantities, percent", () => {
  test("numbers and quantities", () => {
    expect(formatNumber("cs", "1234.5")).toBe(`1${NBSP}234,5`);
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatQuantity("cs", "1.5", "h")).toBe(`1,5${NBSP}h`);
    expect(formatQuantity("en", "2.12345")).toBe("2.1235");
  });

  test("percent and VAT rates", () => {
    expect(formatPercent("cs", 21)).toBe(`21${NBSP}%`);
    expect(formatPercent("en", 21)).toBe("21%");
    expect(formatVatRate("cs", 12)).toBe(`12${NBSP}%`);
    expect(formatPercent("cs", "12.5")).toBe(`12,5${NBSP}%`);
  });
});

describe("dates", () => {
  test("calendar dates per locale", () => {
    expect(spaces(formatDate("cs", "2026-11-23"))).toBe("23. 11. 2026");
    expect(formatDate("en", "2026-11-23")).toBe("23 Nov 2026");
    expect(formatDate("en", "2026-11-23", "numeric")).toBe("23/11/2026");
    expect(spaces(formatDate("cs", "2026-11-23", "long"))).toBe("23. listopadu 2026");
  });

  test("dates never shift by time zone", () => {
    expect(spaces(formatDate("cs", "2026-01-01"))).toBe("1. 1. 2026");
    expect(spaces(formatDate("cs", { year: 2026, month: 12, day: 31 }))).toBe("31. 12. 2026");
  });

  test("timestamps in Europe/Prague", () => {
    expect(spaces(formatDateTime("cs", "2026-11-23T13:05:00Z"))).toBe("23. 11. 2026 14:05");
    expect(formatDateTime("en", "2026-07-01T22:30:00Z")).toBe("2 Jul 2026, 00:30");
  });

  test("ranges", () => {
    expect(formatDateRange("cs", "2026-11-01", "2026-11-30")).toBe("1.–30. 11. 2026");
    expect(formatDateRange("cs", "2026-10-01", "2026-11-23")).toBe("1. 10. – 23. 11. 2026");
    expect(spaces(formatDateRange("cs", "2025-12-01", "2026-01-31"))).toBe(
      "1. 12. 2025 – 31. 1. 2026",
    );
    expect(formatDateRange("en", "2026-11-01", "2026-11-30")).toBe("1–30 Nov 2026");
    expect(formatDateRange("en", "2026-10-01", "2026-11-23")).toBe("1 Oct – 23 Nov 2026");
    expect(formatDateRange("en", "2025-12-01", "2026-01-31")).toBe("1 Dec 2025 – 31 Jan 2026");
    expect(formatDateRange("en", "2026-11-23", "2026-11-23")).toBe("23 Nov 2026");
  });

  test("months for report buckets", () => {
    expect(formatMonth("cs", "2026-11")).toBe("listopad 2026");
    expect(formatMonth("en", "2026-11-05")).toBe("November 2026");
  });

  test("ISO parsing rejects impossible days", () => {
    expect(parseIsoDate("2026-02-30")).toBeUndefined();
    expect(parseIsoDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseIsoDate("23.11.2026")).toBeUndefined();
    expect(() => formatDate("cs", "2026-13-01")).toThrow(RangeError);
  });
});
