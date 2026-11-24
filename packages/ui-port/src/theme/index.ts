/**
 * `@kvitbit/ui-port/theme`: Material 3 theme engine (pure HCT / CAM16, tonal palettes, scheme
 * generation, harmonized financial colours), Material Theme Builder import, WCAG audit, theme
 * precedence, Elegant / Cozy style tokens, and CSS / React Native serializers.
 */
export { harmonize } from "./color/blend";
export { contrastRatio, relativeLuminance } from "./color/contrast";
export { cam16FromRgb, Hct } from "./color/hct";
export { PALETTE_TONES, TonalPalette } from "./color/palette";
export { hexFromRgb, isHex, lstarFromRgb, type Rgb, rgbFromHex } from "./color/utils";
export {
  AA_TEXT,
  AA_UI,
  auditScheme,
  auditTheme,
  CHECKED_ROLE_PAIRS,
  type ContrastIssue,
  contrastIssueText,
  failingPairs,
  feasibleLuminance,
  nearestPassing,
  type RolePair,
  repairContrast,
  withContrast,
} from "./contrast-check";
export {
  contrastNameText,
  modeNameText,
  presetNameText,
  styleNameText,
  themeWarningText,
} from "./copy";
export {
  type DynamicColorInput,
  type DynamicRoles,
  dynamicRoles,
  dynamicSchemeRoles,
  type EffectiveTheme,
  type ExtendedPair,
  effectiveContrast,
  effectiveTheme,
  harmonizeExtended,
  initialThemeState,
  LocalThemeEngine,
  pickThemeSource,
  resolveSource,
  type ThemeDraft,
  ThemeEngine,
  type ThemeEngineError,
  type ThemeOrigin,
  type ThemeState,
} from "./engine";
export {
  EXTENDED_SOURCE_COLORS,
  type ExtendedInput,
  type ExtendedScheme,
  extendedScheme,
} from "./extended";
export {
  type DecodedThemeFile,
  decodeMaterialTheme,
  fileWarningText,
  MATERIAL_THEME_FILE_WARNINGS,
  MATERIAL_THEME_MAX_BYTES,
  type MaterialThemeFileWarning,
  MaterialThemeJson,
  type ParsedThemeFile,
  parseMaterialThemeFile,
  resolveMaterialTheme,
} from "./material-theme-json";
export { PRESET_IDS, type PresetDefinition, PresetDefinitions } from "./presets";
export {
  KvitbitDefaultTheme,
  type ResolvedSchemes,
  resolvePreset,
  resolveRecipe,
  resolveSeed,
  seedRecipe,
} from "./resolve";
export {
  type PaletteTuning,
  palettesOf,
  type RoleMap,
  SCHEME_VARIANTS,
  type SchemePalettes,
  type SchemeVariant,
  schemeRoles,
  type ThemeRecipe,
  variantOf,
} from "./scheme";
export {
  type CssVariables,
  colorVariables,
  cssDeclarations,
  cssVariables,
  extendedVariables,
  type NativeTextStyle,
  type NativeTheme,
  nativeTheme,
  roleVariables,
  styleVariables,
  themeStylesheet,
} from "./serialize";
export {
  FONT_FALLBACKS,
  type FontRole,
  OPERATE_SCALE_NAMES,
  type OperateScaleName,
  StyleTokens,
  TYPE_SCALE_NAMES,
  type TypeScaleName,
  type TypeStyle,
} from "./style-tokens";
