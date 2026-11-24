import type { IdempotencyKey } from "@kvitbit/api-contract";
import type {
  DocumentKind,
  NumberingSeriesId,
  NumberingSeriesView,
} from "@kvitbit/domain/contract";
import { idempotencyHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  Banner,
  Button,
  Card,
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
import { hasCounterToken, previewSeriesNumbers } from "./numbering-preview";
import { canEditWorkspaceSettings } from "./permissions";
import { mintIdempotencyKey } from "./platform-helpers";
import {
  type FormErrorState,
  fieldErrorText,
  formErrorFrom,
  noFormError,
} from "./settings-feedback";

const DOCUMENT_KINDS: ReadonlyArray<DocumentKind> = [
  "invoice",
  "proforma",
  "payment_tax_document",
  "credit_note",
];

const PATTERN_TOKENS = ["YYYY", "YY", "MM", "NNNN"] as const;

interface SeriesDraft {
  readonly id?: NumberingSeriesId;
  readonly kind: DocumentKind;
  readonly name: string;
  readonly pattern: string;
  readonly nextNumber: string;
  readonly isDefault: boolean;
}

const emptySeriesDraft = (kind: DocumentKind = "invoice"): SeriesDraft => ({
  kind,
  name: "",
  pattern: "YYYY-NNNN",
  nextNumber: "1",
  isDefault: false,
});

/** Settings -> Numbering series (flow 10.5): per-kind series, pattern tokens, next-3 preview. */
export function NumberingSection() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    (client) => client.workspace.listSeries({ params: inWorkspace(workspace.id) }),
    [workspace.id],
  );

  const [draft, setDraft] = useState<SeriesDraft | null>(null);
  const [createKey, setCreateKey] = useState<IdempotencyKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  const openCreate = (kind: DocumentKind = "invoice") => {
    setDraft(emptySeriesDraft(kind));
    setCreateKey(mintIdempotencyKey());
    setErrorState(noFormError);
  };

  const openEdit = (series: NumberingSeriesView) => {
    setDraft({
      id: series.id,
      kind: series.kind,
      name: series.name,
      pattern: series.pattern,
      nextNumber: String(series.nextCounter),
      isDefault: series.isDefault,
    });
    setCreateKey(null);
    setErrorState(noFormError);
  };

  const handleSave = async () => {
    if (!editable || draft === null) return;
    if (!hasCounterToken(draft.pattern)) return;
    const parsedNext = Number.parseInt(draft.nextNumber.trim(), 10);
    setSaving(true);
    setErrorState(noFormError);

    const payload = {
      kind: draft.kind,
      name: draft.name.trim(),
      pattern: draft.pattern.trim(),
      ...(Number.isInteger(parsedNext) && parsedNext >= 1 ? { nextNumber: parsedNext } : {}),
      isDefault: draft.isDefault,
    };

    const result =
      draft.id === undefined
        ? await api.run((client) => {
            const key = createKey ?? mintIdempotencyKey();
            setCreateKey(key);
            return client.workspace.createSeries({
              params: inWorkspace(workspace.id),
              headers: idempotencyHeaders(key),
              payload,
            });
          })
        : await api.run((client) =>
            client.workspace.updateSeries({
              params: inWorkspace(workspace.id, { seriesId: draft.id as NumberingSeriesId }),
              payload,
            }),
          );
    setSaving(false);
    if (result._tag === "Ok") {
      setDraft(null);
      setCreateKey(null);
      remote.reload();
      overlay.toast(t("common.toast.saved"));
    } else {
      setErrorState(formErrorFrom(result.error, i18n));
    }
  };

  const preview =
    draft === null
      ? null
      : previewSeriesNumbers(
          draft.pattern.trim(),
          Math.max(1, Number.parseInt(draft.nextNumber.trim(), 10) || 1),
        );

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {(allSeries) => (
        <View style={styles.stack}>
          {editable ? null : <Banner text={t("settings.readOnly")} tone="info" />}
          {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

          {editable ? (
            <View style={styles.row}>
              <Button
                testID="numbering-add"
                kind="tonal"
                icon={Plus}
                label={t("settings.numbering.add")}
                onPress={() => openCreate()}
              />
            </View>
          ) : null}

          {DOCUMENT_KINDS.map((kind) => {
            const items = allSeries.filter((s) => s.kind === kind);
            if (items.length === 0) return null;
            return (
              <Section
                key={kind}
                title={t("settings.numbering.forKind", {
                  kind: t(`enum.documentKindPlural.${kind}`),
                })}
              >
                {items.map((series) => (
                  <Card key={series.id}>
                    <View style={styles.headerRow}>
                      <View style={styles.flex}>
                        <Text variant="titleSmall">{series.name}</Text>
                        <Text variant="meta" color="onSurfaceVariant" numeric>
                          {series.pattern} · {series.nextNumber}
                        </Text>
                      </View>
                      {series.isDefault ? (
                        <Badge label={t("settings.numbering.default")} tone="success" />
                      ) : null}
                    </View>
                    {editable ? (
                      <View style={styles.row}>
                        <Button
                          kind="outlined"
                          label={t("common.action.edit")}
                          onPress={() => openEdit(series)}
                        />
                      </View>
                    ) : null}
                  </Card>
                ))}
              </Section>
            );
          })}

          {editable && draft !== null ? (
            <Section
              title={draft.id === undefined ? t("settings.numbering.add") : t("common.action.edit")}
            >
              <Card>
                <SegmentedChoice<DocumentKind>
                  label={t("common.field.type")}
                  value={draft.kind}
                  choices={DOCUMENT_KINDS.map((kind) => ({
                    value: kind,
                    label: t(`enum.documentKind.${kind}`),
                  }))}
                  onChange={(kind) => setDraft({ ...draft, kind })}
                />
                <TextField
                  label={t("common.field.name")}
                  value={draft.name}
                  error={fieldErrorText(errorState, ["name"], i18n)}
                  onChangeText={(name) => setDraft({ ...draft, name })}
                />
                <TextField
                  label={t("settings.numbering.pattern")}
                  supporting={t("settings.numbering.patternHint")}
                  value={draft.pattern}
                  autoCapitalize="characters"
                  error={
                    !hasCounterToken(draft.pattern)
                      ? local({
                          cs: "Formát musí obsahovat alespoň jeden znak N pro pořadové číslo.",
                          en: "Pattern must include at least one N token for the counter.",
                        })
                      : fieldErrorText(errorState, ["pattern"], i18n)
                  }
                  onChangeText={(pattern) => setDraft({ ...draft, pattern })}
                />
                <View style={styles.row}>
                  {PATTERN_TOKENS.map((tok) => (
                    <Button
                      key={tok}
                      kind="outlined"
                      label={`+${tok}`}
                      onPress={() =>
                        setDraft({
                          ...draft,
                          pattern: draft.pattern === "" ? tok : `${draft.pattern}-${tok}`,
                        })
                      }
                    />
                  ))}
                </View>
                <TextField
                  label={local({ cs: "Další číslo", en: "Next number" })}
                  value={draft.nextNumber}
                  keyboardType="number-pad"
                  error={fieldErrorText(errorState, ["nextNumber"], i18n)}
                  onChangeText={(nextNumber) => setDraft({ ...draft, nextNumber })}
                />
                {preview === null ? null : (
                  <Text variant="meta" color="onSurfaceVariant" numeric>
                    {t("settings.numbering.nextNumbers", { numbers: preview.join(", ") })}
                  </Text>
                )}
                <SwitchRow
                  label={t("settings.numbering.makeDefault")}
                  value={draft.isDefault}
                  onChange={(isDefault) => setDraft({ ...draft, isDefault })}
                />
                <View style={styles.row}>
                  <Button
                    testID="numbering-save"
                    kind="filled"
                    label={t("common.action.save")}
                    busy={saving}
                    disabled={draft.name.trim() === "" || !hasCounterToken(draft.pattern)}
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
      )}
    </RemoteView>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
});
