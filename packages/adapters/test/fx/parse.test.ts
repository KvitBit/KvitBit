import { describe, expect, test } from "bun:test";
import type { CnbFixing } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MalformedFeed, parseDailyTxt } from "../../src/fx";
import { FRIDAY_FEED } from "./support";

const rate = (fixing: CnbFixing, code: string) =>
  Option.getOrUndefined(Arr.findFirst(fixing.rates, (r) => r.code === code));

const wrongColumns = "foo|bar";
const columns = Arr.join(["země", "měna", "množství", "kód", "kurz"], "|");

describe("parseDailyTxt", () => {
  test("reads the header date and sequence and every row", () => {
    const fixing = Effect.runSync(parseDailyTxt(FRIDAY_FEED));
    expect<unknown>(fixing.fixingDate).toBe("2026-11-20");
    expect(fixing.sequence).toBe(223);
    expect<unknown>(Arr.map(fixing.rates, (r) => r.code)).toEqual([
      "AUD",
      "EUR",
      "IDR",
      "JPY",
      "HUF",
      "USD",
    ]);
  });

  test("keeps množství and reads the decimal comma exactly", () => {
    const fixing = Effect.runSync(parseDailyTxt(FRIDAY_FEED));
    const jpy = rate(fixing, "JPY");
    expect(jpy?.quantity).toBe(100);
    expect(rate(fixing, "IDR")?.quantity).toBe(1000);
    expect(jpy === undefined ? undefined : BigDecimal.format(jpy.rate)).toBe("15.123");
    const eur = rate(fixing, "EUR");
    expect(eur?.quantity).toBe(1);
    expect(
      eur !== undefined && BigDecimal.equals(eur.rate, BigDecimal.fromStringUnsafe("24.335")),
    ).toBe(true);
  });

  test("accepts CRLF line endings and an integer rate", () => {
    const text = `20.11.2026 #223\r\n${columns}\r\nX|y|1|XAU|1000\r\n`;
    const fixing = Effect.runSync(parseDailyTxt(text));
    expect(
      fixing.rates[0] === undefined ? undefined : BigDecimal.format(fixing.rates[0].rate),
    ).toBe("1000");
  });

  test.each([
    ["empty body", ""],
    ["HTML error page", "<html><body>Chyba</body></html>"],
    ["header without sequence", `20.11.2026\n${columns}\nEMU|euro|1|EUR|24,335`],
    ["impossible date", `31.02.2026 #40\n${columns}\nEMU|euro|1|EUR|24,335`],
    ["wrong column header", `20.11.2026 #223\n${wrongColumns}\nEMU|euro|1|EUR|24,335`],
    ["no rows", `20.11.2026 #223\n${columns}\n`],
    ["missing cell", `20.11.2026 #223\n${columns}\nEMU|euro|1|EUR`],
    ["decimal point", `20.11.2026 #223\n${columns}\nEMU|euro|1|EUR|24.335`],
    ["lowercase code", `20.11.2026 #223\n${columns}\nEMU|euro|1|eur|24,335`],
    ["zero rate", `20.11.2026 #223\n${columns}\nEMU|euro|1|EUR|0,000`],
    [
      "duplicate currency",
      `20.11.2026 #223\n${columns}\nEMU|euro|1|EUR|24,335\nEMU|euro|1|EUR|24,336`,
    ],
    ["unsafe quantity", `20.11.2026 #223\n${columns}\nEMU|euro|99999999999999999|EUR|24,335`],
    ["unsafe sequence", `20.11.2026 #99999999999999999\n${columns}\nEMU|euro|1|EUR|24,335`],
    ["zero quantity", `20.11.2026 #223\n${columns}\nEMU|euro|0|EUR|24,335`],
  ])("rejects %s", (_, text) => {
    parseDailyTxt(text).pipe(Effect.flip, Effect.runSync, expect).toBeInstanceOf(MalformedFeed);
  });
});
