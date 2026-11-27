import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
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

  const clockLayer = Layer.effectDiscard(
    TestClock.setTime(Date.parse("2026-11-23T12:00:00Z")),
  ).pipe(Layer.provideMerge(TestClock.layer()));

  test("RateLimiterMemory enforces trailing sliding windows and isolates keys", async () => {
    await Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      const rule = { max: 3, windowSeconds: 60 };

      // t=0s: 1 admission.
      const initial = yield* limiter.consume("k1", rule);
      expect(initial).toEqual({ allowed: true });

      // t=40s: 2 more admissions (total 3 in trailing 60s).
      yield* TestClock.adjust(Duration.seconds(40));
      const firstAtForty = yield* limiter.consume("k1", rule);
      expect(firstAtForty).toEqual({ allowed: true });
      const secondAtForty = yield* limiter.consume("k1", rule);
      expect(secondAtForty).toEqual({ allowed: true });

      // t=50s: 4th request denied; Retry-After is 10s (until t=0s leaves the 60s window).
      // Denied requests must not record an admission.
      yield* TestClock.adjust(Duration.seconds(10));
      const deniedAtFifty = yield* limiter.consume("k1", rule);
      expect(deniedAtFifty).toEqual({ allowed: false, retryAfterSeconds: 10 });
      const deniedAgainAtFifty = yield* limiter.consume("k1", rule);
      expect(deniedAgainAtFifty).toEqual({ allowed: false, retryAfterSeconds: 10 });

      // Different key is unaffected.
      const otherKey = yield* limiter.consume("k2", rule);
      expect(otherKey).toEqual({ allowed: true });

      // t=60s: t=0s expires; t=40s admissions remain live -> only 1 slot opens (unlike a fixed window).
      yield* TestClock.adjust(Duration.seconds(10));
      const admittedAtSixty = yield* limiter.consume("k1", rule);
      expect(admittedAtSixty).toEqual({ allowed: true });
      const deniedAtSixty = yield* limiter.consume("k1", rule);
      expect(deniedAtSixty).toEqual({ allowed: false, retryAfterSeconds: 40 });

      // t=100s: both t=40s admissions expire -> 2 slots open.
      yield* TestClock.adjust(Duration.seconds(40));
      const firstAtHundred = yield* limiter.consume("k1", rule);
      expect(firstAtHundred).toEqual({ allowed: true });
      const secondAtHundred = yield* limiter.consume("k1", rule);
      expect(secondAtHundred).toEqual({ allowed: true });
      const deniedAtHundred = yield* limiter.consume("k1", rule);
      expect(deniedAtHundred).toEqual({ allowed: false, retryAfterSeconds: 20 });
    }).pipe(
      Effect.provide(RateLimiterMemory.pipe(Layer.provideMerge(clockLayer))),
      Effect.runPromise,
    );
  });

  test("RateLimiterSql enforces shared trailing sliding windows in auth.rate_limit and prunes expired rows", async () => {
    const coreLayer = SqlTestCore().pipe(Layer.provideMerge(clockLayer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const limiterA = yield* Effect.provide(RateLimiter, RateLimiterSql);
        const limiterB = yield* Effect.provide(RateLimiter, RateLimiterSql);
        const rule = { max: 3, windowSeconds: 60 };

        // Split admissions across two independent RateLimiterSql instances sharing Postgres.
        const initial = yield* limiterA.consume("shared:1", rule);
        expect(initial).toEqual({ allowed: true });
        yield* TestClock.adjust(Duration.seconds(40));
        const firstAtForty = yield* limiterB.consume("shared:1", rule);
        expect(firstAtForty).toEqual({ allowed: true });
        const secondAtForty = yield* limiterA.consume("shared:1", rule);
        expect(secondAtForty).toEqual({ allowed: true });

        // Denied at t=50s with Retry-After: 10.
        yield* TestClock.adjust(Duration.seconds(10));
        const deniedAtFifty = yield* limiterB.consume("shared:1", rule);
        expect(deniedAtFifty).toEqual({
          allowed: false,
          retryAfterSeconds: 10,
        });

        // Key prefix safety: `shared:1` must not collide with `shared:10`.
        const prefixedKey = yield* limiterA.consume("shared:10", rule);
        expect(prefixedKey).toEqual({ allowed: true });

        // At t=60s: t=0s row is pruned and 1 slot opens; next request sees Retry-After: 40.
        yield* TestClock.adjust(Duration.seconds(10));
        const admittedAtSixty = yield* limiterA.consume("shared:1", rule);
        expect(admittedAtSixty).toEqual({ allowed: true });
        const deniedAtSixty = yield* limiterB.consume("shared:1", rule);
        expect(deniedAtSixty).toEqual({
          allowed: false,
          retryAfterSeconds: 40,
        });

        const rows = yield* sql<{ count: string }>`
          select count(*)::text as count from auth.rate_limit
          where starts_with(key, 'edge:shared:1#')`;
        expect(Number(rows[0]?.count)).toBe(3);

        // Seed a non-edge Better Auth counter row to verify edge idle pruning leaves it intact.
        yield* sql`
          insert into auth.rate_limit (id, key, count, last_request)
          values ('ba-row-1', '/sign-in/email:127.0.0.1', 2, ${Date.parse("2026-11-23T12:00:00Z")})`;

        // Idle key cleanup: after 2 minutes of inactivity, a request on another key reclaims
        // expired edge rows belonging to idle keys without touching Better Auth rows.
        yield* TestClock.adjust(Duration.minutes(2));
        const otherKey = yield* limiterA.consume("other:key", rule);
        expect(otherKey).toEqual({ allowed: true });
        const staleRows = yield* sql<{ count: string }>`
          select count(*)::text as count from auth.rate_limit
          where starts_with(key, 'edge:shared:1#')`;
        expect(Number(staleRows[0]?.count)).toBe(0);
        const betterAuthRows = yield* sql<{ count: string }>`
          select count(*)::text as count from auth.rate_limit
          where key = '/sign-in/email:127.0.0.1'`;
        expect(Number(betterAuthRows[0]?.count)).toBe(1);
      }).pipe(Effect.provide(coreLayer)),
    );
  });

  test("HTTP edge routes return 429 with Retry-After over a trailing sliding window", async () => {
    const app = makeHarness();
    harness = app;
    const challenge = () => app.fetch("/api/v1/bot-protection/challenges/sign_up");
    const challengeStatuses = (length: number) =>
      Array.fromAsync({ length }, async () => (await challenge()).status);

    // botChallenge limit is 30/min per IP. Send 10 at t=0s and 20 at t=40s.
    const initial = await challengeStatuses(10);
    expect(initial).toEqual(Array.from({ length: 10 }, () => 204));

    await app.run(TestClock.adjust(Duration.seconds(40)));
    const atForty = await challengeStatuses(20);
    expect(atForty).toEqual(Array.from({ length: 20 }, () => 204));

    // At t=50s: 31st request gets 429 with Retry-After: 10.
    await app.run(TestClock.adjust(Duration.seconds(10)));
    const denied = await challenge();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("10");
    expect(await denied.json()).toEqual({ _tag: "RateLimited", retryAfterSeconds: 10 });

    // At t=60s: only the 10 from t=0s expired; 10 succeed and the 11th gets 429 with Retry-After: 40.
    await app.run(TestClock.adjust(Duration.seconds(10)));
    const atSixty = await challengeStatuses(10);
    expect(atSixty).toEqual(Array.from({ length: 10 }, () => 204));
    const deniedAgain = await challenge();
    expect(deniedAgain.status).toBe(429);
    expect(deniedAgain.headers.get("retry-after")).toBe("40");
  });
});
