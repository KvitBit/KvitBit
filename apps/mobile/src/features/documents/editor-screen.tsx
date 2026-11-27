/**
 * Document editor (`new/[kind].tsx`, `[id]/edit.tsx`) and quick Credit Note creator
 * (`new/credit_note.tsx`). Uses `@kvitbit/ui-port/view-models` `calculate()` for instant
 * VAT & CZK FX breakdown preview alongside live CNB rate lookup.
 */
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentPatch,
  DocumentView,
  FxRateView,
  IsoDate,
  Locale,
  TemplateId,
} from "@kvitbit/domain/contract";
import { MoneyMath } from "@kvitbit/domain/contract";
import {
  describeError,
  idempotencyHeaders,
  ifMatchHeaders,
  issuesAt,
  type UiError,
} from "@kvitbit/ui-port/api";
import { formatDate, formatMoney, formatVatRate, parseIsoDate } from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import { displayAmount } from "@kvitbit/ui-port/view-models";
import { BigDecimal } from "effect";
import { router } from "expo-router";
import { posthog, posthogLog } from "../../config/posthog";
import { BookOpen, Plus, Save, Send, Trash2, Users } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi, useRemote } from "../../runtime/api-runtime";
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
  space,
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
  ImportedDraftRevisionMismatch,
  importTemplate,
  openImportedDraft,
  recordImportedDraftWrite,
  type TemplateSeed,
} from "./template-import";

export function DocumentFromTemplateScreen({ templateId }: { readonly templateId: TemplateId }) {
  const { workspace } = useWorkspace();
  const { t, local, text } = useI18n();
  const { run } = useApi();
  const overlay = useOverlay();
  const requestOwner = useRequestOwner(workspace.id);
  const writable = canWriteWorkspace(workspace);
  const [failure, setFailure] = useState<UiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const expired = failure !== null && isRequestIntentExpired(failure);

  const retry = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };

  const startNewImport = async () => {
    if (requestOwner === null || restarting) return;
    setRestarting(true);
    const label = local({ cs: "Zahájit nový import", en: "Start new import" });
    try {
      const confirmed = await overlay.confirm({
        title: label,
        body: local({
          cs: "Zkontrolujte, zda už předchozí import nevytvořil koncept. Pokračováním vytvoříte nový koncept.",
          en: "Check whether the earlier import already created a draft. Continuing will start a new draft.",
        }),
        confirmLabel: label,
        cancelLabel: t("common.action.cancel"),
      });
      if (!confirmed) return;
      await discardExpiredTemplateImport(requestOwner, templateId);
      retry();
    } catch (error) {
      setFailure(requestIntentFailure(error));
    } finally {
      setRestarting(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry button starts a new attempt
  useEffect(() => {
    if (!writable || requestOwner === null) return;
    let active = true;
    void importTemplate(requestOwner, workspace, templateId, run).then((result) => {
      if (!active) return;
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
  }, [attempt, requestOwner, run, templateId, workspace, writable]);

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
                onPress={() => void startNewImport()}
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
    const q = query.trim().toLowerCase();
    return q === "" ? props.items : props.items.filter((item) => props.filter(item, q));
  }, [props, query]);

  return (
    <Modal transparent visible={props.visible} animationType="fade" onRequestClose={props.onClose}>
      <View style={[styles.scrim, { backgroundColor: `${theme.colors.scrim}66` }]}>
        <View
          style={[
            styles.pickerDialog,
            {
              backgroundColor: theme.colors.surfaceContainerHigh,
              borderRadius: theme.shape.panel + 12,
            },
          ]}
        >
          <Text variant="headlineSmall">{props.title}</Text>
          <TextField
            label={t("common.action.search")}
            placeholder={props.searchPlaceholder}
            value={query}
            onChangeText={setQuery}
          />
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.pickerScroll}>
            {filtered.length === 0 ? (
              <EmptyState title={t("common.state.noMatches")} />
            ) : (
              filtered.map((item) => (
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
          <View style={styles.pickerFooter}>
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
    (api) => api.workspace.current({ params: { workspaceId: workspace.id } }),
    [workspace.id],
  );
  const contactsRemote = useRemote(
    (api) => api.contacts.search({ params: { workspaceId: workspace.id }, query: { limit: 100 } }),
    [workspace.id],
  );
  const priceListRemote = useRemote(
    (api) => api.priceList.list({ params: { workspaceId: workspace.id }, query: {} }),
    [workspace.id],
  );
  const bankAccountsRemote = useRemote(
    (api) => api.workspace.listBankAccounts({ params: { workspaceId: workspace.id } }),
    [workspace.id],
  );
  const seriesRemote = useRemote(
    (api) => api.workspace.listSeries({ params: { workspaceId: workspace.id } }),
    [workspace.id],
  );

  const sourceDocId =
    props.mode === "edit"
      ? props.documentId
      : props.duplicateId !== undefined
        ? props.duplicateId
        : null;

  const sourceDocRemote = useRemote(
    sourceDocId === null
      ? null
      : (api) =>
          api.documents.get({
            params: { workspaceId: workspace.id, documentId: sourceDocId },
          }),
    [workspace.id, sourceDocId],
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
    cachedTemplate?.seed != null && originalDoc !== null && originalDoc.status === "draft"
      ? parseContactSnapshot(originalDoc.contact).contactId || null
      : null;
  const templateContactRemote = useRemote(
    templateContactId === null
      ? null
      : (api) =>
          api.contacts.get({ params: { workspaceId: workspace.id, contactId: templateContactId } }),
    [workspace.id, templateContactId],
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
        ? contactsRemote.state.value.items.map(parseContactOption).filter((c) => !c.archived)
        : [],
    [contactsRemote.state],
  );

  const priceList: ReadonlyArray<PriceListOption> = useMemo(
    () =>
      priceListRemote.state._tag === "Ready"
        ? priceListRemote.state.value.map(parsePriceListOption).filter((p) => !p.archived)
        : [],
    [priceListRemote.state],
  );

  const bankAccounts: ReadonlyArray<BankAccountOption> = useMemo(
    () =>
      bankAccountsRemote.state._tag === "Ready"
        ? bankAccountsRemote.state.value.map(parseBankAccountOption)
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
  const [templateLoadAttempt, setTemplateLoadAttempt] = useState(0);
  const importDocId = originalDoc?.id ?? null;
  const importRevision = originalDoc?.revision ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry button starts a new lookup
  useEffect(() => {
    if (draft !== null || requestOwner === null || importDocId === null || importRevision === null)
      return;
    let live = true;
    void openImportedDraft(requestOwner, importDocId, importRevision).then(
      (seed) => {
        if (live) {
          setTemplateLoadFailure(null);
          setCachedTemplate({ revision: importRevision, seed });
        }
      },
      (error: unknown) => {
        if (live) {
          setTemplateLoadFailure(
            error instanceof ImportedDraftRevisionMismatch ? "revision" : "storage",
          );
        }
      },
    );
    return () => {
      live = false;
    };
  }, [draft, importDocId, importRevision, requestOwner, templateLoadAttempt]);

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
          ? (contacts.find((c) => c.id === props.contactId) ?? null)
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
  const fxCurrency = draft?.currency ?? ("CZK" as CurrencyCode);
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
    void run((api) =>
      api.reports.fxRate({
        params: { workspaceId: workspace.id, currency: fxCurrency },
        query: { on: fxDate as IsoDate },
      }),
    ).then((res) => {
      if (!live) return;
      setFxLoading(false);
      if (res._tag === "Ok") {
        setCnbFx(res.value);
        setFxUnavailable(false);
      } else {
        setCnbFx(null);
        setFxUnavailable(true);
      }
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
            lines: prev.lines.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)),
          },
    );
  }, []);

  const removeLine = useCallback((lineKey: string) => {
    setDraft((prev) =>
      prev === null || prev.lines.length <= 1
        ? prev
        : { ...prev, lines: prev.lines.filter((line) => line.key !== lineKey) },
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

  const submit = async (intent: "save" | "issue") => {
    if (draft === null || validation === null || submitting.current || pendingCheckpoint !== null)
      return;
    setValidationShown(true);
    setBannerError(null);
    setServerIssues([]);
    if (validation.hasErrors) return;

    submitting.current = true;
    setBusyMode(intent);
    try {
      await saveOrIssue(draft, intent);
    } finally {
      submitting.current = false;
      setBusyMode(null);
    }
  };

  const recordWrite = async (
    documentId: DocumentId,
    patch: DocumentPatch | null,
    baseRevision: number,
    revision: number,
  ): Promise<boolean> => {
    if (requestOwner === null || cachedTemplate?.seed == null) return true;
    const checkpoint: Parameters<typeof recordImportedDraftWrite> = [
      requestOwner,
      documentId,
      patch,
      baseRevision,
      revision,
    ];
    try {
      await recordImportedDraftWrite(...checkpoint);
      return true;
    } catch {
      setPendingCheckpoint(checkpoint);
      return false;
    }
  };

  const retryCheckpoint = async () => {
    if (pendingCheckpoint === null || submitting.current) return;
    submitting.current = true;
    setBusyMode("save");
    try {
      await recordImportedDraftWrite(...pendingCheckpoint);
      setPendingCheckpoint(null);
    } catch {
      // Keep the acknowledged revision and retry only its local checkpoint.
    } finally {
      submitting.current = false;
      setBusyMode(null);
    }
  };

  const captureDocumentOutcome = (draft: EditorDraft, intent: "save" | "issue") => {
    try {
      posthog?.capture(intent === "issue" ? "document_issued" : "document_draft_saved", {
        document_kind: draft.kind,
        document_mode: props.mode,
        currency: draft.currency,
        payment_method: draft.paymentMethod,
        line_count: draft.lines.length,
      });
      posthogLog.info("document operation completed", {
        document_kind: draft.kind,
        operation: intent,
        document_mode: props.mode,
        currency: draft.currency,
        payment_method: draft.paymentMethod,
        line_count: draft.lines.length,
      });
    } catch {
      // Analytics must not affect document creation or editing.
    }
  };

  const saveOrIssue = async (draft: EditorDraft, intent: "save" | "issue") => {
    if (props.mode === "new") {
      const input = buildDocumentInput(draft);
      const res =
        intent === "issue"
          ? await runMutation("documents.issueFromInput", input, (api, key) =>
              api.documents.issueFromInput({
                params: { workspaceId: workspace.id },
                headers: idempotencyHeaders(key),
                payload: { input },
              }),
            )
          : await runMutation("documents.createDraft", input, (api, key) =>
              api.documents.createDraft({
                params: { workspaceId: workspace.id },
                headers: idempotencyHeaders(key),
                payload: input,
              }),
            );
      if (res._tag === "Err") {
        const described = describeError(res.error);
        setBannerError(requestErrorText(res.error, { local, text: resolveText }));
        setServerIssues(described.issues);
        return;
      }
      captureDocumentOutcome(draft, intent);
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
      base.draft === draft
        ? {}
        : buildDocumentPatch(draft, base.draft, originalDoc, workspace.role);
    if (Object.keys(patch).length > 0) {
      const editRes = await run((api) =>
        api.documents.edit({
          params: { workspaceId: workspace.id, documentId: originalDoc.id },
          headers: ifMatchHeaders(originalDoc.revision),
          payload: patch,
        }),
      );
      if (editRes._tag === "Err") {
        const described = describeError(editRes.error);
        setBannerError(resolveText(described.text));
        setServerIssues(described.issues);
        return;
      }
      finalDoc = editRes.value;
      sourceDocRemote.set(finalDoc);
      savedDraft.current = { draft, id: finalDoc.id, revision: finalDoc.revision };
      if (!(await recordWrite(originalDoc.id, patch, originalDoc.revision, finalDoc.revision))) {
        return;
      }
    }

    if (intent === "issue" && finalDoc.status === "draft") {
      const { id, revision } = finalDoc;
      const issueRes = await runMutation(`documents.issueDraft:${id}`, { revision }, (api, key) =>
        api.documents.issueDraft({
          params: { workspaceId: workspace.id, documentId: id },
          headers: { ...ifMatchHeaders(revision), ...idempotencyHeaders(key) },
          payload: {},
        }),
      );
      if (issueRes._tag === "Err") {
        const described = describeError(issueRes.error);
        setBannerError(requestErrorText(issueRes.error, { local, text: resolveText }));
        setServerIssues(described.issues);
        return;
      }
      finalDoc = issueRes.value;
      sourceDocRemote.set(finalDoc);
      savedDraft.current = { draft, id: finalDoc.id, revision: finalDoc.revision };
      if (!(await recordWrite(id, null, revision, finalDoc.revision))) return;
    }

    captureDocumentOutcome(draft, intent);
    overlay.toast(
      intent === "issue"
        ? t("documents.issue.done", { number: finalDoc.number ?? "" })
        : t("common.toast.saved"),
    );
    navigate(
      { _tag: "Document", ws: workspace.slug, id: finalDoc.id, tab: "preview" },
      { replace: true },
    );
  };

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
  const hasSavedTerms = props.mode === "new" || cachedTemplate?.seed != null;
  const keepSaved = {
    value: "keep" as const,
    label: local({ cs: "Ponechat uložené", en: "Keep saved value" }),
  };
  const canAdmin = workspace.role === "owner" || workspace.role === "admin";
  const selectedContact =
    draft === null ? null : (contacts.find((c) => c.id === draft.contactId) ?? null);
  const currencyBankAccounts =
    draft === null ? [] : matchingBankAccounts(bankAccounts, draft.currency);
  const kindSeries = draft === null ? [] : matchingSeries(seriesList, draft.kind);
  const selectedSeries =
    draft === null ? null : (kindSeries.find((s) => s.id === draft.seriesId) ?? null);

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
              onPress={() => void submit("save")}
            />
            {!isIssued ? (
              <Button
                kind="filled"
                icon={Send}
                label={t("documents.editor.issue")}
                busy={busyMode === "issue"}
                disabled={busyMode !== null}
                testID="editor-issue-button"
                onPress={() => void submit("issue")}
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
            onPress={() => void retryCheckpoint()}
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
              setTemplateLoadAttempt((n) => n + 1);
            },
          }}
        />
      ) : draft === null ? (
        <Loading label={t("common.state.loading")} />
      ) : (
        <View style={styles.root}>
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
                  selectedContact !== null
                    ? [
                        selectedContact.ico ? `IČO ${selectedContact.ico}` : null,
                        selectedContact.dic ? `DIČ ${selectedContact.dic}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || selectedContact.billingEmails.join(", ")
                    : t("documents.editor.contactSearch")
                }
                leading={Users}
                testID="editor-contact-picker"
                {...(isLocked ? {} : { onPress: () => setContactPickerOpen(true) })}
              />
              {validationShown && validation?.contact !== undefined ? (
                <Text variant="bodySmall" color="error">
                  {validation.contact}
                </Text>
              ) : null}
              {issuesAt(serverIssues, ["contact"]).map((iss) => (
                <Text
                  key={`${iss.path.join(".")}-${iss.text.key}`}
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
            {draft.lines.map((line, index) => {
              const lineCalc = preview?.lines[index];
              const lineError = validationShown ? validation?.lines[line.key] : undefined;
              return (
                <Card key={line.key}>
                  <View style={styles.lineHeader}>
                    <Text variant="labelMedium" color="onSurfaceVariant">
                      {`#${index + 1}`}
                    </Text>
                    <View style={styles.lineHeaderActions}>
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

                  <View style={styles.rowFields}>
                    <View style={styles.flex}>
                      <TextField
                        label={t("documents.editor.line.quantity")}
                        value={line.quantity}
                        onChangeText={(value) => updateLine(line.key, { quantity: value })}
                        keyboardType="decimal-pad"
                        disabled={isLocked}
                        testID={`editor-line-qty-${index}`}
                      />
                    </View>
                    <View style={styles.flex}>
                      <TextField
                        label={t("documents.editor.line.unit")}
                        value={line.unit}
                        onChangeText={(value) => updateLine(line.key, { unit: value })}
                        disabled={isLocked}
                      />
                    </View>
                    <View style={styles.flex}>
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
                      choices={VAT_TREATMENTS.map((tr) => ({
                        value: tr,
                        label: t(enumKey("vatTreatment", tr)),
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
                {...(validationShown && validation?.issuedOn !== undefined
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
                  {...(validationShown && validation?.taxableSupplyOn !== undefined
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
                {...(validationShown && validation?.dueOn !== undefined
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
                choices={COMMON_CURRENCIES.map((cur) => ({ value: cur, label: cur }))}
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
                <View style={styles.fxBox}>
                  <SegmentedChoice
                    label={t("documents.editor.fx.title")}
                    value={draft.fxMode}
                    choices={[
                      { value: "cnb", label: t(enumKey("fxSource", "cnb")) },
                      { value: "manual", label: t("documents.editor.fx.manual") },
                    ]}
                    onChange={(mode) => {
                      if (!isLocked) setDraft({ ...draft, fxMode: mode });
                    }}
                  />
                  {draft.fxMode === "cnb" ? (
                    fxLoading ? (
                      <Text variant="meta" color="onSurfaceVariant">
                        {t("documents.editor.fx.loading")}
                      </Text>
                    ) : cnbFx !== null ? (
                      <Text variant="meta" color="onSurfaceVariant" numeric>
                        {t("documents.editor.fx.cnb", {
                          rate: BigDecimal.format(cnbFx.rate),
                          quantity: cnbFx.quantity,
                          currency: draft.currency,
                          date: formatDate(locale, cnbFx.fixingDate),
                        })}
                      </Text>
                    ) : fxUnavailable ? (
                      <Banner tone="warning" text={t("documents.editor.fx.unavailable")} />
                    ) : null
                  ) : (
                    <View style={styles.rowFields}>
                      <View style={styles.flex}>
                        <TextField
                          label={t("documents.editor.fx.rate")}
                          value={draft.manualFxRate}
                          onChangeText={(value) => setDraft({ ...draft, manualFxRate: value })}
                          keyboardType="decimal-pad"
                          disabled={isLocked}
                          testID="editor-fx-rate"
                        />
                      </View>
                      <View style={styles.flex}>
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
                  {validationShown && validation?.fx !== undefined ? (
                    <Text variant="bodySmall" color="error">
                      {validation.fx}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <SegmentedChoice
                label={t("documents.editor.paymentMethod")}
                value={draft.paymentMethod}
                choices={PAYMENT_METHODS.map((m) => ({
                  value: m,
                  label: t(enumKey("paymentMethod", m)),
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
                  choices={currencyBankAccounts.map((b) => ({
                    value: b.id,
                    label: b.name ? `${b.name} (${b.iban})` : b.iban,
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
                      ...kindSeries.map((s) => ({ value: s.id, label: s.name })),
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
                  { value: "cs", label: t(enumKey("locale", "cs")) },
                  { value: "en", label: t(enumKey("locale", "en")) },
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
                        : draft.pricesIncludeVat
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

              <View style={styles.rowFields}>
                <View style={styles.flex}>
                  <TextField
                    label={t("documents.editor.variableSymbol")}
                    value={draft.variableSymbol}
                    onChangeText={(value) => setDraft({ ...draft, variableSymbol: value })}
                    disabled={isLocked}
                  />
                </View>
                <View style={styles.flex}>
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
                {preview.breakdown.buckets.map((bucket) => (
                  <View
                    key={`${bucket.treatment}-${String(bucket.ratePercent)}`}
                    style={styles.totalRow}
                  >
                    <Text variant="bodyMedium" style={styles.flex}>
                      {`${t(enumKey("vatTreatment", bucket.treatment))} (${formatVatRate(locale, Number(BigDecimal.format(bucket.ratePercent)))})`}
                    </Text>
                    <View style={styles.amountCol}>
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
                            MoneyMath.make(bucket.vatCzk, "CZK" as CurrencyCode),
                          )}`}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
                <View style={styles.totalRow}>
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("documents.editor.totals.base")}
                  </Text>
                  <Text variant="bodyMedium" numeric>
                    {formatMoney(locale, preview.breakdown.net)}
                  </Text>
                </View>
                <View style={styles.totalRow}>
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("common.field.vat")}
                  </Text>
                  <Text variant="bodyMedium" numeric>
                    {formatMoney(locale, preview.breakdown.vat)}
                  </Text>
                </View>
                <View style={styles.totalRow}>
                  <Text variant="titleMedium">{t("documents.editor.totals.total")}</Text>
                  <Text variant="titleMedium" numeric testID="editor-preview-total">
                    {formatMoney(locale, preview.breakdown.gross)}
                  </Text>
                </View>
                {preview.breakdown.vatCzk !== null ? (
                  <View style={styles.totalRow}>
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
              c.name.toLowerCase().includes(q) ||
              (c.ico ?? "").toLowerCase().includes(q) ||
              (c.dic ?? "").toLowerCase().includes(q)
            }
            renderItem={(c, select) => (
              <ListRow
                title={c.name}
                subtitle={[c.ico ? `IČO ${c.ico}` : null, c.dic ? `DIČ ${c.dic}` : null]
                  .filter(Boolean)
                  .join(" · ")}
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
              item.name.toLowerCase().includes(q) ||
              (item.description ?? "").toLowerCase().includes(q)
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
    (api) =>
      api.documents.list({
        params: { workspaceId: workspace.id },
        query: { status: "issued", limit: 100 },
      }),
    [workspace.id],
  );

  const [selectedDocId, setSelectedDocId] = useState<DocumentId | null>(null);
  const [reason, setReason] = useState("");
  const [correctedOn, setCorrectedOn] = useState<string>(() => todayIsoPrague());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDocRemote = useRemote(
    selectedDocId === null
      ? null
      : (api) =>
          api.documents.get({
            params: { workspaceId: workspace.id, documentId: selectedDocId },
          }),
    [workspace.id, selectedDocId],
  );

  const submit = async () => {
    if (selectedDocId === null) {
      setError(local({ cs: "Vyberte původní doklad.", en: "Select the original document." }));
      return;
    }
    if (reason.trim() === "") {
      setError(local({ cs: "Zadejte důvod opravy.", en: "Enter a correction reason." }));
      return;
    }
    if (correctedOn.trim() !== "" && parseIsoDate(correctedOn) === undefined) {
      setError(local({ cs: "Použijte formát RRRR-MM-DD.", en: "Use YYYY-MM-DD format." }));
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      reason: reason.trim(),
      lines: "full" as const,
      ...(correctedOn.trim() !== "" ? { correctedOn: correctedOn as IsoDate } : {}),
    };
    const res = await runMutation(`documents.correct:${selectedDocId}`, payload, (api, key) =>
      api.documents.correct({
        params: { workspaceId: workspace.id, documentId: selectedDocId },
        headers: idempotencyHeaders(key),
        payload,
      }),
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
  };

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
          onPress={() => void submit()}
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
            const eligible = page.items
              .map(parseDocumentSummary)
              .filter((d) => d.kind === "invoice" || d.kind === "payment_tax_document");
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
              <Card style={styles.listCard}>
                {eligible.map((doc) => (
                  <ListRow
                    key={doc.id}
                    testID={`credit-source-${doc.id}`}
                    title={doc.number ?? doc.id}
                    subtitle={`${doc.contact.name} · ${formatDate(locale, doc.issuedOn)}`}
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
          <Card style={styles.listCard}>
            {selectedDocRemote.state.value.lines.map((raw) => {
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
                        : ("CZK" as CurrencyCode),
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

const styles = StyleSheet.create({
  root: { gap: space.lg },
  flex: { flex: 1 },
  rowFields: { flexDirection: "row", gap: space.sm },
  lineHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  lineHeaderActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  fxBox: { gap: space.sm },
  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  amountCol: { alignItems: "flex-end", gap: 2 },
  listCard: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  scrim: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  pickerDialog: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "84%",
    padding: space.xl,
    gap: space.md,
  },
  pickerScroll: { maxHeight: 360 },
  pickerFooter: { flexDirection: "row", justifyContent: "flex-end" },
});
