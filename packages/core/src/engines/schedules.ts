/**
 * Schedules (core-ports 5.6) and reminder date math (rule D16).
 *
 * Occurrence k (k = 0, 1, ...) is `startOn + k x every` on the Prague calendar, always computed
 * from `startOn`: a monthly rule from 31 Jan gives 31 Jan, 28 Feb, 31 Mar (day clamped to the
 * month's end, never drifting). Yearly from 29 Feb gives 28 Feb in common years.
 */

import type { IsoDate } from "@kvitbit/domain/contract";
import { Invalid, type ScheduleRule } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  addDays,
  addDaysWithinRange,
  addMonths,
  addMonthsWithinRange,
  daysBetween,
  isCalendarDate,
  parseIsoDate,
  pragueStartOfDay,
} from "./calendar";

export { ScheduleRule } from "@kvitbit/domain/contract";

const stepOf = (rule: ScheduleRule): { unit: "weeks" | "months" | "years"; n: number } =>
  "weeks" in rule.every
    ? { unit: "weeks", n: rule.every.weeks }
    : "months" in rule.every
      ? { unit: "months", n: rule.every.months }
      : { unit: "years", n: rule.every.years };

const occurrenceShift = (rule: ScheduleRule, k: number) => {
  const { unit, n } = stepOf(rule);
  return unit === "weeks"
    ? { unit: "days" as const, amount: 7 * n * k }
    : { unit: "months" as const, amount: (unit === "months" ? n : 12 * n) * k };
};

/** Occurrence k of the rule (ignores `endOn`). */
const occurrence: {
  (k: number): (rule: ScheduleRule) => IsoDate;
  (rule: ScheduleRule, k: number): IsoDate;
} = Fn.dual(2, (rule: ScheduleRule, k: number): IsoDate => {
  const shift = occurrenceShift(rule, k);
  return shift.unit === "days"
    ? addDays(rule.startOn, shift.amount)
    : addMonths(rule.startOn, shift.amount);
});

const PositiveCadence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The smallest k whose occurrence may be on or after `from` (a lower bound, never too high). */
const firstCandidate = (rule: ScheduleRule, from: IsoDate): number => {
  if (from <= rule.startOn) return 0;
  const { unit, n } = stepOf(rule);
  if (unit === "weeks") return Math.max(0, Math.floor(daysBetween(rule.startOn, from) / (7 * n)));
  const a = parseIsoDate(rule.startOn);
  const b = parseIsoDate(from);
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  return Math.max(0, Math.floor(months / (unit === "months" ? n : 12 * n)) - 1);
};

/** Up to n occurrences on or after `from`, in order; fewer when `endOn` comes first. */
const nextOccurrences: {
  (from: IsoDate, n: number): (rule: ScheduleRule) => ReadonlyArray<IsoDate>;
  (rule: ScheduleRule, from: IsoDate, n: number): ReadonlyArray<IsoDate>;
} = Fn.dual(3, (rule: ScheduleRule, from: IsoDate, n: number): ReadonlyArray<IsoDate> => {
  PositiveCadence.make(stepOf(rule).n);
  const out: Array<IsoDate> = [];
  for (let k = firstCandidate(rule, from); out.length < n; k++) {
    const shift = occurrenceShift(rule, k);
    const date =
      shift.unit === "days"
        ? addDaysWithinRange(rule.startOn, shift.amount)
        : addMonthsWithinRange(rule.startOn, shift.amount);
    if (date === null) break;
    if (rule.endOn !== undefined && date > rule.endOn) break;
    if (date >= from) out.push(date);
  }
  return out;
});

/**
 * `Invalid{schedule.cadence_invalid}` unless the step is a positive integer, the
 * dates are calendar dates and `endOn` (when set) is not before `startOn`.
 */
const validate = (rule: ScheduleRule): Result.Result<ScheduleRule, Invalid> => {
  const fail = (path: ReadonlyArray<string>, reason: string) =>
    Result.fail(
      Invalid.make({
        issues: [{ path: [...path], code: "schedule.cadence_invalid", params: { reason } }],
      }),
    );
  const { unit, n } = stepOf(rule);
  if (!Number.isSafeInteger(n) || n < 1) return fail(["every", unit], "step");
  if (!isCalendarDate(rule.startOn)) return fail(["startOn"], "date");
  if (rule.endOn !== undefined) {
    if (!isCalendarDate(rule.endOn)) return fail(["endOn"], "date");
    if (rule.endOn < rule.startOn) return fail(["endOn"], "end_before_start");
  }
  return Result.succeed(rule);
};

export const Schedules = { nextOccurrences, validate, occurrence } as const;

// Reminders (D16) ----------------------------------------------------------------------------

/** One reminder step: `dueOn + offsetDays`, in the payload's order (step i keeps index i). */
export interface ReminderStep {
  readonly step: number;
  readonly offsetDays: number;
  readonly date: IsoDate;
}

/** The Prague dates of each reminder step for a due date. */
const reminderSteps: {
  (offsetsDays: ReadonlyArray<number>): (dueOn: IsoDate) => ReadonlyArray<ReminderStep>;
  (dueOn: IsoDate, offsetsDays: ReadonlyArray<number>): ReadonlyArray<ReminderStep>;
} = Fn.dual(
  2,
  (dueOn: IsoDate, offsetsDays: ReadonlyArray<number>): ReadonlyArray<ReminderStep> =>
    EffectArray.flatMap(offsetsDays, (offsetDays, step) => {
      const date = addDaysWithinRange(dueOn, offsetDays);
      return date === null ? [] : [{ step, offsetDays, date }];
    }),
);

/**
 * Milliseconds from `nowMillis` until `hour`:00 Prague time on `dueOn + offsetDays` (default
 * midnight), never negative: the `untilPrague(dueOn + offset_i)` of the PaymentReminders
 * workflow (core-ports 7.2). A step already in the past fires immediately (0).
 */
const untilReminder = (dueOn: IsoDate, offsetDays: number, nowMillis: number, hour = 0): number =>
  Math.max(0, pragueStartOfDay(addDays(dueOn, offsetDays), hour) - nowMillis);

export const Reminders = { reminderSteps, untilReminder } as const;
