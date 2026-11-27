import type { ConnectedAppView } from "@kvitbit/api-contract";
import { inWorkspace } from "@kvitbit/ui-port/api";
import { Unplug } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  RemoteView,
  Section,
  Text,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canRevokeConnectedApp } from "./permissions";
import { type FormErrorState, formErrorFrom, noFormError } from "./settings-feedback";

/** Settings -> Connected apps (flow 10.9): MCP OAuth grants list + revoke. */
export function ConnectedAppsSection() {
  const { workspace } = useWorkspace();
  const session = useSession();
  const api = useApi();
  const i18n = useI18n();
  const { t } = i18n;
  const overlay = useOverlay();

  const currentUserId = session.state.status === "signed-in" ? session.state.user.id : null;
  const remote = useRemote(
    (client) => client.connectedApps.listConnectedApps({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  const handleRevoke = async (app: ConnectedAppView) => {
    const confirmed = await overlay.confirm({
      title: t("settings.connectedApps.revokeTitle", { name: app.client.name }),
      body: t("settings.connectedApps.revokeBody"),
      confirmLabel: t("common.action.revoke"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setRevokingId(app.grantId);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.connectedApps.revokeConnectedApp({
        params: inWorkspace(workspace.id, { grantId: app.grantId }),
      }),
    );
    setRevokingId(null);
    if (result._tag === "Ok") {
      remote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  return (
    <View className="gap-4">
      {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

      <Text variant="bodyMedium" color="onSurfaceVariant">
        {t("settings.connectedApps.intro")}
      </Text>

      <RemoteView state={remote.state} onRetry={remote.reload}>
        {(apps) =>
          apps.length === 0 ? (
            <EmptyState
              title={t("settings.connectedApps.title")}
              body={t("settings.connectedApps.empty")}
            />
          ) : (
            <Section title={t("settings.connectedApps.title")}>
              {apps.map((app) => {
                const revocable = canRevokeConnectedApp(
                  workspace.role,
                  app.member.userId,
                  currentUserId,
                  workspace.closed,
                );
                return (
                  <Card key={app.grantId}>
                    <View className="flex-row items-center gap-2">
                      <View className="flex-1">
                        <Text variant="titleSmall">{app.client.name}</Text>
                        <Text variant="meta" color="onSurfaceVariant">
                          {app.client.redirectHost} ·{" "}
                          {t("settings.connectedApps.member", { name: app.member.name })}
                        </Text>
                      </View>
                      <Badge label={t(`enum.accessMode.${app.access}`)} tone="info" />
                    </View>
                    <Text variant="meta" color="onSurfaceVariant">
                      {t("common.field.created")}: {app.createdAt.slice(0, 10)} ·{" "}
                      {t("common.field.lastUsed")}:{" "}
                      {app.lastUsedAt === null
                        ? t("common.time.never")
                        : app.lastUsedAt.slice(0, 10)}
                    </Text>
                    {revocable ? (
                      <View className="flex-row flex-wrap items-center gap-2">
                        <Button
                          testID={`revoke-app-${app.grantId}`}
                          kind="text"
                          icon={Unplug}
                          label={t("common.action.revoke")}
                          busy={revokingId === app.grantId}
                          onPress={() => void handleRevoke(app)}
                        />
                      </View>
                    ) : null}
                  </Card>
                );
              })}
            </Section>
          )
        }
      </RemoteView>
    </View>
  );
}
