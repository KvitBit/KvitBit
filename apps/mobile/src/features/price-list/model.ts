import type {
  CurrencyCode,
  PriceListItemId,
  PriceListItemInput,
  PriceListItemView,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { BigDecimal, Option } from "effect";

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
  "CZK" as CurrencyCode,
  "EUR" as CurrencyCode,
  "USD" as CurrencyCode,
  "GBP" as CurrencyCode,
];

export const VAT_TREATMENTS: ReadonlyArray<VatTreatment> = [
  "standard",
  "reduced",
  "exempt_intra_eu_goods",
  "reverse_charge",
  "outside_scope",
];

const VAT_SET = new Set<string>(VAT_TREATMENTS);
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const toBigDecimal = (value: unknown): BigDecimal.BigDecimal | null => {
  if (BigDecimal.isBigDecimal(value)) return value;
  if (typeof value === "string") {
    return Option.getOrNull(BigDecimal.fromString(value));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigDecimal.fromNumberUnsafe(value);
  }
  return null;
};

/** Parses the open `PriceListItemView` wire object into a concrete `PriceListItemRecord`. */
export const parsePriceListItem = (
  raw: PriceListItemView | unknown,
): PriceListItemRecord | null => {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? (raw.id as PriceListItemId) : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  const unitPrice = toBigDecimal(raw.unitPrice);
  const currency =
    typeof raw.currency === "string" && CURRENCY_RE.test(raw.currency.toUpperCase())
      ? (raw.currency.toUpperCase() as CurrencyCode)
      : null;
  const revision = typeof raw.revision === "number" ? raw.revision : null;
  if (
    id === null ||
    name === null ||
    unitPrice === null ||
    currency === null ||
    revision === null
  ) {
    return null;
  }
  const vat =
    typeof raw.vat === "string" && VAT_SET.has(raw.vat) ? (raw.vat as VatTreatment) : null;
  return {
    id,
    name,
    description: asNullableString(raw.description),
    unit: asNullableString(raw.unit),
    unitPrice,
    currency,
    vat,
    archived: raw.archived === true,
    revision,
  };
};

export const parsePriceListItems = (
  items: ReadonlyArray<PriceListItemView | unknown>,
): ReadonlyArray<PriceListItemRecord> =>
  items.flatMap((item) => {
    const parsed = parsePriceListItem(item);
    return parsed === null ? [] : [parsed];
  });

/** Normalizes user decimal input (strips spaces/NBSP, converts Czech comma to dot). */
export const normalizeDecimalInput = (raw: string): string =>
  raw
    .trim()
    .replace(/[\s\u00a0]/g, "")
    .replace(",", ".");

export const emptyPriceListForm = (
  defaultCurrency: CurrencyCode = "CZK" as CurrencyCode,
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
  if (form.name.trim() === "") errors.name = "name_required";
  const normalizedPrice = normalizeDecimalInput(form.unitPrice);
  if (!DECIMAL_RE.test(normalizedPrice)) errors.unitPrice = "price_invalid";
  if (!CURRENCY_RE.test(form.currency.trim().toUpperCase())) errors.currency = "currency_invalid";
  return errors;
};

const emptyToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/** Builds the `PriceListItemInput` wire payload matching core's `PriceListItemSaveInput`. */
export const buildPriceListInput = (form: PriceListFormState): PriceListItemInput =>
  ({
    name: form.name.trim(),
    description: emptyToNull(form.description),
    unit: emptyToNull(form.unit),
    unitPrice: normalizeDecimalInput(form.unitPrice),
    currency: form.currency.trim().toUpperCase(),
    vat: form.vat,
  }) as unknown as PriceListItemInput;
