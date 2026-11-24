/**
 * Figures the ReportsSource adapter (ce-reports #397/#477, answered in #384) reads from a
 * stored record. The record keeps a Final Invoice's totals net of its deduction lines (D8);
 * Reports wants the FULL supply plus the buckets deducted from Payment Tax Documents.
 */
import type { DocumentId, VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { VatMath } from "../../engines/vat";
import { mergeBuckets } from "./compose";
import { deductionBucketsOf, withRounding } from "./credit";
import type { DocumentRecord } from "./record";

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
 * a Final Invoice (negative for a Credit Note reversing one), `[]` otherwise, bucket CZK VAT as
 * stored. Only those were taxed on their PTDs; a deduction of Proforma cash no PTD covers
 * (final.ts, outside_scope) is not an advance tax base, so it stays out. Lines are classified by
 * the kind of their `deducts` target (`deductsPtd`), never by treatment: a PTD can carry
 * outside_scope buckets, and a Credit Note keeps the original's `deducts` targets.
 * `totals`: the stored totals with ALL deductions added back (the full supply), unchanged
 * without any.
 */
export const reportFigures = (
  row: Pick<DocumentRecord, "lines" | "totals" | "currency" | "pricesIncludeVat">,
  deductsPtd: (target: DocumentId) => boolean,
): { readonly totals: VatBreakdown; readonly advanceDeductions: ReadonlyArray<VatBucket> } => {
  const deducted = deductionBucketsOf(row);
  if (deducted.length === 0) return { totals: row.totals, advanceDeductions: [] };
  const advanceDeductions = positive(
    deductionBucketsOf({
      ...row,
      lines: row.lines.filter((l) => l.deducts !== null && deductsPtd(l.deducts)),
    }),
  );
  // The stored whole-unit adjustment is kept as is (never rounded a second time).
  const full = withRounding(
    VatMath.fromBuckets(
      mergeBuckets(row.totals.buckets, positive(deducted)).filter(
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
