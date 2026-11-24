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
import { auditTheme } from "./contrast-check";
import { DEFAULT_THEME_DATA } from "./default-theme.data";
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

/**
 * All six schemes for a recipe; `rolesFor` lets a file supply its own role maps. Each scheme's
 * extended colours harmonize toward that scheme's own `primary` (DESIGN.md: "harmonized against
 * the active scheme's primary").
 */
export const schemesOf = (
  recipe: ThemeRecipe,
  options: {
    readonly rolesFor?: (variant: SchemeVariant) => RoleMap | undefined;
    readonly extended?: Partial<Record<ExtendedRole, ExtendedInput>>;
  } = {},
): ResolvedSchemes => {
  const palettes = palettesOf(recipe);
  const scheme = (variant: SchemeVariant): ResolvedScheme => {
    const roles = options.rolesFor?.(variant) ?? schemeRoles(recipe, variant, palettes);
    return { roles, extended: extendedScheme(roles.primary, variant, options.extended) };
  };
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

/**
 * Kvitbit's default app theme: Graphite Atelier (spec 4.1 precedence step 4). Checked in as
 * generated data (spec 4.5) so first paint does no colour maths; a test re-resolves the preset
 * and requires an exact match. Regenerate with
 * `bun packages/ui-port/test/theme/generate-default-theme.ts`.
 */
export const KvitbitDefaultTheme: ResolvedTheme = DEFAULT_THEME_DATA;
