/** Types shared by several modules: downloads, VAT breakdown views, schedule rules. */
import type { BigDecimal, Stream } from "effect";
import { Schema } from "effect";
import type { Money, VatTreatment } from "./vocabulary";
import { IsoDate } from "./vocabulary";

declare const UnspecifiedContract: unique symbol;

/**
 * A type that docs/design/core-ports.md references but does not yet define field by field.
 * It is opaque on purpose: nothing can construct or read one until the spec fixes its shape,
 * so no caller can come to depend on guessed fields. Replace each use when the spec lands.
 */
export interface Unspecified<Name extends string> {
  readonly [UnspecifiedContract]: Name;
}

export interface FileDownload {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Stream.Stream<Uint8Array>;
}

/** core-ports 5.1. One bucket per (treatment, ratePercent). */
export interface VatBucket {
  readonly treatment: VatTreatment;
  readonly ratePercent: BigDecimal.BigDecimal; // 0 for non-rated treatments
  readonly base: BigDecimal.BigDecimal;
  readonly vat: BigDecimal.BigDecimal;
  readonly gross: BigDecimal.BigDecimal;
  readonly vatCzk: BigDecimal.BigDecimal | null; // null for CZK documents
}

export interface VatBreakdown {
  readonly buckets: ReadonlyArray<VatBucket>;
  readonly net: Money;
  readonly vat: Money;
  readonly roundingAdjustment: Money; // whole-unit payment rounding, outside the tax base (§36(5))
  readonly gross: Money; // amount to pay
  readonly vatCzk: Money | null;
}

/** Statutory note codes are not enumerated in the spec yet (core-ports 5.4). */
export type StatutoryCode = Unspecified<"StatutoryCode">;
export interface StatutoryNote {
  readonly code: StatutoryCode;
  readonly text: string;
}

/** Recurring cadence (core-ports 5.6). Occurrence k is startOn + k × every on the Prague calendar. */
export const ScheduleRule = Schema.Struct({
  every: Schema.Union([
    Schema.Struct({ weeks: Schema.Int }),
    Schema.Struct({ months: Schema.Int }),
    Schema.Struct({ years: Schema.Int }),
  ]),
  startOn: IsoDate,
  endOn: Schema.optional(IsoDate),
});
export type ScheduleRule = typeof ScheduleRule.Type;
