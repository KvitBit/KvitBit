import { describe, expect, test } from "bun:test";
import {
  CurrencyCode,
  IsoDate,
  type VatBreakdown,
  type VatTreatment,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Result from "effect/Result";

import {
  calculate,
  type LivePreview,
  type PreviewInput,
  PreviewSync,
  rateFor,
} from "../../src/view-models";

const d = (s: string) => BigDecimal.fromStringUnsafe(s);
const str = (n: BigDecimal.BigDecimal) => n.pipe(BigDecimal.normalize, BigDecimal.format);
const line = (
  quantity: string,
  unitPrice: string,
  treatment: VatTreatment = "standard",
  discount?: string,
) => ({
  quantity: d(quantity),
  unitPrice: d(unitPrice),
  treatment,
  ...(discount === undefined ? {} : { discountPercent: d(discount) }),
});

const base: PreviewInput = {
  lines: [],
  currency: CurrencyCode.make("CZK"),
  taxPoint: IsoDate.make("2026-11-23"),
  pricesIncludeVat: false,
  fx: null,
  paymentRounding: "none",
  direction: "outgoing",
  taxRegime: "vat_payer",
};

const run = (patch: Partial<PreviewInput>): LivePreview => {
  const result = calculate({ ...base, ...patch });
  if (Result.isFailure(result)) throw new Error("unexpected failure");
  return result.success;
};

const totals = (b: VatBreakdown) => ({
  net: str(b.net.amount),
  vat: str(b.vat.amount),
  gross: str(b.gross.amount),
  adj: str(b.roundingAdjustment.amount),
  vatCzk: b.vatCzk === null ? null : str(b.vatCzk.amount),
});

const buckets = (b: VatBreakdown) =>
  Arr.map(b.buckets, (x) => ({
    treatment: x.treatment,
    rate: str(x.ratePercent),
    base: str(x.base),
    vat: str(x.vat),
    gross: str(x.gross),
    vatCzk: x.vatCzk === null ? null : str(x.vatCzk),
  }));

describe("rateFor", () => {
  test("21 and 12 since 2024-01-01, 0 for non-rated treatments", () => {
    expect(Result.map(rateFor("standard", IsoDate.make("2024-01-01")), str)).toEqual(
      Result.succeed("21"),
    );
    expect(Result.map(rateFor("reduced", IsoDate.make("2026-06-30")), str)).toEqual(
      Result.succeed("12"),
    );
    expect(Result.map(rateFor("reverse_charge", IsoDate.make("2026-06-30")), str)).toEqual(
      Result.succeed("0"),
    );
  });
  test("a tax point before the table is a defect", () => {
    const r = rateFor("standard", IsoDate.make("2023-12-31"));
    expect(Result.isFailure(r)).toBe(true);
    calculate({ ...base, taxPoint: IsoDate.make("2023-12-31"), lines: [line("1", "1")] })
      .pipe(Result.isFailure, expect)
      .toBe(true);
  });
  test("coverage is checked before the treatment: non-rated treatments fail before the table too", () => {
    for (const treatment of ["outside_scope", "reverse_charge", "exempt_intra_eu_goods"] as const) {
      const failed = rateFor(treatment, IsoDate.make("2023-12-31")).pipe(Result.isFailure);
      expect(failed).toBe(true);
    }
    // a non_vat_payer's document (every line outside_scope) is no exception
    calculate({
      ...base,
      taxRegime: "non_vat_payer",
      taxPoint: IsoDate.make("2023-12-31"),
      lines: [line("1", "1", "outside_scope")],
    })
      .pipe(Result.isFailure, expect)
      .toBe(true);
  });
});

describe("calculate: bottom-up (prices excl. VAT)", () => {
  test("half amounts round away from zero at bucket level", () => {
    const p = run({ lines: [line("1", "0.125")] });
    expect(buckets(p.breakdown)).toEqual([
      { treatment: "standard", rate: "21", base: "0.13", vat: "0.03", gross: "0.16", vatCzk: null },
    ]);
    // line amounts keep full precision
    (p.lines[0]?.net ?? d("0")).pipe(str, expect).toBe("0.125");
    (p.lines[0]?.vat ?? d("0")).pipe(str, expect).toBe("0.02625");
  });

  test("bucket rounding, not line rounding: two 0.004 lines make 0.01", () => {
    const p = run({ lines: [line("1", "0.004"), line("1", "0.004")] });
    expect(totals(p.breakdown).net).toBe("0.01");
    expect(p.breakdown.buckets).toHaveLength(1);
  });

  test("VAT is rounded half up from the rounded base (100.50 × 21 % = 21.105 -> 21.11)", () => {
    const p = run({ lines: [line("1", "100.50")] });
    expect(totals(p.breakdown)).toEqual({
      net: "100.5",
      vat: "21.11",
      gross: "121.61",
      adj: "0",
      vatCzk: null,
    });
  });

  test("buckets follow core's treatment order, not entry order", () => {
    const p = run({
      lines: [
        line("1", "5", "outside_scope"),
        line("1", "10", "reverse_charge"),
        line("1", "50", "reduced"),
        line("1", "7", "exempt_intra_eu_goods"),
        line("1", "100"),
      ],
    });
    expect(Arr.map(buckets(p.breakdown), (b) => b.treatment)).toEqual([
      "standard",
      "reduced",
      "exempt_intra_eu_goods",
      "reverse_charge",
      "outside_scope",
    ]);
    // outside_scope entered before standard (the reviewer's case)
    const two = run({ lines: [line("1", "5", "outside_scope"), line("1", "100")] });
    expect(Arr.map(buckets(two.breakdown), (b) => b.treatment)).toEqual([
      "standard",
      "outside_scope",
    ]);
  });

  test("multiple rates make one bucket each", () => {
    const p = run({
      lines: [line("2", "50"), line("1", "50", "reduced"), line("1", "10", "reverse_charge")],
    });
    expect(buckets(p.breakdown)).toEqual([
      { treatment: "standard", rate: "21", base: "100", vat: "21", gross: "121", vatCzk: null },
      { treatment: "reduced", rate: "12", base: "50", vat: "6", gross: "56", vatCzk: null },
      { treatment: "reverse_charge", rate: "0", base: "10", vat: "0", gross: "10", vatCzk: null },
    ]);
    expect(totals(p.breakdown)).toEqual({
      net: "160",
      vat: "27",
      gross: "187",
      adj: "0",
      vatCzk: null,
    });
  });

  test("discount percent applies to the line amount", () => {
    const p = run({ lines: [line("2", "100", "standard", "10")] });
    expect(totals(p.breakdown)).toEqual({
      net: "180",
      vat: "37.8",
      gross: "217.8",
      adj: "0",
      vatCzk: null,
    });
    const third = run({ lines: [line("1", "10", "standard", "33.333")] });
    expect(totals(third.breakdown).net).toBe("6.67");
  });
});

describe("calculate: top-down (prices incl. VAT)", () => {
  test("gross 121 at 21 % is base 100 + VAT 21", () => {
    const p = run({ pricesIncludeVat: true, lines: [line("1", "121")] });
    expect(totals(p.breakdown)).toEqual({
      net: "100",
      vat: "21",
      gross: "121",
      adj: "0",
      vatCzk: null,
    });
  });
  test("gross 100 at 21 %: VAT round(17.355…) = 17.36, base = 82.64", () => {
    const p = run({ pricesIncludeVat: true, lines: [line("1", "100")] });
    expect(totals(p.breakdown)).toEqual({
      net: "82.64",
      vat: "17.36",
      gross: "100",
      adj: "0",
      vatCzk: null,
    });
  });
  test("12 % bucket and a half gross", () => {
    const p = run({
      pricesIncludeVat: true,
      lines: [line("1", "0.005", "reduced"), line("1", "56", "reduced")],
    });
    // gross round(56.005) = 56.01, VAT round(56.01 × 12 / 112 = 6.00107…) = 6.00
    expect(buckets(p.breakdown)).toEqual([
      { treatment: "reduced", rate: "12", base: "50.01", vat: "6", gross: "56.01", vatCzk: null },
    ]);
  });
});

describe("calculate: FX, credit notes, regimes, payment rounding", () => {
  test("CZK VAT per bucket = round2(VAT × rate / quantity)", () => {
    const p = run({
      currency: CurrencyCode.make("EUR"),
      fx: { rate: d("25.125"), quantity: 1 },
      lines: [line("1", "100"), line("1", "100", "reduced")],
    });
    expect(Arr.map(buckets(p.breakdown), (b) => b.vatCzk)).toEqual(["527.63", "301.5"]);
    expect(totals(p.breakdown).vatCzk).toBe("829.13");
    expect(p.breakdown.net.currency).toBe(CurrencyCode.make("EUR"));
    expect(p.breakdown.vatCzk?.currency).toBe(CurrencyCode.make("CZK"));
  });
  test("fx quantity divides (100 HUF = 6.5 CZK)", () => {
    const p = run({
      currency: CurrencyCode.make("HUF"),
      fx: { rate: d("6.5"), quantity: 100 },
      lines: [line("1", "10000")],
    });
    expect(totals(p.breakdown).vatCzk).toBe("136.5");
  });
  test("CZK documents and unknown rates carry no CZK VAT", () => {
    expect(
      run({ fx: { rate: d("2"), quantity: 1 }, lines: [line("1", "1")] }).breakdown.vatCzk,
    ).toBeNull();
    expect(
      run({ currency: CurrencyCode.make("EUR"), lines: [line("1", "1")] }).breakdown.vatCzk,
    ).toBeNull();
  });

  test("credit notes negate every amount symmetrically", () => {
    const lines = [line("1", "0.125"), line("3", "33.335", "reduced")];
    const invoice = run({ lines });
    const credit = run({ lines, kind: "credit_note" });
    expect(totals(credit.breakdown)).toEqual({
      net: "-100.14",
      vat: "-12.03",
      gross: "-112.17",
      adj: "0",
      vatCzk: null,
    });
    expect(totals(invoice.breakdown)).toEqual({
      net: "100.14",
      vat: "12.03",
      gross: "112.17",
      adj: "0",
      vatCzk: null,
    });
  });

  test("non_vat_payer: every line is outside_scope at 0 %", () => {
    const p = run({
      taxRegime: "non_vat_payer",
      lines: [line("1", "100"), line("1", "50", "reduced")],
    });
    expect(buckets(p.breakdown)).toEqual([
      { treatment: "outside_scope", rate: "0", base: "150", vat: "0", gross: "150", vatCzk: null },
    ]);
    // prices-incl-VAT changes nothing without VAT
    expect(
      totals(
        run({ taxRegime: "non_vat_payer", pricesIncludeVat: true, lines: [line("1", "100")] })
          .breakdown,
      ).gross,
    ).toBe("100");
  });

  test("expenses keep the supplier's VAT whatever the receiver's regime", () => {
    // A non-VAT payer receives a standard-rated receipt of net 100: the supplier charged 21 VAT.
    for (const taxRegime of ["non_vat_payer", "identified_person", "vat_payer"] as const) {
      const p = run({ direction: "incoming", taxRegime, lines: [line("1", "100")] });
      expect(buckets(p.breakdown)).toEqual([
        { treatment: "standard", rate: "21", base: "100", vat: "21", gross: "121", vatCzk: null },
      ]);
      expect(totals(p.breakdown).gross).toBe("121");
    }
    // the same lines issued by the non-VAT payer charge no VAT
    expect(
      totals(run({ taxRegime: "non_vat_payer", lines: [line("1", "100")] }).breakdown).gross,
    ).toBe("100");
  });

  test("identified_person: rated lines are outside_scope, reverse charge stays", () => {
    const p = run({
      taxRegime: "identified_person",
      lines: [line("1", "100"), line("1", "40", "reverse_charge")],
    });
    expect(Arr.map(buckets(p.breakdown), (b) => [b.treatment, b.rate, b.vat])).toEqual([
      ["reverse_charge", "0", "0"],
      ["outside_scope", "0", "0"],
    ]);
  });

  test("whole_unit rounding touches only the amount to pay", () => {
    const down = run({ paymentRounding: "whole_unit", lines: [line("1", "100.40")] }); // 121.48
    expect(totals(down.breakdown)).toEqual({
      net: "100.4",
      vat: "21.08",
      gross: "121",
      adj: "-0.48",
      vatCzk: null,
    });
    const half = run({
      paymentRounding: "whole_unit",
      pricesIncludeVat: true,
      lines: [line("1", "120.5")],
    });
    expect(totals(half.breakdown).gross).toBe("121");
    expect(totals(half.breakdown).adj).toBe("0.5");
    (half.breakdown.buckets[0]?.gross ?? d("0")).pipe(str, expect).toBe("120.5");
  });

  test("round2 for every currency (core-ports 5.1), not the ISO minor unit", () => {
    const jpy = run({
      currency: CurrencyCode.make("JPY"),
      fx: { rate: d("16.5"), quantity: 100 },
      lines: [line("1", "100.125")],
    });
    expect(totals(jpy.breakdown)).toEqual({
      net: "100.13",
      vat: "21.03",
      gross: "121.16",
      adj: "0",
      vatCzk: "3.47",
    });
    const kwd = run({ currency: CurrencyCode.make("KWD"), lines: [line("1", "1.2345")] });
    expect(totals(kwd.breakdown).net).toBe("1.23");
  });

  test("an empty document is zero", () => {
    expect(totals(run({ lines: [] }).breakdown)).toEqual({
      net: "0",
      vat: "0",
      gross: "0",
      adj: "0",
      vatCzk: null,
    });
  });
});

describe("PreviewSync", () => {
  const a = run({ lines: [line("1", "100")] }).breakdown;
  const b = run({ lines: [line("1", "200")] }).breakdown;

  test("server result for the current edit replaces the local one", () => {
    let s = PreviewSync.edit(PreviewSync.init(a), b);
    expect(s.seq).toBe(1);
    expect(PreviewSync.isProvisional(s)).toBe(true);
    s = PreviewSync.receive(s, 1, b);
    expect(PreviewSync.displayed(s)).toBe(b);
    expect(s.calcDrift).toBe(false);
    expect(PreviewSync.isProvisional(s)).toBe(false);
  });

  test("a stale answer is ignored and a newer edit shows local totals again", () => {
    let s = PreviewSync.edit(PreviewSync.init(a), a); // seq 1
    s = PreviewSync.edit(s, b); // seq 2
    s = PreviewSync.receive(s, 1, a);
    expect(s.server._tag).toBe("None");
    s = PreviewSync.receive(s, 2, b);
    s = PreviewSync.edit(s, a); // seq 3
    expect(PreviewSync.displayed(s)).toBe(a);
  });

  test("differing totals for the same edit flag calcDrift and show the server value", () => {
    let s = PreviewSync.edit(PreviewSync.init(a), a);
    s = PreviewSync.receive(s, 1, b);
    expect(s.calcDrift).toBe(true);
    expect(PreviewSync.displayed(s)).toBe(b);
  });
});
