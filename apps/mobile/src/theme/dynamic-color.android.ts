/**
 * Android 12+ (API 31+) Material You (Monet) dynamic colour bridge for ThemeState.system.dynamic.
 * Resolves the Android system accent/neutral resources through React Native's built-in
 * `PlatformColor` + `processColor` (no extra native dependency), falling back safely to `null`
 * on Android < 12 or whenever the platform cannot resolve the Monet resources.
 */
import type { Hex } from "@kvitbit/domain/contract";
import type { DynamicColorInput } from "@kvitbit/ui-port/theme";
import * as RN from "react-native";

const ANDROID_MONET_MIN_API = 31;

export interface AndroidDynamicColorEnv {
  readonly os: string;
  readonly version: number | string;
  readonly resolveResource: (resourceName: string) => number | null;
}

/** Converts a React Native ARGB 32-bit integer to an uppercase `#RRGGBB` hex string. */
export const argbToHex = (value: number): Hex | null => {
  if (!Number.isFinite(value)) return null;
  const rgb = (value >>> 0) & 0x00ffffff;
  return `#${rgb.toString(16).toUpperCase().padStart(6, "0")}` as Hex;
};

const parseApiLevel = (version: number | string): number => {
  if (typeof version === "number") return version;
  const parsed = Number.parseInt(version, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const defaultEnv = (): AndroidDynamicColorEnv => {
  const rn = RN as unknown as {
    readonly Platform?: { readonly OS?: string; readonly Version?: number | string };
    readonly PlatformColor?: (name: string) => unknown;
    readonly processColor?: (color: unknown) => unknown;
  };
  return {
    os: rn.Platform?.OS ?? "",
    version: rn.Platform?.Version ?? 0,
    resolveResource: (resourceName) => {
      if (typeof rn.PlatformColor !== "function" || typeof rn.processColor !== "function") {
        return null;
      }
      try {
        const color = rn.processColor(rn.PlatformColor(resourceName));
        return typeof color === "number" ? color : null;
      } catch {
        return null;
      }
    },
  };
};

/**
 * Reads the Android 12+ Material You Monet palette. Prefers mapping the key system tonal roles
 * (`system_accent1_*`, `system_neutral1_*`) so `dynamicRoles` keeps the OS palette; falls back to
 * a single `Seed` if only `system_accent1_500` resolves, or `null` when unsupported.
 */
export const makeAndroidDynamicColorReader =
  (getEnv: () => AndroidDynamicColorEnv = defaultEnv) =>
  async (): Promise<DynamicColorInput | null> => {
    const env = getEnv();
    if (env.os !== "android" || parseApiLevel(env.version) < ANDROID_MONET_MIN_API) {
      return null;
    }
    const read = (name: string): Hex | null => {
      try {
        const raw = env.resolveResource(name);
        return raw === null ? null : argbToHex(raw);
      } catch {
        return null;
      }
    };

    const lightPrimary = read("@android:color/system_accent1_600");
    const darkPrimary = read("@android:color/system_accent1_200");
    const lightSurface = read("@android:color/system_neutral1_10");
    const darkSurface = read("@android:color/system_neutral1_900");
    const lightSecondary = read("@android:color/system_accent2_600");
    const darkSecondary = read("@android:color/system_accent2_200");
    const lightTertiary = read("@android:color/system_accent3_600");
    const darkTertiary = read("@android:color/system_accent3_200");

    if (lightPrimary !== null && darkPrimary !== null) {
      return {
        _tag: "Roles",
        light: {
          primary: lightPrimary,
          ...(lightSecondary !== null ? { secondary: lightSecondary } : {}),
          ...(lightTertiary !== null ? { tertiary: lightTertiary } : {}),
          ...(lightSurface !== null ? { surface: lightSurface } : {}),
        },
        dark: {
          primary: darkPrimary,
          ...(darkSecondary !== null ? { secondary: darkSecondary } : {}),
          ...(darkTertiary !== null ? { tertiary: darkTertiary } : {}),
          ...(darkSurface !== null ? { surface: darkSurface } : {}),
        },
      };
    }

    const seed = read("@android:color/system_accent1_500");
    return seed === null ? null : { _tag: "Seed", seed };
  };

export const readDynamicColor = makeAndroidDynamicColorReader();
