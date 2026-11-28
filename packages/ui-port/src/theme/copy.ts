/** Text descriptors the theme area emits; the keys live in the ui-i18n catalog. */
import type {
  ThemeContrast,
  ThemeMode,
  ThemePresetId,
  ThemeStyle,
  ThemeWarning,
} from "@kvitbit/api-contract";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { type Text, text } from "../text";

export const presetNameText = (id: ThemePresetId): Text => text(`enum.themePreset.${id}`);
export const styleNameText = (style: ThemeStyle): Text => text(`enum.themeStyle.${style}`);
export const modeNameText = (mode: ThemeMode): Text => text(`enum.themeMode.${mode}`);
export const contrastNameText = (contrast: ThemeContrast): Text =>
  text(`enum.themeContrast.${contrast}`);

const THEME_WARNING_PREFIX = /^theme\./;

export const themeWarningText: {
  (failingPairs: number): (warning: ThemeWarning) => Text;
  (warning: ThemeWarning, failingPairs: number): Text;
} = Fn.dual(
  2,
  (warning: ThemeWarning, failingPairs: number): Text =>
    text(`theme.warning.${Str.replace(THEME_WARNING_PREFIX, "")(warning)}`, {
      count: failingPairs,
    }),
);
