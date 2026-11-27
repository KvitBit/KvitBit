import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, References } from "effect";
import { RequestLogContext } from "../logging/trace";

const authLogContext = new AsyncLocalStorage<Context.Context<never>>();
const pickLogContext = Context.pick(
  References.CurrentLoggers,
  References.CurrentLogAnnotations,
  References.CurrentLogSpans,
  References.MinimumLogLevel,
  RequestLogContext,
);

export const currentAuthLogContext = (): Context.Context<never> | undefined =>
  authLogContext.getStore();

// Better Auth invokes callbacks in Promise code, outside the request's Effect fiber.
export const bindAuthLogging = Effect.withFiberSucceed((fiber) => {
  const context = pickLogContext(fiber.context);
  return <A>(callback: () => A): A => authLogContext.run(context, callback);
});

export const makeAuthEffectRunner = Effect.withFiberSucceed((fiber) => {
  const fallback = pickLogContext(fiber.context);
  return <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseWith(currentAuthLogContext() ?? fallback)(effect);
});

export type AuthEffectRunner = Effect.Success<typeof makeAuthEffectRunner>;
