import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { makeEmailRateLimiter } from "../../src/auth";
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
    expect(result[5]).toEqual({ allowed: false, retryAfterSeconds: 12 });
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

  test("the window rolls instead of resetting at a fixed boundary", async () => {
    const admitted = await run((consume) =>
      Effect.gen(function* () {
        const out: Array<boolean> = [];
        out.push(yield* consume("roll@example.com")); // t = 0
        yield* at(50);
        for (let i = 0; i < 4; i++) out.push(yield* consume("roll@example.com"));
        // A fixed window started at t = 0 would grant five fresh requests at t = 61. A rolling
        // one has only let the t = 0 request age out.
        yield* at(61);
        out.push(yield* consume("roll@example.com"));
        out.push(yield* consume("roll@example.com"));
        return out;
      }),
    );
    expect(admitted).toEqual([true, true, true, true, true, true, false]);
  });

  test("a refused request leaves the allowance unchanged", async () => {
    const admitted = await run((consume) =>
      Effect.gen(function* () {
        for (let i = 0; i < 5; i++) yield* consume("refused@example.com");
        const out: Array<boolean> = [];
        for (let i = 0; i < 10; i++) out.push(yield* consume("refused@example.com"));
        // Retry-After was 12 s; refusals did not push it further.
        yield* at(12);
        out.push(yield* consume("refused@example.com"));
        return out;
      }),
    );
    expect(admitted.slice(0, 10).every((a) => !a)).toBe(true);
    expect(admitted[10]).toBe(true);
  });
});
