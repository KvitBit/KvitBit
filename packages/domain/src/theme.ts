/**
 * Theme types (core-ports section 1; http-mcp-contracts section 3.5.2 for the account
 * preference). Resolving a source into M3 schemes stays in apps/server (`ThemeResolver`).
 */
import { Schema } from "effect";

export const Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/)));
export type Hex = typeof Hex.Type;

/** Built-in presets. The default is "graphite_atelier". */
export const ThemePresetId = Schema.Literals([
  "graphite_atelier",
  "forest",
  "ocean",
  "plum",
  "sand",
  "graphite",
]);
export type ThemePresetId = typeof ThemePresetId.Type;
export const DEFAULT_THEME_PRESET: ThemePresetId = "graphite_atelier";

export const ThemeSource = Schema.Union([
  Schema.TaggedStruct("Preset", { id: ThemePresetId }),
  Schema.TaggedStruct("Seed", { seed: Hex }),
  /** Raw material-theme.json from Material Theme Builder, at most 64 KB encoded. */
  Schema.TaggedStruct("MaterialThemeBuilder", { json: Schema.Unknown }),
]);
export type ThemeSource = typeof ThemeSource.Type;

export const ThemeContrast = Schema.Literals(["standard", "medium", "high"]);
export type ThemeContrast = typeof ThemeContrast.Type;

export const ThemeMode = Schema.Literals(["system", "light", "dark"]);
export type ThemeMode = typeof ThemeMode.Type;

/** Typography and shape style: "elegant" (default) is sharp and serif, "cozy" is soft and rounded. */
export const ThemeStyle = Schema.Literals(["elegant", "cozy"]);
export type ThemeStyle = typeof ThemeStyle.Type;
export const DEFAULT_THEME_STYLE: ThemeStyle = "elegant";

/** The account's theme choice. The M3 colour source is independent of style. */
export const ThemePreference = Schema.Struct({
  mode: ThemeMode,
  style: ThemeStyle, // default "elegant"
  contrast: ThemeContrast,
  dynamicColor: Schema.Boolean, // default true; honoured on Android 12+ only
  source: Schema.NullOr(ThemeSource), // null follows the Workspace theme
});
export type ThemePreference = typeof ThemePreference.Type;
