import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n/i18n-provider";
import { Banner } from "../ui/surface";
import { space } from "../ui/tokens";
import type { UpdatePrompt } from "./update-prompt";
import { useUpdatePrompt } from "./use-update-prompt";

/**
 * The reload offer for a downloaded over-the-air update, floating over the
 * bottom of every screen where toasts appear, above the tab bar, without
 * blocking the screen behind it. Mount it once in the root layout.
 */
export function UpdateBanner() {
  const { prompt, reload } = useUpdatePrompt();
  return <UpdateBannerView prompt={prompt} onReload={reload} />;
}

/** The banner for `prompt`, or nothing when no update is ready. */
export function UpdateBannerView(props: {
  readonly prompt: UpdatePrompt | undefined;
  readonly onReload: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  if (props.prompt === undefined) return null;
  return (
    <View
      style={[
        styles.overlay,
        {
          bottom: insets.bottom + 88,
          left: insets.left + space.lg,
          right: insets.right + space.lg,
        },
      ]}
    >
      <Banner
        tone="info"
        text={t("shell.updateAvailable")}
        action={{ label: t("shell.updateReload"), onPress: props.onReload }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", pointerEvents: "box-none" },
});
