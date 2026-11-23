/**
 * Price List Item rows, the concrete view and the save input (core-ports 4.3). The domain leaves
 * the input and view open; the fields follow the `price_list_items` table of packages/db.
 */
import type { PriceListItemId, WorkspaceId } from "@kvitbit/domain/contract";
import {
  CurrencyCode,
  PriceListItemId as PriceListItemIdSchema,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";

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
  id: Schema.String,
  workspaceId: Schema.String,
  revision: Schema.Int,
  ...ItemFields,
  archivedAt: OptionalText,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export interface PriceListItemRow
  extends Omit<typeof PriceListItemRowSchema.Type, "id" | "workspaceId"> {
  readonly id: PriceListItemId;
  readonly workspaceId: WorkspaceId;
}

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
  vat: Schema.optional(Schema.NullOr(VatTreatment)),
});
export type PriceListItemSaveFields = typeof PriceListItemSaveFields.Type;

/** What `save` decodes: as `PriceListItemSaveFields`, and `unitPrice` also as a decimal string. */
export const PriceListItemSaveInput = Schema.Struct({
  ...PriceListItemSaveFields.fields,
  unitPrice: Schema.optional(Schema.Union([Schema.BigDecimal, Schema.BigDecimalFromString])),
});

/** What `save` fingerprints for its request key (rule C3). */
export const PriceListItemSavePayload = Schema.Struct({
  fields: PriceListItemSaveFields,
  id: Schema.optional(PriceListItemIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});
