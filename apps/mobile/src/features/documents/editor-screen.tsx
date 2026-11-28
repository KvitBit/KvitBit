import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import { fromMobilePromise } from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";
/**
 * Document editor (`new/[kind].tsx`, `[id]/edit.tsx`) and quick Credit Note creator
 * (`new/credit_note.tsx`). Uses `@kvitbit/ui-port/view-models` `calculate()` for instant
 * VAT & CZK FX breakdown preview alongside live CNB rate lookup.
 */

import type {
  ContactId,
  DocumentId,
  DocumentPatch,
  DocumentView,
  FxRateView,
  Locale,
  TemplateId,
} from "@kvitbit/domain/contract";
import { CurrencyCode, IsoDate, MoneyMath } from "@kvitbit/domain/contract";
import {
  describeError,
  idempotencyHeaders,
  ifMatchHeaders,
  issuesAt,
  UiError,
} from "@kvitbit/ui-port/api";
import { formatDate, formatMoney, formatVatRate, parseIsoDate } from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import { displayAmount } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Str from "effect/String";
import { router } from "expo-router";
import { BookOpen, Plus, Save, Send, Trash2, Users } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi, useReloadSignal, useRemote } from "../../runtime/api-runtime";
import { isRequestIntentExpired, requestIntentFailure } from "../../runtime/request-intent";
import { useTheme } from "../../theme/theme-provider";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  Loading,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  SwitchRow,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canWriteWorkspace } from "../dashboard/model";
import {
  type BankAccountOption,
  type ContactOption,
  type PriceListOption,
  parseBankAccountOption,
  parseContactOption,
  parseContactSnapshot,
  parseDocumentSummary,
  parseLineView,
  parsePriceListOption,
  parseWorkspaceDefaults,
  todayIsoPrague,
} from "./codecs";
import {
  applyContactDefaults,
  applyPriceListItem,
  buildDocumentInput,
  buildDocumentPatch,
  COMMON_CURRENCIES,
  computeLivePreview,
  createEmptyLine,
  defaultBankAccountId,
  defaultTreatmentForRegime,
  draftForNew,
  draftFromDocument,
  type EditableDocumentKind,
  type EditorDraft,
  type EditorLineDraft,
  matchingBankAccounts,
  matchingSeries,
  PAYMENT_METHODS,
  VAT_TREATMENTS,
  validateEditorDraft,
} from "./editor-model";
import { requestErrorText, useRequestMutation, useRequestOwner } from "./request-mutation";
import {
  discardExpiredTemplateImport,
  importTemplate,
  openImportedDraft,
  recordImportedDraftWrite,
  type TemplateSeed,
} from "./template-import";

const contactSubtitle = (contact: ContactOption): string => {
  const numbers: string[] = [];
  if ((contact.ico ?? "") !== "") numbers.push(`IČO ${contact.ico}`);
  if ((contact.dic ?? "") !== "") numbers.push(`DIČ ${contact.dic}`);
  return numbers.length > 0 ? Arr.join(numbers, " · ") : Arr.join(contact.billingEmails, ", ");
};

export function DocumentFromTemplateScreen({ templateId }: { readonly templateId: TemplateId }) {
  const { workspace } = useWorkspace();
  const { t, local, text } = useI18n();
  const { run } = useApi();
  const overlay = useOverlay();
  const requestOwner = useRequestOwner(workspace.id);
  const writable = canWriteWorkspace(workspace);
  const [failure, setFailure] = useState<UiError | null>(null);
  const [importSignal, reloadImport] = useReloadSignal();
  const [restarting, setRestarting] = useState(false);
  const expired = failure !== null && isRequestIntentExpired(failure);

  const retry = () => {
    setFailure(null);
    reloadImport();
  };

  const startNewImport = Effect.fn("startNewImport")(function* () {
    if (requestOwner === null || restarting === true) return;
    setRestarting(true);
    const label = local({ cs: "Zahájit nový import", en: "Start new import" });
    yield* Effect.gen(function* () {
      const confirmed = yield* fromMobilePromise(() =>
        overlay.confirm({
          title: label,
          body: local({
            cs: "Zkontrolujte, zda už předchozí import nevytvořil koncept. Pokračováním vytvoříte nový koncept.",
            en: "Check whether the earlier import already created a draft. Continuing will start a new draft.",
          }),
          confirmLabel: label,
          cancelLabel: t("common.action.cancel"),
        }),
      );
      if (!confirmed) return;
      yield* discardExpiredTemplateImport(requestOwner, templateId);
      retry();
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          setFailure(
            error._tag === "SchemaError" ? UiError.offline : requestIntentFailure(error.cause),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => setRestarting(false))),
    );
  }, runFeatureEffect);

  useEffect(() => {
    if (!writable || requestOwner === null || importSignal.aborted) return;
    let active = true;
    runFeatureEffect(importTemplate(requestOwner, workspace, templateId, run)).then((result) => {
      if (!active || importSignal.aborted) return;
      if (result._tag === "Err") {
        setFailure(result.error);
      } else {
        navigate(
          { _tag: "DocumentEdit", ws: workspace.slug, id: result.value.id },
          { replace: true },
        );
      }
    });
    return () => {
      active = false;
    };
  }, [importSignal, requestOwner, run, templateId, workspace, writable]);

  return (
    <Screen title={t("documents.editor.titleDraft")} back>
      {!writable ? (
        <Banner text={t(workspace.closed ? "shell.closedWorkspace" : "error.forbidden")} />
      ) : failure === null ? (
        <Loading label={t("common.state.loading")} />
      ) : (
        <>
          <Banner text={requestErrorText(failure, { local, text })} />
          {expired ? (
            <>
              <Button
                kind="outlined"
                label={local({ cs: "Zkontrolovat doklady", en: "Review documents" })}
                testID="template-import-review-documents"
                disabled={restarting}
                onPress={() =>
                  navigate({ _tag: "Documents", ws: workspace.slug, query: {} }, { replace: true })
                }
              />
              <Button
                label={local({ cs: "Zahájit nový import", en: "Start new import" })}
                testID="template-import-start-new"
                busy={restarting}
                onPress={() => startNewImport()}
              />
            </>
          ) : (
            <Button
              label={t("common.action.retry")}
              testID="template-import-retry"
              onPress={retry}
            />
          )}
        </>
      )}
    </Screen>
  );
}

// --- Picker modal -------------------------------------------------------------------------------

function PickerModal<T>(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly searchPlaceholder: string;
  readonly items: ReadonlyArray<T>;
  readonly filter: (item: T, query: string) => boolean;
  readonly keyOf: (item: T) => string;
  readonly renderItem: (item: T, select: () => void) => React.ReactNode;
  readonly onSelect: (item: T) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = Str.toLowerCase(Str.trim(query));
    return q === "" ? props.items : Arr.filter(props.items, (item) => props.filter(item, q));
  }, [props, query]);

  return (
    <Modal transparent visible={props.visible} animationType="fade" onRequestClose={props.onClose}>
      <View
        className="flex-1 items-center justify-center p-4"
        style={{ backgroundColor: `${theme.colors.scrim}66` }}
      >
        <View
          className="max-h-[84%] w-full max-w-[560px] gap-3 bg-surface-container-high p-6"
          style={{ borderRadius: theme.shape.panel + 12 }}
        >
          <Text variant="headlineSmall">{props.title}</Text>
          <TextField
            label={t("common.action.search")}
            placeholder={props.searchPlaceholder}
            value={query}
            onChangeText={setQuery}
          />
          <ScrollView keyboardShouldPersistTaps="handled" className="max-h-[360px]">
            {filtered.length === 0 ? (
              <EmptyState title={t("common.state.noMatches")} />
            ) : (
              Arr.map(filtered, (item) => (
                <View key={props.keyOf(item)}>
                  {props.renderItem(item, () => {
                    props.onSelect(item);
                    setQuery("");
                    props.onClose();
                  })}
                </View>
              ))
            )}
          </ScrollView>
          <View className="flex-row justify-end">
            <Button kind="text" label={t("common.action.close")} onPress={props.onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// --- Document Editor Screen ---------------------------------------------------------------------

export type DocumentEditorProps =
  | {
      readonly mode: "new";
      readonly kind: EditableDocumentKind;
      readonly contactId?: ContactId;
      readonly duplicateId?: DocumentId;
    }
  | {
      readonly mode: "edit";
      readonly documentId: DocumentId;
    };

export function DocumentEditorScreen(props: DocumentEditorProps) {
  const { workspace } = useWorkspace();
  const { t, locale, local, text: resolveText } = useI18n();
  const { run } = useApi();
  const runMutation = useRequestMutation(workspace.id);
  const requestOwner = useRequestOwner(workspace.id);
  const overlay = useOverlay();

  const wsRemote = useRemote(
    useCallback(
      (api: KvitbitApiClient) => api.workspace.current({ params: { workspaceId: workspace.id } }),
      [workspace.id],
    ),
  );
  const contactsRemote = useRemote(
    useCallback(
      (api: KvitbitApiClient) =>
        api.contacts.search({ params: { workspaceId: workspace.id }, query: { limit: 100 } }),
      [workspace.id],
    ),
  );
  const priceListRemote = useRemote(
    useCallback(
      (api: KvitbitApiClient) =>
        api.priceList.list({ params: { workspaceId: workspace.id }, query: {} }),
      [workspace.id],
    ),
  );
  const bankAccountsRemote = useRemote(
    useCallback(
      (api: KvitbitApiClient) =>
        api.workspace.listBankAccounts({ params: { workspaceId: workspace.id } }),
      [workspace.id],
    ),
  );
  const seriesRemote = useRemote(
    useCallback(
      (api: KvitbitApiClient) =>
        api.workspace.listSeries({ params: { workspaceId: workspace.id } }),
      [workspace.id],
    ),
  );

  const sourceDocId =
    props.mode === "edit"
      ? props.documentId
      : props.duplicateId !== undefined
        ? props.duplicateId
        : null;

  const sourceDocRemote = useRemote(
    useMemo(
      () =>
        sourceDocId === null
          ? null
          : (api: KvitbitApiClient) =>
              api.documents.get({
                params: { workspaceId: workspace.id, documentId: sourceDocId },
              }),
      [workspace.id, sourceDocId],
    ),
  );

  const originalDoc: DocumentView | null =
    props.mode === "edit" && sourceDocRemote.state._tag === "Ready"
      ? sourceDocRemote.state.value
      : null;
  const [cachedTemplate, setCachedTemplate] = useState<{
    readonly revision: number;
    readonly seed: TemplateSeed | null;
  } | null>(null);
  const templateContactId =
    (cachedTemplate?.seed ?? null) !== null &&
    originalDoc !== null &&
    originalDoc.status === "draft"
      ? parseContactSnapshot(originalDoc.contact).contactId
      : null;
  const templateContactRemote = useRemote(
    useMemo(
      () =>
        templateContactId === null
          ? null
          : (api: KvitbitApiClient) =>
              api.contacts.get({
                params: { workspaceId: workspace.id, contactId: templateContactId },
              }),
      [workspace.id, templateContactId],
    ),
  );
  const templateContactArchived =
    templateContactId !== null &&
    templateContactRemote.state._tag === "Ready" &&
    parseContactOption(templateContactRemote.state.value).archived;

  const workspaceDefaults = useMemo(
    () =>
      parseWorkspaceDefaults(
        wsRemote.state._tag === "Ready" ? wsRemote.state.value : null,
        workspace.taxRegime,
      ),
    [wsRemote.state, workspace.taxRegime],
  );

  const contacts: ReadonlyArray<ContactOption> = useMemo(
    () =>
      contactsRemote.state._tag === "Ready"
        ? Arr.filter(
            Arr.map(contactsRemote.state.value.items, parseContactOption),
            (c) => !c.archived,
          )
        : [],
    [contactsRemote.state],
  );

  const priceList: ReadonlyArray<PriceListOption> = useMemo(
    () =>
      priceListRemote.state._tag === "Ready"
        ? Arr.filter(Arr.map(priceListRemote.state.value, parsePriceListOption), (p) => !p.archived)
        : [],
    [priceListRemote.state],
  );

  const bankAccounts: ReadonlyArray<BankAccountOption> = useMemo(
    () =>
      bankAccountsRemote.state._tag === "Ready"
        ? Arr.map(bankAccountsRemote.state.value, parseBankAccountOption)
        : [],
    [bankAccountsRemote.state],
  );

  const seriesList = useMemo(
    () => (seriesRemote.state._tag === "Ready" ? seriesRemote.state.value : []),
    [seriesRemote.state],
  );

  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [templateLoadFailure, setTemplateLoadFailure] = useState<"storage" | "revision" | null>(
    null,
  );
  const [templateLoadSignal, reloadTemplate] = useReloadSignal();
  const importDocId = originalDoc?.id ?? null;
  const importRevision = originalDoc?.revision ?? null;

  useEffect(() => {
    if (
      draft !== null ||
      requestOwner === null ||
      importDocId === null ||
      importRevision === null ||
      templateLoadSignal.aborted
    )
      return;
    let live = true;
    runFeatureEffect(
      openImportedDraft(requestOwner, importDocId, importRevision).pipe(
        Effect.match({
          onSuccess: (seed) => {
            if (live && !templateLoadSignal.aborted) {
              setTemplateLoadFailure(null);
              setCachedTemplate({ revision: importRevision, seed });
            }
          },
          onFailure: (error) => {
            if (live && !templateLoadSignal.aborted)
              setTemplateLoadFailure(error._tag === "StaleImportedDraft" ? "revision" : "storage");
          },
        }),
      ),
    );
    return () => {
      live = false;
    };
  }, [draft, importDocId, importRevision, requestOwner, templateLoadSignal]);

  const readyToInit =
    wsRemote.state._tag === "Ready" &&
    contactsRemote.state._tag === "Ready" &&
    bankAccountsRemote.state._tag === "Ready" &&
    seriesRemote.state._tag === "Ready" &&
    (sourceDocId === null || sourceDocRemote.state._tag === "Ready") &&
    (originalDoc === null || cachedTemplate?.revision === importRevision) &&
    (templateContactId === null || templateContactRemote.state._tag === "Ready");

  const savedDraft = useRef<{
    readonly draft: EditorDraft;
    readonly id: DocumentId;
    readonly revision: number;
  } | null>(null);
  const submitting = useRef(false);
  const [cnbFx, setCnbFx] = useState<FxRateView | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxUnavailable, setFxUnavailable] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [pricePickerLineKey, setPricePickerLineKey] = useState<string | null>(null);
  const [priceMismatchWarning, setPriceMismatchWarning] = useState<string | null>(null);
  const [busyMode, setBusyMode] = useState<"save" | "issue" | null>(null);
  const [pendingCheckpoint, setPendingCheckpoint] = useState<Parameters<
    typeof recordImportedDraftWrite
  > | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ReturnType<typeof describeError>["issues"]>([]);
  const [validationShown, setValidationShown] = useState(false);

  // Initialize editor state once all reference data has loaded.
  useEffect(() => {
    if (!readyToInit || draft !== null) return;
    if (originalDoc !== null) {
      const initial = draftFromDocument(originalDoc, {
        workspaceDefaults,
        bankAccounts,
        seriesList,
        importedSeed: cachedTemplate?.seed ?? null,
      });
      const loaded = templateContactArchived ? { ...initial, contactId: null } : initial;
      savedDraft.current = { draft: loaded, id: originalDoc.id, revision: originalDoc.revision };
      setDraft(loaded);
      if (templateContactArchived) setContactPickerOpen(true);
      return;
    }
    if (
      props.mode === "new" &&
      props.duplicateId !== undefined &&
      sourceDocRemote.state._tag === "Ready"
    ) {
      setDraft(
        draftFromDocument(sourceDocRemote.state.value, {
          workspaceDefaults,
          bankAccounts,
          seriesList,
          duplicate: true,
        }),
      );
      return;
    }
    if (props.mode === "new") {
      const preselected =
        props.contactId !== undefined
          ? (Option.getOrUndefined(Arr.findFirst(contacts, (c) => c.id === props.contactId)) ??
            null)
          : null;
      setDraft(
        draftForNew({
          kind: props.kind,
          workspaceDefaults,
          contact: preselected,
          bankAccounts,
          seriesList,
        }),
      );
    }
  }, [
    readyToInit,
    draft,
    props,
    sourceDocRemote.state,
    workspaceDefaults,
    bankAccounts,
    seriesList,
    contacts,
    originalDoc,
    cachedTemplate?.seed,
    templateContactArchived,
  ]);

  // Fetch CNB FX rate whenever non-CZK currency & CNB mode are active.
  const fxCurrency = draft?.currency ?? CurrencyCode.make("CZK");
  const fxMode = draft?.fxMode ?? "cnb";
  const fxDate =
    draft !== null && parseIsoDate(draft.taxableSupplyOn) !== undefined
      ? draft.taxableSupplyOn
      : draft !== null && parseIsoDate(draft.issuedOn) !== undefined
        ? draft.issuedOn
        : null;

  useEffect(() => {
    if (fxCurrency === "CZK" || fxMode !== "cnb" || fxDate === null) {
      setCnbFx(null);
      setFxUnavailable(false);
      setFxLoading(false);
      return;
    }
    let live = true;
    setFxLoading(true);
    setFxUnavailable(false);
    run((api) =>
      api.reports.fxRate({
        params: { workspaceId: workspace.id, currency: fxCurrency },
        query: { on: IsoDate.make(fxDate) },
      }),
    )
      .then((res) => {
        if (!live) return;
        setFxLoading(false);
        if (res._tag === "Ok") {
          setCnbFx(res.value);
          setFxUnavailable(false);
        } else {
          setCnbFx(null);
          setFxUnavailable(true);
        }
      })
      .catch(() => {
        if (!live) return;
        setFxLoading(false);
        setCnbFx(null);
        setFxUnavailable(true);
      });
    return () => {
      live = false;
    };
  }, [fxCurrency, fxMode, fxDate, run, workspace.id]);

  const preview = useMemo(
    () =>
      draft === null
        ? null
        : computeLivePreview(
            draft,
            workspaceDefaults.taxRegime,
            workspaceDefaults.paymentRounding,
            cnbFx,
          ),
    [draft, workspaceDefaults.taxRegime, workspaceDefaults.paymentRounding, cnbFx],
  );

  const validation = useMemo(
    () =>
      draft === null
        ? null
        : validateEditorDraft(draft, {
            contactRequired: local({ cs: "Vyberte odběratele.", en: "Select a customer." }),
            invalidDate: local({ cs: "Použijte formát RRRR-MM-DD.", en: "Use YYYY-MM-DD format." }),
            dueBeforeIssue: local({
              cs: "Splatnost nesmí být před datem vystavení.",
              en: "Due date cannot be before issue date.",
            }),
            invalidLine: local({
              cs: "Vyplňte popis, kladné množství a jednotkovou cenu.",
              en: "Enter description, positive quantity and unit price.",
            }),
            invalidFx: local({
              cs: "Zadejte kladný kurz a počet jednotek.",
              en: "Enter a positive rate and unit quantity.",
            }),
          }),
    [draft, local],
  );

  const updateLine = useCallback((lineKey: string, patch: Partial<EditorLineDraft>) => {
    setDraft((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            lines: Arr.map(prev.lines, (line) =>
              line.key === lineKey ? { ...line, ...patch } : line,
            ),
          },
    );
  }, []);

  const removeLine = useCallback((lineKey: string) => {
    setDraft((prev) =>
      prev === null || prev.lines.length <= 1
        ? prev
        : { ...prev, lines: Arr.filter(prev.lines, (line) => line.key !== lineKey) },
    );
  }, []);

  const addLine = useCallback(() => {
    setDraft((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            lines: [
              ...prev.lines,
              createEmptyLine(defaultTreatmentForRegime(workspaceDefaults.taxRegime)),
            ],
          },
    );
  }, [workspaceDefaults.taxRegime]);

  const submit = Effect.fn("submitDocument")(function* (intent: "save" | "issue") {
    if (draft === null || validation === null || submitting.current || pendingCheckpoint !== null)
      return;
    setValidationShown(true);
    setBannerError(null);
    setServerIssues([]);
    if (validation.hasErrors) return;

    submitting.current = true;
    setBusyMode(intent);
    yield* saveOrIssue(draft, intent).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          submitting.current = false;
          setBusyMode(null);
        }),
      ),
    );
  }, runFeatureEffect);

  const recordWrite = Effect.fn("recordWrite")(function* (
    documentId: DocumentId,
    patch: DocumentPatch | null,
    baseRevision: number,
    revision: number,
  ) {
    if (requestOwner === null || (cachedTemplate?.seed ?? null) === null) return true;
    const checkpoint: Parameters<typeof recordImportedDraftWrite> = [
      requestOwner,
      documentId,
      patch,
      baseRevision,
      revision,
    ];
    return yield* recordImportedDraftWrite(...checkpoint).pipe(
      Effect.match({
        onSuccess: () => true,
        onFailure: () => {
          setPendingCheckpoint(checkpoint);
          return false;
        },
      }),
    );
  });

  const retryCheckpoint = Effect.fn("retryCheckpoint")(function* () {
    if (pendingCheckpoint === null || submitting.current) return;
    submitting.current = true;
    setBusyMode("save");
    yield* recordImportedDraftWrite(...pendingCheckpoint).pipe(
      Effect.tap(() => Effect.sync(() => setPendingCheckpoint(null))),
      // Keep the acknowledged revision and retry only its local checkpoint.
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          submitting.current = false;
          setBusyMode(null);
        }),
      ),
    );
  }, runFeatureEffect);

  const saveOrIssue = Effect.fn("saveOrIssue")(function* (
    currentDraft: EditorDraft,
    intent: "save" | "issue",
  ) {
    if (props.mode === "new") {
      const input = buildDocumentInput(currentDraft);
      const res =
        intent === "issue"
          ? yield* fromMobilePromise(() =>
              runMutation("documents.issueFromInput", input, (api, key) =>
                api.documents.issueFromInput({
                  params: { workspaceId: workspace.id },
                  headers: idempotencyHeaders(key),
                  payload: { input },
                }),
              ),
            )
          : yield* fromMobilePromise(() =>
              runMutation("documents.createDraft", input, (api, key) =>
                api.documents.createDraft({
                  params: { workspaceId: workspace.id },
                  headers: idempotencyHeaders(key),
                  payload: input,
                }),
              ),
            );
      if (res._tag === "Err") {
        const described = describeError(res.error);
        setBannerError(requestErrorText(res.error, { local, text: resolveText }));
        setServerIssues(described.issues);
        return;
      }
      overlay.toast(
        intent === "issue"
          ? t("documents.issue.done", { number: res.value.number ?? "" })
          : t("common.toast.saved"),
      );
      navigate(
        { _tag: "Document", ws: workspace.slug, id: res.value.id, tab: "preview" },
        { replace: true },
      );
      return;
    }

    const base = savedDraft.current;
    if (originalDoc === null || base === null) return;
    if (base.id !== originalDoc.id || base.revision !== originalDoc.revision) {
      setBannerError(
        local({
          cs: "Doklad se během úprav změnil. Otevřete jej znovu a načtěte aktuální verzi.",
          en: "This document changed while you were editing it. Reopen it to load the current revision.",
        }),
      );
      return;
    }

    let finalDoc = originalDoc;
    const patch =
      base.draft === currentDraft
        ? {}
        : buildDocumentPatch(currentDraft, base.draft, originalDoc, workspace.role);
    if (EffectRecord.keys<string, DocumentPatch[keyof DocumentPatch]>(patch).length > 0) {
      const editRes = yield* fromMobilePromise(() =>
        run((api) =>
          api.documents.edit({
            params: { workspaceId: workspace.id, documentId: originalDoc.id },
            headers: ifMatchHeaders(originalDoc.revision),
            payload: patch,
          }),
        ),
      );
      if (editRes._tag === "Err") {
        const described = describeError(editRes.error);
        setBannerError(resolveText(described.text));
        setServerIssues(described.issues);
        return;
      }
      finalDoc = editRes.value;
      sourceDocRemote.set(finalDoc);
      savedDraft.current = { draft: currentDraft, id: finalDoc.id, revision: finalDoc.revision };
      if (!(yield* recordWrite(originalDoc.id, patch, originalDoc.revision, finalDoc.revision))) {
        return;
      }
    }

    if (intent === "issue" && finalDoc.status === "draft") {
      const { id, revision } = finalDoc;
      const issueRes = yield* fromMobilePromise(() =>
        runMutation(`documents.issueDraft:${id}`, { revision }, (api, key) =>
          api.documents.issueDraft({
            params: { workspaceId: workspace.id, documentId: id },
            headers: { ...ifMatchHeaders(revision), ...idempotencyHeaders(key) },
            payload: {},
          }),
        ),
      );
      if (issueRes._tag === "Err") {
        const described = describeError(issueRes.error);
        setBannerError(requestErrorText(issueRes.error, { local, text: resolveText }));
        setServerIssues(described.issues);
        return;
      }
      finalDoc = issueRes.value;
      sourceDocRemote.set(finalDoc);
      savedDraft.current = { draft: currentDraft, id: finalDoc.id, revision: finalDoc.revision };
      if (!(yield* recordWrite(id, null, revision, finalDoc.revision))) return;
    }

    overlay.toast(
      intent === "issue"
        ? t("documents.issue.done", { number: finalDoc.number ?? "" })
        : t("common.toast.saved"),
    );
    navigate(
      { _tag: "Document", ws: workspace.slug, id: finalDoc.id, tab: "preview" },
      { replace: true },
    );
  });

  const title =
    props.mode === "new"
      ? props.kind === "proforma"
        ? t("documents.editor.titleNewProforma")
        : t("documents.editor.titleNewInvoice")
      : originalDoc?.status === "issued"
        ? t("documents.editor.titleIssued", { number: originalDoc.number ?? "" })
        : t("documents.editor.titleDraft");

  const isLocked = originalDoc?.locked === true;
  const isIssued = originalDoc?.status === "issued";
  const hasSavedTerms = props.mode === "new" || (cachedTemplate?.seed ?? null) !== null;
  const keepSaved = {
    value: "keep" as const,
    label: local({ cs: "Ponechat uložené", en: "Keep saved value" }),
  };
  const canAdmin = workspace.role === "owner" || workspace.role === "admin";
  const selectedContact =
    draft === null
      ? null
      : (Option.getOrUndefined(Arr.findFirst(contacts, (c) => c.id === draft.contactId)) ?? null);
  const currencyBankAccounts =
    draft === null ? [] : matchingBankAccounts(bankAccounts, draft.currency);
  const kindSeries = draft === null ? [] : matchingSeries(seriesList, draft.kind);
  const selectedSeries =
    draft === null
      ? null
      : (Option.getOrUndefined(Arr.findFirst(kindSeries, (s) => s.id === draft.seriesId)) ?? null);

  return (
    <Screen
      title={title}
      back={() =>
        router.canGoBack()
          ? router.back()
          : navigate({ _tag: "Documents", ws: workspace.slug, query: {} }, { replace: true })
      }
      footer={
        draft !== null && !isLocked && pendingCheckpoint === null ? (
          <>
            <Button
              kind="outlined"
              icon={Save}
              label={isIssued ? t("common.action.saveChanges") : t("documents.editor.saveDraft")}
              busy={busyMode === "save"}
              disabled={busyMode !== null}
              testID="editor-save-button"
              onPress={() => submit("save")}
            />
            {!isIssued ? (
              <Button
                kind="filled"
                icon={Send}
                label={t("documents.editor.issue")}
                busy={busyMode === "issue"}
                disabled={busyMode !== null}
                testID="editor-issue-button"
                onPress={() => submit("issue")}
              />
            ) : null}
          </>
        ) : undefined
      }
    >
      {sourceDocRemote.state._tag === "Failed" ? (
        <RemoteView state={sourceDocRemote.state} onRetry={sourceDocRemote.reload}>
          {() => null}
        </RemoteView>
      ) : templateContactId !== null && templateContactRemote.state._tag === "Failed" ? (
        <RemoteView state={templateContactRemote.state} onRetry={templateContactRemote.reload}>
          {() => null}
        </RemoteView>
      ) : pendingCheckpoint !== null ? (
        <>
          <Banner
            text={local({
              cs: "Doklad se uložil, ale nastavení šablony se na tomto zařízení nepodařilo uložit. Než budete pokračovat, zkuste obnovu znovu.",
              en: "The document was saved, but its template settings could not be saved on this device. Retry recovery to continue.",
            })}
          />
          <Button
            label={t("common.action.retry")}
            testID="editor-template-checkpoint-retry"
            busy={busyMode !== null}
            onPress={() => retryCheckpoint()}
          />
        </>
      ) : draft === null && templateLoadFailure !== null ? (
        <Banner
          text={
            templateLoadFailure === "revision"
              ? local({
                  cs: "Uložené nastavení šablony neodpovídá této verzi dokladu. Úpravy jsou pozastavené, aby se nezměnily údaje na dokladu.",
                  en: "The saved template settings do not match this document revision. Editing is paused to protect the document’s terms.",
                })
              : t("error.unknown")
          }
          action={{
            label: t("common.action.retry"),
            onPress: () => {
              setTemplateLoadFailure(null);
              sourceDocRemote.reload();
              reloadTemplate();
            },
          }}
        />
      ) : draft === null ? (
        <Loading label={t("common.state.loading")} />
      ) : (
        <View className="gap-4">
          {isLocked ? <Banner tone="warning" text={t("documents.editor.locked")} /> : null}
          {isIssued && !isLocked ? (
            <Banner tone="warning" text={t("documents.editor.issuedWarning")} />
          ) : null}
          {bannerError !== null ? <Banner text={bannerError} /> : null}
          {!hasSavedTerms ? (
            <Banner
              text={local({
                cs: "Některá uložená nastavení se v editoru nezobrazují. Uložením se změní jen upravená pole.",
                en: "Some saved settings are unavailable in this editor. Saving changes only the fields you edit.",
              })}
            />
          ) : null}
          {templateContactArchived && draft.contactId === null ? (
            <Banner
              tone="warning"
              text={local({
                cs: "Kontakt ze šablony je archivovaný. Vyberte jiný kontakt.",
                en: "The template's contact is archived. Select another contact.",
              })}
            />
          ) : null}
          {priceMismatchWarning !== null ? (
            <Banner tone="warning" text={priceMismatchWarning} />
          ) : null}

          {/* Contact section */}
          <Section title={t("documents.editor.section.parties")}>
            <Card>
              <ListRow
                title={selectedContact?.name ?? t("documents.editor.contact")}
                subtitle={
                  selectedContact === null
                    ? t("documents.editor.contactSearch")
                    : contactSubtitle(selectedContact)
                }
                leading={Users}
                testID="editor-contact-picker"
                {...(isLocked ? {} : { onPress: () => setContactPickerOpen(true) })}
              />
              {validationShown === true && validation?.contact !== undefined ? (
                <Text variant="bodySmall" color="error">
                  {validation.contact}
                </Text>
              ) : null}
              {Arr.map(issuesAt(serverIssues, ["contact"]), (iss) => (
                <Text
                  key={`${Arr.join(Arr.map(iss.path, String), ".")}-${iss.text.key}`}
                  variant="bodySmall"
                  color="error"
                >
                  {resolveText(iss.text)}
                </Text>
              ))}
              {isIssued && !isLocked ? (
                <SwitchRow
                  label={t("documents.editor.refreshParties")}
                  value={draft.refreshParties}
                  onChange={(value) => setDraft({ ...draft, refreshParties: value })}
                />
              ) : null}
            </Card>
          </Section>

          {/* Line items */}
          <Section
            title={t("documents.editor.section.lines")}
            action={
              !isLocked ? (
                <Button
                  kind="tonal"
                  icon={Plus}
                  label={t("documents.editor.line.add")}
                  testID="editor-add-line"
                  onPress={addLine}
                />
              ) : null
            }
          >
            {Arr.map(draft.lines, (line, index) => {
              const lineCalc = preview?.lines[index];
              const lineError = validationShown === true ? validation?.lines[line.key] : undefined;
              return (
                <Card key={line.key}>
                  <View className="flex-row items-center justify-between">
                    <Text variant="labelMedium" color="onSurfaceVariant">
                      {`#${index + 1}`}
                    </Text>
                    <View className="flex-row items-center gap-1">
                      {!isLocked && priceList.length > 0 ? (
                        <Button
                          kind="text"
                          icon={BookOpen}
                          label={t("documents.editor.line.fromPriceList")}
                          testID={`editor-line-pricelist-${index}`}
                          onPress={() => setPricePickerLineKey(line.key)}
                        />
                      ) : null}
                      {!isLocked && draft.lines.length > 1 ? (
                        <Button
                          kind="text"
                          icon={Trash2}
                          label={t("documents.editor.line.remove")}
                          testID={`editor-line-remove-${index}`}
                          onPress={() => removeLine(line.key)}
                        />
                      ) : null}
                    </View>
                  </View>

                  <TextField
                    label={t("documents.editor.line.description")}
                    value={line.description}
                    onChangeText={(value) => updateLine(line.key, { description: value })}
                    disabled={isLocked}
                    testID={`editor-line-desc-${index}`}
                  />

                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <TextField
                        label={t("documents.editor.line.quantity")}
                        value={line.quantity}
                        onChangeText={(value) => updateLine(line.key, { quantity: value })}
                        keyboardType="decimal-pad"
                        disabled={isLocked}
                        testID={`editor-line-qty-${index}`}
                      />
                    </View>
                    <View className="flex-1">
                      <TextField
                        label={t("documents.editor.line.unit")}
                        value={line.unit}
                        onChangeText={(value) => updateLine(line.key, { unit: value })}
                        disabled={isLocked}
                      />
                    </View>
                    <View className="flex-1">
                      <TextField
                        label={t("documents.editor.line.unitPrice")}
                        value={line.unitPrice}
                        onChangeText={(value) => updateLine(line.key, { unitPrice: value })}
                        keyboardType="decimal-pad"
                        disabled={isLocked}
                        testID={`editor-line-price-${index}`}
                      />
                    </View>
                  </View>

                  {workspaceDefaults.taxRegime === "vat_payer" ? (
                    <SegmentedChoice
                      label={t("documents.editor.line.vat")}
                      value={line.treatment}
                      choices={Arr.map(VAT_TREATMENTS, (tr) => ({
                        value: tr,
                        label: t(enumKey({ name: "vatTreatment", value: tr })),
                      }))}
                      onChange={(value) => {
                        if (!isLocked) updateLine(line.key, { treatment: value });
                      }}
                    />
                  ) : null}

                  {lineCalc !== undefined ? (
                    <Text variant="meta" color="onSurfaceVariant" numeric>
                      {`${t("documents.editor.line.total")}: ${formatMoney(
                        locale,
                        MoneyMath.make(displayAmount(lineCalc.gross), draft.currency),
                      )}`}
                    </Text>
                  ) : null}

                  {lineError !== undefined ? (
                    <Text variant="bodySmall" color="error">
                      {lineError}
                    </Text>
                  ) : null}
                </Card>
              );
            })}
          </Section>

          {/* Dates */}
          <Section title={t("documents.editor.section.dates")}>
            <Card>
              <TextField
                label={t("documents.editor.issueDate")}
                value={draft.issuedOn}
                onChangeText={(value) => setDraft({ ...draft, issuedOn: value })}
                placeholder="YYYY-MM-DD"
                disabled={isLocked}
                {...(validationShown === true && validation?.issuedOn !== undefined
                  ? { error: validation.issuedOn }
                  : {})}
                testID="editor-issued-on"
              />
              {workspaceDefaults.taxRegime === "vat_payer" ? (
                <TextField
                  label={t("documents.editor.taxableSupplyDate")}
                  value={draft.taxableSupplyOn}
                  onChangeText={(value) => setDraft({ ...draft, taxableSupplyOn: value })}
                  placeholder="YYYY-MM-DD"
                  disabled={isLocked}
                  {...(validationShown === true && validation?.taxableSupplyOn !== undefined
                    ? { error: validation.taxableSupplyOn }
                    : {})}
                  testID="editor-taxable-supply-on"
                />
              ) : null}
              <TextField
                label={t("documents.editor.dueDate")}
                value={draft.dueOn}
                onChangeText={(value) => setDraft({ ...draft, dueOn: value })}
                placeholder="YYYY-MM-DD"
                disabled={isLocked}
                {...(validationShown === true && validation?.dueOn !== undefined
                  ? { error: validation.dueOn }
                  : {})}
                testID="editor-due-on"
              />
            </Card>
          </Section>

          {/* Payment, Currency, FX & Numbering */}
          <Section title={t("documents.editor.section.payment")}>
            <Card>
              <SegmentedChoice
                label={t("documents.editor.currency")}
                value={draft.currency}
                choices={Arr.map(COMMON_CURRENCIES, (cur) => ({ value: cur, label: cur }))}
                onChange={(currency) => {
                  if (isLocked) return;
                  setDraft({
                    ...draft,
                    currency,
                    bankAccountId: defaultBankAccountId(bankAccounts, currency),
                  });
                }}
              />

              {draft.currency !== "CZK" ? (
                <View className="gap-2">
                  <SegmentedChoice
                    label={t("documents.editor.fx.title")}
                    value={draft.fxMode}
                    choices={[
                      { value: "cnb", label: t(enumKey({ name: "fxSource", value: "cnb" })) },
                      { value: "manual", label: t("documents.editor.fx.manual") },
                    ]}
                    onChange={(mode) => {
                      if (!isLocked) setDraft({ ...draft, fxMode: mode });
                    }}
                  />
                  {draft.fxMode === "cnb" ? (
                    fxLoading === true ? (
                      <Text variant="meta" color="onSurfaceVariant">
                        {t("documents.editor.fx.loading")}
                      </Text>
                    ) : cnbFx !== null ? (
                      <Text variant="meta" color="onSurfaceVariant" numeric>
                        {t("documents.editor.fx.cnb", {
                          rate: BigDecimal.format(cnbFx.rate),
                          quantity: cnbFx.quantity,
                          currency: draft.currency,
                          date: formatDate({ locale, date: cnbFx.fixingDate }),
                        })}
                      </Text>
                    ) : fxUnavailable === true ? (
                      <Banner tone="warning" text={t("documents.editor.fx.unavailable")} />
                    ) : null
                  ) : (
                    <View className="flex-row gap-2">
                      <View className="flex-1">
                        <TextField
                          label={t("documents.editor.fx.rate")}
                          value={draft.manualFxRate}
                          onChangeText={(value) => setDraft({ ...draft, manualFxRate: value })}
                          keyboardType="decimal-pad"
                          disabled={isLocked}
                          testID="editor-fx-rate"
                        />
                      </View>
                      <View className="flex-1">
                        <TextField
                          label={t("documents.editor.fx.quantity")}
                          value={draft.manualFxQuantity}
                          onChangeText={(value) => setDraft({ ...draft, manualFxQuantity: value })}
                          keyboardType="number-pad"
                          disabled={isLocked}
                        />
                      </View>
                    </View>
                  )}
                  {validationShown === true && validation?.fx !== undefined ? (
                    <Text variant="bodySmall" color="error">
                      {validation.fx}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <SegmentedChoice
                label={t("documents.editor.paymentMethod")}
                value={draft.paymentMethod}
                choices={Arr.map(PAYMENT_METHODS, (m) => ({
                  value: m,
                  label: t(enumKey({ name: "paymentMethod", value: m })),
                }))}
                onChange={(paymentMethod) => {
                  if (!isLocked) setDraft({ ...draft, paymentMethod });
                }}
              />

              {currencyBankAccounts.length === 0 ? (
                <Banner
                  tone="warning"
                  text={t("documents.editor.warning.no_bank_account_for_currency", {
                    currency: draft.currency,
                  })}
                />
              ) : (
                <SegmentedChoice
                  label={t("documents.editor.bankAccount")}
                  value={draft.bankAccountId}
                  choices={Arr.map(currencyBankAccounts, (b) => ({
                    value: b.id,
                    label: (b.name ?? "") !== "" ? `${b.name} (${b.iban})` : b.iban,
                  }))}
                  onChange={(bankAccountId) => {
                    if (!isLocked) setDraft({ ...draft, bankAccountId });
                  }}
                />
              )}

              {!isIssued && kindSeries.length > 0 ? (
                <>
                  <SegmentedChoice
                    label={t("documents.editor.series")}
                    value={draft.seriesId ?? (hasSavedTerms ? null : "keep")}
                    choices={[
                      ...(!hasSavedTerms ? [keepSaved] : []),
                      ...Arr.map(kindSeries, (s) => ({ value: s.id, label: s.name })),
                    ]}
                    onChange={(seriesId) => {
                      if (!isLocked)
                        setDraft({ ...draft, seriesId: seriesId === "keep" ? null : seriesId });
                    }}
                  />
                  {selectedSeries !== null ? (
                    <Text variant="meta" color="onSurfaceVariant" numeric>
                      {t("documents.editor.numberHint", { number: selectedSeries.nextNumber })}
                    </Text>
                  ) : null}
                </>
              ) : null}

              {isIssued && canAdmin && !isLocked ? (
                <TextField
                  label={t("documents.editor.overrideNumber")}
                  value={draft.overrideNumber}
                  onChangeText={(value) => setDraft({ ...draft, overrideNumber: value })}
                />
              ) : null}

              <SegmentedChoice
                label={t("documents.editor.language")}
                value={draft.language ?? (hasSavedTerms ? null : "keep")}
                choices={[
                  ...(!hasSavedTerms ? [keepSaved] : []),
                  { value: "cs", label: t(enumKey({ name: "locale", value: "cs" })) },
                  { value: "en", label: t(enumKey({ name: "locale", value: "en" })) },
                ]}
                onChange={(language: Locale | "keep") => {
                  if (!isLocked)
                    setDraft({ ...draft, language: language === "keep" ? null : language });
                }}
              />

              {workspaceDefaults.taxRegime === "vat_payer" ? (
                hasSavedTerms ? (
                  <SwitchRow
                    label={t("documents.editor.pricesIncludeVat")}
                    value={draft.pricesIncludeVat === true}
                    disabled={isLocked}
                    onChange={(pricesIncludeVat) => setDraft({ ...draft, pricesIncludeVat })}
                  />
                ) : (
                  <SegmentedChoice
                    label={t("documents.editor.pricesIncludeVat")}
                    value={
                      draft.pricesIncludeVat === null
                        ? "keep"
                        : draft.pricesIncludeVat === true
                          ? "inclusive"
                          : "exclusive"
                    }
                    choices={[
                      keepSaved,
                      { value: "inclusive", label: local({ cs: "S DPH", en: "Including VAT" }) },
                      { value: "exclusive", label: local({ cs: "Bez DPH", en: "Excluding VAT" }) },
                    ]}
                    onChange={(basis) => {
                      if (!isLocked)
                        setDraft({
                          ...draft,
                          pricesIncludeVat: basis === "keep" ? null : basis === "inclusive",
                        });
                    }}
                  />
                )
              ) : null}

              <View className="flex-row gap-2">
                <View className="flex-1">
                  <TextField
                    label={t("documents.editor.variableSymbol")}
                    value={draft.variableSymbol}
                    onChangeText={(value) => setDraft({ ...draft, variableSymbol: value })}
                    disabled={isLocked}
                  />
                </View>
                <View className="flex-1">
                  <TextField
                    label={t("documents.editor.orderNumber")}
                    value={draft.orderNumber}
                    onChangeText={(value) => setDraft({ ...draft, orderNumber: value })}
                    disabled={isLocked}
                  />
                </View>
              </View>
            </Card>
          </Section>

          {/* Live VAT & FX Preview */}
          {preview !== null ? (
            <Section title={t("documents.editor.section.preview")}>
              <Card>
                {Arr.map(preview.breakdown.buckets, (bucket) => (
                  <View
                    key={`${bucket.treatment}-${String(bucket.ratePercent)}`}
                    className="flex-row items-center justify-between gap-3"
                  >
                    <Text variant="bodyMedium" className="flex-1">
                      {`${t(enumKey({ name: "vatTreatment", value: bucket.treatment }))} (${formatVatRate(locale, Number(BigDecimal.format(bucket.ratePercent)))})`}
                    </Text>
                    <View className="items-end gap-0.5">
                      <Text variant="bodyMedium" numeric>
                        {`${t("documents.editor.totals.base")} ${formatMoney(
                          locale,
                          MoneyMath.make(bucket.base, draft.currency),
                        )} · ${t("common.field.vat")} ${formatMoney(
                          locale,
                          MoneyMath.make(bucket.vat, draft.currency),
                        )}`}
                      </Text>
                      {bucket.vatCzk !== null ? (
                        <Text variant="meta" color="onSurfaceVariant" numeric>
                          {`CZK ${t("common.field.vat")}: ${formatMoney(
                            locale,
                            MoneyMath.make(bucket.vatCzk, CurrencyCode.make("CZK")),
                          )}`}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
                <View className="flex-row items-center justify-between gap-3">
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("documents.editor.totals.base")}
                  </Text>
                  <Text variant="bodyMedium" numeric>
                    {formatMoney(locale, preview.breakdown.net)}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between gap-3">
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("common.field.vat")}
                  </Text>
                  <Text variant="bodyMedium" numeric>
                    {formatMoney(locale, preview.breakdown.vat)}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between gap-3">
                  <Text variant="titleMedium">{t("documents.editor.totals.total")}</Text>
                  <Text variant="titleMedium" numeric testID="editor-preview-total">
                    {formatMoney(locale, preview.breakdown.gross)}
                  </Text>
                </View>
                {preview.breakdown.vatCzk !== null ? (
                  <View className="flex-row items-center justify-between gap-3">
                    <Text variant="meta" color="onSurfaceVariant">
                      {`${t("common.field.vat")} (CZK)`}
                    </Text>
                    <Text
                      variant="meta"
                      color="onSurfaceVariant"
                      numeric
                      testID="editor-preview-vat-czk"
                    >
                      {formatMoney(locale, preview.breakdown.vatCzk)}
                    </Text>
                  </View>
                ) : null}
                {workspaceDefaults.taxRegime !== "vat_payer" ? (
                  <Text variant="meta" color="onSurfaceVariant">
                    {t("documents.editor.nonVatFooter")}
                  </Text>
                ) : null}
              </Card>
            </Section>
          ) : draft.pricesIncludeVat === null && workspaceDefaults.taxRegime === "vat_payer" ? (
            <Text variant="meta" color="onSurfaceVariant">
              {local({
                cs: "Pro náhled vyberte, zda ceny zahrnují DPH.",
                en: "Choose a VAT pricing basis to preview changes.",
              })}
            </Text>
          ) : null}

          {/* Notes */}
          <Section title={t("documents.editor.section.notes")}>
            <Card>
              <TextField
                label={t("documents.editor.note")}
                testID="editor-note"
                value={draft.note}
                onChangeText={(value) => setDraft({ ...draft, note: value })}
                multiline
                disabled={isLocked}
              />
            </Card>
          </Section>

          {/* Contact Picker Modal */}
          <PickerModal
            visible={contactPickerOpen}
            title={t("documents.editor.contact")}
            searchPlaceholder={t("documents.editor.contactSearch")}
            items={contacts}
            keyOf={(c) => c.id}
            filter={(c, q) =>
              Str.includes(q)(Str.toLowerCase(c.name)) ||
              Str.includes(q)(Str.toLowerCase(c.ico ?? "")) ||
              Str.includes(q)(Str.toLowerCase(c.dic ?? ""))
            }
            renderItem={(c, select) => (
              <ListRow
                title={c.name}
                subtitle={Arr.join(
                  Arr.filter(
                    [
                      (c.ico ?? "") !== "" ? `IČO ${c.ico}` : null,
                      (c.dic ?? "") !== "" ? `DIČ ${c.dic}` : null,
                    ],
                    (part): part is string => part !== null && part !== "",
                  ),
                  " · ",
                )}
                onPress={select}
              />
            )}
            onSelect={(contact) =>
              setDraft((prev) =>
                prev === null || prev.contactId === contact.id
                  ? prev
                  : applyContactDefaults(
                      prev,
                      contact,
                      workspaceDefaults,
                      bankAccounts,
                      seriesList,
                    ),
              )
            }
            onClose={() => setContactPickerOpen(false)}
          />

          {/* Price List Picker Modal */}
          <PickerModal
            visible={pricePickerLineKey !== null}
            title={t("documents.editor.line.fromPriceList")}
            searchPlaceholder={t("common.action.search")}
            items={priceList}
            keyOf={(item) => item.id}
            filter={(item, q) =>
              Str.includes(q)(Str.toLowerCase(item.name)) ||
              Str.includes(q)(Str.toLowerCase(item.description ?? ""))
            }
            renderItem={(item, select) => (
              <ListRow
                title={item.name}
                {...(item.description !== null ? { subtitle: item.description } : {})}
                trailing={formatMoney(locale, MoneyMath.make(item.unitPrice, item.currency))}
                onPress={select}
              />
            )}
            onSelect={(item) => {
              if (pricePickerLineKey === null || draft === null) return;
              const applied = applyPriceListItem(
                draft,
                pricePickerLineKey,
                item,
                workspaceDefaults.taxRegime,
              );
              setDraft(applied.draft);
              setPriceMismatchWarning(
                applied.currencyMismatch !== null
                  ? t("documents.editor.warning.price_list_currency_differs", {
                      currency: applied.currencyMismatch,
                    })
                  : null,
              );
            }}
            onClose={() => setPricePickerLineKey(null)}
          />
        </View>
      )}
    </Screen>
  );
}

// --- Credit Note Creator Screen (quick create for kind="credit_note") ---------------------------

export function CreditNoteCreatorScreen() {
  const { workspace } = useWorkspace();
  const { t, locale, local, text: resolveText } = useI18n();
  const runMutation = useRequestMutation(workspace.id);
  const overlay = useOverlay();

  const issuedRemote = useRemote(
    useCallback(
      (api: KvitbitApiClient) =>
        api.documents.list({
          params: { workspaceId: workspace.id },
          query: { status: "issued", limit: 100 },
        }),
      [workspace.id],
    ),
  );

  const [selectedDocId, setSelectedDocId] = useState<DocumentId | null>(null);
  const [reason, setReason] = useState("");
  const [correctedOn, setCorrectedOn] = useState<string>(() => todayIsoPrague());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDocRemote = useRemote(
    useMemo(
      () =>
        selectedDocId === null
          ? null
          : (api: KvitbitApiClient) =>
              api.documents.get({
                params: { workspaceId: workspace.id, documentId: selectedDocId },
              }),
      [workspace.id, selectedDocId],
    ),
  );

  const submit = Effect.fn("submit")(function* () {
    if (selectedDocId === null) {
      setError(local({ cs: "Vyberte původní doklad.", en: "Select the original document." }));
      return;
    }
    if (Str.trim(reason) === "") {
      setError(local({ cs: "Zadejte důvod opravy.", en: "Enter a correction reason." }));
      return;
    }
    if (Str.trim(correctedOn) !== "" && parseIsoDate(correctedOn) === undefined) {
      setError(local({ cs: "Použijte formát RRRR-MM-DD.", en: "Use YYYY-MM-DD format." }));
      return;
    }
    setBusy(true);
    setError(null);
    const correction = { reason: Str.trim(reason), lines: "full" as const };
    const payload =
      Str.trim(correctedOn) === ""
        ? correction
        : { ...correction, correctedOn: IsoDate.make(correctedOn) };
    const res = yield* fromMobilePromise(() =>
      runMutation(`documents.correct:${selectedDocId}`, payload, (api, key) =>
        api.documents.correct({
          params: { workspaceId: workspace.id, documentId: selectedDocId },
          headers: idempotencyHeaders(key),
          payload,
        }),
      ),
    );
    setBusy(false);
    if (res._tag === "Err") {
      setError(requestErrorText(res.error, { local, text: resolveText }));
      return;
    }
    overlay.toast(t("documents.creditNote.issued", { number: res.value.number ?? "" }));
    navigate(
      { _tag: "Document", ws: workspace.slug, id: res.value.id, tab: "preview" },
      { replace: true },
    );
  }, runFeatureEffect);

  return (
    <Screen
      title={local({ cs: "Nový dobropis", en: "New credit note" })}
      back={() =>
        router.canGoBack()
          ? router.back()
          : navigate({ _tag: "Documents", ws: workspace.slug, query: {} }, { replace: true })
      }
      footer={
        <Button
          kind="filled"
          label={t("documents.creditNote.submit")}
          busy={busy}
          disabled={selectedDocId === null}
          testID="credit-note-create-submit"
          onPress={() => submit()}
        />
      }
    >
      {error !== null ? <Banner text={error} /> : null}
      <Banner tone="info" text={t("documents.creditNote.inheritsRate")} />

      <Section
        title={local({
          cs: "Vyberte vystavenou fakturu nebo daňový doklad",
          en: "Select an issued invoice or payment tax document",
        })}
      >
        <RemoteView state={issuedRemote.state} onRetry={issuedRemote.reload}>
          {(page) => {
            const eligible = Arr.filter(
              Arr.map(page.items, parseDocumentSummary),
              (d) => d.kind === "invoice" || d.kind === "payment_tax_document",
            );
            if (eligible.length === 0) {
              return (
                <EmptyState
                  title={local({
                    cs: "Žádné vystavené faktury k opravě",
                    en: "No issued invoices to credit",
                  })}
                />
              );
            }
            return (
              <Card className="px-2 py-1">
                {Arr.map(eligible, (doc) => (
                  <ListRow
                    key={doc.id}
                    testID={`credit-source-${doc.id}`}
                    title={doc.number ?? doc.id}
                    subtitle={`${doc.contact.name} · ${formatDate({ locale, date: doc.issuedOn })}`}
                    trailing={formatMoney(locale, doc.total)}
                    badge={
                      selectedDocId === doc.id ? (
                        <Text variant="labelSmall" color="primary">
                          ✓
                        </Text>
                      ) : undefined
                    }
                    onPress={() => setSelectedDocId(doc.id)}
                  />
                ))}
              </Card>
            );
          }}
        </RemoteView>
      </Section>

      {selectedDocRemote.state._tag === "Ready" ? (
        <Section title={t("documents.editor.section.lines")}>
          <Card className="px-2 py-1">
            {Arr.map(selectedDocRemote.state.value.lines, (raw) => {
              const line = parseLineView(raw);
              return (
                <ListRow
                  key={line.id}
                  title={line.description}
                  trailing={formatMoney(
                    locale,
                    MoneyMath.make(
                      line.amount,
                      selectedDocRemote.state._tag === "Ready"
                        ? selectedDocRemote.state.value.totals.gross.currency
                        : CurrencyCode.make("CZK"),
                    ),
                  )}
                />
              );
            })}
          </Card>
        </Section>
      ) : null}

      <Card>
        <TextField
          label={t("documents.creditNote.reason")}
          placeholder={t("documents.creditNote.reasonHint")}
          value={reason}
          onChangeText={setReason}
          testID="credit-note-create-reason"
        />
        <TextField
          label={t("common.field.date")}
          value={correctedOn}
          onChangeText={setCorrectedOn}
          placeholder="YYYY-MM-DD"
        />
      </Card>
    </Screen>
  );
}
