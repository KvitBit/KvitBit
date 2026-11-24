/**
 * Figures the ReportsSource adapter (ce-reports #397/#477, answered in #384) reads from a
 * stored record. The record keeps a Final Invoice's totals net of its deduction lines (D8);
 * Reports wants the FULL supply plus the deducted advance buckets.
 */
import type { VatBreakdown, VatBucket } from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";
import { VatMath } from "../../engines/vat";
import { mergeBuckets } from "./compose";
import type { DocumentRecord } from "./record";

const neg = (v: BigDecimal.BigDecimal) => BigDecimal.normalize(BigDecimal.negate(v));

/**
 * `advanceDeductions`: the deducted buckets as positive amounts for a Final Invoice (negative
 * for a Credit Note reversing one), `[]` otherwise, bucket CZK VAT as stored; `totals`: the
 * stored totals with the deductions added back (the full supply), unchanged without any.
 */
export const reportFigures = (
  row: Pick<
    DocumentRecord,
    "lines" | "totals" | "currency" | "pricesIncludeVat" | "paymentRounding"
  >,
): { readonly totals: VatBreakdown; readonly advanceDeductions: ReadonlyArray<VatBucket> } => {
  const deducted = row.lines.filter((l) => l.deducts !== null);
  if (deducted.length === 0) return { totals: row.totals, advanceDeductions: [] };
  const buckets = mergeBuckets(
    deducted.map((l) => {
      const vat = l.deductedVat ?? BigDecimal.fromBigInt(0n);
      const base = row.pricesIncludeVat ? BigDecimal.subtract(l.amount, vat) : l.amount;
      // Stored negative on the Final Invoice: the deduction is the negation.
      return {
        treatment: l.treatment,
        ratePercent: l.ratePercent,
        base: neg(base),
        vat: neg(vat),
        gross: neg(BigDecimal.sum(base, vat)),
        vatCzk: row.currency === "CZK" || l.deductedVatCzk === null ? null : neg(l.deductedVatCzk),
      } satisfies VatBucket;
    }),
  );
  const full = VatMath.fromBuckets(
    mergeBuckets(row.totals.buckets, buckets).filter(
      (b) => !(BigDecimal.isZero(b.base) && BigDecimal.isZero(b.vat) && BigDecimal.isZero(b.gross)),
    ),
    row.currency,
    row.paymentRounding,
  );
  return { totals: full, advanceDeductions: buckets };
};
