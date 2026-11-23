/**
 * Material 3 scheme generation from a theme recipe: six tonal palettes (primary, secondary,
 * tertiary, error, and neutral / neutral variant tinted by the recipe's hue) mapped to every
 * `M3ColorRole` for light and dark at standard, medium and high contrast.
 *
 * The mapping is tonal-spot-like with two Kvitbit refinements: light `primary` keeps the seed's
 * own tone when it is dark enough to carry white text (fidelity, so brand seeds render as
 * themselves), and the neutral ramps take a per-recipe chroma so each preset has its own
 * undertone (DESIGN.md "Tonal surface harmonization").
 */
import { type Hex, M3_COLOR_ROLES, type M3ColorRole } from "@kvitbit/api-contract";
import { Hct } from "./color/hct";
import { TonalPalette } from "./color/palette";
import { clamp, hexFromRgb, rgbFromHex } from "./color/utils";

export type RoleMap = Readonly<Record<M3ColorRole, Hex>>;

/** The six scheme variants a `ResolvedTheme` carries, in `ResolvedTheme.schemes` key order. */
export const SCHEME_VARIANTS = [
  "light",
  "dark",
  "lightMedium",
  "lightHigh",
  "darkMedium",
  "darkHigh",
] as const;
export type SchemeVariant = (typeof SCHEME_VARIANTS)[number];

export const variantOf = (
  scheme: "light" | "dark",
  contrast: "standard" | "medium" | "high",
): SchemeVariant =>
  contrast === "standard"
    ? scheme
    : (`${scheme}${contrast === "medium" ? "Medium" : "High"}` as SchemeVariant);

export const isDarkVariant = (v: SchemeVariant): boolean => v.startsWith("dark");

/** 0 standard, 1 medium, 2 high. */
export const contrastLevelOf = (v: SchemeVariant): 0 | 1 | 2 =>
  v.endsWith("High") ? 2 : v.endsWith("Medium") ? 1 : 0;

export interface PaletteTuning {
  /** Hue offset from the seed hue, degrees. */
  readonly hueShift?: number;
  /** Absolute hue, wins over `hueShift` (used to give achromatic seeds a chosen undertone). */
  readonly hue?: number;
  readonly chroma: number;
}

/** Everything that defines a generated theme. Presets add tuning; a custom seed uses defaults. */
export interface ThemeRecipe {
  readonly seed: Hex;
  /** Primary palette; default the seed's own hue and chroma (fidelity). */
  readonly primary?: PaletteTuning;
  readonly secondary?: PaletteTuning;
  readonly tertiary?: PaletteTuning;
  readonly neutral?: PaletteTuning;
  readonly neutralVariant?: PaletteTuning;
  /** Exact role values that replace generated ones per variant (Graphite Atelier's DESIGN.md table). */
  readonly overrides?: Readonly<Partial<Record<SchemeVariant, Partial<RoleMap>>>>;
}

export interface SchemePalettes {
  readonly seed: Hct;
  readonly primary: TonalPalette;
  readonly secondary: TonalPalette;
  readonly tertiary: TonalPalette;
  readonly error: TonalPalette;
  readonly neutral: TonalPalette;
  readonly neutralVariant: TonalPalette;
  /** Light standard `primary` tone. */
  readonly primaryTone: number;
}

const tuned = (seed: Hct, tuning: PaletteTuning | undefined, fallback: PaletteTuning) => {
  const t = tuning ?? fallback;
  const hue = t.hue ?? seed.hue + (t.hueShift ?? 0);
  return TonalPalette.fromHueAndChroma(hue, t.chroma);
};

/**
 * Palettes for a recipe. Defaults scale with the seed's chroma so a grey seed stays grey and a
 * vivid one gets tonal-spot companions: secondary at a third of primary (max 16), tertiary
 * rotated 60 degrees (max 24), neutral and neutral variant at up to 6 and 8.
 */
export const palettesOf = (recipe: ThemeRecipe): SchemePalettes => {
  const seed = Hct.fromRgb(rgbFromHex(recipe.seed));
  const primary = tuned(seed, recipe.primary, { chroma: seed.chroma });
  const pc = primary.chroma;
  return {
    seed,
    primary,
    secondary: tuned(seed, recipe.secondary, { chroma: Math.min(16, pc / 3) }),
    tertiary: tuned(seed, recipe.tertiary, { hueShift: 60, chroma: Math.min(24, pc / 2) }),
    error: TonalPalette.fromHueAndChroma(25, 84),
    neutral: tuned(seed, recipe.neutral, { chroma: Math.min(6, pc / 8) }),
    neutralVariant: tuned(seed, recipe.neutralVariant, { chroma: Math.min(8, pc / 6) }),
    primaryTone: clamp(25, 45, Math.round(seed.tone)),
  };
};

type Tones = readonly [std: number, medium: number, high: number];
interface RoleTone {
  readonly palette: Exclude<keyof SchemePalettes, "seed" | "primaryTone">;
  readonly light: Tones;
  readonly dark: Tones;
}

/** Accent family tones (primary, secondary, tertiary, error and extended colours share them). */
export const ACCENT_TONES = {
  color: { light: [40, 32, 22], dark: [80, 86, 92] },
  onColor: { light: [100, 100, 100], dark: [20, 10, 0] },
  container: { light: [90, 92, 94], dark: [30, 26, 22] },
  onContainer: { light: [10, 6, 0], dark: [90, 96, 100] },
} as const satisfies Record<string, Omit<RoleTone, "palette">>;

const accent = (
  palette: RoleTone["palette"],
): Record<"color" | "onColor" | "container" | "onContainer", RoleTone> => ({
  color: { palette, ...ACCENT_TONES.color },
  onColor: { palette, ...ACCENT_TONES.onColor },
  container: { palette, ...ACCENT_TONES.container },
  onContainer: { palette, ...ACCENT_TONES.onContainer },
});

const fixed = (palette: RoleTone["palette"]) => ({
  fixed: { palette, light: [90, 90, 90], dark: [90, 90, 90] } as RoleTone,
  fixedDim: { palette, light: [80, 80, 80], dark: [80, 80, 80] } as RoleTone,
  onFixed: { palette, light: [10, 5, 0], dark: [10, 5, 0] } as RoleTone,
  onFixedVariant: { palette, light: [30, 25, 20], dark: [30, 25, 20] } as RoleTone,
});

const n = (light: Tones, dark: Tones): RoleTone => ({ palette: "neutral", light, dark });
const nv = (light: Tones, dark: Tones): RoleTone => ({ palette: "neutralVariant", light, dark });

const P = accent("primary");
const S = accent("secondary");
const T = accent("tertiary");
const E = accent("error");
const PF = fixed("primary");
const SF = fixed("secondary");
const TF = fixed("tertiary");

const SURFACE = n([98, 98, 99], [6, 5, 4]);
const ON_SURFACE = n([10, 6, 0], [90, 96, 100]);

/** Tone of every role per variant. `primary` in light is replaced by the fidelity tone below. */
const ROLE_TONES: Record<M3ColorRole, RoleTone> = {
  primary: P.color,
  onPrimary: P.onColor,
  primaryContainer: P.container,
  onPrimaryContainer: P.onContainer,
  primaryFixed: PF.fixed,
  primaryFixedDim: PF.fixedDim,
  onPrimaryFixed: PF.onFixed,
  onPrimaryFixedVariant: PF.onFixedVariant,
  inversePrimary: { palette: "primary", light: [80, 85, 90], dark: [40, 32, 25] },
  secondary: S.color,
  onSecondary: S.onColor,
  secondaryContainer: S.container,
  onSecondaryContainer: S.onContainer,
  secondaryFixed: SF.fixed,
  secondaryFixedDim: SF.fixedDim,
  onSecondaryFixed: SF.onFixed,
  onSecondaryFixedVariant: SF.onFixedVariant,
  tertiary: T.color,
  onTertiary: T.onColor,
  tertiaryContainer: T.container,
  onTertiaryContainer: T.onContainer,
  tertiaryFixed: TF.fixed,
  tertiaryFixedDim: TF.fixedDim,
  onTertiaryFixed: TF.onFixed,
  onTertiaryFixedVariant: TF.onFixedVariant,
  error: E.color,
  onError: E.onColor,
  errorContainer: E.container,
  onErrorContainer: E.onContainer,
  background: SURFACE,
  onBackground: ON_SURFACE,
  surface: SURFACE,
  onSurface: ON_SURFACE,
  surfaceVariant: nv([90, 90, 92], [30, 30, 30]),
  onSurfaceVariant: nv([30, 22, 12], [80, 88, 95]),
  surfaceDim: n([87, 85, 82], [6, 5, 4]),
  surfaceBright: n([98, 98, 99], [24, 26, 28]),
  surfaceContainerLowest: n([100, 100, 100], [4, 3, 2]),
  surfaceContainerLow: n([96, 96, 97], [10, 9, 8]),
  surfaceContainer: n([94, 94, 95], [12, 12, 11]),
  surfaceContainerHigh: n([92, 92, 93], [17, 17, 16]),
  surfaceContainerHighest: n([90, 90, 91], [22, 22, 21]),
  surfaceTint: P.color,
  inverseSurface: n([20, 15, 10], [90, 94, 98]),
  inverseOnSurface: n([95, 97, 100], [20, 10, 0]),
  outline: nv([50, 40, 28], [60, 70, 80]),
  outlineVariant: nv([80, 70, 55], [30, 40, 55]),
  shadow: n([0, 0, 0], [0, 0, 0]),
  scrim: n([0, 0, 0], [0, 0, 0]),
};

/** The tone a role takes in a variant, honouring light `primary` fidelity. */
export const toneOf = (role: M3ColorRole, variant: SchemeVariant, p: SchemePalettes): number => {
  const spec = ROLE_TONES[role];
  const level = contrastLevelOf(variant);
  const tones = isDarkVariant(variant) ? spec.dark : spec.light;
  const tone = tones[level];
  const tintsPrimary = role === "primary" || role === "surfaceTint";
  if (!tintsPrimary || isDarkVariant(variant)) return tone;
  return level === 0 ? p.primaryTone : Math.min(tone, p.primaryTone);
};

/** Every role for one variant, before overrides. */
export const generateRoles = (p: SchemePalettes, variant: SchemeVariant): RoleMap => {
  const out = {} as Record<M3ColorRole, Hex>;
  for (const role of M3_COLOR_ROLES) {
    out[role] = hexFromRgb(p[ROLE_TONES[role].palette].tone(toneOf(role, variant, p)));
  }
  return out;
};

/**
 * Overrides for a medium / high variant derived from the standard variant's overrides: each
 * overridden colour keeps its own hue and chroma and moves by the same tone step the generated
 * role takes from standard to this variant. So an exact design value (Graphite Atelier's
 * `#18181B` primary) never loses contrast when more contrast is requested.
 */
const derivedOverrides = (
  recipe: ThemeRecipe,
  variant: SchemeVariant,
  p: SchemePalettes,
): Partial<RoleMap> => {
  const level = contrastLevelOf(variant);
  if (level === 0) return {};
  const base: SchemeVariant = isDarkVariant(variant) ? "dark" : "light";
  const std = recipe.overrides?.[base] ?? {};
  const out: Partial<Record<M3ColorRole, Hex>> = {};
  for (const role of Object.keys(std) as M3ColorRole[]) {
    const hex = std[role];
    if (hex === undefined) continue;
    const step = toneOf(role, variant, p) - toneOf(role, base, p);
    const own = Hct.fromRgb(rgbFromHex(hex));
    out[role] =
      step === 0
        ? hex
        : hexFromRgb(Hct.from(own.hue, own.chroma, clamp(0, 100, own.tone + step)).rgb);
  }
  return out;
};

/** Generated roles with the recipe's exact overrides applied (derived ones for contrast variants). */
export const schemeRoles = (
  recipe: ThemeRecipe,
  variant: SchemeVariant,
  palettes: SchemePalettes = palettesOf(recipe),
): RoleMap => ({
  ...generateRoles(palettes, variant),
  ...derivedOverrides(recipe, variant, palettes),
  ...recipe.overrides?.[variant],
});
