import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { IsoDate, ratePercentFor, VatRatePercent, VatTreatment } from "../src/index";

const d = Schema.decodeUnknownSync(IsoDate);

describe("Czech VAT rates", () => {
  test("rates are 0, 12 and 21", () => {
    expect(VatRatePercent.literals).toEqual([0, 12, 21]);
  });
  test("standard 21, reduced 12, others 0 from 2024-01-01", () => {
    const on = d("2024-01-01");
    expect(ratePercentFor("standard", on)).toEqual(Option.some(21));
    expect(ratePercentFor("reduced", on)).toEqual(Option.some(12));
    for (const t of ["exempt_intra_eu_goods", "reverse_charge", "outside_scope"] as const) {
      expect(ratePercentFor(t, d("2026-11-23"))).toEqual(Option.some(0));
    }
    expect(VatTreatment.literals).toHaveLength(5);
  });
  test("a tax point before the table is None", () => {
    expect(Option.isNone(ratePercentFor("standard", d("2023-12-31")))).toBe(true);
  });
});
