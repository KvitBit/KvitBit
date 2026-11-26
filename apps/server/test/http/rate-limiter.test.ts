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
