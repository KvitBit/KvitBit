import { BigDecimal } from "effect";
import { INTL_TAG, type Locale } from "../i18n/locale";

/** A decimal value as the server sends it (string), a BigDecimal, or a JS number. */
export type DecimalInput = BigDecimal.BigDecimal | string | number | bigint;

type NumericLiteral = `${number}`;

/** Plain decimal string (no exponent) that `Intl.NumberFormat` formats without float loss. */
export const toDecimalString = (value: DecimalInput): NumericLiteral => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
    return String(value) as NumericLiteral;
  }
  if (typeof value === "bigint") return value.toString() as NumericLiteral;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) throw new RangeError(`Not a decimal string: ${value}`);
    return trimmed as NumericLiteral;
  }
  return BigDecimal.format(value) as NumericLiteral;
};

export type Sign = "positive" | "negative" | "zero";

export const signOf = (value: DecimalInput): Sign => {
  const s = toDecimalString(value);
  if (/^[-+]?0+(\.0+)?$/.test(s)) return "zero";
  return s.startsWith("-") ? "negative" : "positive";
};

const cache = new Map<string, Intl.NumberFormat>();

/** Memoised `Intl.NumberFormat` (formatters are costly to build on Hermes). */
export const numberFormat = (
  locale: Locale,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat => {
  const id = `${locale}|${JSON.stringify(options)}`;
  let format = cache.get(id);
  if (format === undefined) {
    format = new Intl.NumberFormat(INTL_TAG[locale], options);
    cache.set(id, format);
  }
  return format;
};

/** Zero is printed unsigned: `-0.00` from the wire never shows as "-0,00". */
const unsignedZero = (s: NumericLiteral): NumericLiteral =>
  /^[-+]?0+(\.0+)?$/.test(s) ? ("0" as NumericLiteral) : s;

export interface NumberOptions {
  readonly minFractionDigits?: number;
  readonly maxFractionDigits?: number;
  /** Thousands grouping; default true. */
  readonly grouping?: boolean;
}

/** Locale number: cs `1 234,5` (NBSP grouping), en `1,234.5`. */
export const formatNumber = (
  locale: Locale,
  value: DecimalInput,
  options: NumberOptions = {},
): string => {
  const min = options.minFractionDigits ?? 0;
  return numberFormat(locale, {
    minimumFractionDigits: min,
    maximumFractionDigits: Math.max(min, options.maxFractionDigits ?? 3),
    useGrouping: options.grouping ?? true,
  }).format(unsignedZero(toDecimalString(value)));
};

/** Quantity with an optional unit: cs `1,5 h`, en `1.5 h`. Up to 4 decimals, no padding. */
export const formatQuantity = (locale: Locale, value: DecimalInput, unit?: string): string => {
  const n = formatNumber(locale, value, { maxFractionDigits: 4 });
  return unit === undefined || unit === "" ? n : `${n} ${unit}`;
};

/** Percentage given in percent units (21 means 21 %): cs `21 %`, en `21%`. */
export const formatPercent = (
  locale: Locale,
  percent: DecimalInput,
  options: { readonly maxFractionDigits?: number } = {},
): string => {
  const n = formatNumber(locale, percent, {
    maxFractionDigits: options.maxFractionDigits ?? 2,
    grouping: false,
  });
  return locale === "cs" ? `${n} %` : `${n}%`;
};

/** VAT rate label: cs `21 %`, en `21%`. Zero-rated treatments pass 0. */
export const formatVatRate = (locale: Locale, ratePercent: number): string =>
  formatPercent(locale, ratePercent);
