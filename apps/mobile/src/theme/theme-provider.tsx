import { uniwindThemeVariables } from "@kvitbit/ui-port/style";
import type { NativeTheme } from "@kvitbit/ui-port/theme";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, AppState, useColorScheme } from "react-native";
import { Uniwind } from "uniwind";
import { readDynamicColor } from "./dynamic-color";
import {
  type AppTheme,
  appTheme,
  DEFAULT_PREFERENCE,
  type DeviceTheme,
  type ThemePreference,
  themeStateOf,
} from "./theme-state";

interface ThemeContextValue extends AppTheme {
  readonly preference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
  /** Whether the device offers a dynamic palette (drives the Settings switch). */
  readonly dynamicAvailable: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const useHighContrast = (): boolean => {
  const [high, setHigh] = useState(false);
  useEffect(() => {
    let live = true;
    // `isHighTextContrastEnabled` is Android-only; elsewhere it resolves false.
    AccessibilityInfo.isHighTextContrastEnabled?.()
      .then((v) => live && setHigh(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener("highTextContrastChanged", setHigh);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return high;
};

/** Re-reads the system palette on launch and whenever the app returns to the foreground. */
const useDynamicColor = (): DeviceTheme["dynamic"] => {
  const [dynamic, setDynamic] = useState<DeviceTheme["dynamic"]>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      readDynamicColor()
        .then((v) => live && setDynamic(v))
        .catch(() => undefined);
    void read();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void read());
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return dynamic;
};

export const syncUniwindTheme = (theme: AppTheme): void => {
  const themeName = theme.native.dark ? "dark" : "light";
  Uniwind.setTheme(themeName);
  Uniwind.updateCSSVariables(themeName, uniwindThemeVariables(theme.effective));
};

export function ThemeProvider(props: {
  readonly children: ReactNode;
  readonly initialPreference?: ThemePreference;
  readonly onPreferenceChange?: (next: ThemePreference) => void;
}) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const highContrast = useHighContrast();
  const dynamic = useDynamicColor();
  const [preference, setPreferenceState] = useState(props.initialPreference ?? DEFAULT_PREFERENCE);
  const { onPreferenceChange } = props;
  const value = useMemo<ThemeContextValue>(() => {
    const theme = appTheme(themeStateOf({ scheme, highContrast, dynamic }, preference));
    return {
      ...theme,
      preference,
      dynamicAvailable: dynamic !== null,
      setPreference: (next) => {
        setPreferenceState(next);
        onPreferenceChange?.(next);
      },
    };
  }, [scheme, highContrast, dynamic, preference, onPreferenceChange]);
  useEffect(() => {
    syncUniwindTheme(value);
  }, [value]);
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export const useAppTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useAppTheme needs a ThemeProvider");
  return value;
};

/** The render-ready theme object (colour roles, fonts, shape). */
export const useTheme = (): NativeTheme => useAppTheme().native;
