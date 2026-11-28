import { TestCaller } from "../helpers/callerContext";
/**
 * Proforma -> Payment Tax Documents -> Final Invoice -> Credit Notes, net to zero per VAT
 * bucket (skill `verify-vat-numbering-math`, Filip's decisions 2 and 3).
 *
 * Property tests: seeded generated chains run through the real Documents service and the
 * DocumentPayments seam on in-memory layers. Sampled, so not a proof. A failure prints the seed.
 *
 * Asserted per bucket (treatment, ratePercent):
 * - document currency, exact: Proforma = sum of PTDs + Final Invoice (base, VAT, gross);
 *   Final Invoice + its Credit Notes = 0; every PTD + its Credit Note = 0;
 * - CZK VAT: each PTD = round2(VAT x its receipt-date rate); the Final Invoice =
 *   round2((Proforma VAT - PTD VAT) x the Final Invoice rate) (D8, §37a: net in the document
 *   currency, then convert at the Final Invoice's own fixing), and equal to what the VAT report
 *   declares for it; Final Invoice + Credit Notes = 0 exactly;
 * - a Credit Note keeps the Final Invoice's FX (rate, quantity, fixing date) and VAT rates,
 *   even when issued on a later day with a different CNB fixing.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { DocumentId, DocumentView } from "@kvitbit/domain/contract";
import { Documents, IsoDate } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as BigIntMath from "effect/BigInt";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { ReportsSourceLive } from "../../src/compose/reportsSource";
import { DocumentPayments } from "../../src/modules/documents";
import { LineViewData } from "../../src/modules/documents/view";
import { ExpenseRecordsLive, ExpensesRepoMemory } from "../../src/modules/expenses";
import { NumberingSeries } from "../../src/modules/numbering";
import { PaymentsRepoMemory } from "../../src/modules/payments";
import { ReportCompute } from "../../src/modules/reports";
import { ReportsSource } from "../../src/modules/reports/source";
import { WorkspacesRepoMemory } from "../../src/modules/workspaces/repo";
import { CoreStore } from "../../src/store/CoreStore";
import { WORKSPACE_A } from "../helpers";
import { CZK, EUR, fixing, invoiceInput, scenario } from "../modules/documents/fixtures";
import { rng } from "./random";

/** TestClock start (runTest): 2026-11-23. Fixings differ every day around it. */
const FIXINGS = Array.from({ length: 10 }, (_, i) =>
  // Rates rise and fall from day to day (i x 437 mod 900 is distinct and not monotonic).
  fixing(
    `2026-11-${EffectString.padStart(2, "0")(String(16 + i))}`,
    `24.${String(100 + ((i * 437) % 900))}`,
  ),
);
/** The fixture's EUR rate published on `day` (every day has its own fixing). */
const fixtureRate = (day: string) => {
  const f = Option.getOrUndefined(EffectArray.findFirst(FIXINGS, (x) => x.fixingDate === day));
  const rate = f?.rates[0]?.rate;
  if (rate === undefined) throw new Error(`no fixture fixing on ${day}`);
  return rate;
};
const RECEIPT_DAYS = EffectArray.map(
  ["2026-11-16", "2026-11-18", "2026-11-20", "2026-11-21", "2026-11-23"],
  (day) => IsoDate.make(day),
);
const REPORT_RANGE = {
  from: IsoDate.make("2026-11-23"),
  to: IsoDate.make("2026-11-25"),
  field: "issuedOn",
} as const;
const reportsLayer = ReportsSourceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      PaymentsRepoMemory,
      ExpenseRecordsLive.pipe(Layer.provideMerge(ExpensesRepoMemory)),
      WorkspacesRepoMemory,
    ),
  ),
);

// Oracle helpers (bigint, minor units) --------------------------------------------------------

const pow10 = (k: number) => 10n ** BigInt(k);
const units = (x: BigDecimal.BigDecimal, scale: number): bigint => {
  const n = BigDecimal.normalize(x);
  if (n.scale > scale) throw new Error(`${BigDecimal.format(n)} has more than ${scale} decimals`);
  return n.value * pow10(scale - n.scale);
};
const roundHalf = (n: bigint, d: bigint): bigint => {
  const a = n < 0n ? -n : n;
  const q = BigIntMath.sum(2n * a, d) / (2n * d);
  return n < 0n ? -q : q;
};
const fmt = (u: bigint) => BigDecimal.format(BigDecimal.make(u, 2));

interface Sums {
  base: bigint;
  vat: bigint;
  gross: bigint;
  vatCzk: bigint;
}
type ByBucket = Map<string, Sums>;
const keyOf = (b: { treatment: string; ratePercent: BigDecimal.BigDecimal }) =>
  `${b.treatment}|${b.ratePercent.pipe(BigDecimal.normalize, BigDecimal.format)}`;
const bucketsOf = (...docs: ReadonlyArray<DocumentView>): ByBucket => {
  const out: ByBucket = new Map();
  for (const doc of docs) {
    for (const b of doc.totals.buckets) {
      const s = out.get(keyOf(b)) ?? { base: 0n, vat: 0n, gross: 0n, vatCzk: 0n };
      s.base += units(b.base, 2);
      s.vat += units(b.vat, 2);
      s.gross += units(b.gross, 2);
      s.vatCzk += b.vatCzk === null ? 0n : units(b.vatCzk, 2);
      out.set(keyOf(b), s);
    }
  }
  return out;
};
const expectZero = (label: string, sums: ByBucket, czk = true) => {
  for (const [key, s] of sums) {
    if (s.base !== 0n || s.vat !== 0n || s.gross !== 0n || (czk && s.vatCzk !== 0n)) {
      throw new Error(
        `${label} ${key} does not net to zero: base ${fmt(s.base)}, vat ${fmt(s.vat)}, gross ${fmt(s.gross)}, vatCzk ${fmt(s.vatCzk)}`,
      );
    }
  }
};
const sub = (a: ByBucket, b: ByBucket): ByBucket => {
  const out: ByBucket = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? { base: 0n, vat: 0n, gross: 0n, vatCzk: 0n };
    const y = b.get(k) ?? { base: 0n, vat: 0n, gross: 0n, vatCzk: 0n };
    out.set(k, {
      base: x.base - y.base,
      vat: x.vat - y.vat,
      gross: x.gross - y.gross,
      vatCzk: x.vatCzk - y.vatCzk,
    });
  }
  return out;
};
/** CZK of a 2-decimal amount at a 3-decimal CNB rate: half away from zero. */
const czkOf = (vatMinor: bigint, fx: NonNullable<DocumentView["fx"]>) =>
  roundHalf(vatMinor * units(fx.rate, 3), 1000n * BigInt(fx.quantity));

const sameFx = (label: string, a: DocumentView["fx"], b: DocumentView["fx"]) => {
  const plain = (f: DocumentView["fx"]) =>
    f === null
      ? null
      : [f.rate.pipe(BigDecimal.normalize, BigDecimal.format), f.quantity, f.fixingDate, f.source];
  const actual = Formatter.format(plain(a));
  const expected = Formatter.format(plain(b));
  if (actual !== expected) {
    throw new Error(`${label}: fx ${actual}, expected ${expected}`);
  }
};

// The generated chain ---------------------------------------------------------------------

const decodeLine = Schema.decodeUnknownResult(Schema.toType(LineViewData));
const lineOf = (view: DocumentView, index: number) =>
  Result.getOrThrow(decodeLine(EffectArray.getUnsafe(view.lines, index))).id;

/** Records a payment as Payments does: lock, settle, PTD in one transaction. */
const pay = (id: DocumentId, amount: BigDecimal.BigDecimal, paidOn: IsoDate) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const seam = yield* DocumentPayments;
    const caller = yield* TestCaller;
    return yield* store.transaction(
      Effect.gen(function* () {
        const on = (yield* seam.lock(WORKSPACE_A, id)).settleOn;
        yield* seam.settle(
          caller,
          WORKSPACE_A,
          on.id,
          { amount: BigDecimal.sum(on.paid.amount, amount), payments: on.payments + 1 },
          { action: "payment.record" },
        );
        return yield* seam.issuePaymentTaxDocument(caller, WORKSPACE_A, on.id, { amount, paidOn });
      }),
    );
  });

const chain = (seed: number) => {
  const r = rng(seed);
  const currency = r.next() < 0.6 ? EUR : CZK;
  const pricesIncludeVat = r.next() < 0.5;
  const lines = EffectArray.map(
    Array.from({ length: r.int(1, 4) }, (_, i) => ({
      description: `Položka ${i + 1}`,
      quantity: BigDecimal.fromStringUnsafe(String(r.int(1, 12))),
      unitPrice: BigDecimal.fromStringUnsafe(r.decimal(5000, r.int(0, 2), false)),
      vat: r.pick(["standard", "reduced"] as const),
    })),
    (l) => (BigDecimal.isZero(l.unitPrice) ? { ...l, unitPrice: BigDecimal.fromBigInt(1n) } : l),
  );
  const first = lines[0];
  if (first === undefined) throw new Error("generator: no lines");
  const paymentCount = r.int(1, 3);
  const paidShare = r.next() < 0.5 ? 1 : r.next();
  const partialCredit = r.next() < 0.5;
  const creditDays = r.int(0, 2);
  return Effect.gen(function* () {
    const testCaller = yield* TestCaller;
    yield* Effect.flatMap(CoreStore, (store) =>
      store.transaction(
        Effect.flatMap(NumberingSeries, (n) =>
          n.ensureDefaults(WORKSPACE_A, [
            "invoice",
            "proforma",
            "credit_note",
            "payment_tax_document",
          ]),
        ),
      ),
    );
    const docs = yield* Documents;
    const proforma = yield* docs.issue(testCaller, {
      input: invoiceInput({
        kind: "proforma",
        currency,
        pricesIncludeVat,
        lines: [first, ...lines.slice(1)],
      }),
    });
    // Split a share of the gross into positive payments of whole minor units.
    const gross = units(proforma.totals.gross.amount, 2);
    const total = BigInt(Math.max(1, Math.round(Number(gross) * paidShare)));
    const cuts = Array.from({ length: paymentCount - 1 }, () =>
      BigInt(r.int(1, Math.max(1, Number(total) - 1))),
    ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = EffectArray.filter(
      EffectArray.map(
        [...cuts, total],
        (c, i) => c - (i === 0 ? 0n : EffectArray.getUnsafe(cuts, i - 1)),
      ),
      (p) => p > 0n,
    );
    const days = EffectArray.map(parts, () => r.pick(RECEIPT_DAYS)).sort();
    const ptds: Array<DocumentView> = [];
    for (const [i, part] of parts.entries()) {
      const ptd = yield* pay(proforma.id, BigDecimal.make(part, 2), EffectArray.getUnsafe(days, i));
      if (ptd === null) throw new Error("vat_payer advance without a PTD");
      ptds.push(ptd);
    }
    const fi = yield* docs.issueFinalInvoice(testCaller, proforma.id);
    // What the VAT report declares for a document: its stored record through the real
    // ReportsSource mapping (`reportFigures`, all deductions are PTDs) and `taxableBucketsCzk`.
    const declare = (id: DocumentId) =>
      Effect.gen(function* () {
        const source = yield* ReportsSource;
        const store = yield* CoreStore;
        const rows = yield* store.transaction(source.documents(WORKSPACE_A, REPORT_RANGE));
        const row = Option.getOrThrow(EffectArray.findFirst(rows, (report) => report.id === id));
        return { declared: ReportCompute.taxableBucketsCzk(row), full: row.totals };
      }).pipe(Effect.provide(reportsLayer));
    const { declared: reported, full: fullSupply } = yield* declare(fi.id);
    // Corrections run on a later day, where the CNB fixing differs from the Final Invoice's.
    if (creditDays > 0) yield* TestClock.adjust(`${creditDays} days`);
    const credits: Array<DocumentView> = [];
    if (partialCredit && BigDecimal.isGreaterThan(first.quantity, BigDecimal.fromBigInt(1n))) {
      const correctResult = yield* docs.correct(testCaller, fi.id, {
        reason: "částečný dobropis",
        lines: [{ line: lineOf(fi, 0), quantity: BigDecimal.fromBigInt(1n) }],
      });
      credits.push(correctResult);
    }
    const correctResult = yield* docs.correct(testCaller, fi.id, {
      reason: "storno",
      lines: "full",
    });
    credits.push(correctResult);
    const creditsReported: Array<typeof reported> = [];
    for (const cn of credits) creditsReported.push((yield* declare(cn.id)).declared);
    const ptdCredits: Array<DocumentView> = yield* Effect.forEach(
      ptds,
      (ptd) =>
        Effect.flatMap(TestCaller, (caller) =>
          docs.correct(caller, ptd.id, { reason: "storno zálohy", lines: "full" }),
        ),
      { concurrency: 1 },
    );
    return {
      seed,
      currency,
      pricesIncludeVat,
      days,
      parts,
      proforma,
      ptds,
      fi,
      reported,
      fullSupply,
      credits,
      creditsReported,
      ptdCredits,
    };
  });
};

const CHAINS = 120;
type Chain = Effect.Success<ReturnType<typeof chain>>;
const chains: Array<Chain> = [];

const collectChain = async (seed: number) => {
  const exit = await scenario(chain(seed), {
    fixings: FIXINGS,
    billingA: { seriesByKind: {} },
  });
  // Not harness drift by default: a service refusing a valid chain is a product regression too.
  if (Exit.isFailure(exit))
    throw new Error(`seed=${seed}: chain failed: ${Cause.pretty(exit.cause)}`, {
      cause: exit.cause,
    });
  chains.push(exit.value);
};
beforeAll(
  () =>
    EffectArray.reduce(
      Array.from({ length: CHAINS }, (_, i) => 0xc4a1 + i * 7919),
      Promise.resolve(),
      (previous, seed) => previous.then(() => collectChain(seed)),
    ),
  30_000,
);

const eachChain = (body: (c: Chain) => void) => {
  for (const c of chains) {
    try {
      body(c);
    } catch (e) {
      throw new Error(`seed=${c.seed}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }
  return chains.length;
};

/**
 * Independent `splitAdvance` oracle (largest remainder, VatMath header): each bucket gets
 * floor(paid x gross / total) minor units, leftovers go to the largest remainders (ties: bucket
 * order); VAT within a share is top-down at the bucket rate.
 */
const splitOracle = (proforma: DocumentView, paid: bigint) => {
  const gross = EffectArray.map(proforma.totals.buckets, (b) => units(b.gross, 2));
  const total = EffectArray.reduce(gross, 0n, (a, g) => a + g);
  const raw = EffectArray.map(gross, (g, i) => ({
    i,
    floor: (paid * g) / total,
    rem: (paid * g) % total,
  }));
  let left = paid - EffectArray.reduce(raw, 0n, (a, r) => a + r.floor);
  const shares = EffectArray.map(raw, (r) => r.floor);
  for (const r of [...raw].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
    if (left <= 0n) break;
    shares[r.i] = (shares[r.i] ?? 0n) + 1n;
    left--;
  }
  return EffectArray.map(proforma.totals.buckets, (b, i) => {
    const share = shares[i] ?? 0n;
    const rate = units(b.ratePercent, 0);
    const vat = rate === 0n ? 0n : roundHalf(share * rate, 100n + rate);
    return { key: keyOf(b), gross: share, vat, base: share - vat };
  });
};

describe("advance chain net-to-zero (property: seeded, 120 chains)", () => {
  test("the generator reaches every chain shape", () => {
    const seen = {
      foreign: 0,
      multiplePtds: 0,
      partlyPaid: 0,
      partialCredit: 0,
      laterDay: 0,
      topDown: 0,
      bothRates: 0,
      ptdRateAboveFi: 0,
      ptdRateBelowFi: 0,
    };
    // Final Invoice buckets left negative by per-PTD rounding (the negative case of §37a). The
    // net-to-zero properties and the D8 CZK test cover them.
    let negativeFiBuckets = 0;
    const fiRate = Number(BigDecimal.format(fixtureRate("2026-11-23")));
    for (const c of chains) {
      if (c.currency !== "CZK") seen.foreign++;
      if (c.ptds.length > 1) seen.multiplePtds++;
      if (!BigDecimal.isZero(c.fi.totals.gross.amount)) seen.partlyPaid++;
      if (c.credits.length > 1) seen.partialCredit++;
      if (EffectArray.some(c.credits, (cn) => cn.dates.issuedOn > c.fi.dates.issuedOn))
        seen.laterDay++;
      if (c.pricesIncludeVat) seen.topDown++;
      if (c.proforma.totals.buckets.length > 1) seen.bothRates++;
      const ptdRates = EffectArray.map(c.days, (d) => Number(BigDecimal.format(fixtureRate(d))));
      if (c.currency !== "CZK" && EffectArray.some(ptdRates, (r) => r > fiRate))
        seen.ptdRateAboveFi++;
      if (c.currency !== "CZK" && EffectArray.some(ptdRates, (r) => r < fiRate))
        seen.ptdRateBelowFi++;
      negativeFiBuckets += EffectArray.filter(
        c.fi.totals.buckets,
        (b) => BigDecimal.isNegative(b.base) || BigDecimal.isNegative(b.vat),
      ).length;
    }
    for (const [shape, count] of EffectRecord.toEntries(seen))
      expect([shape, count > 5]).toEqual([shape, true]);
    // The negative case is reached too (12 buckets at these seeds).
    expect(negativeFiBuckets).toBeGreaterThan(0);
  });

  test("document currency, exact per bucket: Proforma = PTDs + Final Invoice; every credit nets to zero", () => {
    expect(
      eachChain(({ proforma, ptds, fi, credits, ptdCredits }) => {
        expectZero(
          "Proforma - PTDs - Final Invoice",
          sub(bucketsOf(proforma), bucketsOf(...ptds, fi)),
          false,
        );
        expectZero("Final Invoice + Credit Notes", bucketsOf(fi, ...credits));
        for (const [j, ptd] of ptds.entries()) {
          const cn = ptdCredits[j];
          if (cn === undefined) throw new Error("missing PTD credit");
          expectZero(`PTD ${ptd.number} + Credit Note`, bucketsOf(ptd, cn));
          sameFx(`PTD ${ptd.number} Credit Note`, cn.fx, ptd.fx);
        }
        expectZero("whole chain", bucketsOf(...ptds, fi, ...credits, ...ptdCredits));
      }),
    ).toBe(CHAINS);
  });

  test("each PTD splits its payment like the largest-remainder oracle, VAT top-down per share", () => {
    expect(
      eachChain(({ proforma, ptds, parts }) => {
        for (const [j, ptd] of ptds.entries()) {
          const want = splitOracle(proforma, parts[j] ?? 0n);
          const got = bucketsOf(ptd);
          for (const w of want) {
            const g = got.get(w.key) ?? { base: 0n, vat: 0n, gross: 0n, vatCzk: 0n };
            if (g.gross !== w.gross || g.vat !== w.vat || g.base !== w.base) {
              throw new Error(
                `PTD ${ptd.number} ${w.key}: gross/vat/base ${fmt(g.gross)}/${fmt(g.vat)}/${fmt(g.base)}, oracle ${fmt(w.gross)}/${fmt(w.vat)}/${fmt(w.base)}`,
              );
            }
          }
        }
      }),
    ).toBe(CHAINS);
  });

  test("FX: PTDs and the Final Invoice use their own day's fixing; Credit Notes keep the original FX and rates", () => {
    expect(
      eachChain(({ currency, days, ptds, fi, credits }) => {
        for (const cn of credits) {
          sameFx(`Credit Note ${cn.number}`, cn.fx, fi.fx);
          const fiRates = new Map(
            EffectArray.map(fi.totals.buckets, (b) => [
              b.treatment,
              BigDecimal.format(b.ratePercent),
            ]),
          );
          for (const b of cn.totals.buckets) {
            if (fiRates.get(b.treatment) !== BigDecimal.format(b.ratePercent)) {
              throw new Error(
                `Credit Note ${cn.number} ${b.treatment} rate differs from the Final Invoice`,
              );
            }
          }
        }
        if (currency === "CZK") return;
        const fiFx = fi.fx;
        if (fiFx === null) throw new Error("foreign Final Invoice without fx");
        // Expected fixings come from the fixture, not from the service's answer.
        sameFx("Final Invoice", fiFx, {
          rate: fixtureRate("2026-11-23"),
          quantity: 1,
          fixingDate: IsoDate.make("2026-11-23"),
          source: "cnb",
        });
        for (const [j, ptd] of ptds.entries()) {
          const day = EffectArray.getUnsafe(days, j);
          const expectedFx = {
            rate: fixtureRate(day),
            quantity: 1,
            fixingDate: day,
            source: "cnb" as const,
          };
          sameFx(`PTD ${ptd.number} (received ${day})`, ptd.fx, expectedFx);
          for (const b of ptd.totals.buckets) {
            const want = czkOf(units(b.vat, 2), expectedFx);
            if (b.vatCzk === null || units(b.vatCzk, 2) !== want) {
              throw new Error(
                `PTD ${ptd.number} ${b.treatment} vatCzk ${b.vatCzk && BigDecimal.format(b.vatCzk)}, want ${fmt(want)} at the ${day} fixing`,
              );
            }
          }
        }
        // Partial Credit Notes convert at the Final Invoice rate.
        for (const cn of credits.slice(0, -1)) {
          for (const b of cn.totals.buckets) {
            const want = czkOf(units(b.vat, 2), fiFx);
            if (b.vatCzk === null || units(b.vatCzk, 2) !== want) {
              throw new Error(
                `partial Credit Note ${b.treatment} vatCzk ${b.vatCzk && BigDecimal.format(b.vatCzk)}, want ${fmt(want)} at the Final Invoice rate`,
              );
            }
          }
        }
      }),
    ).toBe(CHAINS);
  });

  test("D8 (§37a): Final Invoice CZK VAT = round2((Proforma VAT - PTD VAT) x the Final Invoice rate) per bucket", () => {
    // Filip's decision on finding F1 (legislative adhesion): the remainder is netted in the
    // document currency and converted once at the Final Invoice's own fixing; the PTDs keep the
    // CZK VAT declared at theirs. The oracle nets the Proforma and PTD buckets itself.
    expect(
      eachChain(({ currency, proforma, ptds, fi }) => {
        if (currency === "CZK" || fi.fx === null) return;
        const advances = bucketsOf(...ptds);
        const stored = bucketsOf(fi);
        let total = 0n;
        for (const b of proforma.totals.buckets) {
          const net = units(b.vat, 2) - (advances.get(keyOf(b))?.vat ?? 0n);
          const want = czkOf(net, fi.fx);
          const got = stored.get(keyOf(b))?.vatCzk;
          if (got !== want) {
            throw new Error(
              `Final Invoice ${fi.number} ${keyOf(b)}: vatCzk ${got === undefined ? "none" : fmt(got)}, want round2(${fmt(net)} x ${BigDecimal.format(fi.fx.rate)}) = ${fmt(want)}`,
            );
          }
          total += want;
        }
        const docCzk = fi.totals.vatCzk === null ? null : units(fi.totals.vatCzk.amount, 2);
        if (docCzk !== total)
          throw new Error(
            `Final Invoice vatCzk ${docCzk === null ? "null" : fmt(docCzk)}, want the bucket sum ${fmt(total)}`,
          );
      }),
    ).toBe(CHAINS);
  });

  /**
   * Resolved finding F1 (seed 58256: stored 56,980.96 CZK, report 57,112.25 CZK). The Final
   * Invoice document and the VAT report (reports/compute.ts `taxableBucketsCzk`, fed by
   * documents/reports.ts `reportFigures`: the full supply plus the deducted PTD buckets) must
   * declare the same CZK VAT per bucket. compose.ts used to store round2(supply VAT x FI rate) -
   * sum(PTD CZK VAT at the PTDs' own rates); both now net through `VatMath.netDeductions`.
   */
  test("the VAT report converts each Final Invoice bucket's VAT at the Final Invoice rate", () => {
    expect(
      eachChain(({ currency, fi, reported }) => {
        if (currency === "CZK" || fi.fx === null) return;
        for (const b of fi.totals.buckets) {
          const report = Option.getOrUndefined(
            EffectArray.findFirst(reported, (r) => keyOf(r) === keyOf(b)),
          );
          const want = czkOf(units(b.vat, 2), fi.fx);
          if (report === undefined || units(report.vat, 2) !== want) {
            throw new Error(
              `VAT report ${keyOf(b)}: ${report === undefined ? "none" : BigDecimal.format(report.vat)}, want round2(${BigDecimal.format(b.vat)} x ${BigDecimal.format(fi.fx.rate)}) = ${fmt(want)}`,
            );
          }
        }
      }),
    ).toBe(CHAINS);
  });

  test("revenue's full supply of a Final Invoice: CZK VAT within 0.01 of round2(Proforma VAT x the Final Invoice rate)", () => {
    // reportFigures adds the deductions back at the Final Invoice's own fixing: stored net
    // round2(N x r) + round2(D x r) per bucket, two roundings from round2((N + D) x r).
    expect(
      eachChain(({ currency, proforma, fi, fullSupply }) => {
        if (currency === "CZK" || fi.fx === null) return;
        for (const b of proforma.totals.buckets) {
          const full = Option.getOrUndefined(
            EffectArray.findFirst(fullSupply.buckets, (x) => keyOf(x) === keyOf(b)),
          );
          const got =
            full?.vatCzk === null || full?.vatCzk === undefined ? null : units(full.vatCzk, 2);
          const want = czkOf(units(b.vat, 2), fi.fx);
          if (got === null || got - want > 1n || want - got > 1n)
            throw new Error(
              `revenue ${keyOf(b)}: full-supply vatCzk ${got === null ? "none" : fmt(got)}, want ${fmt(want)} +- 0.01`,
            );
        }
      }),
    ).toBe(CHAINS);
  });

  test("the Final Invoice and each of its Credit Notes: stored CZK VAT = what the VAT report declares", () => {
    expect(
      eachChain(({ currency, fi, reported, credits, creditsReported }) => {
        if (currency === "CZK" || fi.fx === null) return;
        const docs = [
          { label: "Final Invoice", doc: fi, report: reported },
          ...EffectArray.map(credits, (doc, i) => ({
            label: "Credit Note",
            doc,
            report: creditsReported[i] ?? [],
          })),
        ];
        for (const { label, doc, report } of docs) {
          const rate = doc.fx === null ? "none" : BigDecimal.format(doc.fx.rate);
          for (const b of doc.totals.buckets) {
            const r = Option.getOrUndefined(
              EffectArray.findFirst(report, (x) => keyOf(x) === keyOf(b)),
            );
            const stored = b.vatCzk === null ? null : units(b.vatCzk, 2);
            const declared = r === undefined ? null : units(r.vat, 2);
            if (stored !== declared) {
              throw new Error(
                `${label} ${doc.number} ${keyOf(b)}: VAT ${BigDecimal.format(b.vat)} EUR, rate ${rate}; stored vatCzk ${stored === null ? "null" : fmt(stored)}, VAT report ${declared === null ? "none" : fmt(declared)}`,
              );
            }
          }
          for (const r of report) {
            if (
              !(
                EffectArray.some(doc.totals.buckets, (b) => keyOf(b) === keyOf(r)) ||
                BigDecimal.isZero(r.vat)
              )
            )
              throw new Error(
                `${label} ${doc.number}: VAT report ${keyOf(r)} ${BigDecimal.format(r.vat)} without a stored bucket`,
              );
          }
        }
      }),
    ).toBe(CHAINS);
  });
});

test("chain fixtures: fixings differ by day, so a later-day Credit Note would see another rate", () => {
  const rates = new Set(
    EffectArray.map(FIXINGS, (f) =>
      BigDecimal.format(f.rates[0]?.rate ?? BigDecimal.fromBigInt(0n)),
    ),
  );
  expect(rates.size).toBe(FIXINGS.length);
});
