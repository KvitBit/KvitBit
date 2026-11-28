import { router } from "expo-router";
import { useI18n } from "../../i18n/i18n-provider";
import { EmptyState, Screen, Text } from "../../ui";
import type { ErrorKind } from "./auth-links";

export function ErrorScreen(props: { readonly kind: ErrorKind; readonly requestId?: string }) {
  const { t } = useI18n();
  const titleKey = `public.error.${props.kind}.title` as const;
  const bodyKey = `public.error.${props.kind}.body` as const;

  const action =
    props.kind === "offline" || props.kind === "server"
      ? {
          label: t("common.action.retry"),
          onPress: () => router.replace("/"),
        }
      : {
          label: t("common.action.goHome"),
          onPress: () => router.replace("/"),
        };

  return (
    <Screen title={t(titleKey)}>
      <EmptyState title={t(titleKey)} body={t(bodyKey)} action={action} />
      {props.kind === "server" && props.requestId !== undefined && props.requestId.length > 0 ? (
        <Text variant="meta" color="onSurfaceVariant" align="center">
          {t("public.error.server.requestId", { requestId: props.requestId })}
        </Text>
      ) : null}
    </Screen>
  );
}
