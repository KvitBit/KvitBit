import type {
  BankAccountInput,
  CurrencyCode,
  IssuingEntityPatch,
  NewWorkspace,
  RegistryResult,
  RequestKey,
  TaxRegime,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import { enumText, type Locale } from "@kvitbit/ui-port/i18n";
import * as Crypto from "expo-crypto";
import { Building2, Search } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi } from "../../runtime/api-runtime";
import {
  Banner,
  Button,
  Card,
  Screen,
  Section,
  SegmentedChoice,
  space,
  Text,
  TextField,
} from "../../ui";
import { lastWorkspace } from "../../workspace/last-workspace";

const TOTAL_STEPS = 3;

const DEFAULT_SERIES_PREVIEW = (regime: TaxRegime): string =>
  regime === "vat_payer"
    ? "YYYY-NNNN, ZF-YYYY-NNNN, DD-YYYY-NNNN, OD-YYYY-NNNN"
    : "YYYY-NNNN, ZF-YYYY-NNNN, OD-YYYY-NNNN";

export function OnboardingScreen(props: { readonly initialStep?: number }) {
  const { t, text, locale, local } = useI18n();
  const api = useApi();

  const clampedInitial =
    props.initialStep !== undefined && props.initialStep >= 1 && props.initialStep <= TOTAL_STEPS
      ? props.initialStep
      : 1;
  const [step, setStep] = useState(clampedInitial);

  // Step 1: Issuing entity + ARES
  const [ico, setIco] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [dic, setDic] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("CZ");
  const [registerEntry, setRegisterEntry] = useState("");
  const [aresStatus, setAresStatus] = useState<
    | { readonly _tag: "idle" }
    | { readonly _tag: "loading" }
    | { readonly _tag: "found"; readonly terminatedOn: string | null }
    | { readonly _tag: "not_found" }
    | { readonly _tag: "unavailable" }
    | { readonly _tag: "error"; readonly message: string }
  >({ _tag: "idle" });

  // Step 2: Tax regime & defaults
  const [taxRegime, setTaxRegime] = useState<TaxRegime>("non_vat_payer");
  const [currency, setCurrency] = useState<CurrencyCode>("CZK" as CurrencyCode);
  const [docLocale, setDocLocale] = useState<Locale>(locale);

  // Step 3: Bank account (optional) & submit
  const [iban, setIban] = useState("");
  const [bic, setBic] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const applyAresResult = (result: RegistryResult) => {
    setIco(result.ico);
    setName(result.name);
    setDic(result.dic ?? "");
    setStreet(result.address.street);
    setCity(result.address.city);
    setPostalCode(result.address.postalCode);
    setCountry(result.address.country || "CZ");
    setRegisterEntry(result.registerEntry ?? "");
    setAresStatus({ _tag: "found", terminatedOn: result.terminatedOn });
  };

  const handleAresLookup = async () => {
    const cleaned = ico.replace(/\s+/g, "");
    if (cleaned.length === 0) return;
    setAresStatus({ _tag: "loading" });
    setErrorBanner(null);
    const res = await api.run((client) =>
      client.registry.lookupCompany({ params: { ico: cleaned } }),
    );
    if (res._tag === "Ok") {
      applyAresResult(res.value);
      return;
    }
    if (res.error._tag === "NotFound") {
      setAresStatus({ _tag: "not_found" });
      return;
    }
    if (res.error._tag === "Unavailable" || res.error._tag === "RateLimited") {
      setAresStatus({ _tag: "unavailable" });
      return;
    }
    setAresStatus({ _tag: "error", message: text(describeError(res.error).text) });
  };

  const handleNext = () => {
    setErrorBanner(null);
    if (step === 1) {
      if (name.trim().length === 0) {
        setNameError(t("issue.form.required"));
        return;
      }
      setNameError(null);
      setStep(2);
      return;
    }
    if (step === 2) {
      setStep(3);
    }
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setStep(1);
      setNameError(t("issue.form.required"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);

    const trimmedIco = ico.replace(/\s+/g, "");
    const trimmedSlug = slug.trim();
    const payload = {
      name: trimmedName,
      ...(trimmedSlug.length > 0 ? { slug: trimmedSlug } : {}),
      ...(trimmedIco.length > 0 ? { ico: trimmedIco } : {}),
      taxRegime,
      defaults: { currency, language: docLocale },
    } as unknown as NewWorkspace;

    const idempotencyKey = Crypto.randomUUID() as RequestKey;
    const created = await api.run((client) =>
      client.myWorkspaces.create({
        headers: { "idempotency-key": idempotencyKey },
        payload,
      }),
    );

    if (created._tag !== "Ok") {
      setBusy(false);
      setErrorBanner(text(describeError(created.error).text));
      return;
    }

    const ws = created.value;
    const workspaceId = ws.id as WorkspaceId;
    // Persist optional address/DIČ/registerEntry if user edited or loaded them
    const hasEntityExtras =
      dic.trim().length > 0 ||
      street.trim().length > 0 ||
      city.trim().length > 0 ||
      postalCode.trim().length > 0 ||
      registerEntry.trim().length > 0;
    if (hasEntityExtras) {
      const entityPatch = {
        name: trimmedName,
        ...(trimmedIco.length > 0 ? { ico: trimmedIco } : {}),
        ...(dic.trim().length > 0 ? { dic: dic.trim() } : {}),
        ...(street.trim().length > 0 || city.trim().length > 0
          ? {
              address: {
                street: street.trim(),
                city: city.trim(),
                postalCode: postalCode.trim(),
                country: country.trim() || "CZ",
              },
            }
          : {}),
        ...(registerEntry.trim().length > 0 ? { registerEntry: registerEntry.trim() } : {}),
      } as unknown as IssuingEntityPatch;
      await api.run((client) =>
        client.workspace.updateIssuingEntity({
          params: { workspaceId },
          headers: { "if-match": `"${ws.revision}"` },
          payload: entityPatch,
        }),
      );
    }

    const trimmedIban = iban.replace(/\s+/g, "");
    if (trimmedIban.length > 0) {
      const bankPayload = {
        iban: trimmedIban,
        ...(bic.trim().length > 0 ? { bic: bic.trim() } : {}),
        currency,
        isDefault: true,
      } as unknown as BankAccountInput;
      await api.run((client) =>
        client.workspace.createBankAccount({
          params: { workspaceId },
          headers: { "idempotency-key": Crypto.randomUUID() as RequestKey },
          payload: bankPayload,
        }),
      );
    }

    await lastWorkspace.write(ws.slug);
    setBusy(false);
    navigate({ _tag: "Dashboard", ws: ws.slug }, { replace: true });
  };

  return (
    <Screen
      title={t("onboarding.wizard.title")}
      footer={
        <>
          {step > 1 ? (
            <Button
              kind="outlined"
              label={t("common.action.back")}
              onPress={() => setStep((s) => Math.max(1, s - 1))}
              disabled={busy}
              testID="onboarding-back"
            />
          ) : null}
          {step < TOTAL_STEPS ? (
            <Button
              label={t("common.action.next")}
              onPress={handleNext}
              disabled={busy}
              testID="onboarding-next"
            />
          ) : (
            <Button
              label={busy ? t("onboarding.wizard.creating") : t("onboarding.wizard.submit")}
              onPress={() => void handleCreate()}
              busy={busy}
              testID="onboarding-submit"
            />
          )}
        </>
      }
    >
      <Text variant="labelMedium" color="onSurfaceVariant">
        {t("onboarding.wizard.stepOf", { step, steps: TOTAL_STEPS })}
      </Text>
      {errorBanner === null ? null : <Banner tone="error" text={errorBanner} />}

      {step === 1 ? (
        <Section title={t("onboarding.wizard.step.entity")}>
          <Card>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              {t("onboarding.wizard.entity.intro")}
            </Text>
            <View style={styles.icoRow}>
              <View style={styles.flex}>
                <TextField
                  label={t("common.field.ico")}
                  value={ico}
                  onChangeText={setIco}
                  keyboardType="number-pad"
                  disabled={busy || aresStatus._tag === "loading"}
                  testID="onboarding-ico"
                />
              </View>
              <Button
                kind="tonal"
                icon={Search}
                label={
                  aresStatus._tag === "loading"
                    ? t("onboarding.wizard.entity.lookingUp")
                    : t("onboarding.wizard.entity.lookup")
                }
                onPress={() => void handleAresLookup()}
                busy={aresStatus._tag === "loading"}
                disabled={ico.trim().length === 0 || busy}
                testID="onboarding-ares-lookup"
              />
            </View>

            {aresStatus._tag === "found" ? (
              <Banner
                tone={aresStatus.terminatedOn !== null ? "warning" : "info"}
                text={
                  aresStatus.terminatedOn !== null
                    ? local({
                        cs: `ARES: firma má datum zániku (${aresStatus.terminatedOn}). Zkontrolujte údaje.`,
                        en: `ARES reports this company terminated on ${aresStatus.terminatedOn}. Verify details.`,
                      })
                    : t("onboarding.wizard.entity.found")
                }
              />
            ) : aresStatus._tag === "not_found" ? (
              <Banner tone="warning" text={t("onboarding.wizard.entity.notFound")} />
            ) : aresStatus._tag === "unavailable" ? (
              <Banner tone="warning" text={t("onboarding.wizard.entity.aresDown")} />
            ) : aresStatus._tag === "error" ? (
              <Banner tone="error" text={aresStatus.message} />
            ) : null}

            <TextField
              label={t("onboarding.wizard.entity.legalName")}
              value={name}
              onChangeText={(v) => {
                setName(v);
                if (nameError !== null) setNameError(null);
              }}
              error={nameError}
              disabled={busy}
              testID="onboarding-name"
            />
            <TextField
              label={t("common.field.dic")}
              value={dic}
              onChangeText={setDic}
              autoCapitalize="characters"
              disabled={busy}
              testID="onboarding-dic"
            />
            <TextField
              label={t("common.field.street")}
              value={street}
              onChangeText={setStreet}
              disabled={busy}
            />
            <View style={styles.row}>
              <View style={styles.flex}>
                <TextField
                  label={t("common.field.city")}
                  value={city}
                  onChangeText={setCity}
                  disabled={busy}
                />
              </View>
              <View style={styles.postal}>
                <TextField
                  label={t("common.field.postalCode")}
                  value={postalCode}
                  onChangeText={setPostalCode}
                  disabled={busy}
                />
              </View>
            </View>
            <TextField
              label={t("onboarding.wizard.entity.registerEntry")}
              value={registerEntry}
              onChangeText={setRegisterEntry}
              supporting={t("onboarding.wizard.entity.registerEntryHint")}
              disabled={busy}
            />
            <TextField
              label={t("onboarding.wizard.entity.slug")}
              value={slug}
              onChangeText={setSlug}
              autoCapitalize="none"
              supporting={t("common.state.optional")}
              disabled={busy}
            />
          </Card>
        </Section>
      ) : step === 2 ? (
        <Section title={t("onboarding.wizard.step.tax")}>
          <Card>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              {t("onboarding.wizard.tax.intro")}
            </Text>
            <SegmentedChoice<TaxRegime>
              label={t("onboarding.wizard.step.tax")}
              value={taxRegime}
              onChange={setTaxRegime}
              choices={[
                { value: "non_vat_payer", label: text(enumText("taxRegime", "non_vat_payer")) },
                { value: "vat_payer", label: text(enumText("taxRegime", "vat_payer")) },
                {
                  value: "identified_person",
                  label: text(enumText("taxRegime", "identified_person")),
                },
              ]}
            />
            <SegmentedChoice<CurrencyCode>
              label={t("common.field.currency")}
              value={currency}
              onChange={setCurrency}
              choices={[
                { value: "CZK" as CurrencyCode, label: "CZK" },
                { value: "EUR" as CurrencyCode, label: "EUR" },
              ]}
            />
            <SegmentedChoice<Locale>
              label={t("common.field.language")}
              value={docLocale}
              onChange={setDocLocale}
              choices={[
                { value: "cs", label: t("enum.locale.cs") },
                { value: "en", label: t("enum.locale.en") },
              ]}
            />
          </Card>
        </Section>
      ) : (
        <>
          <Section title={t("onboarding.wizard.step.bank")}>
            <Card>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {t("onboarding.wizard.bank.intro")}
              </Text>
              <TextField
                label="IBAN"
                value={iban}
                onChangeText={setIban}
                autoCapitalize="characters"
                supporting={t("onboarding.wizard.bank.optional")}
                disabled={busy}
                testID="onboarding-iban"
              />
              <TextField
                label="BIC / SWIFT"
                value={bic}
                onChangeText={setBic}
                autoCapitalize="characters"
                supporting={t("common.state.optional")}
                disabled={busy}
              />
              {iban.trim().length === 0 ? (
                <Banner tone="warning" text={t("onboarding.wizard.bank.noQrWarning")} />
              ) : null}
            </Card>
          </Section>

          <Section title={t("onboarding.wizard.step.numbering")}>
            <Card>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {t("onboarding.wizard.numbering.intro")}
              </Text>
              <Text variant="bodyMedium">
                {t("onboarding.wizard.numbering.preview", {
                  numbers: DEFAULT_SERIES_PREVIEW(taxRegime),
                })}
              </Text>
              <Text variant="meta" color="onSurfaceVariant">
                {t("onboarding.wizard.nothingSaved")}
              </Text>
            </Card>
          </Section>
        </>
      )}

      <View style={styles.hintRow}>
        <Building2 size={14} />
        <Text variant="meta" color="onSurfaceVariant">
          {name.trim() || t("onboarding.wizard.entity.workspaceName")}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  icoRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  row: { flexDirection: "row", gap: space.sm },
  postal: { width: 120 },
  hintRow: { flexDirection: "row", alignItems: "center", gap: space.xs, opacity: 0.6 },
});
