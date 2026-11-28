import type {
  DocumentKind,
  NumberingSeriesId,
  NumberingSeriesView,
} from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { idempotencyHeaders, inWorkspace } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { Plus } from "lucide-react-native";
import { useCallback, useState } from "react";
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
  RemoteView,
  Section,
  SegmentedChoice,
  SwitchRow,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { requestOwner } from "../request-owner";
import { forkFeatureEffect } from "../ui-effect";
import { hasCounterToken, previewSeriesNumbers } from "./numbering-preview";
import { canEditWorkspaceSettings } from "./permissions";
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
  const { state: session } = useSession();
  const i18n = useI18n();
  const { t, local } = i18n;
  const overlay = useOverlay();

  const editable = canEditWorkspaceSettings(workspace.role, workspace.closed);
  const remote = useRemote(
    useCallback(
      (client: KvitbitApiClient) =>
        client.workspace.listSeries({ params: inWorkspace(workspace.id) }),
      [workspace.id],
    ),
  );

  const [draft, setDraft] = useState<SeriesDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorState, setErrorState] = useState<FormErrorState>(noFormError);

  const openCreate = (kind: DocumentKind = "invoice") => {
    setDraft(emptySeriesDraft(kind));
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
    setErrorState(noFormError);
  };

  const handleSave = Effect.fn("numbering-section.handleSave")(function* () {
    if (!editable || draft === null || session.status !== "signed-in" || saving === true) return;
    if (!hasCounterToken(draft.pattern)) return;
    const parsedNext = Number.parseInt(Str.trim(draft.nextNumber), 10);
    const owner = requestOwner([api.origin, session.user.id, workspace.id]);
    if (owner === null) return;
    setSaving(true);
    setErrorState(noFormError);

    interface SeriesInput {
      kind: DocumentKind;
      name: string;
      pattern: string;
      nextNumber?: number;
      isDefault: boolean;
    }
    const payload: SeriesInput = {
      kind: draft.kind,
      name: Str.trim(draft.name),
      pattern: Str.trim(draft.pattern),
      isDefault: draft.isDefault,
    };

    if (Number.isInteger(parsedNext) && parsedNext >= 1) payload.nextNumber = parsedNext;
    const seriesId = draft.id;
    const result =
      seriesId === undefined
        ? yield* Effect.promise(() =>
            runRequestIntent(owner, "workspace/createSeries", payload, (key) =>
              api.run((client) =>
                client.workspace.createSeries({
                  params: inWorkspace(workspace.id),
                  headers: idempotencyHeaders(key),
                  payload,
                }),
              ),
            ),
          )
        : yield* Effect.promise(() =>
            api.run((client) =>
              client.workspace.updateSeries({
                params: inWorkspace(workspace.id, { seriesId }),
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

  const preview =
    draft === null
      ? null
      : previewSeriesNumbers(
          Str.trim(draft.pattern),
          Math.max(1, Number.parseInt(Str.trim(draft.nextNumber), 10) || 1),
        );

  return (
    <RemoteView state={remote.state} onRetry={remote.reload}>
      {(allSeries) => (
        <View className="gap-4">
          {editable ? null : <Banner text={t("settings.readOnly")} tone="info" />}
          {errorState.banner === null ? null : <Banner text={errorState.banner} tone="error" />}

          {editable ? (
            <View className="flex-row flex-wrap items-center gap-2">
              <Button
                testID="numbering-add"
                kind="tonal"
                icon={Plus}
                label={t("settings.numbering.add")}
                onPress={() => openCreate()}
              />
            </View>
          ) : null}

          {Arr.map(DOCUMENT_KINDS, (kind) => {
            const items = Arr.filter(allSeries, (s) => s.kind === kind);
            if (items.length === 0) return null;
            return (
              <Section
                key={kind}
                title={t("settings.numbering.forKind", {
                  kind: t(`enum.documentKindPlural.${kind}`),
                })}
              >
                {Arr.map(items, (series) => (
                  <Card key={series.id}>
                    <View className="flex-row items-center gap-2">
                      <View className="flex-1">
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
                      <View className="flex-row flex-wrap items-center gap-2">
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
                  choices={Arr.map(DOCUMENT_KINDS, (kind) => ({
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
                <View className="flex-row flex-wrap items-center gap-2">
                  {Arr.map(PATTERN_TOKENS, (tok) => (
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
                    {t("settings.numbering.nextNumbers", { numbers: Arr.join(preview, ", ") })}
                  </Text>
                )}
                <SwitchRow
                  label={t("settings.numbering.makeDefault")}
                  value={draft.isDefault}
                  onChange={(isDefault) => setDraft({ ...draft, isDefault })}
                />
                <View className="flex-row flex-wrap items-center gap-2">
                  <Button
                    testID="numbering-save"
                    kind="filled"
                    label={t("common.action.save")}
                    busy={saving}
                    disabled={Str.trim(draft.name) === "" || !hasCounterToken(draft.pattern)}
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
      )}
    </RemoteView>
  );
}
