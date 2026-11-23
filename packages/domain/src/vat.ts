/**
 * Czech VAT rate vocabulary. Callers pick a `VatTreatment`; the effective-dated table that maps
 * a treatment to a percentage on a tax point belongs to `VatMath` (core-ports 5.1, rule 8).
 */
import { Schema } from "effect";

/** Percentages that can appear on a Czech document: 0 (non-rated treatments), 12 and 21. */
export const VatRatePercent = Schema.Literals([0, 12, 21]);
export type VatRatePercent = typeof VatRatePercent.Type;
