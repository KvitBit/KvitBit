import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { emailRateLimitKey, makeEmailRateLimiter } from "../../src/auth";
import { layerFromPglite, makeMigratedPglite } from "../../src/testing";

let pg: PGlite;
beforeAll(async () => {
  pg = await makeMigratedPglite();
});
afterAll(async () => {
  await pg.close();
});

const T0 = Date.UTC(2030, 0, 1);

/** Runs `program` with a limiter and a TestClock starting at T0. */
const run = <A>(
  program: (
    consume: (email: string) => Effect.Effect<boolean, unknown>,
  ) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const limiter = yield* makeEmailRateLimiter();
      return yield* program((email) =>
        limiter.consume(email).pipe(Effect.map((decision) => decision.allowed)),
      );
    }).pipe(Effect.provide(Layer.merge(layerFromPglite(pg), TestClock.layer()))),
  );

const at = (seconds: number) => TestClock.setTime(T0 + seconds * 1000);

describe("makeEmailRateLimiter", () => {
  test("admits five per minute, then refuses with Retry-After", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const limiter = yield* makeEmailRateLimiter();
        const decisions = [];
        for (let i = 0; i < 6; i++) decisions.push(yield* limiter.consume("five@example.com"));
        return decisions;
      }).pipe(Effect.provide(Layer.merge(layerFromPglite(pg), TestClock.layer()))),
    );
    expect(result.slice(0, 5).every((d) => d.allowed)).toBe(true);
    expect(result[5]).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  test("one allowance per normalized address", async () => {
    const admitted = await run((consume) =>
      Effect.gen(function* () {
        const spellings = [
          "Same@Example.com",
          " same@example.com",
          "SAME@EXAMPLE.COM ",
          "same@example.com",
        ];
        const out = [];
        for (const s of [...spellings, "same@example.com", "same@example.com"]) {
          out.push(yield* consume(s));
        }
        return out;
      }),
    );
    expect(admitted).toEqual([true, true, true, true, true, false]);
  });

  test("the window slides: never more than five in any trailing minute", async () => {
    const admitted = await run((consume) =>
      Effect.gen(function* () {
        const out: Array<boolean> = [];
        out.push(yield* consume("roll@example.com")); // t = 0
        yield* at(50);
        for (let i = 0; i < 4; i++) out.push(yield* consume("roll@example.com")); // t = 50
        // Before the t = 0 admission leaves the window, nothing more is admitted.
        yield* at(12);
        out.push(yield* consume("roll@example.com"));
        yield* at(59);
        out.push(yield* consume("roll@example.com"));
        // At t = 61 only the t = 0 admission has aged out: one more, not five.
        yield* at(61);
        out.push(yield* consume("roll@example.com"));
        out.push(yield* consume("roll@example.com"));
        // The t = 50 admissions leave at t = 110.
        yield* at(110);
        for (let i = 0; i < 4; i++) out.push(yield* consume("roll@example.com"));
        out.push(yield* consume("roll@example.com"));
        return out;
      }),
    );
    expect(admitted).toEqual([
      true,
      true,
      true,
      true,
      true, // 0, 50 x4
      false,
      false, // 12, 59
      true,
      false, // 61
      true,
      true,
      true,
      true,
      false, // 110
    ]);
  });

  test("a burst of five stays refused for the whole minute", async () => {
    const admitted = await run((consume) =>
      Effect.gen(function* () {
        for (let i = 0; i < 5; i++) yield* consume("burst@example.com");
        const out: Array<boolean> = [];
        for (const t of [12, 30, 59]) {
          yield* at(t);
          out.push(yield* consume("burst@example.com"));
        }
        yield* at(60);
        out.push(yield* consume("burst@example.com"));
        return out;
      }),
    );
    expect(admitted).toEqual([false, false, false, true]);
  });

  test("a refused request leaves the allowance unchanged", async () => {
    const admitted = await run((consume) =>
      Effect.gen(function* () {
        for (let i = 0; i < 5; i++) yield* consume("refused@example.com");
        const out: Array<boolean> = [];
        for (let i = 0; i < 10; i++) out.push(yield* consume("refused@example.com"));
        // Retry-After was 60 s; refusals did not push it further.
        yield* at(60);
        out.push(yield* consume("refused@example.com"));
        return out;
      }),
    );
    expect(admitted.slice(0, 10).every((a) => !a)).toBe(true);
    expect(admitted[10]).toBe(true);
  });

  test("a request that waited for the address lock sees admissions that expired meanwhile", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const sql = yield* SqlClient.SqlClient;
        const limiter = yield* makeEmailRateLimiter();
        for (let i = 0; i < 5; i++) yield* limiter.consume("wait@example.com");
        // Another transaction holds the address lock until t = 61.
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`select pg_advisory_xact_lock(hashtextextended(${emailRateLimitKey("wait@example.com")}, 0))`;
              yield* Effect.sleep("61 seconds");
            }),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const waiter = yield* limiter.consume("wait@example.com").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("61 seconds");
        yield* Fiber.join(holder);
        return yield* Fiber.join(waiter);
      }).pipe(Effect.provide(Layer.merge(layerFromPglite(pg), TestClock.layer()))),
    );
    expect(result).toEqual({ allowed: true });
  });
});
