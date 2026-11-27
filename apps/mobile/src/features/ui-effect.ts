import type * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

// Screen event handlers bridge Effect to React callbacks and existing platform Promise ports.
const runtime = ManagedRuntime.make(Layer.empty);

export const runFeatureEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
export const runFeatureSync = runtime.runSync;
export const runFeatureCallback = <A, E>(input: {
  readonly effect: Effect.Effect<A, E>;
  readonly onExit: (exit: Exit.Exit<A, E>) => void;
}) => runtime.runCallback(input.effect, { onExit: input.onExit });
export const forkFeatureEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime.runFork(effect);
