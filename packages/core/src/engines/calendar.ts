/**
 * Calendar arithmetic on `IsoDate` (a Europe/Prague calendar date, core-ports section 1).
 * Days and months are added on the Gregorian calendar. Prague timezone rules only apply
 * when converting between an instant and a local calendar date.
 */
import { IsoDate } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const DAY_MS = 86_400_000;

export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const utcMillis = (year: number, month: number, day: number, hour = 0): number =>
  DateTime.toEpochMillis(DateTime.makeUnsafe({ year, month, day, hour }));

export const daysInMonth: {
  (month: number): (year: number) => number;
  (year: number, month: number): number;
} = Fn.dual(
  2,
  (year: number, month: number) =>
    DateTime.toPartsUtc(DateTime.makeUnsafe({ year, month: month + 1, day: 0 })).day,
);

export const MAX_ISO_DATE = IsoDate.make("9999-12-31");

/** Splits a validated Gregorian date. */
export const parseIsoDate = (date: string): CalendarDay => {
  const { year, month, day } = DateTime.toPartsUtc(
    DateTime.makeUnsafe(`${IsoDate.make(date)}T00:00:00Z`),
  );
  return { year, month, day };
};

export const isCalendarDate = Schema.is(IsoDate);

export const formatIsoDate = ({ year, month, day }: CalendarDay): IsoDate =>
  IsoDate.make(DateTime.formatIsoDateUtc(DateTime.makeUnsafe({ year, month, day })));

/** Day number since 1970-01-01. */
export const toEpochDay = (date: IsoDate): number =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`${date}T00:00:00Z`)) / DAY_MS;

/** Calendar date for a day number since 1970-01-01. */
export const fromEpochDay = (epochDay: number): IsoDate =>
  IsoDate.make(DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochDay * DAY_MS)));

const atEpochDay = (day: number) => DateTime.make(day * DAY_MS);

export const addDaysWithinRange: {
  (days: number): (date: IsoDate) => IsoDate | null;
  (date: IsoDate, days: number): IsoDate | null;
} = Fn.dual(2, (date: IsoDate, days: number) =>
  atEpochDay(toEpochDay(date) + days).pipe(
    Option.map(DateTime.formatIsoDateUtc),
    Option.filter(isCalendarDate),
    Option.getOrNull,
  ),
);

/** Adds days when the result is known to fit a four-digit ISO year. */
export const addDays: {
  (days: number): (date: IsoDate) => IsoDate;
  (date: IsoDate, days: number): IsoDate;
} = Fn.dual(2, (date: IsoDate, days: number) => fromEpochDay(toEpochDay(date) + days));

const monthsLater = (day: number, index: number): CalendarDay => {
  const targetYear = Math.floor(index / 12);
  const targetMonth = index - targetYear * 12 + 1;
  return {
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  };
};

export const addMonthsWithinRange: {
  (months: number): (date: IsoDate) => IsoDate | null;
  (date: IsoDate, months: number): IsoDate | null;
} = Fn.dual(2, (date: IsoDate, months: number) => {
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + month - 1 + months;
  return index >= 0 && index < 120_000 ? formatIsoDate(monthsLater(day, index)) : null;
});

/** Adds months, clamping the day to the end of the target month. */
export const addMonths: {
  (months: number): (date: IsoDate) => IsoDate;
  (date: IsoDate, months: number): IsoDate;
} = Fn.dual(2, (date: IsoDate, months: number) => {
  const { year, month, day } = parseIsoDate(date);
  return formatIsoDate(monthsLater(day, year * 12 + month - 1 + months));
});

/** Signed whole days from `from` to `to`. */
export const daysBetween: {
  (to: IsoDate): (from: IsoDate) => number;
  (from: IsoDate, to: IsoDate): number;
} = Fn.dual(2, (from: IsoDate, to: IsoDate) => toEpochDay(to) - toEpochDay(from));

/** -1, 0 or 1. Valid ISO dates order as strings. */
export const compareDates: {
  (b: IsoDate): (a: IsoDate) => -1 | 0 | 1;
  (a: IsoDate, b: IsoDate): -1 | 0 | 1;
} = Fn.dual(2, (a: IsoDate, b: IsoDate) => (a < b ? -1 : a > b ? 1 : 0));

const pragueZone = DateTime.zoneMakeNamedUnsafe("Europe/Prague");
const pragueTime = (epochMillis: number) =>
  DateTime.makeZonedUnsafe(epochMillis, { timeZone: pragueZone });

/** The Prague calendar date at an instant (e.g. `Clock.currentTimeMillis`). */
export const pragueDate = (epochMillis: number): IsoDate =>
  pragueTime(epochMillis).pipe(DateTime.toParts, formatIsoDate);

const pragueOffset = (epochMillis: number): number => DateTime.zonedOffset(pragueTime(epochMillis));

/**
 * The instant of `hour`:00 Prague time on `date` (default midnight). A skipped spring hour
 * resolves to the first instant after the gap. A repeated fall hour resolves to its later instant.
 */
export const pragueStartOfDay: {
  (hour?: number): (date: IsoDate) => number;
  (date: IsoDate, hour?: number): number;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (date: IsoDate, hour = 0) => {
    const { year, month, day } = parseIsoDate(date);
    const wall = utcMillis(year, month, day, hour);
    const early = wall - pragueOffset(wall);
    const late = wall - pragueOffset(early);
    const matches = Arr.filter(
      [early, late],
      (candidate) => candidate + pragueOffset(candidate) === wall,
    );
    return matches.length > 0 ? Math.min(...matches) : Math.max(early, late);
  },
);

const FOUR_DIGIT_YEAR = /^\d{4}-/;

/** Whether a computed date still fits a four-digit ISO year. */
export const isInIsoRange = (date: string): boolean =>
  date.length === 10 && FOUR_DIGIT_YEAR.test(date);
