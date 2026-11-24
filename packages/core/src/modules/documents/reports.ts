/**
 * Figures the ReportsSource adapter (ce-reports #397/#477, answered in #384) reads from a
 * stored record. The record keeps a Final Invoice's totals net of its deduction lines (D8);
 * Reports wants the FULL supply plus the buckets deducted from Payment Tax Documents.
 */
import type { DocumentId, VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { Fx } from "../../engines/fx";
import { VatMath } from "../../engines/vat";
import { mergeBuckets } from "./compose";
import { deductionBucketsOf, withRounding } from "./credit";
import type { DocumentRecord } from "./record";

const keyOf = (b: Pick<VatBucket, "treatment" | "ratePercent">) =>
  `${b.treatment}|${BigDecimal.format(BigDecimal.normalize(b.ratePercent))}`;

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));

const positive = (deducted: ReadonlyArray<VatBucket>): ReadonlyArray<VatBucket> =>
  deducted.map((b) => ({
    ...b,
    base: neg(b.base),
    vat: neg(b.vat),
    gross: neg(b.gross),
    vatCzk: b.vatCzk === null ? null : neg(b.vatCzk),
  }));

/**
 * `advanceDeductions`: the buckets deducted from Payment Tax Documents as positive amounts for
 * a Final Invoice (negative for a Credit Note reversing one), `[]` otherwise. Only those were taxed on their PTDs; a deduction of Proforma cash no PTD covers
 * (final.ts, outside_scope) is not an advance tax base, so it stays out. Lines are classified by
 * the kind of their `deducts` target (`deductsPtd`), never by treatment: a PTD can carry
 * outside_scope buckets, and a Credit Note keeps the original's `deducts` targets.
 * `totals`: the stored totals with ALL deductions added back (the full supply), unchanged
 * without any.
 * CZK VAT (D8, VatMath rule 9): every deducted bucket is converted at this document's own
 * fixing, never at the PTD's. The full supply's CZK VAT is the stored net CZK VAT plus these,
 * so the VAT report, subtracting the PTD buckets again, declares exactly the stored net CZK VAT
 * of a Final Invoice and of each Credit Note; and a full supply differs from
 * round2(full VAT x rate) by at most 0.01 CZK per bucket (two roundings), never by a PTD's
 * fixing difference.
 */
export const reportFigures = (
  row: Pick<DocumentRecord, "lines" | "totals" | "currency" | "pricesIncludeVat" | "fx">,
  deductsPtd: (target: DocumentId) => boolean,
): { readonly totals: VatBreakdown; readonly advanceDeductions: ReadonlyArray<VatBucket> } => {
  const fx = row.currency === "CZK" ? null : row.fx;
  // A bucket whose stored net has no CZK VAT gets none on its deductions either: the VAT report
  // then converts the net VAT itself instead of reading a partial sum.
  const storedCzk = new Map(row.totals.buckets.map((b) => [keyOf(b), b.vatCzk]));
  const atOwnFixing = (buckets: ReadonlyArray<VatBucket>): ReadonlyArray<VatBucket> =>
    buckets.map((b) => ({
      ...b,
      vatCzk:
        fx === null || (storedCzk.get(keyOf(b)) ?? null) === null ? null : Fx.toCzk(b.vat, fx),
    }));
  const deducted = atOwnFixing(deductionBucketsOf(row));
  if (deducted.length === 0) return { totals: row.totals, advanceDeductions: [] };
  const advanceDeductions = positive(
    atOwnFixing(
      deductionBucketsOf({
        ...row,
        lines: row.lines.filter((l) => l.deducts !== null && deductsPtd(l.deducts)),
      }),
    ),
  );
  // The stored whole-unit adjustment is kept as is (never rounded a second time).
  const full = withRounding(
    VatMath.fromBuckets(
      // A bucket closed in the document currency can keep a CZK residual (a closing Credit
      // Note's exact CZK VAT against the deductions at its fixing): it stays, so the VAT report
      // and revenue close exactly.
      mergeBuckets(row.totals.buckets, positive(deducted)).filter(
        (b) =>
          !(
            BigDecimal.isZero(b.base) &&
            BigDecimal.isZero(b.vat) &&
            BigDecimal.isZero(b.gross) &&
            (b.vatCzk === null || BigDecimal.isZero(b.vatCzk))
          ),
      ),
      row.currency,
      "none",
    ),
    row.totals.roundingAdjustment.amount,
  );
  return { totals: full, advanceDeductions };
};
