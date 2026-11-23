/** Text descriptors the theme area emits; the keys live in the ui-i18n catalog. */
import type {
  ThemeContrast,
  ThemeMode,
  ThemePresetId,
  ThemeStyle,
  ThemeWarning,
} from "@kvitbit/api-contract";
import { type Text, text } from "../text";

export const presetNameText = (id: ThemePresetId): Text => text(`enum.themePreset.${id}`);
export const styleNameText = (style: ThemeStyle): Text => text(`enum.themeStyle.${style}`);
export const modeNameText = (mode: ThemeMode): Text => text(`enum.themeMode.${mode}`);
export const contrastNameText = (contrast: ThemeContrast): Text =>
  text(`enum.themeContrast.${contrast}`);

/** `theme.warning.low_contrast` with the number of failing pairs. */
export const themeWarningText = (warning: ThemeWarning, failingPairs: number): Text =>
  text(`theme.warning.${warning.replace(/^theme\./, "")}`, { count: failingPairs });
