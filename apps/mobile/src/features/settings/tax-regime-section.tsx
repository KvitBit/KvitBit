import type { IssuingEntityPatch, TaxRegime } from "@kvitbit/domain/contract";
import { ifMatchHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  Banner,
  Button,
  Card,
  ListRow,
  RemoteView,
  Section,
  SegmentedChoice,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canEditWorkspaceSettings } from "./permissions";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";
import { parseWorkspaceView, todayIsoDate } from "./workspace-data";

const TAX_REGIMES: ReadonlyArray<TaxRegime> = ["non_vat_payer", "vat_payer", "identified_person"];

/** Settings -> Tax regime (flow 10.2): current regime, chronological history, and regime change. */
export function TaxRegimeSection() {
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

  const [selectedRegime, setSelectedRegime] = useState<TaxRegime>(workspace.taxRegime);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIsoDate);
  const [saving, setSaving] = useState(false);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  useEffect(() => {
    if (remote.state._tag !== "Ready") return;
    const parsed = parseWorkspaceView(remote.state.value);
    setSelectedRegime(parsed.taxRegime);
    setErrorState(noFormError);
  }, [remote.state]);

  const handleChangeRegime = async (currentRevision: number) => {
    if (!editable) return;
    const date = effectiveFrom.trim();
    const regimeLabel = t(`enum.taxRegime.${selectedRegime}`);
    const confirmed = await overlay.confirm({
      title: t("settings.taxRegime.confirmTitle", { regime: regimeLabel }),
      body:
        selectedRegime === "vat_payer"
          ? `${t("settings.taxRegime.confirmBody", { date })} ${local({
              cs: "Pro plátce DPH bude připravena číselná řada daňových dokladů k přijaté platbě.",
              en: "A default Payment Tax Document numbering series will be added for VAT payers.",
            })}`
          : t("settings.taxRegime.confirmBody", { date }),
      confirmLabel: t("common.action.confirm"),
      cancelLabel: t("common.action.cancel"),
    });
    if (!confirmed) return;

    setSaving(true);
    setErrorState(noFormError);
    const payload = {
      taxRegime: { regime: selectedRegime, effectiveFrom: date },
    } as unknown as IssuingEntityPatch;

    const result = await api.run((client) =>
      client.workspace.updateIssuingEntity({
        params: inWorkspace(workspace.id),
        headers: ifMatchHeaders(currentRevision),
        payload,
      }),
    );
    setSaving(false);
    if (result._tag === "Ok") {
      remote.set(result.value);
      reloadWorkspaces();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {(raw) => {
        const parsed = parseWorkspaceView(raw);
        const unchanged = selectedRegime === parsed.taxRegime;
        return (
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

            <Card>
              <Text variant="titleMedium">
                {t("settings.taxRegime.current", {
                  regime: t(`enum.taxRegime.${parsed.taxRegime}`),
                })}
              </Text>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {t(`enum.taxRegimeHint.${parsed.taxRegime}`)}
              </Text>
            </Card>

            <Section title={local({ cs: "Historie daňového režimu", en: "Regime history" })}>
              <Card className="gap-0 px-3 py-1">
                {parsed.taxRegimeHistory.length === 0 ? (
                  <ListRow
                    title={t(`enum.taxRegime.${parsed.taxRegime}`)}
                    badge={<Badge label={t("common.state.all")} tone="info" />}
                  />
                ) : (
                  parsed.taxRegimeHistory.map((period, idx) => (
                    <ListRow
                      key={`${period.effectiveFrom}-${period.regime}`}
                      title={t(`enum.taxRegime.${period.regime}`)}
                      subtitle={`${t("settings.taxRegime.effectiveFrom")}: ${period.effectiveFrom}`}
                      badge={
                        idx === parsed.taxRegimeHistory.length - 1 ? (
                          <Badge label={local({ cs: "Aktuální", en: "Current" })} tone="success" />
                        ) : undefined
                      }
                    />
                  ))
                )}
              </Card>
            </Section>

            {editable ? (
              <Section title={t("settings.taxRegime.change")}>
                <Card>
                  <SegmentedChoice<TaxRegime>
                    label={t("settings.taxRegime.title")}
                    value={selectedRegime}
                    choices={TAX_REGIMES.map((regime) => ({
                      value: regime,
                      label: t(`enum.taxRegime.${regime}`),
                    }))}
                    onChange={setSelectedRegime}
                  />
                  <Text variant="meta" color="onSurfaceVariant">
                    {t(`enum.taxRegimeHint.${selectedRegime}`)}
                  </Text>
                  <TextField
                    label={t("settings.taxRegime.effectiveFrom")}
                    supporting={t("settings.taxRegime.keepsOld")}
                    value={effectiveFrom}
                    placeholder="YYYY-MM-DD"
                    error={fieldErrorText(errorState, ["taxRegime", "effectiveFrom"], i18n)}
                    onChangeText={setEffectiveFrom}
                  />
                  <Button
                    testID="tax-regime-submit"
                    kind="filled"
                    label={t("settings.taxRegime.change")}
                    busy={saving}
                    disabled={unchanged || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom.trim())}
                    onPress={() => void handleChangeRegime(parsed.revision)}
                  />
                </Card>
              </Section>
            ) : null}
          </View>
        );
      }}
    </RemoteView>
  );
}
