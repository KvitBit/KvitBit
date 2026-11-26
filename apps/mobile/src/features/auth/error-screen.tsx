import { router } from "expo-router";
import { useI18n } from "../../i18n/i18n-provider";
import { EmptyState, Screen, Text } from "../../ui";

export type ErrorKind = "not_found" | "no_access" | "server" | "offline";

export const parseErrorKind = (raw: string | undefined): ErrorKind =>
  raw === "not_found" || raw === "no_access" || raw === "server" || raw === "offline"
    ? raw
    : "not_found";

export function ErrorScreen(props: { readonly kind: ErrorKind; readonly requestId?: string }) {
  const { t } = useI18n();
  const titleKey = `public.error.${props.kind}.title` as const;
  const bodyKey = `public.error.${props.kind}.body` as const;

  const action =
    props.kind === "offline" || props.kind === "server"
      ? {
          label: t("common.action.retry"),
          onPress: () => router.replace("/" as never),
        }
      : {
          label: t("common.action.goHome"),
          onPress: () => router.replace("/" as never),
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
