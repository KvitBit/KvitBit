/**
 * Display formatting for the PDF templates: cs/en money, dates, quantities and rates. The
 * email templates keep their own helpers (no cross-imports between the two streams).
 */
import type { CurrencyCode, IsoDate, Locale } from "@kvitbit/domain";
import { MoneyMath } from "@kvitbit/domain";
import { BigDecimal } from "effect";

const NBSP = " ";
const MINUS = "−";

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const separators = (lang: Locale) =>
  lang === "cs" ? { group: NBSP, decimal: "," } : { group: ",", decimal: "." };

/**
 * Fixed-scale decimal (half away from zero) with locale separators and a typographic minus.
 * `trim` drops trailing zeros (quantities).
 */
export const formatDecimal = (
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
  const digits = (negative ? -rounded.value : rounded.value).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale);
  if (trim) frac = frac.replace(/0+$/, "");
  const { group, decimal } = separators(lang);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${negative ? MINUS : ""}${grouped}${frac === "" ? "" : decimal + frac}`;
};

const CS_SYMBOLS: Readonly<Record<string, string>> = { CZK: "Kč", EUR: "€" };

/** "48 500,00 Kč" / "48,500.00 CZK", at the currency's minor unit. */
export const formatMoney = (
  amount: BigDecimal.BigDecimal,
  currency: CurrencyCode,
  lang: Locale,
): string => {
  const number = formatDecimal(amount, MoneyMath.minorUnitScale(currency), lang);
  const unit = lang === "cs" ? (CS_SYMBOLS[currency] ?? currency) : currency;
  return `${number}${NBSP}${unit}`;
};

export const formatQuantity = (q: BigDecimal.BigDecimal, lang: Locale): string =>
  formatDecimal(q, 6, lang, true);

/** "21 %" / "21%". */
export const formatPercent = (p: BigDecimal.BigDecimal, lang: Locale): string => {
  const n = formatDecimal(p, 2, lang, true);
  return lang === "cs" ? `${n}${NBSP}%` : `${n}%`;
};

/** Exchange rates print exactly as used, padded to the CNB's three decimals. */
export const formatRate = (rate: BigDecimal.BigDecimal, lang: Locale): string =>
  // At least the CNB's three decimals, never fewer than the rate actually carries.
  formatDecimal(rate, Math.max(3, BigDecimal.normalize(rate).scale), lang);

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

/** "02. 11. 2026" / "02 Nov 2026". */
export const formatDate = (date: IsoDate, lang: Locale): string => {
  const [y, m, d] = date.split("-");
  if (lang === "cs") return `${d}.${NBSP}${m}.${NBSP}${y}`;
  return `${d} ${EN_MONTHS[Number(m) - 1] ?? m} ${y}`;
};

/** An ISO instant as a Europe/Prague wall-clock date and time. */
export const formatDateTime = (iso: string, lang: Locale): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const day = formatDate(`${parts.year}-${parts.month}-${parts.day}` as IsoDate, lang);
  return `${day} ${parts.hour}:${parts.minute} ${parts.timeZoneName ?? ""}`.trimEnd();
};

/** "CZ65 2010 0000 0021 0148 2910". */
export const groupIban = (iban: string): string =>
  iban
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, "$1 ");
