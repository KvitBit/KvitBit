/**
 * Price List Item rows, the concrete view and the save input (core-ports 4.3). The domain leaves
 * the input and view open; the fields follow the `price_list_items` table of packages/db.
 */
import {
  CurrencyCode,
  PriceListItemId as PriceListItemIdSchema,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";

const OptionalText = Schema.NullOr(Schema.String);
const Name = Schema.Trimmed.pipe(Schema.check(Schema.isMinLength(1)));

const ItemFields = {
  name: Name,
  description: OptionalText,
  unit: OptionalText,
  /** Excl. VAT, in `currency`; copied onto a line when a document is drafted. */
  unitPrice: Schema.BigDecimal,
  currency: CurrencyCode,
  /** Default VAT treatment of the line; null leaves it to the Tax Regime and Contact (D9). */
  vat: Schema.NullOr(VatTreatment),
};

export const PriceListItemRowSchema = Schema.Struct({
  id: PriceListItemIdSchema,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  ...ItemFields,
  archivedAt: OptionalText,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PriceListItemRow = typeof PriceListItemRowSchema.Type;

/** The concrete `PriceListItemView`. */
export const PriceListItemViewSchema = Schema.Struct({
  id: PriceListItemIdSchema,
  ...ItemFields,
  archived: Schema.Boolean,
  revision: Schema.Int,
});
export type PriceListItemViewData = typeof PriceListItemViewSchema.Type;

export const toPriceListItemView = (row: PriceListItemRow): PriceListItemViewData => ({
  id: row.id,
  name: row.name,
  description: row.description,
  unit: row.unit,
  unitPrice: row.unitPrice,
  currency: row.currency,
  vat: row.vat,
  archived: row.archivedAt !== null,
  revision: row.revision,
});

/**
 * Decoded `save` fields. On create `name`, `unitPrice` and `currency` are required and the
 * rest default to null; on an existing item an absent field keeps its value and `null` clears
 * a nullable one.
 */
export const PriceListItemSaveFields = Schema.Struct({
  name: Schema.optional(Name),
  description: Schema.optional(OptionalText),
  unit: Schema.optional(OptionalText),
  unitPrice: Schema.optional(Schema.BigDecimal),
  currency: Schema.optional(CurrencyCode),
  vat: VatTreatment.pipe(Schema.NullOr, Schema.optional),
});
export type PriceListItemSaveFields = typeof PriceListItemSaveFields.Type;

/** A plain decimal string (`"1500"`, `"-12.50"`); `""` and exponents are rejected. */
const DecimalString = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^-?\d+(\.\d+)?$/)),
  Schema.decodeTo(Schema.BigDecimalFromString),
);

/**
 * The whole `save` input, decoded strictly (unknown fields are Invalid): the fields, with
 * `unitPrice` also as a decimal string, plus the target `id` and `expectedRevision`.
 */
export const PriceListItemSaveInput = Schema.Struct({
  ...PriceListItemSaveFields.fields,
  unitPrice: Schema.optional(Schema.Union([Schema.BigDecimal, DecimalString])),
  id: Schema.optional(PriceListItemIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});

/** What `save` fingerprints for its request key (rule C3). */
export const PriceListItemSavePayload = Schema.Struct({
  fields: PriceListItemSaveFields,
  id: Schema.optional(PriceListItemIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});
