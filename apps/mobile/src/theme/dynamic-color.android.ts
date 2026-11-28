/**
 * Android 12+ (API 31+) Material You (Monet) dynamic colour bridge for ThemeState.system.dynamic.
 * Resolves actual 32-bit ARGB integers through the native `KvitbitDynamicColor` Android module
 * (which reads `android.R.color.system_accent*` / `system_neutral*` via `ContextCompat.getColor`),
 * falling back safely to `null` on Android < 12 or whenever the native bridge is unavailable.
 */

import { Hex } from "@kvitbit/domain/contract";
import type { DynamicColorInput } from "@kvitbit/ui-port/theme";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { NativeModules, Platform } from "react-native";
import { fromMobilePromise, runMobileEffect } from "../runtime/request-intent";

const ANDROID_MONET_MIN_API = 31;

const nativePalette = Schema.Struct({
  system_accent1_600: Schema.optional(Schema.Unknown),
  system_accent1_200: Schema.optional(Schema.Unknown),
  system_accent1_500: Schema.optional(Schema.Unknown),
  system_accent2_600: Schema.optional(Schema.Unknown),
  system_accent2_200: Schema.optional(Schema.Unknown),
  system_accent3_600: Schema.optional(Schema.Unknown),
  system_accent3_200: Schema.optional(Schema.Unknown),
  system_neutral1_10: Schema.optional(Schema.Unknown),
  system_neutral1_900: Schema.optional(Schema.Unknown),
});
type AndroidDynamicPalette = typeof nativePalette.Type;

export interface AndroidDynamicColorEnv {
  readonly os: string;
  readonly version: number | string;
  readonly getNativePalette?: () => Promise<AndroidDynamicPalette | null>;
}

/** Converts an Android ARGB 32-bit integer to an uppercase `#RRGGBB` hex string. */
export const argbToHex = (value: number): Hex | null => {
  if (!Number.isFinite(value)) return null;
  const rgb = (value >>> 0) & 0x00ffffff;
  return Hex.make(`#${EffectString.padStart(6, "0")(EffectString.toUpperCase(rgb.toString(16)))}`);
};

const parseApiLevel = (version: number | string): number => {
  if (Predicate.isNumber(version)) return version;
  const parsed = Number.parseInt(version, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isNativePaletteSource = Schema.is(
  Schema.Struct({ getDynamicPalette: Schema.declare(Predicate.isFunction) }),
);
const decodePalette = Schema.decodeUnknownOption(nativePalette);

const readDefaultAndroidDynamicColorEnv = (): AndroidDynamicColorEnv => {
  const nativeModule = NativeModules["KvitbitDynamicColor"];
  const device = { os: Platform.OS, version: Platform.Version };
  if (!isNativePaletteSource(nativeModule)) return device;
  return {
    ...device,
    getNativePalette: () =>
      fromMobilePromise<unknown>(() => nativeModule.getDynamicPalette()).pipe(
        Effect.map((raw) => Option.getOrNull(decodePalette(raw))),
        Effect.orElseSucceed(() => null),
        runMobileEffect,
      ),
  };
};

/**
 * Reads the Android 12+ Material You Monet palette. Prefers mapping the key system tonal roles
 * (`system_accent1_*`, `system_neutral1_*`) so `dynamicRoles` keeps the OS palette; falls back to
 * a single `Seed` if only `system_accent1_500` resolves, or `null` when unsupported.
 */
export const makeAndroidDynamicColorReader = (
  getEnv: () => AndroidDynamicColorEnv = readDefaultAndroidDynamicColorEnv,
) => {
  const readColor = Effect.fn("MobileAndroidDynamicColor.read")(function* () {
    const env = getEnv();
    if (env.os !== "android" || parseApiLevel(env.version) < ANDROID_MONET_MIN_API) {
      return null;
    }

    const getPalette = env.getNativePalette;
    const palette =
      getPalette === undefined
        ? null
        : yield* fromMobilePromise(getPalette).pipe(Effect.orElseSucceed(() => null));

    const read = (key: keyof AndroidDynamicPalette): Hex | null => {
      const value = palette?.[key];
      return Predicate.isNumber(value) ? argbToHex(value) : null;
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
      const light: Partial<Record<"primary" | "secondary" | "tertiary" | "surface", Hex>> = {
        primary: lightPrimary,
      };
      if (lightSecondary !== null) light.secondary = lightSecondary;
      if (lightTertiary !== null) light.tertiary = lightTertiary;
      if (lightSurface !== null) light.surface = lightSurface;
      const dark: typeof light = { primary: darkPrimary };
      if (darkSecondary !== null) dark.secondary = darkSecondary;
      if (darkTertiary !== null) dark.tertiary = darkTertiary;
      if (darkSurface !== null) dark.surface = darkSurface;
      return { _tag: "Roles" as const, light, dark };
    }

    const seed = read("system_accent1_500");
    return seed === null ? null : { _tag: "Seed" as const, seed };
  });
  return (): Promise<DynamicColorInput | null> => runMobileEffect(readColor());
};

export const readDynamicColor = makeAndroidDynamicColorReader();
