import { describe, expect, test } from "bun:test";
import type { IsoDate, ScheduleId, TemplateId } from "@kvitbit/domain/contract";
import type { ScheduleRow } from "../../../src/modules/recurring";
import {
  decideDue,
  isMissed,
  issueEligibility,
  occurrenceAfter,
  startingOccurrence,
} from "../../../src/modules/recurring";
import { WORKSPACE_A, WORKSPACE_B } from "../../helpers";

const d = (s: string) => s as IsoDate;
const sid = (n: number) =>
  `01900000-0000-7000-8000-0000000e${String(n).padStart(4, "0")}` as ScheduleId;

const row = (n: number, overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: sid(n),
  workspaceId: WORKSPACE_A,
  revision: 1,
  templateId: "01900000-0000-7000-8000-0000000f0001" as TemplateId,
  cadenceUnit: "months",
  cadenceInterval: 1,
  startOn: d("2026-01-31"),
  endOn: null,
  issueAs: "invoice",
  autoSend: false,
  nextOccurrence: d("2026-11-23"),
  pausedAt: null,
  pausedReason: null,
  pausedError: null,
  catchUpThrough: null,
  detachedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const monthlyFrom31 = { every: { months: 1 }, startOn: d("2026-01-31") } as const;

describe("decideDue", () => {
  test("issues due occurrences, pauses ones more than 7 days late, skips the rest", () => {
    const today = d("2026-11-23");
    const decisions = decideDue(
      [
        row(1), // due today
        row(2, { nextOccurrence: d("2026-11-24") }), // future
        row(3, { nextOccurrence: d("2026-11-16") }), // exactly 7 days late: still issued
        row(4, { nextOccurrence: d("2026-11-15") }), // 8 days late: catch-up cap
        row(5, { pausedAt: "2026-11-20T00:00:00.000Z" }),
        row(6, { detachedAt: "2026-11-20T00:00:00.000Z" }),
        row(7, { nextOccurrence: null }), // ended
        // resumed after the cap: missed occurrences up to the resume date issue
        row(8, { nextOccurrence: d("2026-10-01"), catchUpThrough: d("2026-11-20") }),
        row(9, { workspaceId: WORKSPACE_B, nextOccurrence: d("2026-11-23") }),
      ],
      today,
    );
    expect<unknown>(decisions.map((x) => [x.scheduleId, x.occurrence, x.action])).toEqual([
      [sid(8), "2026-10-01", "issue"],
      [sid(4), "2026-11-15", "pause_missed"],
      [sid(3), "2026-11-16", "issue"],
      [sid(1), "2026-11-23", "issue"],
      [sid(9), "2026-11-23", "issue"],
    ]);
    expect(decisions.find((x) => x.scheduleId === sid(9))?.workspaceId).toBe(WORKSPACE_B);
  });

  test("a resume only covers occurrences up to its date", () => {
    expect(isMissed(d("2026-11-01"), d("2026-11-23"), d("2026-11-20"))).toBe(false);
    expect(isMissed(d("2026-11-21"), d("2026-11-30"), d("2026-11-20"))).toBe(true);
    expect(isMissed(d("2026-11-21"), d("2026-11-28"), null)).toBe(false);
  });
});

describe("occurrence math through Schedules", () => {
  test("monthly from the 31st advances to month ends and back to the 31st", () => {
    expect(occurrenceAfter(monthlyFrom31, d("2026-01-31"))).toBe(d("2026-02-28"));
    expect(occurrenceAfter(monthlyFrom31, d("2026-02-28"))).toBe(d("2026-03-31"));
    expect(occurrenceAfter(monthlyFrom31, d("2026-03-31"))).toBe(d("2026-04-30"));
  });

  test("advance past endOn ends the schedule", () => {
    expect(
      occurrenceAfter({ ...monthlyFrom31, endOn: d("2026-03-15") }, d("2026-02-28")),
    ).toBeNull();
  });

  test("a new or changed schedule starts today or later, never on an issued occurrence", () => {
    expect(startingOccurrence(monthlyFrom31, d("2026-11-23"), null)).toBe(d("2026-11-30"));
    expect(startingOccurrence(monthlyFrom31, d("2026-11-30"), null)).toBe(d("2026-11-30"));
    expect(startingOccurrence(monthlyFrom31, d("2026-11-30"), d("2026-11-30"))).toBe(
      d("2026-12-31"),
    );
    const weekly = { every: { weeks: 1 }, startOn: d("2026-12-07") } as const;
    expect(startingOccurrence(weekly, d("2026-11-23"), null)).toBe(d("2026-12-07"));
  });

  test("issueEligibility guards stale, paused, detached and future occurrences", () => {
    const today = d("2026-11-23");
    expect(issueEligibility(row(1), d("2026-11-23"), today)._tag).toBe("Eligible");
    expect(issueEligibility(row(1), d("2026-10-31"), today)).toEqual({
      _tag: "Ineligible",
      reason: "not_next",
    });
    expect(issueEligibility(row(1, { pausedAt: "x" }), d("2026-11-23"), today)).toEqual({
      _tag: "Ineligible",
      reason: "paused",
    });
    expect(issueEligibility(row(1, { detachedAt: "x" }), d("2026-11-23"), today)).toEqual({
      _tag: "Ineligible",
      reason: "detached",
    });
    expect(
      issueEligibility(row(1, { nextOccurrence: d("2026-11-24") }), d("2026-11-24"), today),
    ).toEqual({ _tag: "Ineligible", reason: "not_due" });
  });
});
