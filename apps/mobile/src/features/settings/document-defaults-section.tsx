import type {
  CurrencyCode,
  Locale,
  PaymentMethod,
  WorkspaceSettingsPatch,
} from "@kvitbit/domain/contract";
import { ifMatchHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Banner,
  Button,
  Card,
  RemoteView,
  Section,
  SegmentedChoice,
  SwitchRow,
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
import { type PaymentRounding, parseWorkspaceView } from "./workspace-data";

const CURRENCIES: ReadonlyArray<CurrencyCode> = ["CZK", "EUR", "USD", "GBP"] as CurrencyCode[];
const LOCALES: ReadonlyArray<Locale> = ["cs", "en"];
const PAYMENT_METHODS: ReadonlyArray<PaymentMethod> = ["bank_transfer", "cash", "card", "other"];
const ROUNDINGS: ReadonlyArray<PaymentRounding> = ["none", "whole_unit"];

/** Settings -> Document defaults (flow 10.6): billing defaults with optimistic revision check. */
export function DocumentDefaultsSection() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    (client) => client.workspace.current({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );

  const [currency, setCurrency] = useState<CurrencyCode>("CZK" as CurrencyCode);
  const [language, setLanguage] = useState<Locale>("cs");
  const [dueDays, setDueDays] = useState("14");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("bank_transfer");
  const [paymentRounding, setPaymentRounding] = useState<PaymentRounding>("none");
  const [ptdAutoSend, setPtdAutoSend] = useState(true);
  const [defaultNote, setDefaultNote] = useState("");
  const [revision, setRevision] = useState(1);
  const [saving, setSaving] = useState(false);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  useEffect(() => {
    if (remote.state._tag !== "Ready") return;
    const parsed = parseWorkspaceView(remote.state.value);
    setCurrency(parsed.defaults.currency);
    setLanguage(parsed.defaults.language);
    setDueDays(String(parsed.defaults.dueDays));
    setPaymentMethod(parsed.defaults.paymentMethod);
    setPaymentRounding(parsed.defaults.paymentRounding);
    setPtdAutoSend(parsed.defaults.paymentTaxDocumentAutoSend);
    setDefaultNote(parsed.defaults.defaultNote ?? "");
    setRevision(parsed.revision);
    setErrorState(noFormError);
  }, [remote.state]);

  const parsedDueDays = Number.parseInt(dueDays.trim(), 10);
  const validDueDays =
    Number.isInteger(parsedDueDays) && parsedDueDays >= 0 && parsedDueDays <= 365;

  const handleSave = async () => {
    if (!editable || !validDueDays) return;
    setSaving(true);
    setErrorState(noFormError);
    const payload = {
      defaults: {
        currency,
        language,
        dueDays: parsedDueDays,
        paymentMethod,
        paymentRounding,
        paymentTaxDocumentAutoSend: ptdAutoSend,
        defaultNote: defaultNote.trim() || null,
      },
    } as unknown as WorkspaceSettingsPatch;

    const result = await api.run((client) =>
      client.workspace.updateSettings({
        params: inWorkspace(workspace.id),
        headers: ifMatchHeaders(revision),
        payload,
      }),
    );
    setSaving(false);
    if (result._tag === "Ok") {
      remote.set(result.value);
      setRevision(result.value.revision);
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

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

          <Text variant="bodyMedium" color="onSurfaceVariant">
            {t("settings.documentDefaults.intro")}
          </Text>

          <Section title={t("settings.documentDefaults.title")}>
            <Card>
              <SegmentedChoice<CurrencyCode>
                label={t("common.field.currency")}
                value={currency}
                choices={CURRENCIES.map((c) => ({ value: c, label: c }))}
                onChange={(c) => {
                  if (editable) setCurrency(c);
                }}
              />
              <SegmentedChoice<Locale>
                label={t("settings.documentDefaults.language")}
                value={language}
                choices={LOCALES.map((l) => ({ value: l, label: t(`enum.locale.${l}`) }))}
                onChange={(l) => {
                  if (editable) setLanguage(l);
                }}
              />
              <TextField
                label={t("settings.documentDefaults.dueDays")}
                value={dueDays}
                disabled={!editable}
                keyboardType="number-pad"
                error={
                  !validDueDays
                    ? local({
                        cs: "Zadejte počet dnů (0–365).",
                        en: "Enter a number of days (0–365).",
                      })
                    : fieldErrorText(errorState, ["defaults", "dueDays"], i18n)
                }
                onChangeText={setDueDays}
              />
              <SegmentedChoice<PaymentMethod>
                label={t("settings.documentDefaults.paymentMethod")}
                value={paymentMethod}
                choices={PAYMENT_METHODS.map((pm) => ({
                  value: pm,
                  label: t(`enum.paymentMethod.${pm}`),
                }))}
                onChange={(pm) => {
                  if (editable) setPaymentMethod(pm);
                }}
              />
              <SegmentedChoice<PaymentRounding>
                label={local({ cs: "Zaokrouhlení celkové částky", en: "Total rounding" })}
                value={paymentRounding}
                choices={ROUNDINGS.map((r) => ({
                  value: r,
                  label:
                    r === "none"
                      ? local({ cs: "Bez zaokrouhlení", en: "No rounding" })
                      : local({ cs: "Na celé jednotky", en: "Whole units" }),
                }))}
                onChange={(r) => {
                  if (editable) setPaymentRounding(r);
                }}
              />
              <SwitchRow
                label={local({
                  cs: "Automaticky odesílat daňový doklad k platbě",
                  en: "Auto-send payment tax document",
                })}
                value={ptdAutoSend}
                disabled={!editable}
                onChange={setPtdAutoSend}
              />
              <TextField
                label={t("common.field.note")}
                value={defaultNote}
                disabled={!editable}
                multiline
                error={fieldErrorText(errorState, ["defaults", "defaultNote"], i18n)}
                onChangeText={setDefaultNote}
              />
            </Card>
          </Section>

          {editable ? (
            <Button
              testID="document-defaults-save"
              kind="filled"
              label={t("common.action.saveChanges")}
              busy={saving}
              disabled={!validDueDays}
              onPress={() => void handleSave()}
            />
          ) : null}
        </View>
      )}
    </RemoteView>
  );
}
