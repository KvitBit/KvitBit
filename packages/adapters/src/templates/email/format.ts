/**
 * Locale formatting for email copy (cs, en). Local to the email templates; the PDF stream keeps
 * its own helpers.
 *
 * Non-breaking spaces: every formatter here returns U+00A0 (NBSP) wherever a line must not
 * break: between digit groups and before the currency in cs amounts ("58 100,00 Kč"), between
 * the code and the number in en amounts ("CZK 58,100.00"), between date parts ("16. 11. 2026",
 * "16 Nov 2026"), and between a count and its unit ("24 hodin", "64 KB"). The plain-text part
 * keeps U+00A0 as is; the HTML part writes it as `&nbsp;` (see `escapeHtml`).
 */
import { type IsoDate, type Locale, type Money, MoneyMath } from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

export const NBSP = " ";

/** Currency signs used after cs amounts. Other currencies print their ISO code. */
const CS_CURRENCY_SIGNS: Readonly<Record<string, string>> = { CZK: "Kč", EUR: "€" };

const groupDigits = (digits: string, separator: string): string =>
  Str.replace(/\B(?=(\d{3})+(?!\d))/g, separator)(digits);

/**
 * Rounds half away from zero to the currency's minor unit, then formats without floating point.
 * cs: "58 100,00 Kč", "1 234,50 €", "-12,00 Kč". en: "CZK 58,100.00", "-EUR 12.00".
 */
export const formatMoney: {
  (locale: Locale): (money: Money) => string;
  (money: Money, locale: Locale): string;
} = Fn.dual(2, (money: Money, locale: Locale): string => {
  const scale = MoneyMath.minorUnitScale(money.currency);
  const units = MoneyMath.toMinorUnits(money);
  const negative = units < 0n;
  const digits = Str.padStart(scale + 1, "0")((negative ? -units : units).toString());
  const fractionStart = digits.length - scale;
  const whole = Str.slice(0, fractionStart)(digits);
  const fraction = Str.slice(fractionStart)(digits);
  const sign = negative ? "-" : "";
  if (locale === "cs") {
    const number = groupDigits(whole, NBSP) + (scale > 0 ? `,${fraction}` : "");
    return `${sign}${number}${NBSP}${CS_CURRENCY_SIGNS[money.currency] ?? money.currency}`;
  }
  const number = groupDigits(whole, ",") + (scale > 0 ? `.${fraction}` : "");
  return `${sign}${money.currency}${NBSP}${number}`;
});

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
] as const;

/** Calendar date without zero padding. cs: "16. 11. 2026"; en: "16 Nov 2026". */
export const formatDate: {
  (locale: Locale): (date: IsoDate) => string;
  (date: IsoDate, locale: Locale): string;
} = Fn.dual(2, (date: IsoDate, locale: Locale): string => {
  const [year, month = "", day = ""] = Str.split(date, "-");
  const d = Number(day);
  const m = Number(month);
  return locale === "cs"
    ? `${d}.${NBSP}${m}.${NBSP}${year}`
    : `${d}${NBSP}${EN_MONTHS[m - 1] ?? month}${NBSP}${year}`;
});

/** Czech plural form for a count: 1, 2-4, everything else (including 0 and 11-14). */
const csPlural = (n: number, one: string, few: string, many: string): string =>
  n === 1 ? one : n >= 2 && n <= 4 ? few : many;

const enPlural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * A validity period in the accusative ("Odkaz platí 24 hodin", "platí 1 hodinu"); en "24 hours".
 * Whole days and whole hours use the larger unit.
 */
export const formatDuration: {
  (locale: Locale): (minutes: number) => string;
  (minutes: number, locale: Locale): string;
} = Fn.dual(2, (minutes: number, locale: Locale): string => {
  if (minutes > 0 && minutes % 1440 === 0) {
    const n = minutes / 1440;
    return `${n}${NBSP}${locale === "cs" ? csPlural(n, "den", "dny", "dní") : enPlural(n, "day", "days")}`;
  }
  if (minutes > 0 && minutes % 60 === 0) {
    const n = minutes / 60;
    return `${n}${NBSP}${locale === "cs" ? csPlural(n, "hodinu", "hodiny", "hodin") : enPlural(n, "hour", "hours")}`;
  }
  return `${minutes}${NBSP}${locale === "cs" ? csPlural(minutes, "minutu", "minuty", "minut") : enPlural(minutes, "minute", "minutes")}`;
});

/** Days in a count phrase: cs "1 den", "3 dny", "10 dní"; en "1 day", "10 days". */
export const formatDays =
  (locale: Locale) =>
  (days: number): string =>
    `${days}${NBSP}${locale === "cs" ? csPlural(days, "den", "dny", "dní") : enPlural(days, "day", "days")}`;

/** Attachment size in KB (rounded up) below 1 MB, else MB with one decimal. cs "1,5 MB". */
export const formatFileSize: {
  (locale: Locale): (bytes: number) => string;
  (bytes: number, locale: Locale): string;
} = Fn.dual(2, (bytes: number, locale: Locale): string => {
  const kb = Math.max(1, Math.ceil(bytes / 1024));
  if (kb < 1024) return `${kb}${NBSP}KB`;
  const mb = (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
  return `${locale === "cs" ? Str.replace(".", ",")(mb) : mb}${NBSP}MB`;
});
