import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { Icon, type IconComponent } from "./icon";
import { Text } from "./text";
import { touchTarget } from "./tokens";

export type ButtonKind = "filled" | "tonal" | "outlined" | "text" | "danger";

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly kind?: ButtonKind;
  readonly icon?: IconComponent;
  readonly disabled?: boolean;
  /** Shows a spinner and blocks presses (a save in flight). */
  readonly busy?: boolean;
  readonly accessibilityHint?: string;
  readonly testID?: string;
}

export function Button({
  label,
  onPress,
  kind = "filled",
  icon,
  disabled,
  busy,
  ...a11y
}: ButtonProps) {
  const theme = useTheme();
  const c = theme.colors;
  const palette = {
    filled: { bg: c.primary, fg: "onPrimary", border: undefined },
    tonal: { bg: c.secondaryContainer, fg: "onSecondaryContainer", border: undefined },
    outlined: { bg: "transparent", fg: "primary", border: c.outline },
    text: { bg: "transparent", fg: "primary", border: undefined },
    danger: { bg: c.error, fg: "onError", border: undefined },
  } as const;
  const p = palette[kind];
  const inactive = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      accessibilityHint={a11y.accessibilityHint}
      testID={a11y.testID}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: p.bg,
          borderRadius: theme.roundness,
          borderWidth: p.border === undefined ? 0 : 1,
          borderColor: p.border,
          opacity: disabled === true ? 0.38 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.row}>
        {busy === true ? (
          <ActivityIndicator size="small" color={c[p.fg]} />
        ) : icon === undefined ? null : (
          <Icon icon={icon} size={18} color={p.fg} />
        )}
        <Text variant="labelLarge" color={p.fg}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

export function IconButton(props: {
  readonly icon: IconComponent;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.icon, { opacity: props.disabled ? 0.38 : pressed ? 0.6 : 1 }]}
    >
      <Icon icon={props.icon} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: touchTarget, paddingHorizontal: 20, justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  icon: { width: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" },
});
