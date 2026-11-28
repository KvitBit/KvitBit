import * as Effect from "effect/Effect";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, AppState, useColorScheme } from "react-native";
import { forkMobileEffect, fromMobilePromise } from "../runtime/request-intent";
import { readDynamicColor } from "./dynamic-color";
import { ThemeContext, type ThemeContextValue } from "./theme-context";
import {
  appTheme,
  DEFAULT_PREFERENCE,
  type DeviceTheme,
  type ThemePreference,
  themeStateOf,
} from "./theme-state";
import { syncUniwindTheme } from "./uniwind-theme";

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
      fromMobilePromise(readDynamicColor).pipe(
        Effect.tap((color) =>
          Effect.sync(() => {
            if (live) setDynamic(color);
          }),
        ),
        Effect.ignore,
        forkMobileEffect,
      );
    read();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") read();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return dynamic;
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
