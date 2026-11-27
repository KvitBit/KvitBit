import { CheckCircle2, ShieldAlert } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import type { BotProofState } from "../../platform/altcha/bot-proof";
import { useTheme } from "../../theme/theme-provider";
import { Banner, Icon, Text } from "../../ui";

/** Inline ALTCHA status with space for the retry action before a check starts. */
export function BotProofWidget(props: {
  readonly state: BotProofState;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const { state } = props;

  if (state._tag === "NotRequired") return <View className="min-h-[72px] justify-center" />;

  if (state._tag === "Failed") {
    return (
      <View className="min-h-[72px] justify-center">
        <Banner
          tone="error"
          text={t("auth.botProof.failed")}
          action={{ label: t("common.action.retry"), onPress: props.onRetry }}
        />
      </View>
    );
  }

  const label =
    state._tag === "Fetching"
      ? t("auth.botProof.verifying")
      : state._tag === "Solving"
        ? t("auth.botProof.progress", { percent: Math.round(state.progress * 100) })
        : t("auth.botProof.verified");

  return (
    <View className="min-h-[72px] justify-center">
      <View
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        className="flex-row items-center gap-2 rounded-control border border-outline-variant bg-surface-container-low p-3"
      >
        {state._tag === "Solved" ? (
          <Icon icon={CheckCircle2} size={18} color="primary" />
        ) : (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        )}
        <View className="flex-1 gap-0.5">
          <Text variant="bodyMedium">{label}</Text>
          <Text variant="meta" color="onSurfaceVariant">
            {t("auth.botProof.label")}
          </Text>
        </View>
        {state._tag === "Solved" ? null : (
          <Icon icon={ShieldAlert} size={16} color="onSurfaceVariant" />
        )}
      </View>
    </View>
  );
}
