/**
 * Figures the ReportsSource adapter (ce-reports #397/#477, answered in #384) reads from a
 * stored record. The record keeps a Final Invoice's totals net of its deduction lines (D8);
 * Reports wants the FULL supply plus the deducted advance buckets.
 */
import type { VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { VatMath } from "../../engines/vat";
import { mergeBuckets } from "./compose";
import { deductionBucketsOf, withRounding } from "./credit";
import type { DocumentRecord } from "./record";

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));

/**
 * `advanceDeductions`: the deducted buckets as positive amounts for a Final Invoice (negative
 * for a Credit Note reversing one), `[]` otherwise, bucket CZK VAT as stored; `totals`: the
 * stored totals with the deductions added back (the full supply), unchanged without any.
 */
export const reportFigures = (
  row: Pick<DocumentRecord, "lines" | "totals" | "currency" | "pricesIncludeVat">,
): { readonly totals: VatBreakdown; readonly advanceDeductions: ReadonlyArray<VatBucket> } => {
  const deducted = deductionBucketsOf(row);
  if (deducted.length === 0) return { totals: row.totals, advanceDeductions: [] };
  const advanceDeductions = deducted.map((b) => ({
    ...b,
    base: neg(b.base),
    vat: neg(b.vat),
    gross: neg(b.gross),
    vatCzk: b.vatCzk === null ? null : neg(b.vatCzk),
  }));
  // The stored whole-unit adjustment is kept as is (never rounded a second time).
  const full = withRounding(
    VatMath.fromBuckets(
      mergeBuckets(row.totals.buckets, advanceDeductions).filter(
        (b) =>
          !(BigDecimal.isZero(b.base) && BigDecimal.isZero(b.vat) && BigDecimal.isZero(b.gross)),
      ),
      row.currency,
      "none",
    ),
    row.totals.roundingAdjustment.amount,
  );
  return { totals: full, advanceDeductions };
};
