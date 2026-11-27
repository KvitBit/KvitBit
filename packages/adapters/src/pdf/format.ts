/**
 * Display formatting for the PDF templates: cs/en money, dates, quantities and rates. The
 * email templates keep their own helpers (no cross-imports between the two streams).
 */

import type { CurrencyCode, IsoDate, Locale } from "@kvitbit/domain";
import { MoneyMath } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

const TRAILING_ZEROES = /0+$/;

const NBSP = " ";
const MINUS = "−";
const THOUSANDS_SEPARATOR = /\B(?=(\d{3})+(?!\d))/g;

export const escapeHtml = (text: string): string =>
  Fn.pipe(
    text,
    Str.replaceAll("&", "&amp;"),
    Str.replaceAll("<", "&lt;"),
    Str.replaceAll(">", "&gt;"),
    Str.replaceAll('"', "&quot;"),
    Str.replaceAll("'", "&#39;"),
  );

const separators = (lang: Locale) =>
  lang === "cs" ? { group: NBSP, decimal: "," } : { group: ",", decimal: "." };

/**
 * Fixed-scale decimal (half away from zero) with locale separators and a typographic minus.
 * `trim` drops trailing zeros (quantities).
 */
const formatDecimal = (
  value: BigDecimal.BigDecimal,
  scale: number,
  lang: Locale,
  trim = false,
): string => {
  const rounded = BigDecimal.scale(
    BigDecimal.round(value, { scale, mode: "half-from-zero" }),
    scale,
  );
  const negative = rounded.value < 0n;
  const digits = Str.padStart(
    scale + 1,
    "0",
  )((negative ? -rounded.value : rounded.value).toString());
  const int = Str.slice(0, digits.length - scale)(digits);
  let frac = Str.slice(digits.length - scale)(digits);
  if (trim) frac = Str.replace(TRAILING_ZEROES, "")(frac);
  const { group, decimal } = separators(lang);
  const grouped = Str.replace(THOUSANDS_SEPARATOR, group)(int);
  return `${negative ? MINUS : ""}${grouped}${frac === "" ? "" : decimal + frac}`;
};

const CS_SYMBOLS: Readonly<Record<string, string>> = { CZK: "Kč", EUR: "€" };

/** "48 500,00 Kč" / "48,500.00 CZK", at the currency's minor unit. */
export const formatMoney: {
  (currency: CurrencyCode, lang: Locale): (amount: BigDecimal.BigDecimal) => string;
  (amount: BigDecimal.BigDecimal, currency: CurrencyCode, lang: Locale): string;
} = Fn.dual(3, (amount: BigDecimal.BigDecimal, currency: CurrencyCode, lang: Locale): string => {
  const number = formatDecimal(amount, MoneyMath.minorUnitScale(currency), lang);
  const unit = lang === "cs" ? (CS_SYMBOLS[currency] ?? currency) : currency;
  return `${number}${NBSP}${unit}`;
});

export const formatQuantity: {
  (lang: Locale): (q: BigDecimal.BigDecimal) => string;
  (q: BigDecimal.BigDecimal, lang: Locale): string;
} = Fn.dual(2, (q: BigDecimal.BigDecimal, lang: Locale): string => formatDecimal(q, 6, lang, true));

/** "21 %" / "21%". */
export const formatPercent: {
  (lang: Locale): (p: BigDecimal.BigDecimal) => string;
  (p: BigDecimal.BigDecimal, lang: Locale): string;
} = Fn.dual(2, (p: BigDecimal.BigDecimal, lang: Locale): string => {
  const n = formatDecimal(p, 2, lang, true);
  return lang === "cs" ? `${n}${NBSP}%` : `${n}%`;
});

/** Exchange rates print exactly as used, padded to the CNB's three decimals. */
export const formatRate: {
  (lang: Locale): (rate: BigDecimal.BigDecimal) => string;
  (rate: BigDecimal.BigDecimal, lang: Locale): string;
} = Fn.dual(2, (rate: BigDecimal.BigDecimal, lang: Locale): string =>
  // At least the CNB's three decimals, never fewer than the rate actually carries.
  formatDecimal(rate, Math.max(3, BigDecimal.normalize(rate).scale), lang),
);

const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const formatDateParts = (
  y: string | undefined,
  m: string | undefined,
  d: string | undefined,
  lang: Locale,
): string => {
  if (lang === "cs") return `${d}.${NBSP}${m}.${NBSP}${y}`;
  return `${d} ${EN_MONTHS[Number(m) - 1] ?? m} ${y}`;
};

/** "02. 11. 2026" / "02 Nov 2026". */
export const formatDate: {
  (lang: Locale): (date: IsoDate) => string;
  (date: IsoDate, lang: Locale): string;
} = Fn.dual(2, (date: IsoDate, lang: Locale): string => {
  const [y, m, d] = Str.split(date, "-");
  return formatDateParts(y, m, d, lang);
});

/** An ISO instant as a Europe/Prague wall-clock date and time. */
export const formatDateTime: {
  (lang: Locale): (iso: string) => string;
  (iso: string, lang: Locale): string;
} = Fn.dual(2, (iso: string, lang: Locale): string => {
  const date = DateTime.make(iso);
  if (Option.isNone(date)) return iso;
  const parts = Rec.fromEntries(
    Arr.map(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Prague",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }).formatToParts(DateTime.toDateUtc(date.value)),
      (p) => [p.type, p.value],
    ),
  );
  const day = formatDateParts(parts["year"], parts["month"], parts["day"], lang);
  return Str.trimEnd(`${day} ${parts["hour"]}:${parts["minute"]} ${parts["timeZoneName"] ?? ""}`);
});

/** "CZ65 2010 0000 0021 0148 2910". */
export const groupIban = (iban: string): string =>
  Fn.pipe(iban, Str.replace(/\s+/g, ""), Str.toUpperCase, Str.replace(/(.{4})(?=.)/g, "$1 "));
