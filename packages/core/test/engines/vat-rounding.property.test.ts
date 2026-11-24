/**
 * VatMath rounding against an independent BigInt oracle (skill `verify-vat-numbering-math`).
 *
 * - "verification": exhaustive enumeration of a finite residue space. The bound is in the
 *   test name and the skill.
 * - "property": seeded generated inputs. Sampled, so it is not a proof. A failure prints the seed.
 *
 * The oracle uses only bigint arithmetic and never calls the engine's rounding, so it cannot
 * repeat an engine bug.
 */
import { describe, expect, test } from "bun:test";
import type { CurrencyCode, IsoDate } from "@kvitbit/domain/contract";
import { VatTreatment } from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { roundAt } from "../../src/engines/decimal";
import { toCzk } from "../../src/engines/fx";
import { type VatInput, VatMath } from "../../src/engines/vat";
import { rng } from "./random";

const CZK = "CZK" as CurrencyCode;
const EUR = "EUR" as CurrencyCode;
const TAX_POINT = "2026-11-23" as IsoDate;

// Oracle ------------------------------------------------------------------------------------

/** n / d rounded half away from zero to an integer (d > 0). */
const roundHalf = (n: bigint, d: bigint): bigint => {
  const a = n < 0n ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return n < 0n ? -q : q;
};
const pow10 = (k: number) => 10n ** BigInt(k);
/** Integer units of `x` at `scale` (x must be exact at that scale). */
const units = (x: BigDecimal.BigDecimal, scale: number): bigint => {
  const n = BigDecimal.normalize(x);
  if (n.scale > scale) throw new Error(`oracle: ${BigDecimal.format(n)} exceeds scale ${scale}`);
  return n.value * pow10(scale - n.scale);
};
const minor = (u: bigint) => BigDecimal.make(u, 2);
/**
 * Treatments and their order come from the domain contract (`VatTreatment` literals), not from
 * the engine's `TREATMENTS`, so a treatment the engine drops is still generated.
 */
const ORACLE_TREATMENTS: ReadonlyArray<VatTreatment> = VatTreatment.literals;
/** Rate the oracle expects on the 2026 tax point (the table's single entry, 2024-01-01). */
const ORACLE_RATE: Record<VatTreatment, bigint> = {
  standard: 21n,
  reduced: 12n,
  exempt_intra_eu_goods: 0n,
  reverse_charge: 0n,
  outside_scope: 0n,
};

/** Fails with the seed in the message, so a red run can be replayed. */
const forSeeds = (count: number, base: number, body: (seed: number) => void) => {
  for (let i = 0; i < count; i++) {
    const seed = base + i * 7919;
    try {
      body(seed);
    } catch (e) {
      throw new Error(`seed=${seed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
};

const same = (label: string, actual: BigDecimal.BigDecimal | null, expectedMinor: bigint) => {
  if (actual === null || !BigDecimal.equals(actual, minor(expectedMinor))) {
    throw new Error(
      `${label}: engine ${actual === null ? "null" : BigDecimal.format(actual)}, oracle ${BigDecimal.format(minor(expectedMinor))}`,
    );
  }
};

// 1. Exhaustive residue verification --------------------------------------------------------

describe("VatMath rounding step (verification: exhaustive residue space)", () => {
  test("roundAt(x, 2) = half away from zero for every sub-minor residue at scales 3-7, both signs", () => {
    // x = sign x (I + c/100 + r/10^s): every residue r of the dropped digits, cents that do and
    // do not carry (0, 50, 99), a small and a 15-digit integer part. 999,990 inputs per sign.
    let checked = 0;
    for (let s = 3; s <= 7; s++) {
      const sub = pow10(s - 2);
      for (const sign of [1n, -1n]) {
        for (const int of [0n, 7n, 123_456_789_012_345n]) {
          for (const cents of [0n, 50n, 99n]) {
            for (let r = 0n; r < sub; r++) {
              const scaled = sign * ((int * 100n + cents) * sub + r);
              const got = roundAt(BigDecimal.make(scaled, s), 2);
              const want = roundHalf(scaled, sub);
              if (!BigDecimal.equals(got, minor(want))) {
                throw new Error(
                  `roundAt(${scaled}e-${s}) = ${BigDecimal.format(got)}, want ${want}e-2`,
                );
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * 3 * 3 * (10 + 100 + 1000 + 10_000 + 100_000));
  }, 60_000);

  test("bottom-up bucket VAT = round(base x rate / 100) for every base residue mod 100, both rates and signs", () => {
    // base x rate / 100 in minor units depends on base mod 100: 2 periods each side of zero
    // plus a far offset cover every residue class with and without sign.
    for (const treatment of ["standard", "reduced"] as const) {
      const rate = ORACLE_RATE[treatment];
      for (const offset of [0n, 98_765_432_100n]) {
        for (let b = -200n; b <= 200n; b++) {
          const base = b + (b < 0n ? -offset : offset);
          const out = VatMath.calculate({
            lines: [{ quantity: BigDecimal.fromBigInt(1n), unitPrice: minor(base), treatment }],
            currency: CZK,
            taxPoint: TAX_POINT,
            pricesIncludeVat: false,
            fx: null,
            paymentRounding: "none",
          });
          const bucket = out.buckets[0];
          if (bucket === undefined) throw new Error("no bucket");
          same(`${treatment} base ${base}`, bucket.vat, roundHalf(base * rate, 100n));
          same(`${treatment} gross ${base}`, bucket.gross, base + roundHalf(base * rate, 100n));
        }
      }
    }
  });

  test("top-down bucket VAT = round(gross x rate / (100 + rate)) for every gross residue mod 100 + rate, both signs", () => {
    for (const treatment of ["standard", "reduced"] as const) {
      const rate = ORACLE_RATE[treatment];
      const period = 100n + rate;
      for (const offset of [0n, 12_345_678_900n]) {
        for (let g = -2n * period; g <= 2n * period; g++) {
          const gross = g + (g < 0n ? -offset : offset);
          const out = VatMath.calculate({
            lines: [{ quantity: BigDecimal.fromBigInt(1n), unitPrice: minor(gross), treatment }],
            currency: CZK,
            taxPoint: TAX_POINT,
            pricesIncludeVat: true,
            fx: null,
            paymentRounding: "none",
          });
          const bucket = out.buckets[0];
          if (bucket === undefined) throw new Error("no bucket");
          const vat = roundHalf(gross * rate, period);
          same(`${treatment} vat of gross ${gross}`, bucket.vat, vat);
          same(`${treatment} base of gross ${gross}`, bucket.base, gross - vat);
        }
      }
    }
  });

  test("toCzk = round2(amount x rate / quantity) for every residue of a 3-decimal CNB rate, quantity 1 and 100, both signs", () => {
    // amount 0.01: amount x rate has 5 decimals (q = 1: 1,000 residues) or 7 after / 100
    // (q = 100: 100,000 residues). Rates k/1000 for k up to the period, and one large amount.
    for (const quantity of [1n, 100n]) {
      const period = 1000n * quantity;
      for (const amountMinor of [1n, -1n, 987_654_321n, -987_654_321n]) {
        const ks = amountMinor === 1n || amountMinor === -1n ? period : 2000n;
        for (let k = 1n; k <= ks; k++) {
          const got = toCzk(minor(amountMinor), {
            rate: BigDecimal.make(k, 3),
            quantity: Number(quantity),
          });
          same(
            `toCzk(${amountMinor}e-2, ${k}e-3 / ${quantity})`,
            got,
            roundHalf(amountMinor * k, period),
          );
        }
      }
    }
  });
});

// 2. Generated inputs: buckets, rounding and CZK per bucket ---------------------------------

interface OracleBucket {
  readonly treatment: VatTreatment;
  readonly rate: bigint;
  readonly base: bigint;
  readonly vat: bigint;
  readonly gross: bigint;
  readonly vatCzk: bigint | null;
}

/** Line amounts carry at most 3 + 4 decimals (generator bounds). */
const LINE_SCALE = 7;

const oracle = (input: VatInput) => {
  // Group by (treatment, rate): the key is both, independent of the engine's Map by treatment.
  const sums = new Map<string, { treatment: VatTreatment; rate: bigint; sum: bigint }>();
  for (const l of input.lines) {
    const rate = ORACLE_RATE[l.treatment];
    const key = `${l.treatment}|${rate}`;
    const amount = units(l.quantity, 3) * units(l.unitPrice, 4);
    const prev = sums.get(key);
    sums.set(key, { treatment: l.treatment, rate, sum: (prev?.sum ?? 0n) + amount });
  }
  const order = (t: VatTreatment) => ORACLE_TREATMENTS.indexOf(t);
  const groups = [...sums.values()].sort(
    (a, b) => order(a.treatment) - order(b.treatment) || Number(a.rate - b.rate),
  );
  const toMinor = pow10(LINE_SCALE - 2);
  const foreign = input.currency !== "CZK" && input.fx !== null;
  const fxRate = input.fx === null ? 0n : units(input.fx.rate, 3);
  const fxQ = input.fx === null ? 1n : BigInt(input.fx.quantity);
  const buckets: Array<OracleBucket> = groups.map(({ treatment, rate, sum }) => {
    let base: bigint;
    let vat: bigint;
    let gross: bigint;
    if (input.pricesIncludeVat) {
      gross = roundHalf(sum, toMinor);
      vat = rate === 0n ? 0n : roundHalf(gross * rate, 100n + rate);
      base = gross - vat;
    } else {
      base = roundHalf(sum, toMinor);
      vat = roundHalf(base * rate, 100n);
      gross = base + vat;
    }
    return {
      treatment,
      rate,
      base,
      vat,
      gross,
      vatCzk: foreign ? roundHalf(vat * fxRate, 1000n * fxQ) : null,
    };
  });
  const net = buckets.reduce((a, b) => a + b.base, 0n);
  const vat = buckets.reduce((a, b) => a + b.vat, 0n);
  const total = net + vat;
  const toPay = input.paymentRounding === "whole_unit" ? roundHalf(total, 100n) * 100n : total;
  return {
    buckets,
    net,
    vat,
    gross: toPay,
    adjustment: toPay - total,
    vatCzk: foreign ? buckets.reduce((a, b) => a + (b.vatCzk ?? 0n), 0n) : null,
  };
};

const generate = (seed: number): VatInput => {
  const r = rng(seed);
  // Few distinct prices so buckets collect several lines; signed quantities (discounts).
  const lines = Array.from({ length: r.int(0, 10) }, () => ({
    quantity: BigDecimal.fromStringUnsafe(r.decimal(40, r.int(0, 3))),
    unitPrice: BigDecimal.fromStringUnsafe(r.decimal(20_000, r.int(0, 4), r.next() < 0.2)),
    treatment: r.pick(ORACLE_TREATMENTS),
  }));
  const foreign = r.next() < 0.6;
  return {
    lines,
    currency: foreign ? EUR : CZK,
    taxPoint: TAX_POINT,
    pricesIncludeVat: r.next() < 0.5,
    fx: foreign
      ? { rate: BigDecimal.fromStringUnsafe(r.decimal(60, 3, false)), quantity: r.pick([1, 100]) }
      : null,
    paymentRounding: r.next() < 0.3 ? "whole_unit" : "none",
  };
};

describe("VatMath buckets (property: seeded, 400 inputs)", () => {
  test("bucket keys, order, per-bucket rounding, CZK per bucket and totals equal the oracle", () => {
    forSeeds(400, 0xa7a7, (seed) => {
      const input = generate(seed);
      const got = VatMath.calculate(input);
      const want = oracle(input);
      const keys = (bs: ReadonlyArray<{ treatment: string; rate: string }>) =>
        bs.map((b) => `${b.treatment}|${b.rate}`).join(",");
      const gotKeys = keys(
        got.buckets.map((b) => ({
          treatment: b.treatment,
          rate: BigDecimal.format(BigDecimal.normalize(b.ratePercent)),
        })),
      );
      const wantKeys = keys(
        want.buckets.map((b) => ({ treatment: b.treatment, rate: String(b.rate) })),
      );
      if (gotKeys !== wantKeys) throw new Error(`buckets ${gotKeys}, oracle ${wantKeys}`);
      for (const [i, w] of want.buckets.entries()) {
        const g = got.buckets[i];
        if (g === undefined) throw new Error("missing bucket");
        same(`${w.treatment} base`, g.base, w.base);
        same(`${w.treatment} vat`, g.vat, w.vat);
        same(`${w.treatment} gross`, g.gross, w.gross);
        if (w.vatCzk === null) {
          if (g.vatCzk !== null) throw new Error(`${w.treatment} vatCzk should be null`);
        } else {
          same(`${w.treatment} vatCzk`, g.vatCzk, w.vatCzk);
        }
      }
      same("net", got.net.amount, want.net);
      same("vat", got.vat.amount, want.vat);
      same("gross", got.gross.amount, want.gross);
      same("roundingAdjustment", got.roundingAdjustment.amount, want.adjustment);
      if (want.vatCzk === null) {
        if (got.vatCzk !== null) throw new Error("document vatCzk should be null");
      } else {
        same("document vatCzk", got.vatCzk?.amount ?? null, want.vatCzk);
      }
    });
  });

  test("documented residue: engine CZK VAT per bucket within 0.005 CZK of exact; the document within 0.005 x buckets", () => {
    forSeeds(400, 0xc2c2, (seed) => {
      const input = generate(seed);
      if (input.fx === null || input.currency === "CZK") return;
      const got = VatMath.calculate(input);
      const rate = units(input.fx.rate, 3);
      const d = 1000n * BigInt(input.fx.quantity);
      // Exact CZK VAT of a bucket in minor units is vat x rate / d; |round - exact| <= 1/2
      // minor unit means |2 (vatCzk x d - vat x rate)| <= d.
      let docErr = 0n;
      for (const b of got.buckets) {
        if (b.vatCzk === null) throw new Error(`${b.treatment} vatCzk missing`);
        const err = units(b.vatCzk, 2) * d - units(b.vat, 2) * rate;
        if (2n * (err < 0n ? -err : err) > d) throw new Error(`${b.treatment} residue above 0.005`);
        docErr += err;
      }
      const docCzk = got.vatCzk === null ? 0n : units(got.vatCzk.amount, 2);
      const docExactErr = docCzk * d - units(got.vat.amount, 2) * rate;
      if (docExactErr !== docErr) throw new Error("document vatCzk is not the sum of the buckets");
      if (2n * (docErr < 0n ? -docErr : docErr) > d * BigInt(got.buckets.length)) {
        throw new Error("document CZK residue above 0.005 x buckets");
      }
    });
  });
});
