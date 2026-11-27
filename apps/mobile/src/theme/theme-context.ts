import type { NativeTheme } from "@kvitbit/ui-port/theme";
import * as Option from "effect/Option";
import { createContext, useContext } from "react";
import type { AppTheme, ThemePreference } from "./theme-state";

export interface ThemeContextValue extends AppTheme {
  readonly preference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
  /** Whether the device offers a dynamic palette (drives the Settings switch). */
  readonly dynamicAvailable: boolean;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useAppTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  return Option.getOrThrowWith(
    Option.fromNullOr(value),
    () => new Error("useAppTheme needs a ThemeProvider"),
  );
};

/** The render-ready theme object (colour roles, fonts, shape). */
export const useTheme = (): NativeTheme => useAppTheme().native;
