import { describe, expect, test } from "bun:test";
import type { IsoDate, ScheduleRule } from "@kvitbit/domain/contract";
import { Result, Schema } from "effect";
import {
  addDays,
  addMonths,
  pragueDate,
  pragueStartOfDay,
  Reminders,
  ScheduleRule as ScheduleRuleSchema,
  Schedules,
} from "../../src/engines";
import { rng, SEEDS } from "./random";

const D = (s: string) => s as IsoDate;
const rule = (every: ScheduleRule["every"], startOn: string, endOn?: string): ScheduleRule => ({
  every,
  startOn: D(startOn),
  ...(endOn ? { endOn: D(endOn) } : {}),
});

describe("calendar", () => {
  test("addMonths clamps to the month's end; addDays crosses years", () => {
    expect(addMonths(D("2026-01-31"), 1)).toBe(D("2026-02-28"));
    expect(addMonths(D("2028-01-31"), 1)).toBe(D("2028-02-29"));
    expect(addMonths(D("2026-11-30"), -12)).toBe(D("2025-11-30"));
    expect(addDays(D("2026-12-31"), 1)).toBe(D("2027-01-01"));
    expect(addDays(D("2026-03-01"), -1)).toBe(D("2026-02-28"));
  });

  test("Prague dates and midnights across DST", () => {
    expect(pragueDate(Date.UTC(2026, 10, 22, 23, 30))).toBe(D("2026-11-23")); // CET
    expect(pragueDate(Date.UTC(2026, 6, 1, 22, 30))).toBe(D("2026-07-02")); // CEST
    expect(pragueStartOfDay(D("2026-11-23"))).toBe(Date.UTC(2026, 10, 22, 23));
    expect(pragueStartOfDay(D("2026-07-02"))).toBe(Date.UTC(2026, 6, 1, 22));
    expect(pragueStartOfDay(D("2026-03-29"), 9)).toBe(Date.UTC(2026, 2, 29, 7)); // after spring-forward
    expect(pragueStartOfDay(D("2026-03-29"), 2)).toBe(Date.UTC(2026, 2, 29, 1)); // skipped hour -> 03:00
    expect(pragueStartOfDay(D("2026-10-25"), 9)).toBe(Date.UTC(2026, 9, 25, 8)); // after fall-back
  });

  test("Prague midnight round-trips for historical dates (local mean time before 1891)", () => {
    for (const date of ["0099-01-01", "1850-06-15", "1891-10-01", "1946-12-01", "2026-03-29"]) {
      expect([date, pragueDate(pragueStartOfDay(D(date)))]).toEqual([date, D(date)]);
      expect([date, pragueDate(pragueStartOfDay(D(date)) - 1)]).toEqual([
        date,
        addDays(D(date), -1),
      ]);
    }
  });
});

describe("Schedules.nextOccurrences", () => {
  test("monthly from the 31st never drifts (31 Jan, 28 Feb, 31 Mar)", () => {
    expect(
      Schedules.nextOccurrences(rule({ months: 1 }, "2026-01-31"), D("2026-01-01"), 4),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"].map(D));
  });

  test("starts on or after `from`", () => {
    expect(
      Schedules.nextOccurrences(rule({ months: 1 }, "2026-01-31"), D("2026-03-31"), 2),
    ).toEqual(["2026-03-31", "2026-04-30"].map(D));
    expect(Schedules.nextOccurrences(rule({ weeks: 2 }, "2026-11-02"), D("2026-11-17"), 2)).toEqual(
      ["2026-11-30", "2026-12-14"].map(D),
    );
  });

  test("yearly from 29 Feb gives 28 Feb in common years", () => {
    expect(Schedules.nextOccurrences(rule({ years: 1 }, "2028-02-29"), D("2028-01-01"), 3)).toEqual(
      ["2028-02-29", "2029-02-28", "2030-02-28"].map(D),
    );
  });

  test("stops at endOn (inclusive)", () => {
    expect(
      Schedules.nextOccurrences(
        rule({ months: 3 }, "2026-01-15", "2026-07-15"),
        D("2026-01-01"),
        10,
      ),
    ).toEqual(["2026-01-15", "2026-04-15", "2026-07-15"].map(D));
    expect(
      Schedules.nextOccurrences(rule({ weeks: 1 }, "2026-01-01", "2026-01-01"), D("2026-01-02"), 3),
    ).toEqual([]);
  });

  test("years 0000-0099 survive date arithmetic", () => {
    expect(Schedules.nextOccurrences(rule({ weeks: 1 }, "0099-01-01"), D("0001-01-01"), 2)).toEqual(
      ["0099-01-01", "0099-01-08"].map(D),
    );
    expect(addMonths(D("0000-12-31"), 2)).toBe(D("0001-02-28"));
    expect(addDays(D("0100-01-01"), -1)).toBe(D("0099-12-31"));
  });

  test("enumeration stops at the end of the four-digit calendar", () => {
    expect(Schedules.nextOccurrences(rule({ years: 1 }, "9999-12-31"), D("2026-01-01"), 3)).toEqual(
      [D("9999-12-31")],
    );
    expect(Schedules.nextOccurrences(rule({ weeks: 1 }, "9999-12-25"), D("9999-12-26"), 3)).toEqual(
      [],
    );
  });

  test("an invalid cadence is a defect", () => {
    expect(() =>
      Schedules.nextOccurrences(rule({ weeks: 0 }, "2026-01-01"), D("2027-01-01"), 1),
    ).toThrow();
  });

  test("property: the occurrences equal a brute-force walk from startOn (seeded)", () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const r = rng(seed);
      const unit = r.pick(["weeks", "months", "years"] as const);
      const n = r.int(1, unit === "years" ? 3 : 6);
      const every = (
        unit === "weeks" ? { weeks: n } : unit === "months" ? { months: n } : { years: n }
      ) as ScheduleRule["every"];
      const start = addDays(D("2024-01-01"), r.int(0, 1500));
      const from = addDays(start, r.int(-30, 900));
      const rr = rule(every, start, r.next() < 0.3 ? addDays(start, r.int(0, 1500)) : undefined);
      const expected: Array<IsoDate> = [];
      for (let k = 0; expected.length < 5 && k < 10_000; k++) {
        const date = Schedules.occurrence(rr, k);
        if (rr.endOn !== undefined && date > rr.endOn) break;
        if (date >= from) expected.push(date);
      }
      expect([seed, Schedules.nextOccurrences(rr, from, 5)]).toEqual([seed, expected]);
    }
  });
});

describe("Schedules.validate", () => {
  test("the runtime ScheduleRule schema is exported from the engines", () => {
    expect(
      Schema.decodeUnknownSync(ScheduleRuleSchema)({ every: { months: 1 }, startOn: "2026-01-31" }),
    ).toEqual(rule({ months: 1 }, "2026-01-31"));
  });
  test("no product ceiling on the step (an 11-year cadence is valid)", () => {
    expect(Result.isSuccess(Schedules.validate(rule({ years: 11 }, "2026-01-01")))).toBe(true);
  });
  test("accepts positive integer steps and endOn >= startOn", () => {
    const ok = rule({ months: 1 }, "2026-01-31", "2026-01-31");
    expect(Schedules.validate(ok)).toEqual(Result.succeed(ok));
  });
  test.each([
    [rule({ weeks: 0 }, "2026-01-01"), "step"],
    [rule({ months: 1.5 }, "2026-01-01"), "step"],
    [rule({ months: 1 }, "2026-02-30"), "date"],
    [rule({ months: 1 }, "2026-02-01", "2026-01-31"), "end_before_start"],
  ])("rejects %j (%s)", (r, reason) => {
    const result = Schedules.validate(r);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.issues[0]).toMatchObject({
        code: "schedule.cadence_invalid",
        params: { reason },
      });
    }
  });
});

describe("Reminders (D16)", () => {
  test("steps are dueOn + offset in payload order", () => {
    expect(Reminders.reminderSteps(D("2026-11-30"), [3, 14])).toEqual([
      { step: 0, offsetDays: 3, date: D("2026-12-03") },
      { step: 1, offsetDays: 14, date: D("2026-12-14") },
    ]);
  });
  test("untilReminder is the wait until Prague midnight (or hour) of the step date, never negative", () => {
    const now = Date.UTC(2026, 10, 23, 9);
    expect(Reminders.untilReminder(D("2026-11-30"), 3, now)).toBe(Date.UTC(2026, 11, 2, 23) - now);
    expect(Reminders.untilReminder(D("2026-11-30"), 3, now, 9)).toBe(
      Date.UTC(2026, 11, 3, 8) - now,
    );
    expect(Reminders.untilReminder(D("2026-11-01"), 3, now)).toBe(0);
  });
});
