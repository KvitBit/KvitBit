import type { AccessMode, ApiKeyCreate, ApiKeyCreated, ApiKeyView } from "@kvitbit/api-contract";
import type { IsoDate } from "@kvitbit/domain/contract";
import { inWorkspace } from "@kvitbit/ui-port/api";
import {
  type AreaLevel,
  presetAvailable,
  roleScopeCeiling,
  ScopePicker,
  type ScopePickerState,
  toAccessRequest,
} from "@kvitbit/ui-port/view-models";
import { Option } from "effect";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { posthog } from "../../config/posthog";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  RemoteView,
  Section,
  SegmentedChoice,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canManageApiKeys } from "./permissions";
import { copyToClipboard } from "./platform-helpers";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";

const AREA_LEVELS: ReadonlyArray<AreaLevel> = ["none", "read", "write"];

/** Settings -> API keys (flow 10.7): list, create with ScopePicker + one-time secret, revoke. */
export function ApiKeysSection() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t } = i18n;
  const overlay = useOverlay();

  const editable = canManageApiKeys(workspace.role, workspace.closed);
  const remote = useRemote(
    editable ? (client) => client.apiKeys.listApiKeys({ params: inWorkspace(workspace.id) }) : null,
    [workspace.id, editable],
  );

  const [creatingOpen, setCreatingOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [picker, setPicker] = useState<ScopePickerState>(() =>
    ScopePicker.choosePreset(ScopePicker.init(roleScopeCeiling(workspace.role)), "read"),
  );
  const [createdSecret, setCreatedSecret] = useState<ApiKeyCreated | null>(null);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  if (!editable) {
    return (
      <View style={styles.stack}>
        <Banner text={t("settings.readOnly")} tone="info" />
      </View>
    );
  }

  const accessOption = toAccessRequest(picker);
  const accessChoices: ReadonlyArray<{ readonly value: AccessMode; readonly label: string }> = [
    ...(presetAvailable(picker, "read")
      ? [{ value: "read" as const, label: t("scopePicker.presetRead") }]
      : []),
    ...(presetAvailable(picker, "read_write")
      ? [{ value: "read_write" as const, label: t("scopePicker.presetReadWrite") }]
      : []),
    { value: "custom" as const, label: t("scopePicker.custom") },
  ];

  const handleModeChange = (mode: AccessMode) => {
    if (mode === "custom") setPicker(ScopePicker.chooseCustom(picker));
    else setPicker(ScopePicker.choosePreset(picker, mode));
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (trimmedName === "" || Option.isNone(accessOption)) return;
    const accessReq = accessOption.value;
    const expiry = expiresOn.trim();
    const payload: ApiKeyCreate =
      accessReq.access === "custom"
        ? {
            name: trimmedName,
            ...(expiry === "" ? {} : { expiresOn: expiry as IsoDate }),
            access: "custom",
            scopes: accessReq.scopes,
          }
        : {
            name: trimmedName,
            ...(expiry === "" ? {} : { expiresOn: expiry as IsoDate }),
            access: accessReq.access,
          };

    setSaving(true);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.apiKeys.createApiKey({
        params: inWorkspace(workspace.id),
        payload,
      }),
    );
    setSaving(false);
    if (result._tag === "Ok") {
      try {
        posthog?.capture("api_key_created", { access_mode: accessReq.access });
      } catch {
        // Analytics must not affect API key creation.
      }
      setCreatedSecret(result.value);
      setCreatingOpen(false);
      setName("");
      setExpiresOn("");
      setPicker(
        ScopePicker.choosePreset(ScopePicker.init(roleScopeCeiling(workspace.role)), "read"),
      );
      remote.reload();
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const handleCopySecret = async (secret: string) => {
    const copied = await copyToClipboard(secret);
    if (copied) overlay.toast(t("common.toast.copied"));
  };

  const handleRevoke = async (key: ApiKeyView) => {
    const confirmed = await overlay.confirm({
      title: t("settings.apiKeys.revokeTitle", { name: key.name }),
      body: t("settings.apiKeys.revokeBody"),
      confirmLabel: t("common.action.revoke"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setRevokingId(key.id);
    setErrorState(noFormError);
    const result = await api.run((client) =>
      client.apiKeys.revokeApiKey({
        params: inWorkspace(workspace.id, { keyId: key.id }),
      }),
    );
    setRevokingId(null);
    if (result._tag === "Ok") {
      try {
        posthog?.capture("api_key_revoked", { access_mode: key.access });
      } catch {
        // Analytics must not affect API key revocation.
      }
      remote.reload();
      overlay.toast(t("common.toast.deleted"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  return (
    <View style={styles.stack}>
      {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

      <Text variant="bodyMedium" color="onSurfaceVariant">
        {t("settings.apiKeys.intro")}
      </Text>

      {createdSecret === null ? null : (
        <Card>
          <Text variant="titleMedium">{t("settings.apiKeys.secretTitle")}</Text>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {t("settings.apiKeys.secretBody")}
          </Text>
          <Text testID="api-key-secret-value" variant="row" numeric selectable>
            {createdSecret.secret}
          </Text>
          <View style={styles.row}>
            <Button
              testID="api-key-copy-secret"
              kind="filled"
              icon={Copy}
              label={t("common.action.copy")}
              onPress={() => void handleCopySecret(createdSecret.secret)}
            />
            <Button
              testID="api-key-dismiss-secret"
              kind="outlined"
              label={t("settings.apiKeys.storedIt")}
              onPress={() => setCreatedSecret(null)}
            />
          </View>
        </Card>
      )}

      {creatingOpen ? (
        <Section title={t("settings.apiKeys.create")}>
          <Card>
            <TextField
              label={t("settings.apiKeys.name")}
              value={name}
              error={fieldErrorText(errorState, ["name"], i18n)}
              onChangeText={setName}
            />
            <TextField
              label={t("settings.apiKeys.expiry")}
              supporting={t("settings.apiKeys.noExpiry")}
              placeholder="YYYY-MM-DD"
              value={expiresOn}
              error={fieldErrorText(errorState, ["expiresOn"], i18n)}
              onChangeText={setExpiresOn}
            />
            <SegmentedChoice<AccessMode>
              label={t("settings.apiKeys.access")}
              value={picker.mode}
              choices={accessChoices}
              onChange={handleModeChange}
            />
            <Text variant="meta" color="onSurfaceVariant">
              {t("settings.apiKeys.cappedByRole")}
            </Text>

            {picker.mode === "custom" ? (
              <View style={styles.matrix}>
                <Text variant="meta" color="onSurfaceVariant">
                  {t("scopePicker.writeImpliesRead")}
                </Text>
                {ScopePicker.rows(picker).map((row) => (
                  <View key={row.area} style={styles.matrixRow}>
                    <SegmentedChoice<AreaLevel>
                      label={t(`enum.scopeArea.${row.area}`)}
                      value={row.level}
                      choices={AREA_LEVELS.filter(
                        (lvl) =>
                          lvl === "none" ||
                          (lvl === "read" && row.readEnabled) ||
                          (lvl === "write" && row.writeEnabled),
                      ).map((lvl) => ({
                        value: lvl,
                        label: t(`enum.accessLevel.${lvl}`),
                      }))}
                      onChange={(level) => setPicker(ScopePicker.setArea(picker, row.area, level))}
                    />
                  </View>
                ))}
                {Option.isNone(accessOption) ? (
                  <Text variant="bodySmall" color="error">
                    {t("scopePicker.emptyCustom")}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <View style={styles.row}>
              <Button
                testID="api-key-create-submit"
                kind="filled"
                icon={KeyRound}
                label={t("settings.apiKeys.create")}
                busy={saving}
                disabled={name.trim() === "" || Option.isNone(accessOption)}
                onPress={() => void handleCreate()}
              />
              <Button
                kind="text"
                label={t("common.action.cancel")}
                onPress={() => {
                  setCreatingOpen(false);
                  setErrorState(noFormError);
                }}
              />
            </View>
          </Card>
        </Section>
      ) : null}

      <RemoteView state={remote.state} onRetry={remote.reload}>
        {(keys) =>
          keys.length === 0 ? (
            <EmptyState
              title={t("settings.apiKeys.title")}
              body={t("settings.apiKeys.empty")}
              action={{ label: t("settings.apiKeys.create"), onPress: () => setCreatingOpen(true) }}
            />
          ) : (
            <Section
              title={t("settings.apiKeys.title")}
              action={
                creatingOpen ? undefined : (
                  <Button
                    testID="api-key-open-create"
                    kind="tonal"
                    icon={Plus}
                    label={t("settings.apiKeys.create")}
                    onPress={() => setCreatingOpen(true)}
                  />
                )
              }
            >
              {keys.map((key) => (
                <Card key={key.id}>
                  <View style={styles.headerRow}>
                    <View style={styles.flex}>
                      <Text variant="titleSmall">{key.name}</Text>
                      <Text variant="meta" color="onSurfaceVariant" numeric>
                        {key.prefix}… · {key.createdBy.name}
                      </Text>
                    </View>
                    <Badge label={t(`enum.accessMode.${key.access}`)} tone="info" />
                  </View>
                  <Text variant="meta" color="onSurfaceVariant">
                    {t("common.field.created")}: {key.createdAt.slice(0, 10)} ·{" "}
                    {t("common.field.lastUsed")}:{" "}
                    {key.lastUsedAt === null ? t("common.time.never") : key.lastUsedAt.slice(0, 10)}
                    {key.expiresAt === null
                      ? ""
                      : ` · ${t("common.field.expires")}: ${key.expiresAt.slice(0, 10)}`}
                  </Text>
                  <View style={styles.row}>
                    <Button
                      kind="text"
                      icon={Trash2}
                      label={t("common.action.revoke")}
                      busy={revokingId === key.id}
                      onPress={() => void handleRevoke(key)}
                    />
                  </View>
                </Card>
              ))}
            </Section>
          )
        }
      </RemoteView>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  matrix: { gap: space.sm, paddingTop: space.xs },
  matrixRow: { paddingVertical: 2 },
});
