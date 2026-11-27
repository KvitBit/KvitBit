import { type ReactNode, useState } from "react";
import { StyleSheet, TextInput, type TextInputProps, View } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { Text, textStyle } from "./text";
import { space, touchTarget } from "./tokens";

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
  const [focused, setFocused] = useState<boolean>(false);
  const c = theme.colors;
  const hasError: boolean = (error ?? "").length > 0;
  const border = hasError ? c.error : focused === true ? c.primary : c.outline;
  return (
    <View style={styles.wrap}>
      <Text variant="labelMedium" color={hasError ? "error" : "onSurfaceVariant"}>
        {label}
      </Text>
      <View
        style={[
          styles.box,
          {
            borderColor: border,
            borderWidth: focused === true || hasError ? 2 : 1,
            borderRadius: theme.shape.control,
            backgroundColor: disabled === true ? c.surfaceContainerHighest : c.surface,
          },
        ]}
      >
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
          style={[textStyle(theme.fonts.bodyLarge), styles.input, { color: c.onSurface }]}
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

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  box: { flexDirection: "row", alignItems: "center", minHeight: touchTarget + 8 },
  input: { flex: 1, paddingHorizontal: space.lg, paddingVertical: space.md },
});
