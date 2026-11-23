/**
 * Schedules (core-ports 5.6) and reminder date math (rule D16).
 *
 * Occurrence k (k = 0, 1, ...) is `startOn + k x every` on the Prague calendar, always computed
 * from `startOn`: a monthly rule from 31 Jan gives 31 Jan, 28 Feb, 31 Mar (day clamped to the
 * month's end, never drifting). Yearly from 29 Feb gives 28 Feb in common years.
 */
import type { IsoDate, ScheduleRule } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Result } from "effect";
import {
  addDays,
  addMonths,
  daysBetween,
  isCalendarDate,
  parseIsoDate,
  pragueStartOfDay,
} from "./calendar";

export type { ScheduleRule };

/** Upper bounds for a cadence step (product limits). */
export const MAX_EVERY = { weeks: 520, months: 120, years: 10 } as const;

const stepOf = (rule: ScheduleRule): { unit: "weeks" | "months" | "years"; n: number } =>
  "weeks" in rule.every
    ? { unit: "weeks", n: rule.every.weeks }
    : "months" in rule.every
      ? { unit: "months", n: rule.every.months }
      : { unit: "years", n: rule.every.years };

/** Occurrence k of the rule (ignores `endOn`). */
export const occurrence = (rule: ScheduleRule, k: number): IsoDate => {
  const { unit, n } = stepOf(rule);
  return unit === "weeks"
    ? addDays(rule.startOn, 7 * n * k)
    : addMonths(rule.startOn, (unit === "months" ? n : 12 * n) * k);
};

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
export const nextOccurrences = (
  rule: ScheduleRule,
  from: IsoDate,
  n: number,
): ReadonlyArray<IsoDate> => {
  const { n: step } = stepOf(rule);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error("Schedules.nextOccurrences: invalid cadence; run Schedules.validate first");
  }
  const out: Array<IsoDate> = [];
  for (let k = firstCandidate(rule, from); out.length < n; k++) {
    const date = occurrence(rule, k);
    if (rule.endOn !== undefined && date > rule.endOn) break;
    if (date >= from) out.push(date);
  }
  return out;
};

/**
 * `Invalid{schedule.cadence_invalid}` unless the step is an integer from 1 to `MAX_EVERY`, the
 * dates are calendar dates and `endOn` (when set) is not before `startOn`.
 */
export const validate = (rule: ScheduleRule): Result.Result<ScheduleRule, Invalid> => {
  const fail = (path: ReadonlyArray<string>, reason: string) =>
    Result.fail(
      new Invalid({
        issues: [{ path: [...path], code: "schedule.cadence_invalid", params: { reason } }],
      }),
    );
  const { unit, n } = stepOf(rule);
  if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY[unit]) return fail(["every", unit], "step");
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
export const reminderSteps = (
  dueOn: IsoDate,
  offsetsDays: ReadonlyArray<number>,
): ReadonlyArray<ReminderStep> =>
  offsetsDays.map((offsetDays, step) => ({ step, offsetDays, date: addDays(dueOn, offsetDays) }));

/**
 * Milliseconds from `nowMillis` until `hour`:00 Prague time on `dueOn + offsetDays` (default
 * midnight), never negative: the `untilPrague(dueOn + offset_i)` of the PaymentReminders
 * workflow (core-ports 7.2). A step already in the past fires immediately (0).
 */
export const untilReminder = (
  dueOn: IsoDate,
  offsetDays: number,
  nowMillis: number,
  hour = 0,
): number => Math.max(0, pragueStartOfDay(addDays(dueOn, offsetDays), hour) - nowMillis);

export const Reminders = { reminderSteps, untilReminder } as const;
