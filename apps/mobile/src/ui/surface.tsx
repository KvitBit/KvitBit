import { ChevronRight } from "lucide-react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../theme/theme-provider";
import { Button } from "./button";
import { Icon, type IconComponent } from "./icon";
import { Text } from "./text";
import { space, touchTarget } from "./tokens";

/** A panel: flat with an outline in the elegant style, a tonal step in cozy. */
export function Card(props: {
  readonly children: ReactNode;
  readonly onPress?: () => void;
  readonly style?: ViewStyle;
  readonly accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const style: ViewStyle = {
    borderRadius: theme.shape.panel,
    borderWidth: theme.panelBorder,
    borderColor: theme.colors.outlineVariant,
    backgroundColor:
      theme.surface === "tonal" ? theme.colors.surfaceContainerLow : theme.colors.surface,
    padding: space.lg,
    gap: space.sm,
  };
  if (props.onPress === undefined)
    return <View style={[style, props.style]}>{props.children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={({ pressed }) => [style, props.style, pressed ? { opacity: 0.85 } : null]}
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
    <View style={styles.section}>
      {props.title === undefined && props.action === undefined ? null : (
        <View style={styles.sectionHead}>
          <Text
            variant="titleSmall"
            color="onSurfaceVariant"
            accessibilityRole="header"
            style={styles.flex}
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
  const theme = useTheme();
  const content = (
    <View style={styles.row}>
      {props.leading === undefined ? null : <Icon icon={props.leading} />}
      <View style={styles.flex}>
        <Text variant="row" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle === undefined ? null : (
          <Text variant="meta" color="onSurfaceVariant" numberOfLines={2}>
            {props.subtitle}
          </Text>
        )}
      </View>
      <View style={styles.trailing}>
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
  const divider = {
    borderBottomColor: theme.colors.outlineVariant,
    borderBottomWidth: StyleSheet.hairlineWidth,
  };
  if (props.onPress === undefined) return <View style={divider}>{content}</View>;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [
        divider,
        pressed ? { backgroundColor: theme.colors.surfaceContainerHigh } : null,
      ]}
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
  const theme = useTheme();
  const c = theme.colors;
  const x = theme.extended;
  const tones = {
    neutral: [c.surfaceContainerHighest, c.onSurfaceVariant],
    info: [c.secondaryContainer, c.onSecondaryContainer],
    success: [x.paid.colorContainer, x.paid.onColorContainer],
    warning: [x.overdue.colorContainer, x.overdue.onColorContainer],
    proforma: [x.proforma.colorContainer, x.proforma.onColorContainer],
    draft: [x.draft.colorContainer, x.draft.onColorContainer],
    danger: [c.errorContainer, c.onErrorContainer],
  } as const;
  const [bg, fg] = tones[props.tone ?? "neutral"];
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderRadius: theme.shape.badge }]}>
      <Text variant="labelSmall" style={{ color: fg }}>
        {props.label}
      </Text>
    </View>
  );
}

export function Loading(props: { readonly label?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.center} accessibilityLabel={props.label} accessibilityRole="progressbar">
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
    <View style={styles.center}>
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
  const theme = useTheme();
  const c = theme.colors;
  const [bg, fg] =
    props.tone === "info"
      ? [c.secondaryContainer, "onSecondaryContainer" as const]
      : props.tone === "warning"
        ? [theme.extended.overdue.colorContainer, "onSurface" as const]
        : [c.errorContainer, "onErrorContainer" as const];
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: bg, borderRadius: theme.shape.panel }]}
    >
      <Text variant="bodyMedium" color={fg} style={styles.flex}>
        {props.text}
      </Text>
      {props.action === undefined ? null : <Button kind="text" {...props.action} />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  section: { gap: space.sm },
  sectionHead: { flexDirection: "row", alignItems: "center", minHeight: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: touchTarget + 16,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
  },
  trailing: { alignItems: "flex-end", gap: 2 },
  badge: { paddingHorizontal: space.sm, paddingVertical: 2, alignSelf: "flex-start" },
  center: { alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.md },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md },
});
