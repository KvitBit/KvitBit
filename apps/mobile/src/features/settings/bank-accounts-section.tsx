import { type BankAccountId, BankAccountInput } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { idempotencyHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Plus, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
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
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { requestOwner } from "../request-owner";
import { forkFeatureEffect } from "../ui-effect";
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
    useCallback(
      (client: KvitbitApiClient) =>
        client.workspace.listBankAccounts({ params: inWorkspace(workspace.id) }),
      [workspace.id],
    ),
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
      name: Option.getOrElse(Option.fromNullOr(account.name), () => ""),
      iban: account.iban,
      bic: account.bic ?? "",
      currency: account.currency,
      isDefault: account.isDefault,
    });
    setErrorState(noFormError);
  };

  const handleSave = Effect.fn("bank-accounts-section.handleSave")(function* () {
    if (!editable || draft === null || session.status !== "signed-in" || saving === true) return;
    const owner = requestOwner([api.origin, session.user.id, workspace.id]);
    if (owner === null) return;
    setSaving(true);
    setErrorState(noFormError);
    const payload = BankAccountInput.make({
      name: Str.trim(draft.name) || null,
      iban: Str.toUpperCase(Str.replace(/\s+/g, "")(draft.iban)),
      bic: Str.toUpperCase(Str.trim(draft.bic)) || null,
      currency: Str.toUpperCase(Str.trim(draft.currency)),
      isDefault: draft.isDefault,
    });

    const bankAccountId = draft.id;
    const result =
      bankAccountId === undefined
        ? yield* Effect.promise(() =>
            runRequestIntent(owner, "workspace/createBankAccount", payload, (key) =>
              api.run((client) =>
                client.workspace.createBankAccount({
                  params: inWorkspace(workspace.id),
                  headers: idempotencyHeaders(key),
                  payload,
                }),
              ),
            ),
          )
        : yield* Effect.promise(() =>
            api.run((client) =>
              client.workspace.updateBankAccount({
                params: inWorkspace(workspace.id, { bankAccountId }),
                payload,
              }),
            ),
          );
    setSaving(false);
    if (result._tag === "Ok") {
      setDraft(null);
      remote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const handleMakeDefault = Effect.fn("bank-accounts-section.handleMakeDefault")(function* (
    account: BankAccountData,
  ) {
    if (!editable) return;
    setErrorState(noFormError);
    const payload = BankAccountInput.make({
      name: account.name,
      iban: account.iban,
      bic: account.bic,
      currency: account.currency,
      isDefault: true,
    });
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.workspace.updateBankAccount({
          params: inWorkspace(workspace.id, { bankAccountId: account.id }),
          payload,
        }),
      ),
    );
    if (result._tag === "Ok") {
      remote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  });

  const performRemove = Effect.fn("bank-accounts-section.performRemove")(function* (
    account: BankAccountData,
    replacement?: BankAccountId,
  ) {
    setRemovingId(account.id);
    setErrorState(noFormError);
    const result = yield* Effect.promise(() =>
      api.run((client) =>
        client.workspace.removeBankAccount({
          params: inWorkspace(workspace.id, { bankAccountId: account.id }),
          query: replacement === undefined ? {} : { replacement },
        }),
      ),
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
  });

  const handleRemove = Effect.fn("bank-accounts-section.handleRemove")(function* (
    account: BankAccountData,
  ) {
    if (!editable) return;
    const ok = yield* Effect.promise(() =>
      overlay.confirm({
        title: t("settings.bankAccounts.removeTitle"),
        body: account.name ?? account.iban,
        confirmLabel: t("common.action.remove"),
        cancelLabel: t("common.action.cancel"),
        destructive: true,
      }),
    );
    if (!ok) return;
    yield* performRemove(account);
  });

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {(rawAccounts) => {
        const accounts = Arr.filterMap(rawAccounts, parseBankAccountView);
        const replacementChoices =
          replacementTarget === null
            ? []
            : Arr.filter(
                accounts,
                (a) => a.id !== replacementTarget.id && a.currency === replacementTarget.currency,
              );
        return (
          <View style={styles.stack}>
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
                      choices={Arr.map(replacementChoices, (a) => ({
                        value: a.id,
                        label: a.name ?? a.iban,
                      }))}
                      onChange={setReplacementId}
                    />
                    <View style={styles.row}>
                      <Button
                        kind="danger"
                        label={t("common.action.remove")}
                        disabled={replacementId === null}
                        busy={removingId === replacementTarget.id}
                        onPress={() =>
                          replacementId !== null &&
                          forkFeatureEffect(performRemove(replacementTarget, replacementId))
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
                {Arr.map(accounts, (account) => (
                  <Card key={account.id}>
                    <View style={styles.headerRow}>
                      <View style={styles.flex}>
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
                      <View style={styles.row}>
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
                            onPress={() => forkFeatureEffect(handleMakeDefault(account))}
                          />
                        )}
                        <Button
                          kind="text"
                          icon={Trash2}
                          label={t("common.action.remove")}
                          busy={removingId === account.id}
                          onPress={() => forkFeatureEffect(handleRemove(account))}
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
                      Arr.some(COMMON_CURRENCIES, (currency) => currency === draft.currency)
                        ? draft.currency
                        : null
                    }
                    choices={Arr.map(COMMON_CURRENCIES, (c) => ({ value: c, label: c }))}
                    onChange={(currency) => setDraft({ ...draft, currency })}
                  />
                  <SwitchRow
                    label={t("settings.bankAccounts.makeDefault", {
                      currency: draft.currency || "CZK",
                    })}
                    value={draft.isDefault}
                    onChange={(isDefault) => setDraft({ ...draft, isDefault })}
                  />
                  <View style={styles.row}>
                    <Button
                      testID="bank-account-save"
                      kind="filled"
                      label={t("common.action.save")}
                      busy={saving}
                      disabled={Str.trim(draft.iban) === ""}
                      onPress={() => forkFeatureEffect(handleSave())}
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

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
});
