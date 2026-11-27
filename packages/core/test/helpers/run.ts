/** Runners for one-line tests. */
import type { Caller } from "@kvitbit/domain/contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectFunction from "effect/Function";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { InMemoryPortsOptions, TestCoreOptions, TestCoreServices } from "../../src/testing";
import { InMemoryPortsLive, TestCore } from "../../src/testing";

/** Drop Effect.fn call-site metadata before comparing a typed failure. */
export const withoutStackTrace = <A, E>(exit: Exit.Exit<A, E>): Exit.Exit<A, E> => {
  if (Exit.isSuccess(exit)) return exit;
  const reasons = EffectArray.map(exit.cause.reasons, (reason) => {
    if (!Cause.isFailReason(reason)) return reason;
    const annotations = Cause.reasonAnnotations(reason).pipe(Context.omit(Cause.StackTrace));
    return Cause.makeFailReason(reason.error).annotate(annotations);
  });
  return Exit.failCause(Cause.fromReasons(reasons));
};

/** 2026-11-23T09:00:00Z: the TestClock's starting instant in `runTest`. */
export const TEST_NOW = Date.UTC(2026, 10, 23, 9, 0, 0);

/** Runs `effect` as `caller` and returns its Exit. */
export const runWithCaller: {
  <A, E>(effect: Effect.Effect<A, E, CurrentCaller>): (caller: Caller) => Promise<Exit.Exit<A, E>>;
  <A, E>(caller: Caller, effect: Effect.Effect<A, E, CurrentCaller>): Promise<Exit.Exit<A, E>>;
} = EffectFunction.dual(
  2,
  <A, E>(caller: Caller, effect: Effect.Effect<A, E, CurrentCaller>): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(Effect.provideService(effect, CurrentCaller, caller)),
);

type TestServices = Layer.Success<ReturnType<typeof InMemoryPortsLive>> | CurrentCaller;

/**
 * Runs `effect` as `caller` on fresh in-memory ports and a TestClock set to `TEST_NOW`.
 * Returns the Exit, so failures are asserted with `Exit.fail(...)`.
 */
export const runTest: {
  <A, E>(
    effect: Effect.Effect<A, E, TestServices>,
    options?: InMemoryPortsOptions,
  ): (caller: Caller) => Promise<Exit.Exit<A, E>>;
  <A, E>(
    caller: Caller,
    effect: Effect.Effect<A, E, TestServices>,
    options?: InMemoryPortsOptions,
  ): Promise<Exit.Exit<A, E>>;
} = EffectFunction.dual(
  (args) => !Effect.isEffect(args[0]),
  <A, E>(
    caller: Caller,
    effect: Effect.Effect<A, E, TestServices>,
    options: InMemoryPortsOptions = {},
  ): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(
      Effect.andThen(TestClock.setTime(TEST_NOW), effect).pipe(
        Effect.provideService(CurrentCaller, caller),
        Effect.provide(Layer.merge(InMemoryPortsLive(options), TestClock.layer())),
      ),
    ),
);

/** Runs `effect` as `caller` (switch callers inside with `asCaller`). */
export const asCaller: {
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): (caller: Caller) => Effect.Effect<A, E, Exclude<R, CurrentCaller>>;
  <A, E, R>(
    caller: Caller,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentCaller>>;
} = EffectFunction.dual(
  2,
  <A, E, R>(
    caller: Caller,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentCaller>> =>
    Effect.provideService(effect, CurrentCaller, caller),
);

/**
 * Runs `effect` as `caller` on a fresh `TestCore` (all nine modules on real layers over memory
 * ports and fakes) and a TestClock at `TEST_NOW`. `options` seed the registry records and CNB
 * fixings (`InMemoryPortsOptions`) and the directory users. Every fake control is reachable
 * from `effect`: `StartedDeliveries` (delivery jobs), `CaptureEmailSender`,
 * `CaptureInvitationDelivery`, `FakeExportWorkflow`, `FakeReportPdfRenderer`,
 * `DocumentFixtures.renders`, `MemoryBlobStorage`; move time with `TestClock.adjust`.
 */
export const runCore: {
  <A, E>(
    effect: Effect.Effect<A, E, TestCoreServices | CurrentCaller>,
    options?: TestCoreOptions,
  ): (caller: Caller) => Promise<Exit.Exit<A, E>>;
  <A, E>(
    caller: Caller,
    effect: Effect.Effect<A, E, TestCoreServices | CurrentCaller>,
    options?: TestCoreOptions,
  ): Promise<Exit.Exit<A, E>>;
} = EffectFunction.dual(
  (args) => !Effect.isEffect(args[0]),
  <A, E>(
    caller: Caller,
    effect: Effect.Effect<A, E, TestCoreServices | CurrentCaller>,
    options: TestCoreOptions = {},
  ): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(
      Effect.andThen(TestClock.setTime(TEST_NOW), effect).pipe(
        Effect.provideService(CurrentCaller, caller),
        Effect.provide(Layer.merge(TestCore(options), TestClock.layer())),
      ),
    ),
);
