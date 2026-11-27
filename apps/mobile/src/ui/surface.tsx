import { ChevronRight } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View, type ViewStyle } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { Button } from "./button";
import { Icon, type IconComponent } from "./icon";
import { badgeTextVariants, badgeVariants, bannerVariants, cardVariants, cn } from "./styles";
import { Text } from "./text";

/** A panel: flat with an outline in the elegant style, a tonal step in cozy. */
export function Card(props: {
  readonly children: ReactNode;
  readonly onPress?: () => void;
  readonly style?: ViewStyle;
  readonly className?: string;
  readonly accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const surface = theme.surface === "tonal" ? "tonal" : "outlined";
  const cardClass = cn(cardVariants({ surface }), props.className);
  if (props.onPress === undefined) {
    return (
      <View className={cardClass} style={props.style}>
        {props.children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      className={cn(cardClass, "active:opacity-85")}
      style={props.style}
    >
      {props.children}
    </Pressable>
  );
}

export function Section(props: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <View className="gap-2">
      {props.title === undefined && props.action === undefined ? null : (
        <View className="min-h-8 flex-row items-center">
          <Text
            variant="titleSmall"
            color="onSurfaceVariant"
            accessibilityRole="header"
            className="flex-1"
          >
            {props.title ?? ""}
          </Text>
          {props.action}
        </View>
      )}
      {props.children}
    </View>
  );
}

export interface ListRowProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Right-aligned value (an amount) in tabular figures. */
  readonly trailing?: string;
  readonly trailingSub?: string;
  readonly leading?: IconComponent;
  readonly badge?: ReactNode;
  readonly onPress?: () => void;
  readonly chevron?: boolean;
  readonly testID?: string;
}

export function ListRow(props: ListRowProps) {
  const content = (
    <View className="min-h-16 flex-row items-center gap-3 px-1 py-2">
      {props.leading === undefined ? null : <Icon icon={props.leading} />}
      <View className="flex-1">
        <Text variant="row" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle === undefined ? null : (
          <Text variant="meta" color="onSurfaceVariant" numberOfLines={2}>
            {props.subtitle}
          </Text>
        )}
      </View>
      <View className="items-end gap-0.5">
        {props.trailing === undefined ? null : (
          <Text variant="row" numeric>
            {props.trailing}
          </Text>
        )}
        {props.trailingSub === undefined ? null : (
          <Text variant="meta" color="onSurfaceVariant" numeric>
            {props.trailingSub}
          </Text>
        )}
        {props.badge}
      </View>
      {props.onPress !== undefined && props.chevron !== false ? (
        <Icon icon={ChevronRight} size={20} />
      ) : null}
    </View>
  );
  if (props.onPress === undefined) {
    return <View className="border-b border-outline-variant">{content}</View>;
  }
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      onPress={props.onPress}
      className="border-b border-outline-variant active:bg-surface-container-high"
    >
      {content}
    </Pressable>
  );
}

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "proforma"
  | "draft";

export function Badge(props: { readonly label: string; readonly tone?: BadgeTone }) {
  const tone = props.tone ?? "neutral";
  return (
    <View className={badgeVariants({ tone })}>
      <Text variant="labelSmall" className={badgeTextVariants({ tone })}>
        {props.label}
      </Text>
    </View>
  );
}

export function Loading(props: { readonly label?: string }) {
  const theme = useTheme();
  return (
    <View
      className="items-center justify-center gap-3 p-6"
      accessibilityLabel={props.label}
      accessibilityRole="progressbar"
    >
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}

export function EmptyState(props: {
  readonly title: string;
  readonly body?: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View className="items-center justify-center gap-3 p-6">
      <Text variant="titleMedium" align="center">
        {props.title}
      </Text>
      {props.body === undefined ? null : (
        <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
          {props.body}
        </Text>
      )}
      {props.action === undefined ? null : <Button kind="tonal" {...props.action} />}
    </View>
  );
}

/** An inline error or notice banner. */
export function Banner(props: {
  readonly text: string;
  readonly tone?: "error" | "info" | "warning";
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  const tone = props.tone ?? "error";
  const fg =
    tone === "info"
      ? ("onSecondaryContainer" as const)
      : tone === "warning"
        ? ("onSurface" as const)
        : ("onErrorContainer" as const);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className={bannerVariants({ tone })}
    >
      <Text variant="bodyMedium" color={fg} className="flex-1">
        {props.text}
      </Text>
      {props.action === undefined ? null : <Button kind="text" {...props.action} />}
    </View>
  );
}
