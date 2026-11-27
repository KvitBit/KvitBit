/**
 * Android 12+ dynamic colour (Material You) for ThemeState.system.dynamic. This default
 * reports none; the platform bridge (dynamic-color.android.ts) reads the system palette.
 */
import type { DynamicColorInput } from "@kvitbit/ui-port/theme";

export const readDynamicColor = async (): Promise<DynamicColorInput | null> => null;
