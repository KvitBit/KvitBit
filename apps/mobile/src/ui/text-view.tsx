import type { M3ColorRole } from "@kvitbit/api-contract";
import {
  OPERATE_SCALE_NAMES,
  type OperateScaleName,
  type TypeScaleName,
} from "@kvitbit/ui-port/theme";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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
  readonly className?: string;
  readonly children?: ReactNode;
}

const isOperateVariant = Schema.is(Schema.Literals(OPERATE_SCALE_NAMES));

export function Text({
  variant = "body",
  color,
  numeric = false,
  align,
  style,
  className,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const font = isOperateVariant(variant) ? theme.operateFonts[variant] : theme.fonts[variant];
  return (
    <RNText
      {...rest}
      {...(className === undefined ? {} : { className })}
      maxFontSizeMultiplier={2}
      style={[
        textStyle(font),
        numeric === true ? textStyle(theme.numeric) : null,
        color === undefined
          ? className !== undefined && Str.includes("text-")(className)
            ? null
            : { color: theme.colors.onSurface }
          : { color: theme.colors[color] },
        align === undefined ? null : { textAlign: align },
        style,
      ]}
    />
  );
}
