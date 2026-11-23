/**
 * Pure theme resolution: preset, custom seed or Material Theme Builder file to a complete
 * `ResolvedTheme` (six schemes with harmonized extended colours), plus the contrast warnings.
 */
import type {
  ExtendedRole,
  Hex,
  ResolvedScheme,
  ResolvedTheme,
  ThemePresetId,
  ThemeSource,
  ThemeWarning,
} from "@kvitbit/api-contract";
import { hexFromRgb } from "./color/utils";
import { auditTheme } from "./contrast-check";
import { type ExtendedInput, extendedScheme } from "./extended";
import { PresetDefinitions } from "./presets";
import {
  palettesOf,
  type RoleMap,
  SCHEME_VARIANTS,
  type SchemeVariant,
  schemeRoles,
  type ThemeRecipe,
} from "./scheme";

export type ResolvedSchemes = ResolvedTheme["schemes"];

/** Attach `theme.low_contrast` when any checked pair fails AA. */
export const withContrastWarnings = (
  source: ThemeSource,
  schemes: ResolvedSchemes,
): ResolvedTheme => {
  const warnings: ThemeWarning[] = auditTheme(schemes).length > 0 ? ["theme.low_contrast"] : [];
  return warnings.length > 0 ? { source, schemes, warnings } : { source, schemes };
};

/** The primary extended colours harmonize toward: the recipe's tone-40 primary. */
const harmonizationTarget = (recipe: ThemeRecipe): Hex =>
  hexFromRgb(palettesOf(recipe).primary.tone(40));

/** All six schemes for a recipe; `rolesFor` lets a file supply its own role maps. */
export const schemesOf = (
  recipe: ThemeRecipe,
  options: {
    readonly rolesFor?: (variant: SchemeVariant) => RoleMap | undefined;
    readonly extended?: Partial<Record<ExtendedRole, ExtendedInput>>;
    readonly harmonizeToward?: Hex;
  } = {},
): ResolvedSchemes => {
  const palettes = palettesOf(recipe);
  const target = options.harmonizeToward ?? harmonizationTarget(recipe);
  const scheme = (variant: SchemeVariant): ResolvedScheme => ({
    roles: options.rolesFor?.(variant) ?? schemeRoles(recipe, variant, palettes),
    extended: extendedScheme(target, variant, options.extended),
  });
  const out = {} as Record<SchemeVariant, ResolvedScheme>;
  for (const v of SCHEME_VARIANTS) out[v] = scheme(v);
  return out;
};

export const resolveRecipe = (recipe: ThemeRecipe, source: ThemeSource): ResolvedTheme =>
  withContrastWarnings(source, schemesOf(recipe));

/** Default recipe for a user's custom seed (tonal-spot-like with seed fidelity). */
export const seedRecipe = (seed: Hex): ThemeRecipe => ({ seed: seed.toUpperCase() as Hex });

export const resolvePreset = (id: ThemePresetId): ResolvedTheme =>
  resolveRecipe(PresetDefinitions[id], { _tag: "Preset", id });

export const resolveSeed = (seed: Hex): ResolvedTheme =>
  resolveRecipe(seedRecipe(seed), { _tag: "Seed", seed });

/** Kvitbit's default app theme: Graphite Atelier (spec 4.1 precedence step 4). */
export const KvitbitDefaultTheme: ResolvedTheme = resolvePreset("graphite_atelier");
