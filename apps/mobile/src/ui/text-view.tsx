import type { M3ColorRole } from "@kvitbit/api-contract";
import {
  OPERATE_SCALE_NAMES,
  type OperateScaleName,
  type TypeScaleName,
} from "@kvitbit/ui-port/theme";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { textStyle } from "./text-style";

export type TextVariant = TypeScaleName | OperateScaleName;

export interface TextProps extends Omit<RNTextProps, "style"> {
  readonly variant?: TextVariant;
  readonly color?: M3ColorRole;
  /** Tabular figures for amounts and dates. */
  readonly numeric?: boolean;
  readonly align?: TextStyle["textAlign"];
  readonly style?: TextStyle;
  readonly children?: ReactNode;
}

const isOperateVariant = Schema.is(Schema.Literals(OPERATE_SCALE_NAMES));

export function Text({
  variant = "body",
  color = "onSurface",
  numeric = false,
  align,
  style,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const font = isOperateVariant(variant) ? theme.operateFonts[variant] : theme.fonts[variant];
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={2}
      style={[
        textStyle(font),
        numeric === true ? textStyle(theme.numeric) : null,
        { color: theme.colors[color], textAlign: align },
        style,
      ]}
    />
  );
}
