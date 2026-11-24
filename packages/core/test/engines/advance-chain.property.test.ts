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
 * - CZK VAT: each PTD = round2(VAT x its receipt-date rate); Final Invoice + PTDs =
 *   round2(Proforma VAT x the Final Invoice rate), within 0.005 CZK of exact (the documented
 *   residue); Final Invoice + Credit Notes = 0 exactly;
 * - a Credit Note keeps the Final Invoice's FX (rate, quantity, fixing date) and VAT rates,
 *   even when issued on a later day with a different CNB fixing.
 */
import { describe, expect, test } from "bun:test";
import type { DocumentId, DocumentView, IsoDate, LineId } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { DocumentPayments } from "../../src/modules/documents";
import { NumberingSeries } from "../../src/modules/numbering";
import { CoreStore } from "../../src/store/CoreStore";
import { WORKSPACE_A } from "../helpers";
import { CZK, EUR, fixing, invoiceInput, scenario } from "../modules/documents/fixtures";
import { rng } from "./random";

const WS = WORKSPACE_A;
/** TestClock start (runTest): 2026-11-23. Fixings differ every day around it. */
const FIXINGS = Array.from({ length: 10 }, (_, i) =>
  fixing(`2026-11-${String(16 + i).padStart(2, "0")}`, `24.${String(100 + i * 37)}`),
);
/** The fixture's EUR rate published on `day` (every day has its own fixing). */
const fixtureRate = (day: string) => {
  const f = FIXINGS.find((x) => x.fixingDate === day);
  const rate = f?.rates[0]?.rate;
  if (rate === undefined) throw new Error(`no fixture fixing on ${day}`);
  return rate;
};
const RECEIPT_DAYS = ["2026-11-16", "2026-11-18", "2026-11-20", "2026-11-21", "2026-11-23"];

// Oracle helpers (bigint, minor units) --------------------------------------------------------

const pow10 = (k: number) => 10n ** BigInt(k);
const units = (x: BigDecimal.BigDecimal, scale: number): bigint => {
  const n = BigDecimal.normalize(x);
  if (n.scale > scale) throw new Error(`${BigDecimal.format(n)} has more than ${scale} decimals`);
  return n.value * pow10(scale - n.scale);
};
const roundHalf = (n: bigint, d: bigint): bigint => {
  const a = n < 0n ? -n : n;
  const q = (2n * a + d) / (2n * d);
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
  `${b.treatment}|${BigDecimal.format(BigDecimal.normalize(b.ratePercent))}`;
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
      : [BigDecimal.format(BigDecimal.normalize(f.rate)), f.quantity, f.fixingDate, f.source];
  if (JSON.stringify(plain(a)) !== JSON.stringify(plain(b))) {
    throw new Error(
      `${label}: fx ${JSON.stringify(plain(a))}, expected ${JSON.stringify(plain(b))}`,
    );
  }
};

// The generated chain ---------------------------------------------------------------------

const lineOf = (view: DocumentView, i: number) =>
  (view.lines as unknown as ReadonlyArray<{ readonly id: string }>)[i]?.id as LineId;

/** Records a payment as Payments does: lock, settle, PTD in one transaction. */
const pay = (id: DocumentId, amount: BigDecimal.BigDecimal, paidOn: IsoDate) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const seam = yield* DocumentPayments;
    return yield* store.transaction(
      Effect.gen(function* () {
        const on = (yield* seam.lock(WS, id)).settleOn;
        yield* seam.settle(
          WS,
          on.id,
          { amount: BigDecimal.sum(on.paid.amount, amount), payments: on.payments + 1 },
          { action: "payment.record" },
        );
        return yield* seam.issuePaymentTaxDocument(WS, on.id, { amount, paidOn });
      }),
    );
  });

const chain = (seed: number) => {
  const r = rng(seed);
  const currency = r.next() < 0.6 ? EUR : CZK;
  const pricesIncludeVat = r.next() < 0.5;
  const lines = Array.from({ length: r.int(1, 4) }, (_, i) => ({
    description: `Položka ${i + 1}`,
    quantity: BigDecimal.fromStringUnsafe(String(r.int(1, 12))),
    unitPrice: BigDecimal.fromStringUnsafe(r.decimal(5000, r.int(0, 2), false)),
    vat: r.pick(["standard", "reduced"] as const),
  })).map((l) =>
    BigDecimal.isZero(l.unitPrice) ? { ...l, unitPrice: BigDecimal.fromBigInt(1n) } : l,
  );
  const first = lines[0];
  if (first === undefined) throw new Error("generator: no lines");
  const paymentCount = r.int(1, 3);
  const paidShare = r.next() < 0.5 ? 1 : r.next();
  const partialCredit = r.next() < 0.5;
  const creditDays = r.int(0, 2);
  return Effect.gen(function* () {
    yield* Effect.flatMap(CoreStore, (store) =>
      store.transaction(
        Effect.flatMap(NumberingSeries, (n) =>
          n.ensureDefaults(WS, ["invoice", "proforma", "credit_note", "payment_tax_document"]),
        ),
      ),
    );
    const docs = yield* Documents;
    const proforma = yield* docs.issue({
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
    const parts = [...cuts, total]
      .map((c, i, all) => c - (i === 0 ? 0n : (all[i - 1] ?? 0n)))
      .filter((p) => p > 0n);
    const days = parts.map(() => r.pick(RECEIPT_DAYS)).sort();
    const ptds: Array<DocumentView> = [];
    for (const [i, part] of parts.entries()) {
      const ptd = yield* pay(proforma.id, BigDecimal.make(part, 2), days[i] as IsoDate);
      if (ptd === null) throw new Error("vat_payer advance without a PTD");
      ptds.push(ptd);
    }
    const fi = yield* docs.issueFinalInvoice(proforma.id);
    // Corrections run on a later day, where the CNB fixing differs from the Final Invoice's.
    if (creditDays > 0) yield* TestClock.adjust(`${creditDays} days`);
    const credits: Array<DocumentView> = [];
    if (partialCredit && BigDecimal.isGreaterThan(first.quantity, BigDecimal.fromBigInt(1n))) {
      credits.push(
        yield* docs.correct(fi.id, {
          reason: "částečný dobropis",
          lines: [{ line: lineOf(fi, 0), quantity: BigDecimal.fromBigInt(1n) }],
        }),
      );
    }
    credits.push(yield* docs.correct(fi.id, { reason: "storno", lines: "full" }));
    const ptdCredits: Array<DocumentView> = [];
    for (const ptd of ptds)
      ptdCredits.push(yield* docs.correct(ptd.id, { reason: "storno zálohy", lines: "full" }));
    return { currency, pricesIncludeVat, days, proforma, ptds, fi, credits, ptdCredits };
  });
};

const CHAINS = 120;

describe("advance chain net-to-zero (property: seeded, 120 chains)", () => {
  test("per VAT bucket: exact in document currency, CZK residue <= 0.005, Credit Notes keep the Final Invoice FX and rates", async () => {
    const seen = {
      foreign: 0,
      multiplePtds: 0,
      partlyPaid: 0,
      partialCredit: 0,
      laterDay: 0,
      topDown: 0,
      bothRates: 0,
    };
    for (let i = 0; i < CHAINS; i++) {
      const seed = 0xc4a1 + i * 7919;
      const exit = await scenario(chain(seed), {
        fixings: FIXINGS,
        billingA: { seriesByKind: {} },
      });
      if (Exit.isFailure(exit))
        throw new Error(`seed=${seed}: chain failed: ${JSON.stringify(exit.cause)}`);
      const { currency, pricesIncludeVat, days, proforma, ptds, fi, credits, ptdCredits } =
        exit.value;
      if (currency !== "CZK") seen.foreign++;
      if (ptds.length > 1) seen.multiplePtds++;
      if (!BigDecimal.isZero(fi.totals.gross.amount)) seen.partlyPaid++;
      if (credits.length > 1) seen.partialCredit++;
      if (credits.some((c) => c.dates.issuedOn > fi.dates.issuedOn)) seen.laterDay++;
      if (pricesIncludeVat) seen.topDown++;
      if (proforma.totals.buckets.length > 1) seen.bothRates++;
      try {
        // Proforma = PTDs + Final Invoice, exactly, per bucket (document currency).
        expectZero(
          "Proforma - PTDs - Final Invoice",
          sub(bucketsOf(proforma), bucketsOf(...ptds, fi)),
          false,
        );
        // Final Invoice + its Credit Notes; each PTD + its Credit Note (CZK VAT too).
        expectZero("Final Invoice + Credit Notes", bucketsOf(fi, ...credits));
        for (const [j, ptd] of ptds.entries()) {
          const cn = ptdCredits[j];
          if (cn === undefined) throw new Error("missing PTD credit");
          expectZero(`PTD ${ptd.number} + Credit Note`, bucketsOf(ptd, cn));
          sameFx(`PTD ${ptd.number} Credit Note`, cn.fx, ptd.fx);
        }
        expectZero("whole chain", bucketsOf(...ptds, fi, ...credits, ...ptdCredits));
        for (const cn of credits) {
          sameFx(`Credit Note ${cn.number}`, cn.fx, fi.fx);
          const fiRates = new Map(
            fi.totals.buckets.map((b) => [b.treatment, BigDecimal.format(b.ratePercent)]),
          );
          for (const b of cn.totals.buckets) {
            if (fiRates.get(b.treatment) !== BigDecimal.format(b.ratePercent)) {
              throw new Error(
                `Credit Note ${cn.number} ${b.treatment} rate differs from the Final Invoice`,
              );
            }
          }
        }
        if (currency !== "CZK") {
          const fiFx = fi.fx;
          if (fiFx === null) throw new Error("foreign Final Invoice without fx");
          // The Final Invoice and each PTD use the fixing of their own tax point, taken from the
          // fixture (not from the service's answer), and convert per bucket at it.
          sameFx("Final Invoice", fiFx, {
            rate: fixtureRate("2026-11-23"),
            quantity: 1,
            fixingDate: "2026-11-23" as IsoDate,
            source: "cnb",
          });
          for (const [j, ptd] of ptds.entries()) {
            const day = days[j] as IsoDate;
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
          // Declared CZK VAT (PTDs + Final Invoice) per bucket = round2(Proforma VAT x the Final
          // Invoice rate), so within 0.005 CZK of exact.
          const declared = bucketsOf(...ptds, fi);
          const d = 1000n * BigInt(fiFx.quantity);
          for (const b of proforma.totals.buckets) {
            const got = declared.get(keyOf(b))?.vatCzk ?? 0n;
            const vat = units(b.vat, 2);
            if (got !== czkOf(vat, fiFx)) {
              throw new Error(
                `${keyOf(b)} declared CZK VAT ${fmt(got)}, want ${fmt(czkOf(vat, fiFx))}`,
              );
            }
            const err = got * d - vat * units(fiFx.rate, 3);
            if (2n * (err < 0n ? -err : err) > d)
              throw new Error(`${keyOf(b)} CZK residue above 0.005`);
          }
        }
      } catch (e) {
        throw new Error(`seed=${seed}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The generator reaches every shape the properties are about.
    for (const [shape, count] of Object.entries(seen))
      expect([shape, count > 5]).toEqual([shape, true]);
  }, 30_000);
});

test("chain fixtures: fixings differ by day, so a later-day Credit Note would see another rate", () => {
  const rates = new Set(
    FIXINGS.map((f) => BigDecimal.format(f.rates[0]?.rate ?? BigDecimal.fromBigInt(0n))),
  );
  expect(rates.size).toBe(FIXINGS.length);
});
