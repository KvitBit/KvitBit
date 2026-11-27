import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { INTL_TAG, type Locale } from "../i18n/locale";
import { stringifyJson } from "../json";

const LEADING_ZEROES = /^0+(?=\d)/;
const TRAILING_ZEROES = /0+$/;
const ZERO_DIGITS = /^0*$/;

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
const parseDecimal = (input: string): Result.Result<Decimal, RangeError> => {
  const m = DECIMAL.exec(Str.trim(input));
  if (m === null) return Result.fail(new RangeError(`Not a decimal: ${input}`));
  const digits = (m[2] ?? "") + (m[3] ?? "");
  const point = (m[2] ?? "").length + Number(m[4] ?? "0");
  const padded =
    point <= 0
      ? Fn.pipe("0", Str.repeat(1 - point)) + digits
      : Fn.pipe(digits, Str.padEnd(point, "0"));
  const at = point <= 0 ? 1 : point;
  const integer = Fn.pipe(padded, Str.slice(0, at), Str.replace(LEADING_ZEROES, ""));
  const fraction = Fn.pipe(padded, Str.slice(at), Str.replace(TRAILING_ZEROES, ""));
  const zero = ZERO_DIGITS.test(integer + fraction);
  return Result.succeed({ negative: m[1] === "-" && !zero, integer, fraction });
};

const decimalResult = (value: DecimalInput): Result.Result<Decimal, RangeError> => {
  if (Predicate.isNumber(value) && !Number.isFinite(value)) {
    return Result.fail(new RangeError(`Not a finite number: ${value}`));
  }
  return parseDecimal(BigDecimal.isBigDecimal(value) ? BigDecimal.format(value) : String(value));
};

const toDecimal = Fn.flow(decimalResult, Result.getOrThrow);

/** Plain decimal string with no exponent or trailing zeroes. */
export const toDecimalString = (value: DecimalInput): string => {
  const decimal = toDecimal(value);
  const fraction = decimal.fraction === "" ? "" : `.${decimal.fraction}`;
  return `${decimal.negative ? "-" : ""}${decimal.integer}${fraction}`;
};

export type Sign = "positive" | "negative" | "zero";

export const signOf = (value: DecimalInput): Sign => {
  const d = toDecimal(value);
  if (ZERO_DIGITS.test(d.integer + d.fraction)) return "zero";
  return d.negative ? "negative" : "positive";
};

/** Rounds half away from zero (Intl's default `halfExpand`) to `max` digits, pads to `min`. */
const roundTo = (d: Decimal, min: number, max: number): Decimal => {
  let integer = d.integer;
  let fraction = d.fraction;
  if (fraction.length > max) {
    const up = Number(fraction[max]) >= 5;
    fraction = Fn.pipe(fraction, Str.slice(0, max));
    if (up) {
      const all = Fn.pipe(
        (BigInt(integer + fraction) + 1n).toString(),
        Str.padStart(integer.length + max, "0"),
      );
      integer = Fn.pipe(all, Str.slice(0, all.length - max)) || "0";
      fraction = Fn.pipe(all, Str.slice(all.length - max));
    }
  }
  fraction = Fn.pipe(fraction, Str.replace(TRAILING_ZEROES, ""), Str.padEnd(min, "0"));
  const zero = ZERO_DIGITS.test(integer + fraction);
  return { negative: d.negative && !zero, integer, fraction };
};

/** The value as displayed with `min`..`max` fraction digits, as a plain decimal string. */
export const roundedDecimal: {
  (min: number, max: number): (value: DecimalInput) => string;
  (value: DecimalInput, min: number, max: number): string;
} = Fn.dual(3, (value: DecimalInput, min: number, max: number): string => {
  const d = roundTo(toDecimal(value), min, Math.max(min, max));
  return `${d.negative ? "-" : ""}${d.integer}${d.fraction === "" ? "" : `.${d.fraction}`}`;
});

const cache = new Map<string, Intl.NumberFormat>();

/** Memoised `Intl.NumberFormat` (formatters are costly to build on Hermes). */
const numberFormat: {
  (options: Intl.NumberFormatOptions): (locale: Locale) => Intl.NumberFormat;
  (locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat;
} = Fn.dual(2, (locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const id = `${locale}|${stringifyJson(options)}`;
  let format = cache.get(id);
  if (format === undefined) {
    format = new Intl.NumberFormat(INTL_TAG[locale], options);
    cache.set(id, format);
  }
  return format;
});

const groupDigits = (integer: string, separator: string, minGroupDigits: number): string =>
  integer.length < 3 + minGroupDigits
    ? integer
    : Fn.pipe(integer, Str.replace(/\B(?=(\d{3})+(?!\d))/g, separator));

/**
 * Exact locale formatting. `Intl` supplies only the layout (separators, currency symbol, sign
 * position) via `formatToParts` on a sample number; the digits come from the decimal string.
 * Intl string input is not exact on every engine (Hermes coerces to double), so this never
 * passes the value itself to Intl.
 */
export const formatExact: {
  (
    value: DecimalInput,
    options: Intl.NumberFormatOptions & { readonly minGroupDigits?: number },
  ): (locale: Locale) => string;
  (
    locale: Locale,
    value: DecimalInput,
    options: Intl.NumberFormatOptions & { readonly minGroupDigits?: number },
  ): string;
} = Fn.dual(
  3,
  (
    locale: Locale,
    value: DecimalInput,
    options: Intl.NumberFormatOptions & { readonly minGroupDigits?: number },
  ): string => {
    const { minGroupDigits = 1, ...intl } = options;
    const min = intl.minimumFractionDigits ?? 0;
    const max = Math.max(min, intl.maximumFractionDigits ?? 3);
    const d = roundTo(toDecimal(value), min, max);
    const zero = ZERO_DIGITS.test(d.integer + d.fraction);
    // A value that rounds to zero is shown unsigned, whatever signDisplay asked for.
    const signDisplay = zero && intl.signDisplay !== "never" ? "auto" : intl.signDisplay;
    const format = numberFormat(locale, {
      ...intl,
      signDisplay,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const sample = format.formatToParts(d.negative ? -1234567.5 : zero ? 0.5 : 1234567.5);
    const group =
      Option.getOrUndefined(Arr.findFirst(sample, (p) => p.type === "group"))?.value ?? "";
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
  },
);

export interface NumberOptions {
  readonly minFractionDigits?: number;
  readonly maxFractionDigits?: number;
  /** Thousands grouping; default true. */
  readonly grouping?: boolean;
}

/** Locale number: cs `1 234,5` (NBSP grouping), en `1,234.5`. Exact for any decimal input. */
// A decimal input is a string and can overlap the locale at the call boundary.
// @effect-diagnostics-next-line missingPipeableSignature:off The data-first API accepts any decimal text and has an optional options argument.
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
// The value and optional unit accept strings, which overlap the locale.
// @effect-diagnostics-next-line missingPipeableSignature:off The value and optional unit can both be strings, overlapping the locale argument.
export const formatQuantity = (locale: Locale, value: DecimalInput, unit?: string): string => {
  const n = formatNumber(locale, value, { maxFractionDigits: 4 });
  return unit === undefined || unit === "" ? n : `${n} ${unit}`;
};

/** Percentage given in percent units (21 means 21 %): cs `21 %`, en `21%`. */
export const formatPercent: {
  (
    percent: DecimalInput,
    options?: { readonly maxFractionDigits?: number },
  ): (locale: Locale) => string;
  (
    locale: Locale,
    percent: DecimalInput,
    options?: { readonly maxFractionDigits?: number },
  ): string;
} = Fn.dual(
  (args) => args.length > 1 && (args[0] === "cs" || args[0] === "en"),
  (
    locale: Locale,
    percent: DecimalInput,
    options: { readonly maxFractionDigits?: number } = {},
  ): string => {
    const n = formatNumber(locale, percent, {
      maxFractionDigits: options.maxFractionDigits ?? 2,
      grouping: false,
    });
    return locale === "cs" ? `${n} %` : `${n}%`;
  },
);

/** VAT rate label: cs `21 %`, en `21%`. Zero-rated treatments pass 0. */
export const formatVatRate: {
  (ratePercent: number): (locale: Locale) => string;
  (locale: Locale, ratePercent: number): string;
} = Fn.dual(2, (locale: Locale, ratePercent: number): string => formatPercent(locale, ratePercent));
