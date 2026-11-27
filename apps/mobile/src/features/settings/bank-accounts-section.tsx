import type { BankAccountId, BankAccountInput, CurrencyCode } from "@kvitbit/domain/contract";
import { idempotencyHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import { Plus, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { runRequestIntent } from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
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
import { type BankAccountData, parseBankAccountView } from "./workspace-data";

const COMMON_CURRENCIES = ["CZK", "EUR", "USD", "GBP"] as const;

interface BankAccountDraft {
  readonly id?: BankAccountId;
  readonly name: string;
  readonly iban: string;
  readonly bic: string;
  readonly currency: string;
  readonly isDefault: boolean;
}

const emptyDraft = (): BankAccountDraft => ({
  name: "",
  iban: "",
  bic: "",
  currency: "CZK",
  isDefault: false,
});

/** Settings -> Bank accounts (flow 10.3): CRUD, default per currency, replacement on removal. */
export function BankAccountsSection() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const { state: session } = useSession();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    (client) => client.workspace.listBankAccounts({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );

  const [draft, setDraft] = useState<BankAccountDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<BankAccountId | null>(null);
  const [replacementTarget, setReplacementTarget] = useState<BankAccountData | null>(null);
  const [replacementId, setReplacementId] = useState<BankAccountId | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  const openCreate = () => {
    setDraft(emptyDraft());
    setErrorState(noFormError);
  };

  const openEdit = (account: BankAccountData) => {
    setDraft({
      id: account.id,
      name: account.name ?? "",
      iban: account.iban,
      bic: account.bic ?? "",
      currency: account.currency,
      isDefault: account.isDefault,
    });
    setErrorState(noFormError);
  };

  const handleSave = async () => {
    if (!editable || draft === null || session.status !== "signed-in" || saving) return;
    setSaving(true);
    setErrorState(noFormError);
    const payload = {
      name: draft.name.trim() || null,
      iban: draft.iban.replace(/\s+/g, "").toUpperCase(),
      bic: draft.bic.trim().toUpperCase() || null,
      currency: draft.currency.trim().toUpperCase() as CurrencyCode,
      isDefault: draft.isDefault,
    } as unknown as BankAccountInput;

    const result =
      draft.id === undefined
        ? await runRequestIntent(
            JSON.stringify([api.origin, session.user.id, workspace.id]),
            "workspace/createBankAccount",
            payload,
            (key) =>
              api.run((client) =>
                client.workspace.createBankAccount({
                  params: inWorkspace(workspace.id),
                  headers: idempotencyHeaders(key),
                  payload,
                }),
              ),
          )
        : await api.run((client) =>
            client.workspace.updateBankAccount({
              params: inWorkspace(workspace.id, { bankAccountId: draft.id as BankAccountId }),
              payload,
            }),
          );
    setSaving(false);
    if (result._tag === "Ok") {
      setDraft(null);
      remote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleMakeDefault = async (account: BankAccountData) => {
    if (!editable) return;
    setErrorState(noFormError);
    const payload = {
      name: account.name,
      iban: account.iban,
      bic: account.bic,
      currency: account.currency,
      isDefault: true,
    } as unknown as BankAccountInput;
    const result = await api.run((client) =>
      client.workspace.updateBankAccount({
        params: inWorkspace(workspace.id, { bankAccountId: account.id }),
        payload,
      }),
    );
    if (result._tag === "Ok") {
      remote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const performRemove = async (account: BankAccountData, replacement?: BankAccountId) => {
    setRemovingId(account.id);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.workspace.removeBankAccount({
        params: inWorkspace(workspace.id, { bankAccountId: account.id }),
        query: replacement === undefined ? {} : { replacement },
      }),
    );
    setRemovingId(null);
    if (result._tag === "Ok") {
      setReplacementTarget(null);
      setReplacementId(null);
      remote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else if (result.error._tag === "Conflict" && replacement === undefined) {
      setReplacementTarget(account);
      setErrorState(formErrorFrom(result.error, i18n));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleRemove = async (account: BankAccountData) => {
    if (!editable) return;
    const ok = await overlay.confirm({
      title: t("settings.bankAccounts.removeTitle"),
      body: account.name ?? account.iban,
      confirmLabel: t("common.action.remove"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!ok) return;
    await performRemove(account);
  };

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {(rawAccounts) => {
        const accounts = rawAccounts.map(parseBankAccountView);
        const replacementChoices =
          replacementTarget === null
            ? []
            : accounts.filter(
                (a) => a.id !== replacementTarget.id && a.currency === replacementTarget.currency,
              );
        return (
          <View className="gap-4">
            {editable ? null : <Banner text={t("settings.readOnly")} tone="info" />}
            {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

            {replacementTarget !== null ? (
              <Card>
                <Text variant="titleSmall">{t("settings.bankAccounts.replacement")}</Text>
                {replacementChoices.length === 0 ? (
                  <Text variant="meta" color="onSurfaceVariant">
                    {local({
                      cs: `Přidejte nejprve jiný účet v měně ${replacementTarget.currency}.`,
                      en: `Add another ${replacementTarget.currency} account first to replace this one.`,
                    })}
                  </Text>
                ) : (
                  <>
                    <SegmentedChoice<BankAccountId>
                      value={replacementId}
                      choices={replacementChoices.map((a) => ({
                        value: a.id,
                        label: a.name ?? a.iban,
                      }))}
                      onChange={setReplacementId}
                    />
                    <View className="flex-row flex-wrap items-center gap-2">
                      <Button
                        kind="danger"
                        label={t("common.action.remove")}
                        disabled={replacementId === null}
                        busy={removingId === replacementTarget.id}
                        onPress={() =>
                          replacementId !== null &&
                          void performRemove(replacementTarget, replacementId)
                        }
                      />
                      <Button
                        kind="text"
                        label={t("common.action.cancel")}
                        onPress={() => {
                          setReplacementTarget(null);
                          setReplacementId(null);
                        }}
                      />
                    </View>
                  </>
                )}
              </Card>
            ) : null}

            {accounts.length === 0 ? (
              <EmptyState
                title={t("settings.bankAccounts.title")}
                body={t("settings.bankAccounts.empty")}
                {...(editable
                  ? { action: { label: t("settings.bankAccounts.add"), onPress: openCreate } }
                  : {})}
              />
            ) : (
              <Section
                title={t("settings.bankAccounts.title")}
                action={
                  editable ? (
                    <Button
                      testID="bank-account-add"
                      kind="tonal"
                      icon={Plus}
                      label={t("settings.bankAccounts.add")}
                      onPress={openCreate}
                    />
                  ) : undefined
                }
              >
                {accounts.map((account) => (
                  <Card key={account.id}>
                    <View className="flex-row items-center gap-2">
                      <View className="flex-1">
                        <Text variant="titleSmall">{account.name ?? account.iban}</Text>
                        <Text variant="meta" color="onSurfaceVariant" numeric>
                          {account.iban}
                          {account.bic === null ? "" : ` · ${account.bic}`}
                        </Text>
                      </View>
                      <Badge label={account.currency} tone="info" />
                    </View>
                    {account.isDefault ? (
                      <Badge
                        label={t("settings.bankAccounts.default", {
                          currency: account.currency,
                        })}
                        tone="success"
                      />
                    ) : null}
                    {editable ? (
                      <View className="flex-row flex-wrap items-center gap-2">
                        <Button
                          kind="outlined"
                          label={t("common.action.edit")}
                          onPress={() => openEdit(account)}
                        />
                        {account.isDefault ? null : (
                          <Button
                            kind="text"
                            label={t("settings.bankAccounts.makeDefault", {
                              currency: account.currency,
                            })}
                            onPress={() => void handleMakeDefault(account)}
                          />
                        )}
                        <Button
                          kind="text"
                          icon={Trash2}
                          label={t("common.action.remove")}
                          busy={removingId === account.id}
                          onPress={() => void handleRemove(account)}
                        />
                      </View>
                    ) : null}
                  </Card>
                ))}
              </Section>
            )}

            {editable && draft !== null ? (
              <Section
                title={
                  draft.id === undefined ? t("settings.bankAccounts.add") : t("common.action.edit")
                }
              >
                <Card>
                  <TextField
                    label={t("settings.bankAccounts.label")}
                    value={draft.name}
                    error={fieldErrorText(errorState, ["name"], i18n)}
                    onChangeText={(name) => setDraft({ ...draft, name })}
                  />
                  <TextField
                    label={t("common.field.iban")}
                    value={draft.iban}
                    autoCapitalize="characters"
                    error={fieldErrorText(errorState, ["iban"], i18n)}
                    onChangeText={(iban) => setDraft({ ...draft, iban })}
                  />
                  <TextField
                    label={t("common.field.bic")}
                    value={draft.bic}
                    autoCapitalize="characters"
                    error={fieldErrorText(errorState, ["bic"], i18n)}
                    onChangeText={(bic) => setDraft({ ...draft, bic })}
                  />
                  <SegmentedChoice<string>
                    label={t("common.field.currency")}
                    value={
                      (COMMON_CURRENCIES as ReadonlyArray<string>).includes(draft.currency)
                        ? draft.currency
                        : null
                    }
                    choices={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
                    onChange={(currency) => setDraft({ ...draft, currency })}
                  />
                  <SwitchRow
                    label={t("settings.bankAccounts.makeDefault", {
                      currency: draft.currency || "CZK",
                    })}
                    value={draft.isDefault}
                    onChange={(isDefault) => setDraft({ ...draft, isDefault })}
                  />
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Button
                      testID="bank-account-save"
                      kind="filled"
                      label={t("common.action.save")}
                      busy={saving}
                      disabled={draft.iban.trim() === ""}
                      onPress={() => void handleSave()}
                    />
                    <Button
                      kind="text"
                      label={t("common.action.cancel")}
                      onPress={() => {
                        setDraft(null);
                        setErrorState(noFormError);
                      }}
                    />
                  </View>
                </Card>
              </Section>
            ) : null}
          </View>
        );
      }}
    </RemoteView>
  );
}
