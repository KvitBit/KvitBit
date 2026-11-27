import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView as RNSafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";
import { useI18n } from "../i18n/i18n-provider";
import { IconButton } from "./button";
import { Text } from "./text";

const SafeAreaView = withUniwind(RNSafeAreaView);

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
  const { t } = useI18n();
  const onBack =
    props.back === undefined || props.back === false
      ? undefined
      : props.back === true
        ? () => (router.canGoBack() ? router.back() : router.replace("/"))
        : props.back;
  return (
    <View className="min-h-16 flex-row items-center bg-surface px-1">
      {onBack === undefined ? null : (
        <IconButton icon={ArrowLeft} label={t("common.action.back")} onPress={onBack} />
      )}
      <Text
        variant="titleLarge"
        accessibilityRole="header"
        numberOfLines={1}
        className="mx-3 flex-1"
      >
        {props.title ?? ""}
      </Text>
      <View className="flex-row items-center">{props.actions}</View>
    </View>
  );
}

export function Screen(props: ScreenProps) {
  const body =
    props.scroll === false ? (
      <View className="flex-1">{props.children}</View>
    ) : (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="items-center p-4 pb-8"
        refreshControl={
          props.onRefresh === undefined ? undefined : (
            <RefreshControl refreshing={props.refreshing === true} onRefresh={props.onRefresh} />
          )
        }
      >
        <View className="w-full max-w-[720px] gap-4">{props.children}</View>
      </ScrollView>
    );
  return (
    <SafeAreaView edges={["top", "left", "right"]} className="flex-1 bg-surface">
      {props.title === undefined && props.back === undefined ? null : (
        <AppBar title={props.title} back={props.back} actions={props.actions} />
      )}
      {body}
      {props.footer === undefined ? null : (
        <View className="flex-row justify-end gap-2 border-t border-outline-variant bg-surface p-3">
          {props.footer}
        </View>
      )}
    </SafeAreaView>
  );
}
