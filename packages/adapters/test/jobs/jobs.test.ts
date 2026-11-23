import { describe, expect, test } from "bun:test";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import {
  type CronHandlers,
  type CronJob,
  CurrentScheduledTime,
  cronJobs,
  cronLayer,
  cronSpecs,
  cronsLayer,
  parseCron,
  selfHostedRunnerLayer,
  testRunnerLayer,
} from "@kvitbit/adapters/jobs";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

const nextAfter = (job: CronJob, iso: string): string =>
  Cron.next(parseCron(cronSpecs[job]), new Date(iso)).toISOString();

const sequenceAfter = (job: CronJob, iso: string, count: number): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const date of Cron.sequence(parseCron(cronSpecs[job]), new Date(iso))) {
    out.push(date.toISOString());
    if (out.length === count) break;
  }
  return out;
};

describe("cron table", () => {
  test("every row parses and names are unique kvitbit/ names", () => {
    const names = cronJobs.map((job) => cronSpecs[job].name);
    expect(new Set(names).size).toBe(names.length);
    for (const job of cronJobs) {
      const spec = cronSpecs[job];
      expect(spec.name.startsWith("kvitbit/")).toBe(true);
      expect(Result.isSuccess(Cron.parse(spec.expression, spec.timeZone))).toBe(true);
      expect(Duration.toMillis(spec.skipIfOlderThan)).toBeGreaterThan(0);
    }
  });

  test("names and schedules match core-ports 7.3", () => {
    expect(cronSpecs.recurringSweep).toMatchObject({
      name: "kvitbit/recurring-sweep",
      expression: "*/15 * * * *",
      timeZone: "Europe/Prague",
    });
    expect(cronSpecs.cnbFixing).toMatchObject({
      name: "kvitbit/cnb-fixing",
      expression: "45 14-17 * * 1-5",
      timeZone: "Europe/Prague",
    });
    expect(cronSpecs.outboxReconcile).toMatchObject({
      name: "kvitbit/outbox-reconcile",
      expression: "* * * * *",
      timeZone: "UTC",
    });
    expect(cronSpecs.housekeeping).toMatchObject({
      name: "kvitbit/housekeeping",
      expression: "30 3 * * *",
      timeZone: "Europe/Prague",
    });
    expect(Duration.toMillis(cronSpecs.recurringSweep.skipIfOlderThan)).toBe(3_600_000);
    expect(Duration.toMillis(cronSpecs.outboxReconcile.skipIfOlderThan)).toBe(300_000);
    expect(Duration.toMillis(cronSpecs.housekeeping.skipIfOlderThan)).toBe(6 * 3_600_000);
  });

  test("reminder sweep stays at 08:00 Prague across both 2026 DST switches", () => {
    // CET (UTC+1) before 29 March, CEST (UTC+2) after; back to CET on 25 October.
    expect(sequenceAfter("reminderSweep", "2026-03-27T12:00:00Z", 3)).toEqual([
      "2026-03-28T07:00:00.000Z",
      "2026-03-29T06:00:00.000Z",
      "2026-03-30T06:00:00.000Z",
    ]);
    expect(sequenceAfter("reminderSweep", "2026-10-24T12:00:00Z", 2)).toEqual([
      "2026-10-25T07:00:00.000Z",
      "2026-10-26T07:00:00.000Z",
    ]);
  });

  test("housekeeping 03:30 Prague on spring-forward and fall-back days", () => {
    expect(nextAfter("housekeeping", "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    expect(nextAfter("housekeeping", "2026-10-24T12:00:00Z")).toBe("2026-10-25T02:30:00.000Z");
  });

  test("CNB warm-up retries hourly on weekdays and skips the weekend", () => {
    expect(sequenceAfter("cnbFixing", "2026-03-27T12:00:00Z", 5)).toEqual([
      "2026-03-27T13:45:00.000Z", // Fri 14:45 CET
      "2026-03-27T14:45:00.000Z",
      "2026-03-27T15:45:00.000Z",
      "2026-03-27T16:45:00.000Z", // Fri 17:45 CET, last attempt
      "2026-03-30T12:45:00.000Z", // Mon 14:45 CEST
    ]);
  });

  test("recurring sweep every 15 minutes, outbox every minute", () => {
    expect(nextAfter("recurringSweep", "2026-05-01T10:07:30Z")).toBe("2026-05-01T10:15:00.000Z");
    expect(nextAfter("outboxReconcile", "2026-05-01T10:07:30Z")).toBe("2026-05-01T10:08:00.000Z");
  });
});

describe("cron layers on the memory runner", () => {
  const START = Date.parse("2026-05-01T10:00:30Z");

  const runWithClock = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        return yield* effect;
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(References.MinimumLogLevel, "Error"),
      ),
    );

  const advance = (minutes: number) =>
    Effect.gen(function* () {
      for (let i = 0; i < minutes * 6; i++) {
        yield* TestClock.adjust("10 seconds");
        yield* Effect.yieldNow;
      }
    });

  test("an injected handler runs when its cron fires and sees CurrentScheduledTime", async () => {
    const fired = await runWithClock(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([]);
        const handler = Effect.gen(function* () {
          const at = yield* CurrentScheduledTime;
          yield* Ref.update(seen, (xs) => [...xs, DateTime.formatIso(at)]);
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              cronLayer("outboxReconcile", handler).pipe(Layer.provide(testRunnerLayer)),
            );
            yield* advance(3);
          }),
        );
        return yield* Ref.get(seen);
      }),
    );
    expect(fired.slice(0, 2)).toEqual(["2026-05-01T10:01:00.000Z", "2026-05-01T10:02:00.000Z"]);
  });

  test("cronsLayer registers every job; a failing handler does not stop the schedule", async () => {
    const counts = await runWithClock(
      Effect.gen(function* () {
        const hits = yield* Ref.make<Record<string, number>>({});
        const hit = (job: CronJob) => Ref.update(hits, (m) => ({ ...m, [job]: (m[job] ?? 0) + 1 }));
        const handlers: CronHandlers<string> = {
          recurringSweep: hit("recurringSweep"),
          reminderSweep: hit("reminderSweep"),
          cnbFixing: hit("cnbFixing"),
          outboxReconcile: Effect.andThen(hit("outboxReconcile"), Effect.fail("boom")),
          housekeeping: hit("housekeeping"),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(cronsLayer(handlers).pipe(Layer.provide(testRunnerLayer)));
            yield* advance(16);
          }),
        );
        return yield* Ref.get(hits);
      }),
    );
    expect(counts.outboxReconcile).toBe(16); // 10:01 .. 10:16, once each despite failing
    expect(counts.recurringSweep).toBe(1); // 10:15
    expect(counts.reminderSweep).toBeUndefined();
    expect(counts.cnbFixing).toBeUndefined();
    expect(counts.housekeeping).toBeUndefined();
  });

  test("selfHostedRunnerLayer builds SQL storage on PGlite and fires a cron", async () => {
    const fired = await runWithClock(
      Effect.gen(function* () {
        const seen = yield* Ref.make(0);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              cronLayer(
                "outboxReconcile",
                Ref.update(seen, (n) => n + 1),
              ).pipe(
                Layer.provide(selfHostedRunnerLayer()),
                Layer.provide(PgliteClient.layer()),
                Layer.orDie,
              ),
            );
            yield* advance(2);
          }),
        );
        return yield* Ref.get(seen);
      }),
    );
    expect(fired).toBe(2); // 10:01 and 10:02
  }, 60_000);
});
