/**
 * `@kvitbit/ui-port/theme`: Material 3 theme engine (pure HCT / CAM16, tonal palettes, scheme
 * generation, harmonized financial colours), Material Theme Builder import, WCAG audit, theme
 * precedence, Elegant / Cozy style tokens, and CSS / React Native serializers.
 */
export { harmonize } from "./color/blend";
export { contrastRatio } from "./color/contrast";
export { cam16FromRgb, Hct } from "./color/hct";
export { TonalPalette } from "./color/palette";
export { hexFromRgb, isHex, lstarFromRgb, rgbFromHex } from "./color/utils";
export {
  auditScheme,
  auditTheme,
  CHECKED_ROLE_PAIRS,
  failingPairs,
  feasibleLuminance,
} from "./contrast-check";
export { contrastNameText, modeNameText, presetNameText, styleNameText } from "./copy";
export {
  type DynamicColorInput,
  type DynamicRoles,
  dynamicRoles,
  dynamicSchemeRoles,
  type EffectiveTheme,
  effectiveTheme,
  harmonizeExtended,
  initialThemeState,
  LocalThemeEngine,
  resolveSource,
  ThemeEngine,
  type ThemeState,
} from "./engine";
export { EXTENDED_SOURCE_COLORS, extendedScheme } from "./extended";
export {
  fileWarningText,
  parseMaterialThemeFile,
  resolveMaterialTheme,
} from "./material-theme-json";
export { PRESET_IDS, PresetDefinitions } from "./presets";
export { KvitbitDefaultTheme, resolvePreset, resolveSeed } from "./resolve";
export { type RoleMap, SCHEME_VARIANTS, type SchemeVariant, variantOf } from "./scheme";
export {
  cssVariables,
  type NativeTextStyle,
  type NativeTheme,
  nativeTheme,
  styleVariables,
  themeStylesheet,
} from "./serialize";
export { type OperateScaleName, StyleTokens, type TypeScaleName } from "./style-tokens";
