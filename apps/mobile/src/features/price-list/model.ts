import type { WorkspaceId } from "@kvitbit/domain/contract";
import {
  CurrencyCode,
  PriceListItemId,
  PriceListItemInput,
  type PriceListItemView,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { inWorkspace, type KvitbitApiClient } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export interface PriceListItemRecord {
  readonly id: PriceListItemId;
  readonly name: string;
  readonly description: string | null;
  readonly unit: string | null;
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly currency: CurrencyCode;
  readonly vat: VatTreatment | null;
  readonly archived: boolean;
  readonly revision: number;
}

export interface PriceListFormState {
  readonly editingId: PriceListItemId | null;
  readonly editingRevision: number | null;
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly currency: CurrencyCode;
  readonly vat: VatTreatment | null;
}

export type PriceListFormErrorCode = "name_required" | "price_invalid" | "currency_invalid";

export const PRICE_LIST_CURRENCIES: ReadonlyArray<CurrencyCode> = [
  CurrencyCode.make("CZK"),
  CurrencyCode.make("EUR"),
  CurrencyCode.make("USD"),
  CurrencyCode.make("GBP"),
];

export const VAT_TREATMENTS: ReadonlyArray<VatTreatment> = [
  "standard",
  "reduced",
  "exempt_intra_eu_goods",
  "reverse_charge",
  "outside_scope",
];

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const decodeItem = Schema.decodeUnknownOption(
  Schema.Struct({
    id: PriceListItemId,
    name: Schema.String,
    description: Schema.optional(Schema.Unknown),
    unit: Schema.optional(Schema.Unknown),
    unitPrice: Schema.Union([Schema.BigDecimal, Schema.BigDecimalFromString, Schema.Finite]),
    currency: Schema.String.check(Schema.isPattern(/^[a-z]{3}$/i)),
    vat: Schema.optional(Schema.Unknown),
    archived: Schema.optional(Schema.Unknown),
    revision: Schema.Finite,
  }),
);
const decodeOptionalText = Fn.flow(
  Schema.decodeUnknownOption(Schema.String),
  Option.filter((value) => Str.trim(value) !== ""),
  Option.getOrNull,
);
const decodeVat = Schema.decodeUnknownOption(VatTreatment);

/** Parses the open Price List Item payload into the fields the screen uses. */
export const parsePriceListItem = Fn.flow(
  decodeItem,
  Option.map(
    (row): PriceListItemRecord => ({
      id: row.id,
      name: row.name,
      description: decodeOptionalText(row.description),
      unit: decodeOptionalText(row.unit),
      unitPrice: BigDecimal.isBigDecimal(row.unitPrice)
        ? row.unitPrice
        : BigDecimal.fromNumberUnsafe(row.unitPrice),
      currency: CurrencyCode.make(Str.toUpperCase(row.currency)),
      vat: Option.getOrNull(decodeVat(row.vat)),
      archived: row.archived === true,
      revision: row.revision,
    }),
  ),
  Option.getOrNull,
);

export const parsePriceListItems = (
  items: ReadonlyArray<PriceListItemView>,
): ReadonlyArray<PriceListItemRecord> =>
  Arr.flatMap(items, (item) => {
    const parsed = parsePriceListItem(item);
    return parsed === null ? [] : [parsed];
  });

/** Normalizes user decimal input (strips spaces/NBSP, converts Czech comma to dot). */
export const normalizeDecimalInput = (raw: string): string =>
  Str.replace(",", ".")(Str.replace(/[\s\u00a0]/g, "")(Str.trim(raw)));

export const emptyPriceListForm = (
  defaultCurrency: CurrencyCode = CurrencyCode.make("CZK"),
): PriceListFormState => ({
  editingId: null,
  editingRevision: null,
  name: "",
  description: "",
  unit: "",
  unitPrice: "",
  currency: defaultCurrency,
  vat: null,
});

export const priceListFormFromItem = (item: PriceListItemRecord): PriceListFormState => ({
  editingId: item.id,
  editingRevision: item.revision,
  name: item.name,
  description: item.description ?? "",
  unit: item.unit ?? "",
  unitPrice: BigDecimal.format(item.unitPrice),
  currency: item.currency,
  vat: item.vat,
});

export const validatePriceListForm = (
  form: PriceListFormState,
): Readonly<Partial<Record<string, PriceListFormErrorCode>>> => {
  const errors: Partial<Record<string, PriceListFormErrorCode>> = {};
  if (Str.trim(form.name) === "") errors.name = "name_required";
  const normalizedPrice = normalizeDecimalInput(form.unitPrice);
  if (!DECIMAL_RE.test(normalizedPrice)) errors.unitPrice = "price_invalid";
  if (!CURRENCY_RE.test(Str.toUpperCase(Str.trim(form.currency))))
    errors.currency = "currency_invalid";
  return errors;
};

const emptyToNull = (value: string): string | null => {
  const trimmed = Str.trim(value);
  return trimmed === "" ? null : trimmed;
};

/** Builds the `PriceListItemInput` wire payload matching core's `PriceListItemSaveInput`. */
export const buildPriceListInput = (form: PriceListFormState): PriceListItemInput =>
  PriceListItemInput.make({
    name: Str.trim(form.name),
    description: emptyToNull(form.description),
    unit: emptyToNull(form.unit),
    unitPrice: normalizeDecimalInput(form.unitPrice),
    currency: Str.toUpperCase(Str.trim(form.currency)),
    vat: form.vat,
  });

export const reloadPriceListItem = ({
  priceList,
  workspaceId,
  editingId,
}: {
  readonly priceList: Pick<KvitbitApiClient["priceList"], "list">;
  readonly workspaceId: WorkspaceId;
  readonly editingId: PriceListItemId;
}) =>
  Effect.map(priceList.list({ params: inWorkspace(workspaceId), query: {} }), (items) =>
    Option.getOrUndefined(
      Arr.findFirst(parsePriceListItems(items), (item) => item.id === editingId && !item.archived),
    ),
  );
