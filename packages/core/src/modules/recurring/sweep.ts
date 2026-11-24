/**
 * Pure decisions of RecurringSweep and RecurringIssuance (core-ports 4.8, 7.2, 7.3). No I/O:
 * the cron and the issuance steps call these with stored rows and the Prague date.
 */
import type { IsoDate, ScheduleId, ScheduleRule, WorkspaceId } from "@kvitbit/domain/contract";
import { addDays, daysBetween } from "../../engines/calendar";
import { Schedules } from "../../engines/schedules";
import type { ScheduleRow } from "./repo";

/** Occurrences up to this many days late are still issued; later ones pause the schedule. */
export const CATCH_UP_DAYS = 7;

/** The ScheduleRule a stored schedule encodes. */
export const ruleOf = (row: ScheduleRow): ScheduleRule => ({
  every: (row.cadenceUnit === "weeks"
    ? { weeks: row.cadenceInterval }
    : row.cadenceUnit === "months"
      ? { months: row.cadenceInterval }
      : { years: row.cadenceInterval }) as ScheduleRule["every"],
  startOn: row.startOn,
  ...(row.endOn !== null ? { endOn: row.endOn } : {}),
});

/** The first occurrence on or after `from`, or null once `endOn` has passed. */
export const firstOccurrenceFrom = (rule: ScheduleRule, from: IsoDate): IsoDate | null =>
  Schedules.nextOccurrences(rule, from, 1)[0] ?? null;

/** The occurrence after `occurrence` ("advance", core-ports 7.2). */
export const occurrenceAfter = (rule: ScheduleRule, occurrence: IsoDate): IsoDate | null =>
  firstOccurrenceFrom(rule, addDays(occurrence, 1));

/**
 * Where a new or changed schedule starts (changes affect future occurrences only): the first
 * occurrence on or after today and after the last occurrence the schedule already issued.
 */
export const startingOccurrence = (
  rule: ScheduleRule,
  today: IsoDate,
  lastIssued: IsoDate | null,
): IsoDate | null => {
  const afterIssued = lastIssued === null ? today : addDays(lastIssued, 1);
  return firstOccurrenceFrom(rule, afterIssued > today ? afterIssued : today);
};

/** Whether the occurrence is past the catch-up cap on `today` and `resume` has not cleared it. */
export const isMissed = (
  occurrence: IsoDate,
  today: IsoDate,
  catchUpThrough: IsoDate | null,
): boolean =>
  daysBetween(occurrence, today) > CATCH_UP_DAYS &&
  (catchUpThrough === null || occurrence > catchUpThrough);

export type DueAction = "issue" | "pause_missed";

/** What one sweep tick does for one schedule. */
export interface SweepDecision {
  readonly workspaceId: WorkspaceId;
  readonly scheduleId: ScheduleId;
  readonly occurrence: IsoDate;
  readonly action: DueAction;
}

/**
 * The sweep of one tick: for each attached, unpaused schedule whose next occurrence is on or
 * before `today` (Prague), issue that occurrence, or pause the schedule when it is more than
 * `CATCH_UP_DAYS` late. One occurrence per schedule per tick; catch-up happens tick by tick.
 * Ordered by occurrence, then schedule id.
 */
export const decideDue = (
  schedules: ReadonlyArray<ScheduleRow>,
  today: IsoDate,
): ReadonlyArray<SweepDecision> =>
  schedules
    .flatMap((row): ReadonlyArray<SweepDecision> => {
      const occurrence = row.nextOccurrence;
      if (row.detachedAt !== null || row.pausedAt !== null || occurrence === null) return [];
      if (occurrence > today) return [];
      return [
        {
          workspaceId: row.workspaceId,
          scheduleId: row.id,
          occurrence,
          action: isMissed(occurrence, today, row.catchUpThrough) ? "pause_missed" : "issue",
        },
      ];
    })
    .sort((a, b) =>
      a.occurrence !== b.occurrence
        ? a.occurrence < b.occurrence
          ? -1
          : 1
        : a.scheduleId < b.scheduleId
          ? -1
          : a.scheduleId > b.scheduleId
            ? 1
            : 0,
    );

/**
 * Whether occurrence `occurrence` of `row` may be issued now: the schedule is attached, not
 * paused, and its next occurrence is exactly this one (an advanced, changed or detached
 * schedule makes a stale RecurringIssuance a no-op).
 */
export type IssueEligibility =
  | { readonly _tag: "Eligible" }
  | {
      readonly _tag: "Ineligible";
      readonly reason: "detached" | "paused" | "not_next" | "not_due";
    };

export const issueEligibility = (
  row: ScheduleRow,
  occurrence: IsoDate,
  today: IsoDate,
): IssueEligibility => {
  if (row.detachedAt !== null) return { _tag: "Ineligible", reason: "detached" };
  if (row.pausedAt !== null) return { _tag: "Ineligible", reason: "paused" };
  if (row.nextOccurrence !== occurrence) return { _tag: "Ineligible", reason: "not_next" };
  if (occurrence > today) return { _tag: "Ineligible", reason: "not_due" };
  return { _tag: "Eligible" };
};
