import { WorkspaceSettingsPatch } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { ifMatchHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { Plus, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  SwitchRow,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { forkFeatureEffect } from "../ui-effect";
import { canEditWorkspaceSettings } from "./permissions";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";
import { parseWorkspaceView } from "./workspace-data";

const DIGITS = /^\d+$/;

/** Settings -> Reminders (flow 7.5): overdue reminder schedule with optimistic revision check. */
export function RemindersSection() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    useCallback(
      (client: KvitbitApiClient) => client.workspace.current({ params: inWorkspace(workspace.id) }),
      [workspace.id],
    ),
  );

  const [enabled, setEnabled] = useState(true);
  const [proformas, setProformas] = useState(false);
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([3, 10, 30]);
  const [newOffset, setNewOffset] = useState("");
  const [revision, setRevision] = useState(1);
  const [saving, setSaving] = useState(false);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  useEffect(() => {
    if (remote.state._tag !== "Ready") return;
    const parsed = parseWorkspaceView(remote.state.value);
    setEnabled(parsed.reminderPolicy.enabled);
    setProformas(parsed.reminderPolicy.proformas);
    setOffsets(parsed.reminderPolicy.offsetsDays);
    setRevision(parsed.revision);
    setErrorState(noFormError);
  }, [remote.state]);

  const handleAddOffset = () => {
    const parsed = Number.parseInt(Str.trim(newOffset), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return;
    if (!offsets.includes(parsed)) {
      setOffsets([...offsets, parsed].sort((a, b) => a - b));
    }
    setNewOffset("");
  };

  const handleRemoveOffset = (day: number) => {
    setOffsets(Arr.filter(offsets, (d) => d !== day));
  };

  const handleSave = Effect.fn("reminders-section.handleSave")(function* () {
    if (!editable) return;
    setSaving(true);
    setErrorState(noFormError);
    const payload = WorkspaceSettingsPatch.make({
      reminderPolicy: {
        enabled,
        proformas,
        offsetsDays: [...offsets],
      },
    });

    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.workspace.updateSettings({
          params: inWorkspace(workspace.id),
          headers: ifMatchHeaders(revision),
          payload,
        }),
      ),
    );
    setSaving(false);
    if (result._tag === "Ok") {
      remote.set(result.value);
      setRevision(result.value.revision);
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {() => (
        <View className="gap-4">
          {editable ? null : <Banner text={t("settings.readOnly")} tone="info" />}
          {errorState.banner === null ? null : (
            <Banner
              text={errorState.banner}
              tone="error"
              {...(errorState.staleRevision
                ? { action: { label: t("common.action.reload"), onPress: remote.reload } }
                : {})}
            />
          )}

          <Section title={t("settings.reminders.title")}>
            <Card>
              <SwitchRow
                label={t("settings.reminders.enable")}
                value={enabled}
                disabled={!editable}
                onChange={setEnabled}
              />
              <SwitchRow
                label={local({
                  cs: "Posílat upomínky i pro zálohové faktury",
                  en: "Also send reminders for proforma invoices",
                })}
                value={proformas}
                disabled={!editable || enabled !== true}
                onChange={setProformas}
              />
            </Card>
          </Section>

          <Section title={t("settings.reminders.offsets")}>
            <Card>
              {offsets.length === 0 ? (
                <Text variant="meta" color="onSurfaceVariant">
                  {t("common.state.none")}
                </Text>
              ) : (
                <View className="flex-row flex-wrap gap-2">
                  {Arr.map(offsets, (day) => (
                    <Button
                      key={day}
                      kind="tonal"
                      {...(editable ? { icon: X, disabled: false } : { disabled: true })}
                      label={t("settings.reminders.offset", { count: day })}
                      onPress={() => handleRemoveOffset(day)}
                    />
                  ))}
                </View>
              )}

              {editable ? (
                <View className="flex-row items-end gap-2">
                  <View className="flex-1">
                    <TextField
                      label={t("settings.reminders.addOffset")}
                      value={newOffset}
                      keyboardType="number-pad"
                      placeholder="14"
                      error={fieldErrorText(errorState, ["reminderPolicy", "offsetsDays"], i18n)}
                      onChangeText={setNewOffset}
                    />
                  </View>
                  <Button
                    testID="reminder-add-offset"
                    kind="outlined"
                    icon={Plus}
                    label={t("common.action.add")}
                    disabled={!DIGITS.test(Str.trim(newOffset))}
                    onPress={handleAddOffset}
                  />
                </View>
              ) : null}
            </Card>
          </Section>

          {editable ? (
            <Button
              testID="reminders-save"
              kind="filled"
              label={t("common.action.saveChanges")}
              busy={saving}
              onPress={() => forkFeatureEffect(handleSave())}
            />
          ) : null}
        </View>
      )}
    </RemoteView>
  );
}
