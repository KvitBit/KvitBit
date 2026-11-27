import type { M3ColorRole } from "@kvitbit/api-contract";
import type { NativeTextStyle, OperateScaleName, TypeScaleName } from "@kvitbit/ui-port/theme";
import type { ReactNode } from "react";
import {
  Platform,
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from "react-native";
import { useTheme } from "../theme/theme-provider";

export type TextVariant = TypeScaleName | OperateScaleName;

export interface TextProps extends Omit<RNTextProps, "style"> {
  readonly variant?: TextVariant;
  readonly color?: M3ColorRole;
  /** Tabular figures for amounts and dates. */
  readonly numeric?: boolean;
  readonly align?: TextStyle["textAlign"];
  readonly style?: TextStyle;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * Theme fonts by name. Brand faces are loaded on the web (PWA); Android falls back to the system
 * sans, since only the face, not the metrics, is missing.
 */
export const textStyle = (font: NativeTextStyle): TextStyle => ({
  ...(Platform.OS === "web" ? { fontFamily: font.fontFamily } : {}),
  fontWeight: font.fontWeight,
  fontSize: font.fontSize,
  lineHeight: font.lineHeight,
  letterSpacing: font.letterSpacing,
  ...(font.fontVariant === undefined ? {} : { fontVariant: [...font.fontVariant] }),
});

export function Text({
  variant = "body",
  color,
  numeric,
  align,
  style,
  className,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const font =
    variant in theme.operateFonts
      ? theme.operateFonts[variant as OperateScaleName]
      : theme.fonts[variant as TypeScaleName];
  const colorStyle =
    color !== undefined
      ? { color: theme.colors[color] }
      : className?.includes("text-")
        ? null
        : { color: theme.colors.onSurface };
  return (
    <RNText
      {...rest}
      {...(className === undefined ? {} : { className })}
      maxFontSizeMultiplier={2}
      style={[
        textStyle(font),
        numeric ? textStyle(theme.numeric) : null,
        colorStyle,
        align === undefined ? null : { textAlign: align },
        style,
      ]}
    />
  );
}
