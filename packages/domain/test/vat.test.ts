import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { VatRatePercent, VatTreatment } from "../src/index";

describe("Czech VAT vocabulary", () => {
  test("rates are 0, 12 and 21", () => {
    expect(VatRatePercent.literals).toEqual([0, 12, 21]);
    expect(Schema.is(VatRatePercent)(15)).toBe(false);
  });
  test("five supply-class treatments", () => {
    expect(VatTreatment.literals).toEqual([
      "standard",
      "reduced",
      "exempt_intra_eu_goods",
      "reverse_charge",
      "outside_scope",
    ]);
  });
});
