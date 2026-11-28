import * as Effect from "effect/Effect";
import { runMobileEffect } from "../../runtime/request-intent";

export const BACKGROUND_CAPTURE_DRAIN_TASK = "kvitbit.expense-capture.drain";
export const BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES = 15;

export const registerBackgroundCaptureDrain = (): Promise<boolean> =>
  runMobileEffect(Effect.succeed(false));

export const unregisterBackgroundCaptureDrain = (): Promise<boolean> =>
  runMobileEffect(Effect.succeed(false));
