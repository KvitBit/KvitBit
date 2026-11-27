import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../i18n/i18n-provider";
import { useTheme } from "../theme/theme-provider";
import { IconButton } from "./button";
import { Text } from "./text";
import { contentMaxWidth, space } from "./tokens";

export interface ScreenProps {
  readonly title?: string;
  /** Shows a back arrow: `true` uses router.back(), a function overrides it. */
  readonly back?: boolean | (() => void);
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Pull to refresh; scroll screens only. */
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
  /** Pinned under the content (form actions). */
  readonly footer?: ReactNode;
  /** false for screens that host their own FlatList. */
  readonly scroll?: boolean;
}

export function AppBar(props: {
  readonly title?: string | undefined;
  readonly back?: ScreenProps["back"] | undefined;
  readonly actions?: ReactNode;
}) {
  const theme = useTheme();
  const { t } = useI18n();
  const onBack =
    props.back === undefined || props.back === false
      ? undefined
      : props.back === true
        ? () => (router.canGoBack() ? router.back() : router.replace("/"))
        : props.back;
  return (
    <View style={[styles.bar, { backgroundColor: theme.colors.surface }]}>
      {onBack === undefined ? null : (
        <IconButton icon={ArrowLeft} label={t("common.action.back")} onPress={onBack} />
      )}
      <Text variant="titleLarge" accessibilityRole="header" numberOfLines={1} style={styles.title}>
        {props.title ?? ""}
      </Text>
      <View style={styles.actions}>{props.actions}</View>
    </View>
  );
}

export function Screen(props: ScreenProps) {
  const theme = useTheme();
  const body =
    props.scroll === false ? (
      <View style={styles.fill}>{props.children}</View>
    ) : (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        refreshControl={
          props.onRefresh === undefined ? undefined : (
            <RefreshControl refreshing={props.refreshing === true} onRefresh={props.onRefresh} />
          )
        }
      >
        <View style={styles.column}>{props.children}</View>
      </ScrollView>
    );
  return (
    <SafeAreaView
      edges={["top", "left", "right"]}
      style={[styles.fill, { backgroundColor: theme.colors.surface }]}
    >
      {props.title === undefined && props.back === undefined ? null : (
        <AppBar title={props.title} back={props.back} actions={props.actions} />
      )}
      {body}
      {props.footer === undefined ? null : (
        <View
          style={[
            styles.footer,
            { borderTopColor: theme.colors.outlineVariant, backgroundColor: theme.colors.surface },
          ]}
        >
          {props.footer}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: "row", alignItems: "center", minHeight: 64, paddingHorizontal: space.xs },
  title: { flex: 1, marginHorizontal: space.md },
  actions: { flexDirection: "row", alignItems: "center" },
  content: { padding: space.lg, paddingBottom: space.xxl, alignItems: "center" },
  column: { width: "100%", maxWidth: contentMaxWidth, gap: space.lg },
  footer: {
    flexDirection: "row",
    gap: space.sm,
    justifyContent: "flex-end",
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
