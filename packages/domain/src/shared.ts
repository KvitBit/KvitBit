/** Types shared by several modules: downloads, VAT breakdown views, schedule rules. */

import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import { IsoDate, Money, VatTreatment } from "./vocabulary";

/**
 * Runtime schema for a type the spec defines only partly: the specified fields are checked and
 * typed, and every other field passes through untouched (no stripping on decode).
 */
export const OpenStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);

export interface FileDownload {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Stream.Stream<Uint8Array>;
}

/** core-ports 5.1. One bucket per (treatment, ratePercent). */
export const VatBucket = Schema.Struct({
  treatment: VatTreatment,
  ratePercent: Schema.BigDecimal, // 0 for non-rated treatments
  base: Schema.BigDecimal,
  vat: Schema.BigDecimal,
  gross: Schema.BigDecimal,
  vatCzk: Schema.NullOr(Schema.BigDecimal), // null for CZK documents
});
export type VatBucket = typeof VatBucket.Type;

export const VatBreakdown = Schema.Struct({
  buckets: Schema.Array(VatBucket),
  net: Money,
  vat: Money,
  roundingAdjustment: Money, // whole-unit payment rounding, outside the tax base (§36(5))
  gross: Money, // amount to pay
  vatCzk: Schema.NullOr(Money),
});
export type VatBreakdown = typeof VatBreakdown.Type;

/** Statutory note codes are not enumerated in the spec yet (core-ports 5.4). */
export const StatutoryCode = Schema.Unknown.pipe(Schema.brand("StatutoryCode"));
export type StatutoryCode = typeof StatutoryCode.Type;
export const StatutoryNote = Schema.Struct({ code: StatutoryCode, text: Schema.String });
export type StatutoryNote = typeof StatutoryNote.Type;

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
