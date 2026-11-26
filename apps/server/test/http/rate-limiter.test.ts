import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Duration, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { RateLimiter, RateLimiterMemory, RateLimiterSql } from "../../src/http/edge/RateLimiter";
import { SqlTestCore } from "../persistence/conformance/sqlCore";
import { type Harness, makeHarness } from "./harness";

setDefaultTimeout(15_000);

describe("Shared HTTP/MCP trailing sliding-window RateLimiter", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  const runTrailingWindowScenario = (layer: Layer.Layer<RateLimiter, never, never>) =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      const rule = { max: 3, windowSeconds: 60 };

      // t=0s: 1 admission.
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: true });

      // t=40s: 2 more admissions (total 3 in trailing 60s).
      yield* TestClock.adjust(Duration.seconds(40));
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: true });
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: true });

      // t=50s: 4th request denied; Retry-After is 10s (until t=0s leaves the 60s window).
      // Denied requests must not record an admission.
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: false, retryAfterSeconds: 10 });
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: false, retryAfterSeconds: 10 });

      // Different key is unaffected.
      expect(yield* limiter.consume("k2", rule)).toEqual({ allowed: true });

      // t=60s: t=0s expires; t=40s admissions remain live -> only 1 slot opens (unlike a fixed window).
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: true });
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: false, retryAfterSeconds: 40 });

      // t=100s: both t=40s admissions expire -> 2 slots open.
      yield* TestClock.adjust(Duration.seconds(40));
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: true });
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: true });
      expect(yield* limiter.consume("k1", rule)).toEqual({ allowed: false, retryAfterSeconds: 20 });
    }).pipe(
      Effect.provide(layer),
      Effect.provide(
        Layer.effectDiscard(TestClock.setTime(Date.parse("2026-11-23T12:00:00Z"))).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    );

  test("RateLimiterMemory enforces trailing sliding windows and isolates keys", async () => {
    await Effect.runPromise(runTrailingWindowScenario(RateLimiterMemory));
  });

  test("RateLimiterSql enforces shared trailing sliding windows in auth.rate_limit and prunes expired rows", async () => {
    const clockLayer = Layer.effectDiscard(
      TestClock.setTime(Date.parse("2026-11-23T12:00:00Z")),
    ).pipe(Layer.provideMerge(TestClock.layer()));
    const coreLayer = SqlTestCore().pipe(Layer.provideMerge(clockLayer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const limiterA = yield* Effect.provide(RateLimiter, RateLimiterSql);
        const limiterB = yield* Effect.provide(RateLimiter, RateLimiterSql);
        const rule = { max: 3, windowSeconds: 60 };

        // Split admissions across two independent RateLimiterSql instances sharing Postgres.
        expect(yield* limiterA.consume("shared:1", rule)).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(40));
        expect(yield* limiterB.consume("shared:1", rule)).toEqual({ allowed: true });
        expect(yield* limiterA.consume("shared:1", rule)).toEqual({ allowed: true });

        // Denied at t=50s with Retry-After: 10.
        yield* TestClock.adjust(Duration.seconds(10));
        expect(yield* limiterB.consume("shared:1", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 10,
        });

        // Key prefix safety: `shared:1` must not collide with `shared:10`.
        expect(yield* limiterA.consume("shared:10", rule)).toEqual({ allowed: true });

        // At t=60s: t=0s row is pruned and 1 slot opens; next request sees Retry-After: 40.
        yield* TestClock.adjust(Duration.seconds(10));
        expect(yield* limiterA.consume("shared:1", rule)).toEqual({ allowed: true });
        expect(yield* limiterB.consume("shared:1", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 40,
        });

        const rows = yield* sql<{ count: string }>`
          select count(*)::text as count from auth.rate_limit
          where starts_with(key, 'edge:shared:1#')`;
        expect(Number(rows[0]?.count)).toBe(3);

        // Idle key cleanup: after 2 minutes of inactivity, a request on another key reclaims
        // expired rows belonging to idle keys.
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* limiterA.consume("other:key", rule)).toEqual({ allowed: true });
        const staleRows = yield* sql<{ count: string }>`
          select count(*)::text as count from auth.rate_limit
          where starts_with(key, 'edge:shared:1#')`;
        expect(Number(staleRows[0]?.count)).toBe(0);
      }).pipe(Effect.provide(coreLayer)),
    );
  });

  test("RateLimiterSql shares one allowance bidirectionally with legacy fixed-window instances during rollout", async () => {
    const t0 = Date.parse("2026-11-23T12:00:00Z");
    const clockLayer = Layer.effectDiscard(TestClock.setTime(t0)).pipe(
      Layer.provideMerge(TestClock.layer()),
    );
    const coreLayer = SqlTestCore().pipe(Layer.provideMerge(clockLayer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const limiter = yield* Effect.provide(RateLimiter, RateLimiterSql);
        const rule = { max: 3, windowSeconds: 60 };

        // Exact SQL from the previous fixed-window release.
        const consumeLegacy = (key: string) =>
          Effect.gen(function* () {
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            const windowOpenedAfter = now - rule.windowSeconds * 1000;
            const rows = yield* sql<{ count: number; last_request: string | number }>`
              insert into auth.rate_limit (id, key, count, last_request)
              values (${`legacy-${now}-${Math.random()}`}, ${`edge:${key}`}, 1, ${now})
              on conflict (key) do update set
                count = case when auth.rate_limit.last_request <= ${windowOpenedAfter}
                  then 1 else auth.rate_limit.count + 1 end,
                last_request = case when auth.rate_limit.last_request <= ${windowOpenedAfter}
                  then ${now} else auth.rate_limit.last_request end
              returning count, last_request`;
            const row = rows[0];
            if (row === undefined) return { allowed: true } as const;
            const count = Number(row.count);
            const start = Number(row.last_request);
            return count <= rule.max
              ? ({ allowed: true } as const)
              : ({
                  allowed: false,
                  retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((start + rule.windowSeconds * 1000 - now) / 1000),
                  ),
                } as const);
          });

        // 1. Legacy admits 2 at t=0s, upgraded takes the 3rd slot at t=15s -> legacy row updates
        //    to count=3 so a legacy instance also sees 0 remaining slots.
        expect(yield* consumeLegacy("api-key:mixed-1")).toEqual({ allowed: true });
        expect(yield* consumeLegacy("api-key:mixed-1")).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(15));
        expect(yield* limiter.consume("api-key:mixed-1", rule)).toEqual({ allowed: true });

        const [aggAfterUpgrade] = yield* sql<{ count: number | string }>`
          select count from auth.rate_limit where key = 'edge:api-key:mixed-1'`;
        expect(Number(aggAfterUpgrade?.count)).toBe(3);

        // Both upgraded and legacy instances now deny with Retry-After: 45s.
        expect(yield* limiter.consume("api-key:mixed-1", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 45,
        });
        expect(yield* consumeLegacy("api-key:mixed-1")).toEqual({
          allowed: false,
          retryAfterSeconds: 45,
        });

        // 2. Interleaved order: upgraded admits 1 at t=15s, legacy admits 1 at t=25s,
        //    upgraded admits 1 at t=35s -> both see the 4th request denied.
        expect(yield* limiter.consume("api-key:mixed-2", rule)).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(10));
        expect(yield* consumeLegacy("api-key:mixed-2")).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(10));
        expect(yield* limiter.consume("api-key:mixed-2", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-2", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 40,
        });
        expect(yield* consumeLegacy("api-key:mixed-2")).toEqual({
          allowed: false,
          retryAfterSeconds: 40,
        });

        // 3. At t=60s (45s after t=15s, 25s after t=35s): mixed-1's 1st legacy admission (t=0s)
        //    expires while the 2nd legacy admission (materialized at t=15s) and the upgraded
        //    t=15s admission remain live -> 1 slot opens (not 2), 2nd denied with Retry-After: 15s.
        yield* TestClock.adjust(Duration.seconds(25));
        expect(yield* limiter.consume("api-key:mixed-1", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-1", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 15,
        });

        // 4. Legacy-first post-rollover with a single legacy admission.
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(40));
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({ allowed: true });

        yield* TestClock.adjust(Duration.seconds(20));
        expect(yield* consumeLegacy("api-key:mixed-rollover")).toEqual({ allowed: true });

        yield* TestClock.adjust(Duration.seconds(1));
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 39,
        });
        expect(yield* consumeLegacy("api-key:mixed-rollover")).toEqual({
          allowed: false,
          retryAfterSeconds: 39,
        });

        // At t=160s (+39s): the two t=100s admissions expire; the materialized t=120s legacy
        // admission stays live -> exactly 2 slots open, 3rd denied with Retry-After: 20s.
        yield* TestClock.adjust(Duration.seconds(39));
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-rollover", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 20,
        });

        // 5. Staggered legacy batch (t=160s and t=170s, observed by upgraded at t=175s):
        //    at t=220s only the 1st legacy admission expires; the 2nd stays live (never released
        //    early at t=220s) until t=235s.
        expect(yield* consumeLegacy("api-key:mixed-batch")).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(10));
        expect(yield* consumeLegacy("api-key:mixed-batch")).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(5));
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 45,
        });

        // At t=220s (+45s): only the t=160s admission expires -> 1 slot opens, 2nd denied (15s).
        yield* TestClock.adjust(Duration.seconds(45));
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 15,
        });

        // At t=235s (+15s): both t=175s entries (materialized 2nd legacy + upgraded) expire -> 2 open.
        yield* TestClock.adjust(Duration.seconds(15));
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({ allowed: true });
        expect(yield* limiter.consume("api-key:mixed-batch", rule)).toEqual({
          allowed: false,
          retryAfterSeconds: 45,
        });
      }).pipe(Effect.provide(coreLayer)),
    );
  });

  test("HTTP edge routes return 429 with Retry-After over a trailing sliding window", async () => {
    harness = makeHarness();

    // botChallenge limit is 30/min per IP. Send 10 at t=0s and 20 at t=40s.
    for (let i = 0; i < 10; i++) {
      const res = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
      expect(res.status).toBe(204);
    }

    await harness.run(TestClock.adjust(Duration.seconds(40)));
    for (let i = 0; i < 20; i++) {
      const res = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
      expect(res.status).toBe(204);
    }

    // At t=50s: 31st request gets 429 with Retry-After: 10.
    await harness.run(TestClock.adjust(Duration.seconds(10)));
    const denied = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("10");
    expect(await denied.json()).toEqual({ _tag: "RateLimited", retryAfterSeconds: 10 });

    // At t=60s: only the 10 from t=0s expired; 10 succeed and the 11th gets 429 with Retry-After: 40.
    await harness.run(TestClock.adjust(Duration.seconds(10)));
    for (let i = 0; i < 10; i++) {
      const res = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
      expect(res.status).toBe(204);
    }
    const deniedAgain = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
    expect(deniedAgain.status).toBe(429);
    expect(deniedAgain.headers.get("retry-after")).toBe("40");
  });
});
