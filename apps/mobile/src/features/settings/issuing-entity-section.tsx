import type { IssuingEntityPatch } from "@kvitbit/domain/contract";
import { describeError, ifMatchHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import { applyAddressInputChange } from "@kvitbit/ui-port/format";
import { RefreshCw } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  type AresFieldDiff,
  type AresLookupState,
  applyAresResult,
  aresAfterIcoEdit,
  aresIdle,
  aresSettled,
  aresStarted,
} from "./ares-lookup";
import { canEditWorkspaceSettings } from "./permissions";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";
import { type IssuingEntityData, parseWorkspaceView } from "./workspace-data";

const diffFieldLabel = (
  field: AresFieldDiff["field"],
  t: ReturnType<typeof useI18n>["t"],
): string => {
  switch (field) {
    case "name":
      return t("common.field.name");
    case "dic":
      return t("common.field.dic");
    case "street":
      return t("common.field.street");
    case "city":
      return t("common.field.city");
    case "postalCode":
      return t("common.field.postalCode");
    case "country":
      return t("common.field.country");
    case "legalForm":
      return t("common.field.type");
    case "registerEntry":
      return t("settings.issuingEntity.registerEntry");
  }
};

/** Settings -> Business details (flow 10.1): Issuing Entity form + ARES refresh with diff preview. */
export function IssuingEntitySection() {
  const { workspace, reload: reloadWorkspaces } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    (client) => client.workspace.current({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );

  const [draft, setDraft] = useState<IssuingEntityData | null>(null);
  const [revision, setRevision] = useState<number>(1);
  const [saving, setSaving] = useState(false);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);
  const [ares, setAres] = useState<AresLookupState>(aresIdle);

  useEffect(() => {
    if (remote.state._tag !== "Ready") return;
    const parsed = parseWorkspaceView(remote.state.value);
    setDraft(parsed.issuingEntity);
    setRevision(parsed.revision);
    setErrorState(noFormError);
  }, [remote.state]);

  const updateField = <K extends keyof IssuingEntityData>(key: K, value: IssuingEntityData[K]) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, [key]: value }));
  };

  const updateAddress = (key: keyof IssuingEntityData["address"], value: string) => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const pasted = applyAddressInputChange(prev.address, key, value, { defaultCountry: "CZ" });
      return {
        ...prev,
        address: pasted ?? { ...prev.address, [key]: value },
      };
    });
  };

  const handleAresLookup = async () => {
    if (draft === null) return;
    const ico = (draft.ico ?? "").trim();
    if (ico === "") return;
    setAres(aresStarted(ico));
    const result = await api.run((client) => client.registry.lookupCompany({ params: { ico } }));
    setAres((current) => {
      if (current._tag !== "LookingUp" || current.ico !== ico) return current;
      return aresSettled(ico, draft, result);
    });
  };

  const handleApplyAres = () => {
    if (draft === null || ares._tag !== "Found") return;
    setDraft(applyAresResult(draft, ares.result));
    setAres({ _tag: "Applied", ico: ares.ico });
    overlay.toast(
      local({
        cs: "Údaje z ARES připraveny k uložení.",
        en: "ARES details applied. Save to persist.",
      }),
    );
  };

  const handleSave = async () => {
    if (!editable || draft === null) return;
    setSaving(true);
    setErrorState(noFormError);
    const payload = {
      name: draft.name.trim(),
      ico: draft.ico?.trim() || null,
      dic: draft.dic?.trim() || null,
      address: {
        street: draft.address.street.trim(),
        city: draft.address.city.trim(),
        postalCode: draft.address.postalCode.trim(),
        country: draft.address.country.trim() || "CZ",
      },
      legalForm: draft.legalForm?.trim() || null,
      registerEntry: draft.registerEntry?.trim() || null,
      email: draft.email?.trim() || null,
      phone: draft.phone?.trim() || null,
      web: draft.web?.trim() || null,
    } as unknown as IssuingEntityPatch;

    const result = await api.run((client) =>
      client.workspace.updateIssuingEntity({
        params: inWorkspace(workspace.id),
        headers: ifMatchHeaders(revision),
        payload,
      }),
    );
    setSaving(false);
    if (result._tag === "Ok") {
      remote.set(result.value);
      const parsed = parseWorkspaceView(result.value);
      setDraft(parsed.issuingEntity);
      setRevision(parsed.revision);
      setAres(aresIdle);
      reloadWorkspaces();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {() => {
        if (draft === null) return null;
        return (
          <View style={styles.stack}>
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

            <Text variant="bodyMedium" color="onSurfaceVariant">
              {t("settings.issuingEntity.intro")}
            </Text>

            <Section title={t("common.field.ico")}>
              <Card>
                <TextField
                  label={t("common.field.ico")}
                  value={draft.ico ?? ""}
                  disabled={!editable}
                  keyboardType="number-pad"
                  error={fieldErrorText(errorState, ["ico"], i18n)}
                  onChangeText={(value) => {
                    updateField("ico", value);
                    setAres((prev) => aresAfterIcoEdit(prev, value));
                  }}
                />
                {editable ? (
                  <View style={styles.row}>
                    <Button
                      testID="ares-refresh-button"
                      kind="tonal"
                      icon={RefreshCw}
                      label={t("settings.issuingEntity.refreshAres")}
                      busy={ares._tag === "LookingUp"}
                      disabled={(draft.ico ?? "").trim() === ""}
                      onPress={() => void handleAresLookup()}
                    />
                  </View>
                ) : null}

                {ares._tag === "Failed" ? (
                  <Banner text={i18n.text(describeError(ares.error).text)} tone="error" />
                ) : null}

                {ares._tag === "Found" ? (
                  <View style={styles.diffBox}>
                    {ares.result.terminatedOn === null ? null : (
                      <Banner
                        tone="warning"
                        text={local({
                          cs: `Subjekt byl v ARES ukončen dne ${ares.result.terminatedOn}.`,
                          en: `Entity was terminated in ARES on ${ares.result.terminatedOn}.`,
                        })}
                      />
                    )}
                    {ares.diffs.length === 0 ? (
                      <Text variant="meta" color="onSurfaceVariant">
                        {local({
                          cs: "Údaje jsou aktuální podle ARES.",
                          en: "Details already match ARES.",
                        })}
                      </Text>
                    ) : (
                      <>
                        <Text variant="titleSmall">
                          {local({ cs: "Změny z ARES", en: "Changes from ARES" })}
                        </Text>
                        {ares.diffs.map((diff) => (
                          <View key={diff.field} style={styles.diffRow}>
                            <Text variant="labelSmall" color="onSurfaceVariant">
                              {diffFieldLabel(diff.field, t)}
                            </Text>
                            <Text variant="meta" color="onSurfaceVariant">
                              {diff.before === "" ? "—" : diff.before} → {diff.after}
                            </Text>
                          </View>
                        ))}
                        <View style={styles.row}>
                          <Button
                            testID="ares-apply-button"
                            kind="filled"
                            label={t("common.action.apply")}
                            onPress={handleApplyAres}
                          />
                          <Button
                            kind="text"
                            label={t("common.action.cancel")}
                            onPress={() => setAres(aresIdle)}
                          />
                        </View>
                      </>
                    )}
                  </View>
                ) : null}
              </Card>
            </Section>

            <Section title={t("settings.issuingEntity.title")}>
              <Card>
                <TextField
                  label={t("common.field.name")}
                  value={draft.name}
                  disabled={!editable}
                  error={fieldErrorText(errorState, ["name"], i18n)}
                  onChangeText={(value) => updateField("name", value)}
                />
                <TextField
                  label={t("common.field.dic")}
                  value={draft.dic ?? ""}
                  disabled={!editable}
                  error={fieldErrorText(errorState, ["dic"], i18n)}
                  onChangeText={(value) => updateField("dic", value)}
                />
                <TextField
                  label={t("settings.issuingEntity.registerEntry")}
                  supporting={t("settings.issuingEntity.registerEntryHint")}
                  value={draft.registerEntry ?? ""}
                  disabled={!editable}
                  multiline
                  error={fieldErrorText(errorState, ["registerEntry"], i18n)}
                  onChangeText={(value) => updateField("registerEntry", value)}
                />
              </Card>
            </Section>

            <Section title={t("common.field.address")}>
              <Card>
                <TextField
                  label={t("common.field.street")}
                  value={draft.address.street}
                  disabled={!editable}
                  error={fieldErrorText(errorState, ["address", "street"], i18n)}
                  onChangeText={(value) => updateAddress("street", value)}
                />
                <TextField
                  label={t("common.field.city")}
                  value={draft.address.city}
                  disabled={!editable}
                  error={fieldErrorText(errorState, ["address", "city"], i18n)}
                  onChangeText={(value) => updateAddress("city", value)}
                />
                <TextField
                  label={t("common.field.postalCode")}
                  value={draft.address.postalCode}
                  disabled={!editable}
                  error={fieldErrorText(errorState, ["address", "postalCode"], i18n)}
                  onChangeText={(value) => updateAddress("postalCode", value)}
                />
                <TextField
                  label={t("common.field.country")}
                  value={draft.address.country}
                  disabled={!editable}
                  autoCapitalize="characters"
                  error={fieldErrorText(errorState, ["address", "country"], i18n)}
                  onChangeText={(value) => updateAddress("country", value)}
                />
              </Card>
            </Section>

            <Section title={local({ cs: "Kontaktní údaje", en: "Contact details" })}>
              <Card>
                <TextField
                  label={t("common.field.email")}
                  value={draft.email ?? ""}
                  disabled={!editable}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  error={fieldErrorText(errorState, ["email"], i18n)}
                  onChangeText={(value) => updateField("email", value)}
                />
                <TextField
                  label={t("common.field.phone")}
                  value={draft.phone ?? ""}
                  disabled={!editable}
                  keyboardType="phone-pad"
                  error={fieldErrorText(errorState, ["phone"], i18n)}
                  onChangeText={(value) => updateField("phone", value)}
                />
                <TextField
                  label={t("common.field.website")}
                  value={draft.web ?? ""}
                  disabled={!editable}
                  autoCapitalize="none"
                  error={fieldErrorText(errorState, ["web"], i18n)}
                  onChangeText={(value) => updateField("web", value)}
                />
              </Card>
            </Section>

            {editable ? (
              <Button
                testID="issuing-entity-save"
                kind="filled"
                label={t("common.action.saveChanges")}
                busy={saving}
                onPress={() => void handleSave()}
              />
            ) : null}
          </View>
        );
      }}
    </RemoteView>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  diffBox: { gap: space.sm, paddingTop: space.sm },
  diffRow: { gap: 2 },
});
