/**
 * Material 3 theme wire types (agreement AG-HTTP-THEME, http-mcp-contracts section 3.5.2).
 * Hex, ThemePresetId, ThemeSource and ThemePreference are core's and re-exported unchanged;
 * this module adds the preset table, the resolved schemes and the account preferences.
 */

import {
  Hex,
  Locale,
  ThemeContrast,
  ThemePreference,
  type ThemePresetId,
  ThemeSource,
} from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";

export {
  DEFAULT_THEME_PRESET,
  DEFAULT_THEME_STYLE,
  Hex,
  ThemeContrast,
  ThemeMode,
  ThemePreference,
  ThemePresetId,
  ThemeSource,
  ThemeStyle,
} from "@kvitbit/domain/contract";

/**
 * Seed per built-in preset; ui-port shows swatches from `seed`. The spec fixes the ids, the seeds
 * are ui-port's tuned design values (packages/ui-port/src/theme/presets.ts; its preset test
 * keeps the two tables equal): graphite_atelier is the achromatic brand ink, forest is
 * DESIGN.md's Banknote Emerald and sand is its Prague Ledger blue.
 */
export const ThemePresets: Readonly<
  Record<ThemePresetId, { readonly seed: Hex; readonly contrast?: ThemeContrast }>
> = {
  graphite_atelier: { seed: "#111111" },
  forest: { seed: "#0F5D42" },
  ocean: { seed: "#0E6B8C" },
  plum: { seed: "#6B2D5C" },
  sand: { seed: "#1D4ED8" },
  graphite: { seed: "#4B5563" },
};

/** The full Material 3 colour role set (material-color-utilities DynamicScheme roles). */
export const M3_COLOR_ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "primaryFixed",
  "primaryFixedDim",
  "onPrimaryFixed",
  "onPrimaryFixedVariant",
  "inversePrimary",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "secondaryFixed",
  "secondaryFixedDim",
  "onSecondaryFixed",
  "onSecondaryFixedVariant",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "tertiaryFixed",
  "tertiaryFixedDim",
  "onTertiaryFixed",
  "onTertiaryFixedVariant",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "background",
  "onBackground",
  "surface",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "surfaceTint",
  "inverseSurface",
  "inverseOnSurface",
  "outline",
  "outlineVariant",
  "shadow",
  "scrim",
] as const;
export const M3ColorRole = Schema.Literals(M3_COLOR_ROLES);
export type M3ColorRole = typeof M3ColorRole.Type;

export const EXTENDED_ROLES = ["paid", "proforma", "overdue", "draft"] as const;
export const ExtendedRole = Schema.Literals(EXTENDED_ROLES);
export type ExtendedRole = typeof ExtendedRole.Type;

export const ExtendedColor = Schema.Struct({
  color: Hex,
  onColor: Hex,
  colorContainer: Hex,
  onColorContainer: Hex,
});
export type ExtendedColor = typeof ExtendedColor.Type;

export const ResolvedScheme = Schema.Struct({
  roles: Schema.Record(M3ColorRole, Hex),
  extended: Schema.Struct({
    paid: ExtendedColor,
    proforma: ExtendedColor,
    overdue: ExtendedColor,
    draft: ExtendedColor,
  }),
});
export type ResolvedScheme = typeof ResolvedScheme.Type;

/** Warnings travel in the resolved view, never as rejections (rule T2). */
export const ThemeWarning = Schema.Literals(["theme.low_contrast"]);
export type ThemeWarning = typeof ThemeWarning.Type;

export const ResolvedTheme = Schema.Struct({
  source: ThemeSource,
  schemes: Schema.Struct({
    light: ResolvedScheme,
    dark: ResolvedScheme,
    lightMedium: ResolvedScheme,
    lightHigh: ResolvedScheme,
    darkMedium: ResolvedScheme,
    darkHigh: ResolvedScheme,
  }),
  warnings: ThemeWarning.pipe(Schema.Array, Schema.optional),
});
export type ResolvedTheme = typeof ResolvedTheme.Type;

/** `POST /api/v1/themes/resolve` body. */
export const ThemeResolveRequest = Schema.Struct({
  source: ThemeSource,
  contrast: Schema.optional(ThemeContrast),
});
export type ThemeResolveRequest = typeof ThemeResolveRequest.Type;

export const AccountPreferences = Schema.Struct({
  locale: Schema.NullOr(Locale),
  theme: ThemePreference,
  resolvedTheme: Schema.NullOr(ResolvedTheme), // null when source is null
  revision: Schema.Int,
});
export type AccountPreferences = typeof AccountPreferences.Type;

/** `PATCH /api/v1/me/preferences` body; `locale: null` falls back to Accept-Language. */
export const AccountPreferencesPatch = Schema.Struct({
  locale: Locale.pipe(Schema.NullOr, Schema.optional),
  theme: Schema.optional(ThemePreference),
});
export type AccountPreferencesPatch = typeof AccountPreferencesPatch.Type;
