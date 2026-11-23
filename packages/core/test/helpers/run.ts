/** Runners for one-line tests. */
import type { Caller } from "@kvitbit/domain/contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import type { Exit } from "effect";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { InMemoryPortsOptions } from "../../src/testing";
import { InMemoryPortsLive } from "../../src/testing";

/** 2026-11-23T09:00:00Z: the TestClock's starting instant in `runTest`. */
export const TEST_NOW = Date.UTC(2026, 10, 23, 9, 0, 0);

/** Runs `effect` as `caller` and returns its Exit. */
export const runWithCaller = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, CurrentCaller>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.provideService(effect, CurrentCaller, caller));

type TestServices = Layer.Success<ReturnType<typeof InMemoryPortsLive>> | CurrentCaller;

/**
 * Runs `effect` as `caller` on fresh in-memory ports and a TestClock set to `TEST_NOW`.
 * Returns the Exit, so failures are asserted with `Exit.fail(...)`.
 */
export const runTest = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, TestServices>,
  options: InMemoryPortsOptions = {},
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    Effect.andThen(TestClock.setTime(TEST_NOW), effect).pipe(
      Effect.provideService(CurrentCaller, caller),
      Effect.provide(Layer.merge(InMemoryPortsLive(options), TestClock.layer())),
    ),
  );
