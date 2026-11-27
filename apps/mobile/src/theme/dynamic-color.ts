/**
 * Android 12+ dynamic colour (Material You) for ThemeState.system.dynamic. This default
 * reports none; the platform bridge (dynamic-color.android.ts) reads the system palette.
 */
import type { DynamicColorInput } from "@kvitbit/ui-port/theme";
import * as Effect from "effect/Effect";
import { runMobileEffect } from "../runtime/request-intent";

export const readDynamicColor = (): Promise<DynamicColorInput | null> =>
  runMobileEffect(Effect.succeed(null));
