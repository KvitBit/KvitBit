/**
 * Calendar arithmetic on `IsoDate` (a Europe/Prague calendar date, core-ports section 1).
 * Dates are plain proleptic-Gregorian days: adding days or months never touches a clock, so
 * DST cannot shift a date. Only `pragueDate` and `pragueStartOfDay` cross between instants
 * and dates.
 */
import type { IsoDate } from "@kvitbit/domain/contract";

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDay {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/**
 * UTC milliseconds of a calendar day. `Date.UTC` maps years 0-99 to 1900-1999, so the year is
 * set with `setUTCFullYear`, which takes it literally.
 */
const utcMillis = (year: number, month: number, day: number, hour = 0): number => {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, 0, 0, 0);
  return d.getTime();
};

export const daysInMonth = (year: number, month: number): number =>
  new Date(utcMillis(year, month + 1, 0)).getUTCDate();

/** The last date an `IsoDate` (four-digit year) can hold. */
export const MAX_ISO_DATE = "9999-12-31" as IsoDate;

/** Splits a date; an impossible date (2026-02-30) or a malformed string is a defect. */
export const parseIsoDate = (date: string): CalendarDay => {
  const match = ISO_DATE.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`not a calendar date: "${date}"`);
  }
  return { year, month, day };
};

/** True for a well-formed, existing calendar date. */
export const isCalendarDate = (date: string): boolean => {
  try {
    parseIsoDate(date);
    return true;
  } catch {
    return false;
  }
};

export const formatIsoDate = ({ year, month, day }: CalendarDay): IsoDate =>
  `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as IsoDate;

/** Day number since 1970-01-01. */
export const toEpochDay = (date: IsoDate): number => {
  const { year, month, day } = parseIsoDate(date);
  return utcMillis(year, month, day) / DAY_MS;
};

export const fromEpochDay = (epochDay: number): IsoDate => {
  const d = new Date(epochDay * DAY_MS);
  return formatIsoDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
};

/** Whether a computed date still fits `IsoDate` (years 0000-9999). */
export const isInIsoRange = (date: string): boolean => /^\d{4}-/.test(date) && date.length === 10;

export const addDays = (date: IsoDate, days: number): IsoDate =>
  fromEpochDay(toEpochDay(date) + days);

/** Adds calendar months; a day past the end of the target month clamps to its last day. */
export const addMonths = (date: IsoDate, months: number): IsoDate => {
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return formatIsoDate({ year: y, month: m, day: Math.min(day, daysInMonth(y, m)) });
};

/** Signed whole days from `from` to `to`. */
export const daysBetween = (from: IsoDate, to: IsoDate): number =>
  toEpochDay(to) - toEpochDay(from);

/** -1, 0 or 1. Valid `IsoDate`s order as strings. */
export const compareDates = (a: IsoDate, b: IsoDate): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

const pragueParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  era: "short",
});

const pragueFields = (epochMillis: number) => {
  const parts: Record<string, number> = {};
  let beforeCommonEra = false;
  for (const p of pragueParts.formatToParts(new Date(epochMillis))) {
    if (p.type === "era") beforeCommonEra = p.value !== "AD";
    else if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  // The formatter gives a year of era (1 BC, 2 BC, ...); ISO years count 0, -1, ...
  if (beforeCommonEra && parts.year !== undefined) parts.year = 1 - parts.year;
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
};

/** The Prague calendar date at an instant (e.g. `Clock.currentTimeMillis`). */
export const pragueDate = (epochMillis: number): IsoDate => {
  const f = pragueFields(epochMillis);
  return formatIsoDate({ year: f.year, month: f.month, day: f.day });
};

/** Prague's UTC offset in milliseconds at an instant (a whole second; LMT +0:57:44 before 1891). */
const pragueOffset = (epochMillis: number): number => {
  const at = Math.floor(epochMillis / 1000) * 1000;
  const f = pragueFields(at);
  return utcMillis(f.year, f.month, f.day, f.hour) + f.minute * 60_000 + f.second * 1000 - at;
};

/**
 * The instant of `hour`:00 Prague time on `date` (default midnight), for any offset the zone
 * has had (CET, CEST, local mean time). A wall time skipped by a spring-forward resolves to the
 * first instant after the gap (02:00 -> 03:00 CEST); a repeated one (fall-back) to one of
 * its two instants.
 */
export const pragueStartOfDay = (date: IsoDate, hour = 0): number => {
  const { year, month, day } = parseIsoDate(date);
  const wall = utcMillis(year, month, day, hour);
  const early = wall - pragueOffset(wall);
  const late = wall - pragueOffset(early);
  const matches = [early, late].filter((c) => c + pragueOffset(c) === wall);
  return matches.length > 0 ? Math.min(...matches) : Math.max(early, late);
};
