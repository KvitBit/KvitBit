import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { Icon, type IconComponent } from "./icon";
import { buttonVariants, cn } from "./styles";
import { Text } from "./text";

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
  readonly className?: string;
}

const fgByKind = {
  filled: "onPrimary",
  tonal: "onSecondaryContainer",
  outlined: "primary",
  text: "primary",
  danger: "onError",
} as const;

export function Button({
  label,
  onPress,
  kind = "filled",
  icon,
  disabled,
  busy,
  className,
  ...a11y
}: ButtonProps) {
  const theme = useTheme();
  const fg = fgByKind[kind];
  const inactive = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      accessibilityHint={a11y.accessibilityHint}
      testID={a11y.testID}
      disabled={inactive}
      onPress={onPress}
      className={cn(buttonVariants({ kind, disabled: disabled === true }), className)}
    >
      <View className="flex-row items-center justify-center gap-2">
        {busy === true ? (
          <ActivityIndicator size="small" color={theme.colors[fg]} />
        ) : icon === undefined ? null : (
          <Icon icon={icon} size={18} color={fg} />
        )}
        <Text variant="labelLarge" color={fg}>
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
  readonly className?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      className={cn(
        "h-12 w-12 items-center justify-center active:opacity-60",
        props.disabled === true && "opacity-40",
        props.className,
      )}
    >
      <Icon icon={props.icon} />
    </Pressable>
  );
}
