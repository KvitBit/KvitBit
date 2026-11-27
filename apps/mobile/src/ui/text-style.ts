import type { NativeTextStyle } from "@kvitbit/ui-port/theme";
import { Platform, type TextStyle } from "react-native";

/**
 * Theme fonts by name. Brand faces are loaded on the web (PWA); Android falls back to the system
 * sans, since only the face, not the metrics, is missing.
 */
type MutableTextStyle = { -readonly [Key in keyof TextStyle]: TextStyle[Key] };

export const textStyle = (font: NativeTextStyle): TextStyle => {
  const style: MutableTextStyle = {
    fontWeight: font.fontWeight,
    fontSize: font.fontSize,
    lineHeight: font.lineHeight,
    letterSpacing: font.letterSpacing,
  };
  if (Platform.OS === "web") style.fontFamily = font.fontFamily;
  if (font.fontVariant !== undefined) style.fontVariant = [...font.fontVariant];
  return style;
};
