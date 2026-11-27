import { describe, expect, test } from "bun:test";
import type { VatTreatment } from "@kvitbit/domain/contract";
import { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import type { VatBreakdown, VatInput, VatInputLine } from "../../src/engines";
import { TREATMENTS, VatMath } from "../../src/engines";
import { rng, SEEDS } from "./random";

const d = BigDecimal.fromStringUnsafe;
const s = (v: BigDecimal.BigDecimal | null) => (v === null ? null : BigDecimal.format(v));
const CZK = CurrencyCode.make("CZK");
const EUR = CurrencyCode.make("EUR");
const TAX_POINT = IsoDate.make("2026-11-23");

const line = (quantity: string, unitPrice: string, treatment: VatTreatment = "standard") => ({
  quantity: d(quantity),
  unitPrice: d(unitPrice),
  treatment,
});

const calc = (lines: ReadonlyArray<VatInputLine>, over: Partial<VatInput> = {}) =>
  VatMath.calculate({
    lines,
    currency: CZK,
    taxPoint: TAX_POINT,
    pricesIncludeVat: false,
    fx: null,
    paymentRounding: "none",
    ...over,
  });

/** A breakdown as plain strings, for readable equality. */
const view = (b: VatBreakdown) => ({
  buckets: EffectArray.map(b.buckets, (k) => ({
    treatment: k.treatment,
    rate: s(k.ratePercent),
    base: s(k.base),
    vat: s(k.vat),
    gross: s(k.gross),
    vatCzk: s(k.vatCzk),
  })),
  net: `${s(b.net.amount)} ${b.net.currency}`,
  vat: `${s(b.vat.amount)} ${b.vat.currency}`,
  roundingAdjustment: s(b.roundingAdjustment.amount),
  gross: `${s(b.gross.amount)} ${b.gross.currency}`,
  vatCzk: b.vatCzk === null ? null : `${s(b.vatCzk.amount)} ${b.vatCzk.currency}`,
});

describe("VatMath.rateFor", () => {
  test("21 and 12 from 2024-01-01; non-rated treatments are 0", () => {
    const standard = VatMath.rateFor("standard", IsoDate.make("2024-01-01")).pipe(s);
    const reduced = VatMath.rateFor("reduced", TAX_POINT).pipe(s);
    expect(standard).toBe("21");
    expect(reduced).toBe("12");
    for (const t of ["exempt_intra_eu_goods", "reverse_charge", "outside_scope"] as const) {
      VatMath.rateFor(t, TAX_POINT).pipe(s, expect).toBe("0");
    }
  });
  test("a tax point before the rate table is a defect", () => {
    expect(() => VatMath.rateFor("standard", IsoDate.make("2023-12-31"))).toThrow();
  });
});

describe("VatMath.calculate", () => {
  test("bottom-up: buckets round the summed line nets, then VAT on the rounded base", () => {
    const b = calc([line("3", "33.333"), line("1", "10.005", "reduced")]);
    expect(view(b)).toEqual({
      buckets: [
        { treatment: "standard", rate: "21", base: "100", vat: "21", gross: "121", vatCzk: null },
        {
          treatment: "reduced",
          rate: "12",
          base: "10.01",
          vat: "1.2",
          gross: "11.21",
          vatCzk: null,
        },
      ],
      net: "110.01 CZK",
      vat: "22.2 CZK",
      roundingAdjustment: "0",
      gross: "132.21 CZK",
      vatCzk: null,
    });
  });

  test("VAT is rounded per rate bucket, not per line", () => {
    // Per line: 7 x round(0.0147) = 0.07. Per bucket: round(0.49 x 0.21) = 0.10.
    const b = calc(Array.from({ length: 7 }, () => line("1", "0.07")));
    const vat = b.vat.amount.pipe(s);
    expect(vat).toBe("0.1");
  });

  test("rounding is half away from zero, not half-even", () => {
    const positive = calc([line("1", "0.5")]).vat.amount.pipe(s);
    const negative = calc([line("-1", "0.5")]).vat.amount.pipe(s);
    const outsideScope = calc([line("1", "0.125", "outside_scope")]).net.amount.pipe(s);
    expect(positive).toBe("0.11"); // 0.105
    expect(negative).toBe("-0.11");
    expect(outsideScope).toBe("0.13");
  });

  test("top-down (prices include VAT): VAT = gross x rate / (100 + rate)", () => {
    const b = calc([line("1", "100"), line("1", "121"), line("1", "100", "reduced")], {
      pricesIncludeVat: true,
    });
    expect(view(b).buckets).toEqual([
      // 221 x 21 / 121 = 38.355
      {
        treatment: "standard",
        rate: "21",
        base: "182.64",
        vat: "38.36",
        gross: "221",
        vatCzk: null,
      },
      // 100 x 12 / 112 = 10.714
      { treatment: "reduced", rate: "12", base: "89.29", vat: "10.71", gross: "100", vatCzk: null },
    ]);
    b.gross.amount.pipe(s, expect).toBe("321");
  });

  test("non-rated treatments get their own zero-VAT buckets in treatment order", () => {
    const b = calc([
      line("1", "50", "outside_scope"),
      line("2", "100", "reverse_charge"),
      line("1", "10", "exempt_intra_eu_goods"),
    ]);
    expect(EffectArray.map(b.buckets, (k) => [k.treatment, s(k.ratePercent), s(k.vat)])).toEqual([
      ["exempt_intra_eu_goods", "0", "0"],
      ["reverse_charge", "0", "0"],
      ["outside_scope", "0", "0"],
    ]);
    b.gross.amount.pipe(s, expect).toBe("260");
  });

  test("whole-unit payment rounding is reported outside the tax base", () => {
    const b = calc([line("1", "10.40")], { paymentRounding: "whole_unit" }); // 12.58 -> 13
    expect(view(b)).toMatchObject({
      net: "10.4 CZK",
      vat: "2.18 CZK",
      roundingAdjustment: "0.42",
      gross: "13 CZK",
    });
    const down = calc([line("1", "10.30")], { paymentRounding: "whole_unit" }); // 12.46 -> 12
    expect(view(down)).toMatchObject({ roundingAdjustment: "-0.46", gross: "12 CZK" });
    expect(s(b.buckets[0]?.base ?? null)).toBe("10.4");
    calc([line("1", "10.50", "outside_scope")], { paymentRounding: "whole_unit" })
      .gross.amount.pipe(s, expect)
      .toBe("11");
  });

  test("foreign currency: CZK VAT per bucket = round2(VAT x rate / quantity), summed", () => {
    const b = calc([line("1", "1000"), line("1", "100", "reduced")], {
      currency: EUR,
      fx: { rate: d("25.125"), quantity: 1 },
    });
    expect(EffectArray.map(b.buckets, (k) => s(k.vatCzk))).toEqual(["5276.25", "301.5"]);
    expect(view(b).vatCzk).toBe("5577.75 CZK");
    const huf = calc([line("1", "10000")], {
      currency: CurrencyCode.make("HUF"),
      fx: { rate: d("6.512"), quantity: 100 },
    });
    expect(s(huf.buckets[0]?.vatCzk ?? null)).toBe("136.75"); // 2100 x 6.512 / 100 = 136.752
  });

  test("a foreign document without a rate yet (live preview) has unknown CZK VAT", () => {
    const b = calc([line("1", "1000")], { currency: EUR, fx: null });
    expect(EffectArray.map(b.buckets, (k) => k.vatCzk)).toEqual([null]);
    expect(b.vatCzk).toBeNull();
  });

  test("CZK documents have no CZK VAT even when given a rate", () => {
    expect(calc([line("1", "10")], { fx: { rate: d("1"), quantity: 1 } }).vatCzk).toBeNull();
  });

  test("rounds to 2 decimals whatever the currency (JPY too, rule 3)", () => {
    const b = calc([line("1", "1001")], { currency: CurrencyCode.make("JPY") });
    const jpyVat = b.vat.amount.pipe(s);
    const bhdNet = calc([line("1", "0.125")], {
      currency: CurrencyCode.make("BHD"),
    }).net.amount.pipe(s);
    expect(jpyVat).toBe("210.21");
    expect(bhdNet).toBe("0.13");
  });

  test("no lines: empty buckets and zero totals", () => {
    const b = calc([], { paymentRounding: "whole_unit" });
    expect(view(b)).toMatchObject({
      buckets: [],
      net: "0 CZK",
      gross: "0 CZK",
      roundingAdjustment: "0",
    });
  });
});

describe("VatMath.negate", () => {
  test("negates every amount (credit note of a whole document)", () => {
    const b = calc([line("1", "1000"), line("1", "0.5", "reduced")], {
      currency: EUR,
      fx: { rate: d("25.1"), quantity: 1 },
      paymentRounding: "whole_unit",
    });
    const n = VatMath.negate(b);
    n.gross.amount.pipe(s, expect).toBe(`-${s(b.gross.amount)}`);
    n.roundingAdjustment.amount
      .pipe(s, expect)
      .toBe(`${b.roundingAdjustment.amount.pipe(BigDecimal.negate, s)}`);
    expect(EffectArray.map(n.buckets, (k) => s(k.vatCzk))).toEqual(
      EffectArray.map(b.buckets, (k) => (k.vatCzk ?? d("0")).pipe(BigDecimal.negate, s)),
    );
    expect(view(VatMath.negate(n))).toEqual(view(b));
  });
});

describe("VatMath.splitAdvance", () => {
  const proforma = calc([line("1", "1000"), line("1", "100", "reduced")]); // gross 1210 + 112

  test("splits by gross share and recomputes VAT top-down", () => {
    const split = VatMath.splitAdvance(proforma, d("661"));
    expect(EffectArray.map(split, (k) => [k.treatment, s(k.gross), s(k.vat), s(k.base)])).toEqual([
      ["standard", "605", "105", "500"],
      ["reduced", "56", "6", "50"],
    ]);
  });

  test("the largest bucket absorbs the rounding remainder", () => {
    const split = VatMath.splitAdvance(proforma, d("100"));
    expect(EffectArray.map(split, (k) => s(k.gross))).toEqual(["91.53", "8.47"]);
  });

  test("fromBuckets sums a split back into a breakdown with CZK VAT", () => {
    const eur = calc([line("1", "1000")], { currency: EUR, fx: { rate: d("25"), quantity: 1 } });
    const split = VatMath.splitAdvance(eur, d("121"), { fx: { rate: d("24"), quantity: 1 } });
    const b = VatMath.fromBuckets(split, EUR);
    expect(view(b)).toMatchObject({
      net: "100 EUR",
      vat: "21 EUR",
      gross: "121 EUR",
      vatCzk: "504 CZK",
    });
  });

  test("largest remainder: no share flips sign (4 equal buckets, 0.02 paid)", () => {
    const four = {
      ...proforma,
      buckets: EffectArray.map(TREATMENTS.slice(0, 4), (treatment) => ({
        treatment,
        ratePercent: d("0"),
        base: d("25"),
        vat: d("0"),
        gross: d("25"),
        vatCzk: null,
      })),
    };
    expect(EffectArray.map(VatMath.splitAdvance(four, d("0.02")), (k) => s(k.gross))).toEqual([
      "0.01",
      "0.01",
      "0",
      "0",
    ]);
  });

  test("taxPoint re-reads the rate in force on the receipt date", () => {
    const split = VatMath.splitAdvance(proforma, d("121"), {
      taxPoint: IsoDate.make("2026-12-01"),
    });
    expect(EffectArray.map(split, (k) => s(k.ratePercent))).toEqual(["21", "12"]);
    expect(() =>
      VatMath.splitAdvance(proforma, d("1"), { taxPoint: IsoDate.make("2023-01-01") }),
    ).toThrow();
  });

  test("shares keep the payment's minor units (BHD: 3 decimals); VAT stays round2", () => {
    const bhd = calc([line("1", "100", "outside_scope")], { currency: CurrencyCode.make("BHD") });
    expect(EffectArray.map(VatMath.splitAdvance(bhd, d("1.234")), (k) => s(k.gross))).toEqual([
      "1.234",
    ]);
    expect(EffectArray.map(VatMath.splitAdvance(bhd, d("0.001")), (k) => s(k.gross))).toEqual([
      "0.001",
    ]);
    const std = calc([line("1", "100")], { currency: CurrencyCode.make("BHD") });
    // 1.234 x 21 / 121 = 0.21416... -> 0.21
    expect(
      EffectArray.map(VatMath.splitAdvance(std, d("1.234")), (k) => [
        s(k.gross),
        s(k.vat),
        s(k.base),
      ]),
    ).toEqual([["1.234", "0.21", "1.024"]]);
  });

  test("a payment more precise than the minor unit is kept whole (JPY gross 1.21)", () => {
    const jpy = calc([line("1", "1")], { currency: CurrencyCode.make("JPY") });
    jpy.gross.amount.pipe(s, expect).toBe("1.21");
    expect(
      EffectArray.map(VatMath.splitAdvance(jpy, jpy.gross.amount), (k) => [
        s(k.gross),
        s(k.vat),
        s(k.base),
      ]),
    ).toEqual([["1.21", "0.21", "1"]]);
  });

  test("shares carry the payment's own precision (1.005 JPY over two equal buckets)", () => {
    const two = calc([line("1", "100", "reverse_charge"), line("1", "100", "outside_scope")], {
      currency: CurrencyCode.make("JPY"),
    });
    expect(EffectArray.map(VatMath.splitAdvance(two, d("1.005")), (k) => s(k.gross))).toEqual([
      "0.503",
      "0.502",
    ]);
  });

  test("a proforma without gross cannot be split", () => {
    expect(() => VatMath.splitAdvance(calc([]), d("1"))).toThrow();
  });
});

// Property tests -----------------------------------------------------------------------------

const exact = (lines: ReadonlyArray<VatInputLine>, t: VatTreatment) =>
  EffectArray.reduce(
    EffectArray.filter(lines, (l) => l.treatment === t),
    d("0"),
    (acc, l) => BigDecimal.sum(acc, BigDecimal.multiply(l.quantity, l.unitPrice)),
  );

const within = (a: BigDecimal.BigDecimal, b: BigDecimal.BigDecimal, bound: string) =>
  BigDecimal.isLessThanOrEqualTo(BigDecimal.abs(BigDecimal.subtract(a, b)), d(bound));

const randomInput = (seed: number): VatInput => {
  const r = rng(seed);
  const lines = Array.from({ length: r.int(0, 12) }, () => ({
    quantity: d(r.decimal(50, r.int(0, 3))),
    unitPrice: d(r.decimal(10_000, r.int(0, 4), false)),
    treatment: r.pick(TREATMENTS),
  }));
  const foreign = r.next() < 0.4;
  return {
    lines,
    currency: foreign ? EUR : CZK,
    taxPoint: TAX_POINT,
    pricesIncludeVat: r.next() < 0.5,
    fx: foreign ? { rate: d(r.decimal(40, 3, false)), quantity: r.pick([1, 100]) } : null,
    paymentRounding: r.next() < 0.5 ? "whole_unit" : "none",
  };
};

describe("VatMath properties (seeded)", () => {
  test("bucket sums equal the document totals", () => {
    for (const seed of SEEDS) {
      const b = VatMath.calculate(randomInput(seed));
      const sum = (f: (k: (typeof b.buckets)[number]) => BigDecimal.BigDecimal) =>
        EffectArray.reduce(b.buckets, d("0"), (acc, k) => BigDecimal.sum(acc, f(k)));
      expect([
        seed,
        BigDecimal.equals(
          sum((k) => k.base),
          b.net.amount,
        ),
      ]).toEqual([seed, true]);
      expect([
        seed,
        BigDecimal.equals(
          sum((k) => k.vat),
          b.vat.amount,
        ),
      ]).toEqual([seed, true]);
      for (const k of b.buckets) {
        expect([seed, BigDecimal.equals(BigDecimal.sum(k.base, k.vat), k.gross)]).toEqual([
          seed,
          true,
        ]);
      }
      const total = BigDecimal.sum(b.net.amount, b.vat.amount);
      expect([
        seed,
        BigDecimal.equals(BigDecimal.sum(total, b.roundingAdjustment.amount), b.gross.amount),
      ]).toEqual([seed, true]);
      const czkVatMatches =
        b.vatCzk === null ||
        BigDecimal.equals(
          sum((k) => k.vatCzk ?? d("0")),
          b.vatCzk.amount,
        );
      expect([seed, czkVatMatches]).toEqual([seed, true]);
    }
  });

  test("negating the lines negates the breakdown", () => {
    for (const seed of SEEDS) {
      const input = randomInput(seed);
      const negated = VatMath.calculate({
        ...input,
        lines: EffectArray.map(input.lines, (l) => ({
          ...l,
          quantity: BigDecimal.negate(l.quantity),
        })),
      });
      expect([seed, view(negated)]).toEqual([seed, view(VatMath.negate(VatMath.calculate(input)))]);
    }
  });

  test("every rounding stays within half a minor unit (whole-unit: half a unit)", () => {
    for (const seed of SEEDS) {
      const input = randomInput(seed);
      const b = VatMath.calculate(input);
      for (const k of b.buckets) {
        const sum = exact(input.lines, k.treatment);
        const rate = k.ratePercent;
        const basis = input.pricesIncludeVat ? k.gross : k.base;
        const divisor = input.pricesIncludeVat ? BigDecimal.sum(d("100"), rate) : d("100");
        const vat = BigDecimal.divideUnsafe(BigDecimal.multiply(basis, rate), divisor);
        expect([seed, within(basis, sum, "0.005")]).toEqual([seed, true]);
        expect([seed, within(k.vat, vat, "0.005")]).toEqual([seed, true]);
        const czkVatWithinBounds =
          input.fx === null ||
          k.vatCzk === null ||
          within(
            k.vatCzk,
            BigDecimal.divideUnsafe(
              BigDecimal.multiply(k.vat, input.fx.rate),
              BigDecimal.fromBigInt(BigInt(input.fx.quantity)),
            ),
            "0.005",
          );
        expect([seed, czkVatWithinBounds]).toEqual([seed, true]);
      }
      expect([seed, within(b.roundingAdjustment.amount, d("0"), "0.5")]).toEqual([seed, true]);
    }
  });

  test("advance splits always sum to the amount paid", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const b = VatMath.calculate(randomInput(seed));
      const total = EffectArray.reduce(b.buckets, d("0"), (acc, k) => BigDecimal.sum(acc, k.gross));
      if (BigDecimal.isZero(total)) continue;
      const paid = d(r.decimal(5000, 2, false));
      const split = VatMath.splitAdvance(b, paid);
      const sum = EffectArray.reduce(split, d("0"), (acc, k) => BigDecimal.sum(acc, k.gross));
      expect([seed, BigDecimal.equals(sum, paid)]).toEqual([seed, true]);
    }
  });
});
