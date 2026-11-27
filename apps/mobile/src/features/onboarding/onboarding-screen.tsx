import type {
  BankAccountInput,
  CurrencyCode,
  IssuingEntityPatch,
  NewWorkspace,
  RegistryResult,
  TaxRegime,
} from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import { enumText, type Locale } from "@kvitbit/ui-port/i18n";
import { Building2, Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { posthog } from "../../config/posthog";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi } from "../../runtime/api-runtime";
import {
  isRequestIntentExpired,
  requestIntentReconciliationCopy,
} from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
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
import {
  type OnboardingFormFields,
  type OnboardingProgress,
  type OnboardingStep,
  onboardingStore,
} from "./onboarding-persistence";
import { saveOnboarding } from "./save-onboarding";

const TOTAL_STEPS = 3;

const DEFAULT_SERIES_PREVIEW = (regime: TaxRegime): string =>
  regime === "vat_payer"
    ? "YYYY-NNNN, ZF-YYYY-NNNN, DD-YYYY-NNNN, OD-YYYY-NNNN"
    : "YYYY-NNNN, ZF-YYYY-NNNN, OD-YYYY-NNNN";

export function OnboardingScreen(props: { readonly initialStep?: number }) {
  const { t, text, locale, local } = useI18n();
  const api = useApi();
  const { state: session } = useSession();

  const clampedInitial: OnboardingStep =
    props.initialStep === 1 || props.initialStep === 2 || props.initialStep === 3
      ? props.initialStep
      : 1;
  const [step, setStep] = useState<OnboardingStep>(clampedInitial);

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
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const userId = session.status === "signed-in" ? session.user.id : null;
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const activeScope = userId === null ? null : `${api.origin}\0${userId}`;
  const hydrating = activeScope !== null && hydratedScope !== activeScope;

  useEffect(() => {
    if (userId === null || activeScope === null) {
      setHydratedScope(null);
      return;
    }
    let cancelled = false;
    void onboardingStore.read(api.origin, userId).then((saved) => {
      if (cancelled) return;
      if (saved !== null) {
        setStep(saved.step);
        setProgress(saved.progress);
        setIco(saved.fields.ico);
        setName(saved.fields.name);
        setSlug(saved.fields.slug);
        setDic(saved.fields.dic);
        setStreet(saved.fields.street);
        setCity(saved.fields.city);
        setPostalCode(saved.fields.postalCode);
        setCountry(saved.fields.country);
        setRegisterEntry(saved.fields.registerEntry);
        setTaxRegime(saved.fields.taxRegime);
        setCurrency(saved.fields.currency);
        setDocLocale(saved.fields.docLocale);
        setIban(saved.fields.iban);
        setBic(saved.fields.bic);
      }
      setHydratedScope(activeScope);
    });
    return () => {
      cancelled = true;
    };
  }, [api.origin, userId, activeScope]);

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
    if (session.status !== "signed-in" || busy || hydrating) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setStep(1);
      setNameError(t("issue.form.required"));
      return;
    }
    setBusy(true);
    setErrorBanner(null);

    const fields: OnboardingFormFields = {
      ico,
      name,
      slug,
      dic,
      street,
      city,
      postalCode,
      country,
      registerEntry,
      taxRegime,
      currency,
      docLocale,
      iban,
      bic,
    };

    const trimmedIco = ico.replace(/\s+/g, "");
    const trimmedSlug = slug.trim();
    const payload = {
      name: trimmedName,
      ...(trimmedSlug.length > 0 ? { slug: trimmedSlug } : {}),
      ...(trimmedIco.length > 0 ? { ico: trimmedIco } : {}),
      taxRegime,
      defaults: { currency, language: docLocale },
    } as unknown as NewWorkspace;

    // Persist optional address/DIČ/registerEntry if user edited or loaded them
    const hasEntityExtras =
      dic.trim().length > 0 ||
      street.trim().length > 0 ||
      city.trim().length > 0 ||
      postalCode.trim().length > 0 ||
      registerEntry.trim().length > 0;
    const issuingEntity = hasEntityExtras
      ? ({
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
        } as unknown as IssuingEntityPatch)
      : null;

    const trimmedIban = iban.replace(/\s+/g, "");
    const bank =
      trimmedIban.length > 0
        ? ({
            iban: trimmedIban,
            ...(bic.trim().length > 0 ? { bic: bic.trim() } : {}),
            currency,
            isDefault: true,
          } as unknown as BankAccountInput)
        : null;

    const saved = await saveOnboarding(
      api,
      { workspace: payload, issuingEntity, bank },
      {
        scope: { origin: api.origin, userId: session.user.id },
        fields,
        step,
        progress,
        onProgress: setProgress,
      },
    );
    if (saved.result._tag === "Err") {
      setBusy(false);
      setErrorBanner(
        isRequestIntentExpired(saved.result.error)
          ? local(requestIntentReconciliationCopy)
          : text(describeError(saved.result.error).text),
      );
      if (saved.step === "issuer") setStep(1);
      return;
    }
    const ws = saved.result.value;
    try {
      posthog?.capture("workspace_created", {
        tax_regime: taxRegime,
        currency,
        has_bank_account: bank !== null,
      });
    } catch {
      // Analytics must not affect workspace creation.
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
          {step > 1 && progress === null ? (
            <Button
              kind="outlined"
              label={t("common.action.back")}
              onPress={() => setStep((s) => (s === 3 ? 2 : 1))}
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
              disabled={hydrating}
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
              {progress === null ? (
                <Text variant="meta" color="onSurfaceVariant">
                  {t("onboarding.wizard.nothingSaved")}
                </Text>
              ) : null}
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
