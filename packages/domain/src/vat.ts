/**
 * Czech VAT rate data (core-ports section 5.1, rule 8): a table of rates with effective dates.
 * Callers pick a `VatTreatment`; only this table maps it to a percentage on a tax point.
 * The full calculation engine (`VatMath`) is not part of this package.
 */
import { Option, Schema } from "effect";
import type { IsoDate, VatTreatment } from "./vocabulary";

/** Percentages that can appear on a Czech document: 0 (non-rated treatments), 12 and 21. */
export const VatRatePercent = Schema.Literals([0, 12, 21]);
export type VatRatePercent = typeof VatRatePercent.Type;

export interface VatRatePeriod {
  /** First tax point (inclusive, Europe/Prague) the rates apply to. */
  readonly from: string;
  readonly standard: VatRatePercent;
  readonly reduced: VatRatePercent;
}

/** Newest first. 21 % standard and 12 % reduced since 2024-01-01. */
export const CZECH_VAT_RATES: ReadonlyArray<VatRatePeriod> = [
  { from: "2024-01-01", standard: 21, reduced: 12 },
];

/**
 * Rate in force for `treatment` on `taxPoint`. Non-rated treatments are 0. `None` when the
 * tax point is before the table's first entry, which callers treat as a defect.
 */
export const ratePercentFor = (
  treatment: VatTreatment,
  taxPoint: IsoDate,
): Option.Option<VatRatePercent> => {
  const period = CZECH_VAT_RATES.find((p) => taxPoint >= p.from);
  if (period === undefined) return Option.none();
  switch (treatment) {
    case "standard":
      return Option.some(period.standard);
    case "reduced":
      return Option.some(period.reduced);
    case "exempt_intra_eu_goods":
    case "reverse_charge":
    case "outside_scope":
      return Option.some(0);
  }
};
