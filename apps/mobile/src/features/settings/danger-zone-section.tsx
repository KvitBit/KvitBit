import type { MemberView, UserId } from "@kvitbit/domain/contract";
import { inWorkspace } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  SegmentedChoice,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { forkFeatureEffect } from "../ui-effect";
import { canCloseWorkspace, canTransferOwnership } from "./permissions";
import { type FormErrorState, formErrorFrom, noFormError } from "./settings-feedback";

/** Settings -> Danger zone (flows 2.8, 2.9): transfer ownership & close workspace (owner only). */
export function DangerZoneSection() {
  const { workspace, reload: reloadWorkspaces } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const canTransfer = canTransferOwnership(workspace.role, workspace.closed);
  const canClose = canCloseWorkspace(workspace.role, workspace.closed);

  const membersRemote = useRemote(
    canTransfer ? (client) => client.team.listMembers({ params: inWorkspace(workspace.id) }) : null,
    [workspace.id, canTransfer],
  );

  const [targetAdminId, setTargetAdminId] = useState<UserId | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState<"transfer" | "close" | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  if (!(canTransfer || canClose)) {
    return (
      <View style={styles.stack}>
        <Banner
          text={local({
            cs: "Tuto sekci může spravovat pouze vlastník workspace.",
            en: "Only the workspace owner can manage these actions.",
          })}
          tone="info"
        />
      </View>
    );
  }

  const handleTransfer = Effect.fn("danger-zone-section.handleTransfer")(function* (
    admins: ReadonlyArray<MemberView>,
  ) {
    if (targetAdminId === null) return;
    const picked = Option.getOrUndefined(Arr.findFirst(admins, (m) => m.userId === targetAdminId));
    if (picked === undefined) return;
    const confirmed = yield* Effect.promise(() =>
      overlay.confirm({
        title: t("settings.dangerZone.transferConfirm", { name: picked.name }),
        body: t("settings.dangerZone.transferBody"),
        confirmLabel: t("settings.dangerZone.transfer"),
        cancelLabel: t("common.action.cancel"),
        destructive: true,
      }),
    );
    if (!confirmed) return;
    setBusy("transfer");
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.team.transferOwnership({
          params: inWorkspace(workspace.id),
          payload: { to: targetAdminId },
        }),
      ),
    );
    setBusy(null);
    if (result._tag === "Ok") {
      reloadWorkspaces();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleClose = Effect.fn("danger-zone-section.handleClose")(function* () {
    if (Str.trim(confirmName) !== workspace.name) return;
    const confirmed = yield* Effect.promise(() =>
      overlay.confirm({
        title: t("settings.dangerZone.close"),
        body: t("settings.dangerZone.closeBody"),
        confirmLabel: t("settings.dangerZone.close"),
        cancelLabel: t("common.action.cancel"),
        destructive: true,
      }),
    );
    if (!confirmed) return;
    setBusy("close");
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.workspace.close({
          params: inWorkspace(workspace.id),
          payload: { confirmName: Str.trim(confirmName) },
        }),
      ),
    );
    setBusy(null);
    if (result._tag === "Ok") {
      reloadWorkspaces();
      router.replace("/");
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  return (
    <View style={styles.stack}>
      {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

      <Section title={t("settings.dangerZone.transfer")}>
        <RemoteView state={membersRemote.state} onRetry={membersRemote.reload}>
          {(members) => {
            const admins = Arr.filter(members, (m) => m.role === "admin");
            return (
              <Card>
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  {t("settings.dangerZone.transferBody")}
                </Text>
                {admins.length === 0 ? (
                  <Text variant="meta" color="onSurfaceVariant">
                    {local({
                      cs: "Nejprve povyšte některého člena na roli Správce v sekci Tým.",
                      en: "Promote a member to Admin in Team settings first.",
                    })}
                  </Text>
                ) : (
                  <>
                    <SegmentedChoice<UserId>
                      label={t("settings.dangerZone.transferPick")}
                      value={targetAdminId}
                      choices={Arr.map(admins, (a) => ({ value: a.userId, label: a.name }))}
                      onChange={setTargetAdminId}
                    />
                    <Button
                      testID="danger-transfer-submit"
                      kind="danger"
                      label={t("settings.dangerZone.transfer")}
                      busy={busy === "transfer"}
                      disabled={targetAdminId === null}
                      onPress={() => forkFeatureEffect(handleTransfer(admins))}
                    />
                  </>
                )}
              </Card>
            );
          }}
        </RemoteView>
      </Section>

      <Section title={t("settings.dangerZone.close")}>
        <Card>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {t("settings.dangerZone.closeBody")}
          </Text>
          <Banner text={t("settings.dangerZone.retention")} tone="warning" />
          <TextField
            label={t("settings.dangerZone.closeConfirm", { name: workspace.name })}
            value={confirmName}
            onChangeText={setConfirmName}
          />
          <Button
            testID="danger-close-submit"
            kind="danger"
            label={t("settings.dangerZone.close")}
            busy={busy === "close"}
            disabled={Str.trim(confirmName) !== workspace.name}
            onPress={() => forkFeatureEffect(handleClose())}
          />
        </Card>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
});
