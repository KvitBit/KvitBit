import { type ReactNode, useState } from "react";
import { TextInput, type TextInputProps, View } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { fieldBoxVariants } from "./styles";
import { Text, textStyle } from "./text";

export interface TextFieldProps
  extends Omit<TextInputProps, "style" | "value" | "onChangeText" | "editable"> {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** Field-level error (already translated). */
  readonly error?: string | null;
  readonly supporting?: string;
  readonly disabled?: boolean;
  readonly trailing?: ReactNode;
}

/** M3 outlined text field: label above, error below with an accessible live region. */
export function TextField({
  label,
  error,
  supporting,
  disabled,
  trailing,
  ...input
}: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const c = theme.colors;
  const hasError = error !== undefined && error !== null && error !== "";
  const state = hasError ? "error" : focused ? "focused" : "idle";
  return (
    <View className="gap-1">
      <Text variant="labelMedium" color={hasError ? "error" : "onSurfaceVariant"}>
        {label}
      </Text>
      <View className={fieldBoxVariants({ state, disabled: disabled === true })}>
        <TextInput
          {...input}
          accessibilityLabel={label}
          editable={disabled !== true}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          placeholderTextColor={c.onSurfaceVariant}
          className="flex-1 px-4 py-3 text-on-surface"
          style={textStyle(theme.fonts.bodyLarge)}
        />
        {trailing}
      </View>
      {hasError ? (
        <Text variant="bodySmall" color="error" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : supporting === undefined ? null : (
        <Text variant="bodySmall" color="onSurfaceVariant">
          {supporting}
        </Text>
      )}
    </View>
  );
}
