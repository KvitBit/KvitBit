import { AsyncLocalStorage } from "node:async_hooks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import { RequestLogContext } from "../logging/trace";

const authLogContext = new AsyncLocalStorage<Context.Context<never>>();
export const pickAuthLogContext = Context.pick(
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
  const context = pickAuthLogContext(fiber.context);
  return <A>(callback: () => A): A => authLogContext.run(context, callback);
});
