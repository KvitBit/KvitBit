import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { INTL_TAG, type Locale } from "../i18n/locale";
import { stringifyJson } from "../json";

const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

/** Business time zone: dates on documents are Europe/Prague calendar dates. */
export const BUSINESS_TIME_ZONE = "Europe/Prague";

export interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

/** Parses `YYYY-MM-DD`; impossible days (2026-02-30) give undefined. */
export const parseIsoDate = (iso: string): CalendarDate | undefined => {
  const m = ISO_CALENDAR_DATE.exec(iso);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const actual = DateTime.toPartsUtc(toUtc({ year, month, day }));
  if (actual.year !== year || actual.month !== month || actual.day !== day) {
    return undefined;
  }
  return { year, month, day };
};

const toUtc = (date: CalendarDate): DateTime.Utc =>
  DateTime.makeUnsafe(Date.UTC(2000, date.month - 1, date.day)).pipe(
    DateTime.setPartsUtc({ year: date.year }),
  );

const asDate = (value: string | CalendarDate): CalendarDate => {
  if (!Predicate.isString(value)) return value;
  return Option.getOrThrowWith(
    Option.fromUndefinedOr(parseIsoDate(value)),
    () => new RangeError(`Not an ISO calendar date: ${value}`),
  );
};

const cache = new Map<string, Intl.DateTimeFormat>();
const dateFormat = (locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const id = `${locale}|${stringifyJson(options)}`;
  let format = cache.get(id);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(INTL_TAG[locale], options);
    cache.set(id, format);
  }
  return format;
};

/**
 * - `default`: cs `23. 11. 2026`, en `23 Nov 2026` (unambiguous for foreign readers)
 * - `numeric`: cs `23. 11. 2026`, en `23/11/2026`
 * - `long`: cs `23. listopadu 2026`, en `23 November 2026`
 */
export type DateStyle = "default" | "numeric" | "long";

const optionsFor = (locale: Locale, style: DateStyle): Intl.DateTimeFormatOptions => {
  const month =
    style === "long" ? "long" : style === "numeric" || locale === "cs" ? "numeric" : "short";
  return { day: "numeric", month, year: "numeric", timeZone: "UTC" };
};

/** Formats a calendar date (no time-zone shift: the date is the date). */
export const formatDate = ({
  locale,
  date,
  style = "default",
}: {
  readonly locale: Locale;
  readonly date: string | CalendarDate;
  readonly style?: DateStyle;
}): string =>
  dateFormat(locale, optionsFor(locale, style)).format(DateTime.toEpochMillis(toUtc(asDate(date))));

/** Formats an instant (ISO timestamp or Date) in Europe/Prague: cs `23. 11. 2026 14:05`. */
export const formatDateTime = ({
  locale,
  instant,
  timeZone = BUSINESS_TIME_ZONE,
}: {
  readonly locale: Locale;
  readonly instant: string | Date;
  readonly timeZone?: string;
}): string => {
  // Date.parse interprets offsetless timestamps in the device's time zone.
  const parsed = Predicate.isString(instant) ? Date.parse(instant) : instant.getTime();
  const dateValue = Option.getOrThrowWith(
    DateTime.make(parsed),
    () => new RangeError(`Not a timestamp: ${String(instant)}`),
  );
  const millis = DateTime.toEpochMillis(dateValue);
  const date = dateFormat(locale, { ...optionsFor(locale, "default"), timeZone }).format(millis);
  const time = dateFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(millis);
  return locale === "cs" ? `${date} ${time}` : `${date}, ${time}`;
};

/** Month label for report buckets (`YYYY-MM` or a date): cs `listopad 2026`, en `November 2026`. */
export const formatMonth: {
  (month: string | CalendarDate): (locale: Locale) => string;
  (locale: Locale, month: string | CalendarDate): string;
} = Fn.dual(2, (locale: Locale, month: string | CalendarDate): string => {
  const date = Predicate.isString(month) && ISO_MONTH.test(month) ? `${month}-01` : month;
  return dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    DateTime.toEpochMillis(toUtc(asDate(date))),
  );
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
];

/**
 * Compact inclusive range, built by hand so web and Hermes agree (no `formatRange`):
 * cs `1.–23. 11. 2026`, `1. 10. – 23. 11. 2026`, `1. 12. 2025 – 23. 1. 2026`;
 * en `1–23 Nov 2026`, `1 Oct – 23 Nov 2026`, `1 Dec 2025 – 23 Jan 2026`.
 * A single-day range prints one date.
 */
export const formatDateRange: {
  (from: string | CalendarDate, to: string | CalendarDate): (locale: Locale) => string;
  (locale: Locale, from: string | CalendarDate, to: string | CalendarDate): string;
} = Fn.dual(3, (locale: Locale, from: string | CalendarDate, to: string | CalendarDate): string => {
  const a = asDate(from);
  const b = asDate(to);
  if (a.year === b.year && a.month === b.month && a.day === b.day)
    return formatDate({ locale, date: a });
  const sameYear = a.year === b.year;
  const sameMonth = sameYear && a.month === b.month;
  if (locale === "cs") {
    if (sameMonth) return `${a.day}.–${b.day}. ${b.month}. ${b.year}`;
    if (sameYear) return `${a.day}. ${a.month}. – ${b.day}. ${b.month}. ${b.year}`;
    return `${formatDate({ locale, date: a })} – ${formatDate({ locale, date: b })}`;
  }
  const ma = EN_MONTHS[a.month - 1] ?? "";
  const mb = EN_MONTHS[b.month - 1] ?? "";
  if (sameMonth) return `${a.day}–${b.day} ${mb} ${b.year}`;
  if (sameYear) return `${a.day} ${ma} – ${b.day} ${mb} ${b.year}`;
  return `${a.day} ${ma} ${a.year} – ${b.day} ${mb} ${b.year}`;
});
