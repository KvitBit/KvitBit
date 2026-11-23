import { BigDecimal } from "effect";
import { INTL_TAG, type Locale } from "../i18n/locale";

/** A decimal value as the server sends it (string), a BigDecimal, or a JS number. */
export type DecimalInput = BigDecimal.BigDecimal | string | number | bigint;

/** An exact decimal split into parts: sign, integer digits (no leading zeros), fraction digits. */
interface Decimal {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

const DECIMAL = /^([-+]?)(\d+)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/;

/** Parses plain or exponent notation (`1.5e3`, `1e-7`) exactly, without going through floats. */
const parseDecimal = (input: string): Decimal => {
  const m = DECIMAL.exec(input.trim());
  if (m === null) throw new RangeError(`Not a decimal: ${input}`);
  const digits = (m[2] ?? "") + (m[3] ?? "");
  const point = (m[2] ?? "").length + Number(m[4] ?? "0");
  const padded = point <= 0 ? "0".repeat(1 - point) + digits : digits.padEnd(point, "0");
  const at = point <= 0 ? 1 : point;
  const integer = padded.slice(0, at).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(at).replace(/0+$/, "");
  const zero = /^0*$/.test(integer + fraction);
  return { negative: m[1] === "-" && !zero, integer, fraction };
};

const toDecimal = (value: DecimalInput): Decimal => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
    return parseDecimal(String(value));
  }
  if (typeof value === "bigint") return parseDecimal(value.toString());
  if (typeof value === "string") return parseDecimal(value);
  return parseDecimal(BigDecimal.format(value));
};

/** Plain decimal string (no exponent, no trailing zeros); `-0` becomes `0`. */
export const toDecimalString = (value: DecimalInput): string => {
  const d = toDecimal(value);
  return `${d.negative ? "-" : ""}${d.integer}${d.fraction === "" ? "" : `.${d.fraction}`}`;
};

export type Sign = "positive" | "negative" | "zero";

export const signOf = (value: DecimalInput): Sign => {
  const d = toDecimal(value);
  if (/^0*$/.test(d.integer + d.fraction)) return "zero";
  return d.negative ? "negative" : "positive";
};

/** Rounds half away from zero (Intl's default `halfExpand`) to `max` digits, pads to `min`. */
const roundTo = (d: Decimal, min: number, max: number): Decimal => {
  let integer = d.integer;
  let fraction = d.fraction;
  if (fraction.length > max) {
    const up = Number(fraction[max]) >= 5;
    fraction = fraction.slice(0, max);
    if (up) {
      const all = (BigInt(integer + fraction) + 1n).toString().padStart(integer.length + max, "0");
      integer = all.slice(0, all.length - max) || "0";
      fraction = all.slice(all.length - max);
    }
  }
  fraction = fraction.replace(/0+$/, "").padEnd(min, "0");
  const zero = /^0*$/.test(integer + fraction);
  return { negative: d.negative && !zero, integer, fraction };
};

/** The value as displayed with `min`..`max` fraction digits, as a plain decimal string. */
export const roundedDecimal = (value: DecimalInput, min: number, max: number): string => {
  const d = roundTo(toDecimal(value), min, Math.max(min, max));
  return `${d.negative ? "-" : ""}${d.integer}${d.fraction === "" ? "" : `.${d.fraction}`}`;
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

const groupDigits = (integer: string, separator: string, minGroupDigits: number): string =>
  integer.length < 3 + minGroupDigits
    ? integer
    : integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

/**
 * Exact locale formatting. `Intl` supplies only the layout (separators, currency symbol, sign
 * position) via `formatToParts` on a sample number; the digits come from the decimal string.
 * Intl string input is not exact on every engine (Hermes coerces to double), so this never
 * passes the value itself to Intl.
 */
export const formatExact = (
  locale: Locale,
  value: DecimalInput,
  options: Intl.NumberFormatOptions & { readonly minGroupDigits?: number },
): string => {
  const { minGroupDigits = 1, ...intl } = options;
  const min = intl.minimumFractionDigits ?? 0;
  const max = Math.max(min, intl.maximumFractionDigits ?? 3);
  const d = roundTo(toDecimal(value), min, max);
  const zero = /^0*$/.test(d.integer + d.fraction);
  // A value that rounds to zero is shown unsigned, whatever signDisplay asked for.
  const signDisplay = zero && intl.signDisplay !== "never" ? "auto" : intl.signDisplay;
  const format = numberFormat(locale, {
    ...intl,
    ...(signDisplay === undefined ? {} : { signDisplay }),
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const sample = format.formatToParts(d.negative ? -1234567.5 : zero ? 0.5 : 1234567.5);
  const group = sample.find((p) => p.type === "group")?.value ?? "";
  let out = "";
  let integerDone = false;
  for (const part of sample) {
    if (part.type === "integer") {
      if (!integerDone)
        out += groupDigits(d.integer, intl.useGrouping === false ? "" : group, minGroupDigits);
      integerDone = true;
    } else if (part.type === "group") {
      // emitted with the integer digits
    } else if (part.type === "decimal") {
      if (d.fraction !== "") out += part.value;
    } else if (part.type === "fraction") {
      out += d.fraction;
    } else {
      out += part.value;
    }
  }
  return out;
};

export interface NumberOptions {
  readonly minFractionDigits?: number;
  readonly maxFractionDigits?: number;
  /** Thousands grouping; default true. */
  readonly grouping?: boolean;
}

/** Locale number: cs `1 234,5` (NBSP grouping), en `1,234.5`. Exact for any decimal input. */
export const formatNumber = (
  locale: Locale,
  value: DecimalInput,
  options: NumberOptions = {},
): string =>
  formatExact(locale, value, {
    minimumFractionDigits: options.minFractionDigits ?? 0,
    maximumFractionDigits: options.maxFractionDigits ?? 3,
    useGrouping: options.grouping ?? true,
  });

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
