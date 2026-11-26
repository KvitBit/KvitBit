/**
 * The device side of ui-port's `ThemeState` (ui-port-contracts 4.1, 4.2): system scheme, the
 * Android 12+ dynamic palette and the stored preference. Pure, so the provider only wires inputs.
 */
import type { ThemeContrast, ThemeMode, ThemeStyle } from "@kvitbit/api-contract";
import {
  type DynamicColorInput,
  type DynamicRoles,
  dynamicRoles,
  type EffectiveTheme,
  effectiveTheme,
  initialThemeState,
  type NativeTheme,
  nativeTheme,
  type ThemeState,
} from "@kvitbit/ui-port/theme";
import { Option, Result } from "effect";

export interface ThemePreference {
  readonly mode: ThemeMode;
  readonly style: ThemeStyle;
  readonly contrast: ThemeContrast;
  readonly dynamicColor: boolean;
}

export const DEFAULT_PREFERENCE: ThemePreference = {
  mode: "system",
  style: "elegant",
  contrast: "standard",
  dynamicColor: true,
};

export interface DeviceTheme {
  readonly scheme: "light" | "dark";
  readonly highContrast: boolean;
  /** What the platform reported for dynamic colour; null when it has none (web, Android < 12). */
  readonly dynamic: DynamicColorInput | null;
}

/** Dynamic roles from the platform report; a malformed report counts as none. */
export const deviceDynamicRoles = (
  input: DynamicColorInput | null,
): Option.Option<DynamicRoles> => {
  if (input === null) return Option.none();
  const roles = dynamicRoles(input);
  return Result.isSuccess(roles) ? Option.some(roles.success) : Option.none();
};

export const themeStateOf = (
  device: DeviceTheme,
  preference: ThemePreference,
  base: Pick<ThemeState, "account" | "workspace" | "draft"> = initialThemeState(),
): ThemeState => ({
  preference: { ...preference, source: Option.none() },
  system: {
    scheme: device.scheme,
    highContrast: device.highContrast,
    dynamic: deviceDynamicRoles(device.dynamic),
  },
  account: base.account,
  workspace: base.workspace,
  draft: base.draft,
});

export interface AppTheme {
  readonly effective: EffectiveTheme;
  readonly native: NativeTheme;
}

export const appTheme = (state: ThemeState): AppTheme => {
  const effective = effectiveTheme(state);
  return { effective, native: nativeTheme(effective) };
};
