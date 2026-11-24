/**
 * Built-in presets: seed plus per-preset palette tuning. Ids are `ThemePresetId` from
 * @kvitbit/api-contract; the seeds here are the tuned design values, and api-contract's
 * `ThemePresets` table carries the same seeds (the preset test keeps them equal).
 */
import type { Hex, ThemePresetId } from "@kvitbit/api-contract";
import type { RoleMap, ThemeRecipe } from "./scheme";

export interface PresetDefinition extends ThemeRecipe {
  readonly id: ThemePresetId;
  /** English display name; UI copy comes from the catalog key `enum.themePreset.<id>`. */
  readonly name: string;
  /** Swatch shown in the preset picker. */
  readonly swatch: Hex;
}

/**
 * Zinc, the ramp DESIGN.md's Graphite Atelier is built from: fitted in HCT, its light steps sit
 * near hue 262 / chroma 4.5 and its mid steps near hue 276 / chroma 7.5.
 */
const ZINC_HUE = 262;
const ZINC_VARIANT_HUE = 276;

/** DESIGN.md "Color Architecture": Graphite Atelier's exact light and dark roles. */
const GRAPHITE_ATELIER_LIGHT: Partial<RoleMap> = {
  background: "#F4F4F5",
  surface: "#F4F4F5",
  surfaceBright: "#F4F4F5",
  surfaceContainerLowest: "#FFFFFF",
  surfaceContainerLow: "#EFEFF1",
  surfaceContainer: "#E8E8EC",
  surfaceContainerHigh: "#DCDCE0",
  // Not in DESIGN.md's table; zinc-300 keeps the container steps descending past "High".
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

export const PresetDefinitions: Readonly<Record<ThemePresetId, PresetDefinition>> = {
  /** Achromatic zinc chrome; colour is reserved for financial status. */
  graphite_atelier: {
    id: "graphite_atelier",
    name: "Graphite Atelier",
    seed: "#111111",
    swatch: "#111111",
    primary: { hue: ZINC_VARIANT_HUE, chroma: 4 },
    secondary: { hue: ZINC_VARIANT_HUE, chroma: 4 },
    tertiary: { hue: ZINC_VARIANT_HUE, chroma: 6 },
    neutral: { hue: ZINC_HUE, chroma: 4.5 },
    neutralVariant: { hue: ZINC_VARIANT_HUE, chroma: 7.5 },
    overrides: { light: GRAPHITE_ATELIER_LIGHT, dark: GRAPHITE_ATELIER_DARK },
  },
  /** Banknote Emerald: deep banknote green on sage-mineral paper, teal tertiary. */
  forest: {
    id: "forest",
    name: "Banknote Emerald",
    seed: "#0F5D42",
    swatch: "#0F5D42",
    secondary: { chroma: 14 },
    tertiary: { hueShift: 45, chroma: 20 },
    neutral: { hueShift: -8, chroma: 5 },
    neutralVariant: { hueShift: -6, chroma: 8 },
  },
  /** Ocean: petrol blue with seafoam tertiary over cool sea-mist neutrals. */
  ocean: {
    id: "ocean",
    name: "Ocean",
    seed: "#0E6B8C",
    swatch: "#0E6B8C",
    secondary: { chroma: 14 },
    tertiary: { hueShift: -60, chroma: 22 },
    neutral: { chroma: 5 },
    neutralVariant: { chroma: 8 },
  },
  /** Plum: aubergine ink, lavender tertiary, mauve-paper neutrals. */
  plum: {
    id: "plum",
    name: "Plum",
    seed: "#6B2D5C",
    swatch: "#6B2D5C",
    secondary: { chroma: 15 },
    tertiary: { hueShift: -45, chroma: 22 },
    neutral: { chroma: 4 },
    neutralVariant: { chroma: 7 },
  },
  /** Prague Ledger: ledger cobalt, slate-blue neutrals, a brass tertiary. */
  sand: {
    id: "sand",
    name: "Prague Ledger",
    seed: "#1D4ED8",
    swatch: "#1D4ED8",
    secondary: { chroma: 16 },
    tertiary: { hue: 75, chroma: 28 },
    neutral: { hue: 265, chroma: 6 },
    neutralVariant: { hue: 265, chroma: 9 },
  },
  /** Pure Graphite: cool pencil-lead grey with a faint blue-grey undertone. */
  graphite: {
    id: "graphite",
    name: "Pure Graphite",
    seed: "#4B5563",
    swatch: "#4B5563",
    secondary: { chroma: 6 },
    tertiary: { hueShift: -30, chroma: 10 },
    neutral: { chroma: 4 },
    neutralVariant: { chroma: 6 },
  },
};

export const PRESET_IDS = Object.keys(PresetDefinitions) as ReadonlyArray<ThemePresetId>;
