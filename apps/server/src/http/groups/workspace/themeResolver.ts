/**
 * Server-side Material 3 theme resolver (http-mcp-contracts 3.5.2, rules T1–T3).
 *
 * Adapted from `packages/ui-port/src/theme/` so `apps/server` resolves presets, seeds and
 * Material Theme Builder JSON identically to the offline client engine without depending on
 * `@kvitbit/ui-port`, plus a bounded content-hash cache (rule T3).
 */
import { createHash } from "node:crypto";
import {
  EXTENDED_ROLES,
  type ExtendedColor,
  type ExtendedRole,
  type Hex,
  M3_COLOR_ROLES,
  type M3ColorRole,
  type ResolvedScheme,
  type ResolvedTheme,
  THEME_JSON_MAX_BYTES,
  type ThemePresetId,
  type ThemeSource,
  type ThemeWarning,
} from "@kvitbit/api-contract";
import { Hex as HexSchema, Invalid, type Issue } from "@kvitbit/domain/contract";
import { Effect, Exit, Schema } from "effect";
import {
  clamp,
  contrastRatio,
  Hct,
  harmonize,
  hexFromRgb,
  isHex,
  type Rgb,
  rgbFromHex,
  TonalPalette,
} from "./themeColor";

type RoleMap = Readonly<Record<M3ColorRole, Hex>>;

const SCHEME_VARIANTS = [
  "light",
  "dark",
  "lightMedium",
  "lightHigh",
  "darkMedium",
  "darkHigh",
] as const;
type SchemeVariant = (typeof SCHEME_VARIANTS)[number];

const isDarkVariant = (v: SchemeVariant): boolean => v.startsWith("dark");
const contrastLevelOf = (v: SchemeVariant): 0 | 1 | 2 =>
  v.endsWith("High") ? 2 : v.endsWith("Medium") ? 1 : 0;

interface PaletteTuning {
  readonly hueShift?: number;
  readonly hue?: number;
  readonly chroma: number;
}

interface ThemeRecipe {
  readonly seed: Hex;
  readonly primary?: PaletteTuning;
  readonly secondary?: PaletteTuning;
  readonly tertiary?: PaletteTuning;
  readonly neutral?: PaletteTuning;
  readonly neutralVariant?: PaletteTuning;
  readonly overrides?: Readonly<Partial<Record<SchemeVariant, Partial<RoleMap>>>>;
}

interface SchemePalettes {
  readonly seed: Hct;
  readonly primary: TonalPalette;
  readonly secondary: TonalPalette;
  readonly tertiary: TonalPalette;
  readonly error: TonalPalette;
  readonly neutral: TonalPalette;
  readonly neutralVariant: TonalPalette;
  readonly primaryTone: number;
}

const tuned = (seed: Hct, tuning: PaletteTuning | undefined, fallback: PaletteTuning) => {
  const t = tuning ?? fallback;
  const hue = t.hue ?? seed.hue + (t.hueShift ?? 0);
  return TonalPalette.fromHueAndChroma(hue, t.chroma);
};

const palettesOf = (recipe: ThemeRecipe): SchemePalettes => {
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

const ACCENT_TONES = {
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

const toneOf = (role: M3ColorRole, variant: SchemeVariant, p: SchemePalettes): number => {
  const spec = ROLE_TONES[role];
  const level = contrastLevelOf(variant);
  const tones = isDarkVariant(variant) ? spec.dark : spec.light;
  const tone = tones[level];
  const tintsPrimary = role === "primary" || role === "surfaceTint";
  if (!tintsPrimary || isDarkVariant(variant)) return tone;
  return level === 0 ? p.primaryTone : Math.min(tone, p.primaryTone);
};

const generateRoles = (p: SchemePalettes, variant: SchemeVariant): RoleMap => {
  const out = {} as Record<M3ColorRole, Hex>;
  for (const role of M3_COLOR_ROLES) {
    out[role] = hexFromRgb(p[ROLE_TONES[role].palette].tone(toneOf(role, variant, p)));
  }
  return out;
};

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

const schemeRoles = (recipe: ThemeRecipe, variant: SchemeVariant, p: SchemePalettes): RoleMap => ({
  ...generateRoles(p, variant),
  ...derivedOverrides(recipe, variant, p),
  ...recipe.overrides?.[variant],
});

// --- Extended status colours -------------------------------------------------------------------

const EXTENDED_SOURCE_COLORS: Readonly<Record<ExtendedRole, Hex>> = {
  paid: "#1F8A4C",
  proforma: "#2F5FD0",
  overdue: "#C2410C",
  draft: "#5B6B80",
};

const HARMONIZE_MIN_PRIMARY_CHROMA = 8;

const harmonizeToward = (color: Rgb, primary: Rgb): Rgb =>
  Hct.fromRgb(primary).chroma < HARMONIZE_MIN_PRIMARY_CHROMA ? color : harmonize(color, primary);

interface ExtendedInput {
  readonly color: Hex;
  readonly harmonized: boolean;
}

const extendedColorOf = (key: Rgb, variant: SchemeVariant): ExtendedColor => {
  const palette = TonalPalette.fromRgb(key);
  const level = contrastLevelOf(variant);
  const side = isDarkVariant(variant) ? "dark" : "light";
  return {
    color: hexFromRgb(palette.tone(ACCENT_TONES.color[side][level])),
    onColor: hexFromRgb(palette.tone(ACCENT_TONES.onColor[side][level])),
    colorContainer: hexFromRgb(palette.tone(ACCENT_TONES.container[side][level])),
    onColorContainer: hexFromRgb(palette.tone(ACCENT_TONES.onContainer[side][level])),
  };
};

const extendedScheme = (
  primary: Hex,
  variant: SchemeVariant,
  inputs: Partial<Record<ExtendedRole, ExtendedInput>> = {},
): ResolvedScheme["extended"] => {
  const p = isHex(primary) ? rgbFromHex(primary) : undefined;
  const one = (role: ExtendedRole): ExtendedColor => {
    const input = inputs[role] ?? { color: EXTENDED_SOURCE_COLORS[role], harmonized: true };
    const key = rgbFromHex(input.color);
    return extendedColorOf(
      input.harmonized && p !== undefined ? harmonizeToward(key, p) : key,
      variant,
    );
  };
  const [paid, proforma, overdue, draft] = EXTENDED_ROLES.map(one) as [
    ExtendedColor,
    ExtendedColor,
    ExtendedColor,
    ExtendedColor,
  ];
  return { paid, proforma, overdue, draft };
};

// --- Built-in presets (matches packages/ui-port/src/theme/presets.ts) --------------------------

const ZINC_HUE = 262;
const ZINC_VARIANT_HUE = 276;

const GRAPHITE_ATELIER_LIGHT: Partial<RoleMap> = {
  background: "#F4F4F5",
  surface: "#F4F4F5",
  surfaceBright: "#F4F4F5",
  surfaceContainerLowest: "#FFFFFF",
  surfaceContainerLow: "#EFEFF1",
  surfaceContainer: "#E8E8EC",
  surfaceContainerHigh: "#DCDCE0",
  surfaceContainerHighest: "#D4D4D8",
  onBackground: "#09090B",
  onSurface: "#09090B",
  onSurfaceVariant: "#52525B",
  primary: "#18181B",
  surfaceTint: "#18181B",
  onPrimary: "#FAFAFA",
  primaryContainer: "#E4E4E7",
  onPrimaryContainer: "#09090B",
  outline: "#A1A1AA",
  outlineVariant: "#D4D4D8",
  error: "#B91C1C",
  onError: "#FFFFFF",
  errorContainer: "#FEE2E2",
  onErrorContainer: "#991B1B",
};

const GRAPHITE_ATELIER_DARK: Partial<RoleMap> = {
  background: "#09090B",
  surface: "#09090B",
  surfaceDim: "#09090B",
  surfaceBright: "#27272A",
  surfaceVariant: "#27272A",
  surfaceContainerLowest: "#131316",
  surfaceContainerLow: "#101013",
  surfaceContainer: "#18181C",
  surfaceContainerHigh: "#232329",
  onBackground: "#FAFAFA",
  onSurface: "#FAFAFA",
  onSurfaceVariant: "#A1A1AA",
  primary: "#FAFAFA",
  surfaceTint: "#FAFAFA",
  onPrimary: "#09090B",
  primaryContainer: "#27272A",
  onPrimaryContainer: "#FAFAFA",
  outline: "#52525B",
  outlineVariant: "#27272A",
  error: "#F87171",
  onError: "#450A0A",
  errorContainer: "#351517",
  onErrorContainer: "#FECACA",
};

const PRESET_RECIPES: Readonly<Record<ThemePresetId, ThemeRecipe>> = {
  graphite_atelier: {
    seed: "#111111",
    primary: { hue: ZINC_VARIANT_HUE, chroma: 4 },
    secondary: { hue: ZINC_VARIANT_HUE, chroma: 4 },
    tertiary: { hue: ZINC_VARIANT_HUE, chroma: 6 },
    neutral: { hue: ZINC_HUE, chroma: 4.5 },
    neutralVariant: { hue: ZINC_VARIANT_HUE, chroma: 7.5 },
    overrides: { light: GRAPHITE_ATELIER_LIGHT, dark: GRAPHITE_ATELIER_DARK },
  },
  forest: {
    seed: "#0F5D42",
    secondary: { chroma: 14 },
    tertiary: { hueShift: 45, chroma: 20 },
    neutral: { hueShift: -8, chroma: 5 },
    neutralVariant: { hueShift: -6, chroma: 8 },
  },
  ocean: {
    seed: "#0E6B8C",
    secondary: { chroma: 14 },
    tertiary: { hueShift: -60, chroma: 22 },
    neutral: { chroma: 5 },
    neutralVariant: { chroma: 8 },
  },
  plum: {
    seed: "#6B2D5C",
    secondary: { chroma: 15 },
    tertiary: { hueShift: -45, chroma: 22 },
    neutral: { chroma: 4 },
    neutralVariant: { chroma: 7 },
  },
  sand: {
    seed: "#1D4ED8",
    secondary: { chroma: 16 },
    tertiary: { hue: 75, chroma: 28 },
    neutral: { hue: 265, chroma: 6 },
    neutralVariant: { hue: 265, chroma: 9 },
  },
  graphite: {
    seed: "#4B5563",
    secondary: { chroma: 6 },
    tertiary: { hueShift: -30, chroma: 10 },
    neutral: { chroma: 4 },
    neutralVariant: { chroma: 6 },
  },
};

// --- Contrast audit (rule T2) ------------------------------------------------------------------

const AA_TEXT = 4.5;
const AA_UI = 3;

const SURFACES: ReadonlyArray<M3ColorRole> = [
  "surface",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
];

const CHECKED_ROLE_PAIRS: ReadonlyArray<{
  readonly foreground: M3ColorRole;
  readonly background: M3ColorRole;
  readonly required: number;
}> = [
  { foreground: "onPrimary", background: "primary", required: AA_TEXT },
  { foreground: "onPrimaryContainer", background: "primaryContainer", required: AA_TEXT },
  { foreground: "onSecondary", background: "secondary", required: AA_TEXT },
  { foreground: "onSecondaryContainer", background: "secondaryContainer", required: AA_TEXT },
  { foreground: "onTertiary", background: "tertiary", required: AA_TEXT },
  { foreground: "onTertiaryContainer", background: "tertiaryContainer", required: AA_TEXT },
  { foreground: "onError", background: "error", required: AA_TEXT },
  { foreground: "onErrorContainer", background: "errorContainer", required: AA_TEXT },
  { foreground: "onBackground", background: "background", required: AA_TEXT },
  ...SURFACES.map((s) => ({ foreground: "onSurface" as const, background: s, required: AA_TEXT })),
  ...SURFACES.map((s) => ({
    foreground: "onSurfaceVariant" as const,
    background: s,
    required: AA_TEXT,
  })),
  { foreground: "onSurfaceVariant", background: "surfaceVariant", required: AA_TEXT },
  { foreground: "inverseOnSurface", background: "inverseSurface", required: AA_TEXT },
  { foreground: "inversePrimary", background: "inverseSurface", required: AA_TEXT },
  { foreground: "onPrimaryFixed", background: "primaryFixed", required: AA_TEXT },
  { foreground: "onPrimaryFixedVariant", background: "primaryFixed", required: AA_TEXT },
  { foreground: "onSecondaryFixed", background: "secondaryFixed", required: AA_TEXT },
  { foreground: "onSecondaryFixedVariant", background: "secondaryFixed", required: AA_TEXT },
  { foreground: "onTertiaryFixed", background: "tertiaryFixed", required: AA_TEXT },
  { foreground: "onTertiaryFixedVariant", background: "tertiaryFixed", required: AA_TEXT },
  { foreground: "onPrimaryFixed", background: "primaryFixedDim", required: AA_TEXT },
  { foreground: "onPrimaryFixedVariant", background: "primaryFixedDim", required: AA_TEXT },
  { foreground: "onSecondaryFixed", background: "secondaryFixedDim", required: AA_TEXT },
  { foreground: "onSecondaryFixedVariant", background: "secondaryFixedDim", required: AA_TEXT },
  { foreground: "onTertiaryFixed", background: "tertiaryFixedDim", required: AA_TEXT },
  { foreground: "onTertiaryFixedVariant", background: "tertiaryFixedDim", required: AA_TEXT },
  { foreground: "primary", background: "surface", required: AA_UI },
  { foreground: "error", background: "surface", required: AA_UI },
];

const hasLowContrast = (schemes: ResolvedTheme["schemes"]): boolean => {
  for (const variant of SCHEME_VARIANTS) {
    const scheme = schemes[variant];
    for (const pair of CHECKED_ROLE_PAIRS) {
      if (
        contrastRatio(
          rgbFromHex(scheme.roles[pair.foreground]),
          rgbFromHex(scheme.roles[pair.background]),
        ) < pair.required
      ) {
        return true;
      }
    }
    for (const role of EXTENDED_ROLES) {
      const e = scheme.extended[role];
      if (
        contrastRatio(rgbFromHex(e.onColor), rgbFromHex(e.color)) < AA_TEXT ||
        contrastRatio(rgbFromHex(e.onColorContainer), rgbFromHex(e.colorContainer)) < AA_TEXT
      ) {
        return true;
      }
    }
  }
  return false;
};

const withContrastWarnings = (
  source: ThemeSource,
  schemes: ResolvedTheme["schemes"],
): ResolvedTheme => {
  const warnings: ThemeWarning[] = hasLowContrast(schemes) ? ["theme.low_contrast"] : [];
  return warnings.length > 0 ? { source, schemes, warnings } : { source, schemes };
};

const schemesOf = (
  recipe: ThemeRecipe,
  options: {
    readonly rolesFor?: (variant: SchemeVariant) => RoleMap | undefined;
    readonly extended?: Partial<Record<ExtendedRole, ExtendedInput>>;
  } = {},
): ResolvedTheme["schemes"] => {
  const palettes = palettesOf(recipe);
  const out = {} as Record<SchemeVariant, ResolvedScheme>;
  for (const variant of SCHEME_VARIANTS) {
    const roles = options.rolesFor?.(variant) ?? schemeRoles(recipe, variant, palettes);
    out[variant] = { roles, extended: extendedScheme(roles.primary, variant, options.extended) };
  }
  return out;
};

// --- Material Theme Builder JSON validation (rules T1, T2) -------------------------------------

const RoleScheme = Schema.Record(Schema.String, Schema.String);

const MaterialThemeJson = Schema.Struct({
  description: Schema.optional(Schema.String),
  seed: HexSchema,
  coreColors: Schema.Struct({
    primary: HexSchema,
    secondary: Schema.optional(HexSchema),
    tertiary: Schema.optional(HexSchema),
    error: Schema.optional(HexSchema),
    neutral: Schema.optional(HexSchema),
    neutralVariant: Schema.optional(HexSchema),
  }),
  extendedColors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        color: HexSchema,
        description: Schema.optional(Schema.String),
        harmonized: Schema.Boolean,
      }),
    ),
  ),
  schemes: Schema.Struct({
    light: RoleScheme,
    dark: RoleScheme,
    "light-medium-contrast": Schema.optional(RoleScheme),
    "light-high-contrast": Schema.optional(RoleScheme),
    "dark-medium-contrast": Schema.optional(RoleScheme),
    "dark-high-contrast": Schema.optional(RoleScheme),
  }),
  palettes: Schema.optional(Schema.Unknown),
});
type MaterialThemeJson = typeof MaterialThemeJson.Type;

const FILE_SCHEME_KEY = {
  light: "light",
  dark: "dark",
  lightMedium: "light-medium-contrast",
  lightHigh: "light-high-contrast",
  darkMedium: "dark-medium-contrast",
  darkHigh: "dark-high-contrast",
} as const satisfies Record<SchemeVariant, keyof MaterialThemeJson["schemes"]>;

const issue = (
  code: Issue["code"],
  path: Issue["path"] = [],
  params?: Record<string, string>,
): Issue => (params === undefined ? { path, code } : { path, code, params });

const invalid = (first: Issue, ...rest: Issue[]) => new Invalid({ issues: [first, ...rest] });

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const pickRoles = (
  scheme: Readonly<Record<string, string>>,
): { roles: Partial<Record<M3ColorRole, Hex>>; missing: M3ColorRole[] } => {
  const roles: Partial<Record<M3ColorRole, Hex>> = {};
  const missing: M3ColorRole[] = [];
  for (const role of M3_COLOR_ROLES) {
    const value = scheme[role];
    if (value !== undefined && isHex(value)) roles[role] = value.toUpperCase() as Hex;
    else missing.push(role);
  }
  return { roles, missing };
};

const resolveMaterialThemeBuilder = (
  json: unknown,
  source: ThemeSource,
): Effect.Effect<ResolvedTheme, Invalid> => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(json);
  } catch {
    return Effect.fail(invalid(issue("theme.json_invalid", ["source", "json"])));
  }
  if (encoded === undefined) {
    return Effect.fail(invalid(issue("theme.json_invalid", ["source", "json"])));
  }
  if (Buffer.byteLength(encoded, "utf8") > THEME_JSON_MAX_BYTES) {
    return Effect.fail(
      invalid(
        issue("theme.too_large", ["source", "json"], { maxBytes: String(THEME_JSON_MAX_BYTES) }),
      ),
    );
  }
  if (isRecord(json) && "seed" in json && !(typeof json.seed === "string" && isHex(json.seed))) {
    return Effect.fail(invalid(issue("theme.seed_invalid", ["source", "json", "seed"])));
  }
  const exit = Schema.decodeUnknownExit(MaterialThemeJson)(json);
  if (Exit.isFailure(exit)) {
    return Effect.fail(invalid(issue("theme.json_invalid", ["source", "json"])));
  }
  const file = exit.value;
  const roles: Partial<Record<SchemeVariant, RoleMap>> = {};
  const missingIssues: Issue[] = [];
  for (const [variant, key] of Object.entries(FILE_SCHEME_KEY) as [SchemeVariant, string][]) {
    const scheme = (file.schemes as Readonly<Record<string, Readonly<Record<string, string>>>>)[
      key
    ];
    if (scheme === undefined) continue;
    const picked = pickRoles(scheme);
    if (picked.missing.length === 0) {
      roles[variant] = picked.roles as RoleMap;
    } else if (variant === "light" || variant === "dark") {
      for (const role of picked.missing) {
        missingIssues.push(
          issue("theme.json_invalid", ["source", "json", "schemes", key, role], { role }),
        );
      }
    }
  }
  const [firstMissing, ...restMissing] = missingIssues;
  if (firstMissing !== undefined) return Effect.fail(invalid(firstMissing, ...restMissing));

  const extended: Partial<Record<ExtendedRole, ExtendedInput>> = {};
  for (const entry of file.extendedColors ?? []) {
    const name = entry.name.trim().toLowerCase();
    const role = EXTENDED_ROLES.find((r) => r === name);
    if (role !== undefined && extended[role] === undefined) {
      extended[role] = { color: entry.color.toUpperCase() as Hex, harmonized: entry.harmonized };
    }
  }

  const seed = file.seed.toUpperCase() as Hex;
  return Effect.succeed(
    withContrastWarnings(source, schemesOf({ seed }, { rolesFor: (v) => roles[v], extended })),
  );
};

// --- Content-hash LRU cache (rule T3) ----------------------------------------------------------

const CACHE_MAX_ENTRIES = 256;
const resolvedCache = new Map<string, ResolvedTheme>();

const cacheKey = (source: ThemeSource): string | undefined => {
  try {
    return createHash("sha256").update(JSON.stringify(source)).digest("hex");
  } catch {
    return undefined;
  }
};

const cacheGet = (key: string): ResolvedTheme | undefined => {
  const hit = resolvedCache.get(key);
  if (hit === undefined) return undefined;
  // Refresh LRU order.
  resolvedCache.delete(key);
  resolvedCache.set(key, hit);
  return hit;
};

const cacheSet = (key: string, value: ResolvedTheme): void => {
  if (resolvedCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = resolvedCache.keys().next().value;
    if (oldest !== undefined) resolvedCache.delete(oldest);
  }
  resolvedCache.set(key, value);
};

/** Resolves any `ThemeSource` into a six-scheme `ResolvedTheme`, cached by content hash (T1–T3). */
export const resolveTheme = (source: ThemeSource): Effect.Effect<ResolvedTheme, Invalid> => {
  const key = cacheKey(source);
  if (key !== undefined) {
    const hit = cacheGet(key);
    if (hit !== undefined) return Effect.succeed(hit);
  }
  const compute: Effect.Effect<ResolvedTheme, Invalid> = (() => {
    switch (source._tag) {
      case "Preset": {
        const recipe = PRESET_RECIPES[source.id];
        return Effect.succeed(withContrastWarnings(source, schemesOf(recipe)));
      }
      case "Seed": {
        if (!isHex(source.seed)) {
          return Effect.fail(invalid(issue("theme.seed_invalid", ["source", "seed"])));
        }
        const seed = source.seed.toUpperCase() as Hex;
        return Effect.succeed(withContrastWarnings(source, schemesOf({ seed })));
      }
      case "MaterialThemeBuilder":
        return resolveMaterialThemeBuilder(source.json, source);
    }
  })();
  return Effect.tap(compute, (resolved) =>
    Effect.sync(() => {
      if (key !== undefined) cacheSet(key, resolved);
    }),
  );
};
