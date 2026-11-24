import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Result } from "effect";
import type { NumberPattern } from "../../src/engines";
import { Numbering } from "../../src/engines";

const D = (s: string) => s as IsoDate;
const parse = (p: string): NumberPattern => Result.getOrThrow(Numbering.parsePattern(p));
const invalid = (reason: string, path = "pattern") =>
  Result.fail(
    new Invalid({
      issues: [{ path: [path], code: "numbering.pattern_invalid", params: { reason } }],
    }),
  );

describe("Numbering.parsePattern", () => {
  test("tokenizes and derives the reset from the finest date token", () => {
    expect(parse("FV-YYYY-NNNN")).toEqual({
      tokens: [
        { _tag: "Literal", text: "FV-" },
        { _tag: "Year4" },
        { _tag: "Literal", text: "-" },
        { _tag: "Counter", width: 4 },
      ],
      reset: "yearly",
    });
    expect(parse("YYMMNNN").reset).toBe("monthly");
    expect(parse("ZF-NNNNN").reset).toBe("never");
    expect(parse("N").tokens).toEqual([{ _tag: "Counter", width: 1 }]);
    // Words with other letters are literal: Y, M and N inside them are not tokens.
    expect(parse("INV-YYYY-NNNN").tokens[0]).toEqual({ _tag: "Literal", text: "INV-" });
    expect(Numbering.format(parse("FAKTURA/YY/NNN"), D("2026-11-23"), 5)).toBe("FAKTURA/26/005");
    expect(Numbering.format(parse("MONTHLY-NN"), D("2026-11-23"), 5)).toBe("MONTHLY-05");
  });

  test.each([
    ["", "empty"],
    ["FV-YYYY", "counter_missing"],
    ["INV-YYYY", "counter_missing"],
    ["NY-NNN", "year_run"],
    ["NN-YYYY-NN", "counter_repeated"],
    ["YYY-NNN", "year_run"],
    ["Y-NNN", "year_run"],
    ["YYYYY-NNN", "year_run"],
    ["YYYY-M-NNN", "month_run"],
    ["MM-NNNN", "month_without_year"],
    [" YYYY-NNNN", "whitespace_edge"],
    ["YYYY\tNNNN", "control_character"],
  ])("%p is invalid (%s)", (pattern, reason) => {
    expect(Numbering.parsePattern(pattern)).toEqual(invalid(reason));
  });

  test("20 rendered characters is the limit", () => {
    expect(Result.isSuccess(Numbering.parsePattern("ABCDEFGHIJ-YYYY-NNNN"))).toBe(true); // 20
    expect(Numbering.parsePattern("ABCDEFGHIJK-YYYY-NNNN")).toEqual(invalid("too_long")); // 21
  });
});

describe("Numbering.periodKey and format", () => {
  test("period keys per reset", () => {
    expect(Numbering.periodKey(parse("YYYY-NNNN"), D("2026-11-23"))).toBe("2026");
    expect(Numbering.periodKey(parse("YY/MM/NNN"), D("2026-03-01"))).toBe("2026-03");
    expect(Numbering.periodKey(parse("NNNNNN"), D("2026-03-01"))).toBe("all");
  });

  test("renders date tokens and the zero-padded counter", () => {
    expect(Numbering.format(parse("FV-YY-NNN"), D("2026-11-23"), 7)).toBe("FV-26-007");
    expect(Numbering.format(parse("YYYYMMNNNN"), D("2026-03-09"), 42)).toBe("2026030042");
    expect(Numbering.format(parse("YYYY-NNNN"), D("2026-01-01"), 1)).toBe("2026-0001");
  });

  test("a counter past its width widens instead of truncating", () => {
    expect(Numbering.format(parse("NNN"), D("2026-01-01"), 1000)).toBe("1000");
  });

  test("a counter below 1 is a defect", () => {
    expect(() => Numbering.format(parse("NNN"), D("2026-01-01"), 0)).toThrow();
  });
});

describe("Numbering.variableSymbol", () => {
  test("digits only, last 10; null without digits", () => {
    expect(Numbering.variableSymbol("FV-2026-0042")).toBe("20260042");
    expect(Numbering.variableSymbol("2026/11/000123456")).toBe("1000123456");
    expect(Numbering.variableSymbol("ABC")).toBeNull();
  });
});

describe("Numbering guards", () => {
  test("checkNextCounter: may raise or keep, never lower the next counter", () => {
    expect(Numbering.checkNextCounter(5, 5)).toEqual(Result.succeed(5));
    expect(Numbering.checkNextCounter(5, 900)).toEqual(Result.succeed(900));
    expect(Numbering.checkNextCounter(5, 4)).toEqual(
      Result.fail(
        new Invalid({
          issues: [
            {
              path: ["nextNumber"],
              code: "numbering.pattern_invalid",
              params: { reason: "below_used", minimum: "5" },
            },
          ],
        }),
      ),
    );
    expect(Result.isFailure(Numbering.checkNextCounter(1, 0))).toBe(true);
    // The counter column is a Postgres integer and allocation stores sequence + 1.
    expect(Result.isSuccess(Numbering.checkNextCounter(1, Numbering.MAX_COUNTER))).toBe(true);
    expect(Numbering.checkNextCounter(1, Numbering.MAX_COUNTER + 1)).toEqual(
      Result.fail(
        new Invalid({
          issues: [
            {
              path: ["nextNumber"],
              code: "numbering.pattern_invalid",
              params: { reason: "too_large", maximum: String(Numbering.MAX_COUNTER) },
            },
          ],
        }),
      ),
    );
    expect(Result.isFailure(Numbering.checkNextCounter(1, 1.5))).toBe(true);
  });

  test("checkManualNumber trims and bounds the number", () => {
    expect(Numbering.checkManualNumber("  2026-0099 ")).toEqual(Result.succeed("2026-0099"));
    expect(Numbering.checkManualNumber("  ")).toEqual(invalid("empty", "number"));
    expect(Numbering.checkManualNumber("X".repeat(21))).toEqual(invalid("too_long", "number"));
  });
});
