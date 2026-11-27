/**
 * The device side of ui-port's `ThemeState` (ui-port-contracts 4.1, 4.2): system scheme, the
 * Android 12+ dynamic palette and the stored preference. Pure, so the provider only wires inputs.
 */
import type { ThemeContrast, ThemeMode, ThemeStyle } from "@kvitbit/api-contract";
import { Hex } from "@kvitbit/domain/contract";
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
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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

type DeviceColorReport =
  | Extract<DynamicColorInput, { readonly _tag: "Roles" }>
  | { readonly _tag: "Seed"; readonly seed: string };

/** Dynamic roles from the platform report; a malformed report counts as none. */
export const deviceDynamicRoles = (
  input: DeviceColorReport | null,
): Option.Option<DynamicRoles> => {
  if (input === null) return Option.none();
  if (input._tag === "Seed") {
    return Schema.decodeOption(Hex)(input.seed).pipe(
      Option.flatMap((seed) => Result.getSuccess(dynamicRoles({ _tag: "Seed", seed }))),
    );
  }
  return Result.getSuccess(dynamicRoles(input));
};

type ThemeOverrides = Pick<ThemeState, "account" | "workspace" | "draft">;

export const themeStateOf: {
  (preference: ThemePreference, base?: ThemeOverrides): (device: DeviceTheme) => ThemeState;
  (device: DeviceTheme, preference: ThemePreference, base?: ThemeOverrides): ThemeState;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], "scheme"),
  (
    device: DeviceTheme,
    preference: ThemePreference,
    base: ThemeOverrides = initialThemeState(),
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
  }),
);

export interface AppTheme {
  readonly effective: EffectiveTheme;
  readonly native: NativeTheme;
}

export const appTheme = (state: ThemeState): AppTheme => {
  const effective = effectiveTheme(state);
  return { effective, native: nativeTheme(effective) };
};
