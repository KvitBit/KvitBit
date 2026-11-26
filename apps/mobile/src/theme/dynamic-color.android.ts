/**
 * Android 12+ (API 31+) Material You (Monet) dynamic colour bridge for ThemeState.system.dynamic.
 * Resolves actual 32-bit ARGB integers through the native `KvitbitDynamicColor` Android module
 * (which reads `android.R.color.system_accent*` / `system_neutral*` via `ContextCompat.getColor`),
 * falling back safely to `null` on Android < 12 or whenever the native bridge is unavailable.
 */
import type { Hex } from "@kvitbit/domain/contract";
import type { DynamicColorInput } from "@kvitbit/ui-port/theme";
import * as RN from "react-native";

const ANDROID_MONET_MIN_API = 31;

export interface AndroidDynamicPalette {
  readonly system_accent1_600?: number;
  readonly system_accent1_200?: number;
  readonly system_accent1_500?: number;
  readonly system_accent2_600?: number;
  readonly system_accent2_200?: number;
  readonly system_accent3_600?: number;
  readonly system_accent3_200?: number;
  readonly system_neutral1_10?: number;
  readonly system_neutral1_900?: number;
}

export interface AndroidDynamicColorEnv {
  readonly os: string;
  readonly version: number | string;
  readonly getNativePalette?: () => Promise<AndroidDynamicPalette | null>;
}

/** Converts an Android ARGB 32-bit integer to an uppercase `#RRGGBB` hex string. */
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

export const readDefaultAndroidDynamicColorEnv = (): AndroidDynamicColorEnv => {
  const rn = RN as unknown as {
    readonly Platform?: { readonly OS?: string; readonly Version?: number | string };
    readonly NativeModules?: {
      readonly KvitbitDynamicColor?: {
        readonly getDynamicPalette?: () => Promise<AndroidDynamicPalette | null>;
      };
    };
  };
  const nativeModule = rn.NativeModules?.KvitbitDynamicColor;
  return {
    os: rn.Platform?.OS ?? "",
    version: rn.Platform?.Version ?? 0,
    ...(typeof nativeModule?.getDynamicPalette === "function"
      ? {
          getNativePalette: async () => {
            try {
              return (await nativeModule.getDynamicPalette?.()) ?? null;
            } catch {
              return null;
            }
          },
        }
      : {}),
  };
};

/**
 * Reads the Android 12+ Material You Monet palette. Prefers mapping the key system tonal roles
 * (`system_accent1_*`, `system_neutral1_*`) so `dynamicRoles` keeps the OS palette; falls back to
 * a single `Seed` if only `system_accent1_500` resolves, or `null` when unsupported.
 */
export const makeAndroidDynamicColorReader =
  (getEnv: () => AndroidDynamicColorEnv = readDefaultAndroidDynamicColorEnv) =>
  async (): Promise<DynamicColorInput | null> => {
    const env = getEnv();
    if (env.os !== "android" || parseApiLevel(env.version) < ANDROID_MONET_MIN_API) {
      return null;
    }

    let palette: AndroidDynamicPalette | null = null;
    if (env.getNativePalette) {
      try {
        palette = await env.getNativePalette();
      } catch {
        palette = null;
      }
    }

    const read = (key: keyof AndroidDynamicPalette): Hex | null => {
      const value = palette?.[key];
      return typeof value === "number" ? argbToHex(value) : null;
    };

    const lightPrimary = read("system_accent1_600");
    const darkPrimary = read("system_accent1_200");
    const lightSurface = read("system_neutral1_10");
    const darkSurface = read("system_neutral1_900");
    const lightSecondary = read("system_accent2_600");
    const darkSecondary = read("system_accent2_200");
    const lightTertiary = read("system_accent3_600");
    const darkTertiary = read("system_accent3_200");

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

    const seed = read("system_accent1_500");
    return seed === null ? null : { _tag: "Seed", seed };
  };

export const readDynamicColor = makeAndroidDynamicColorReader();
