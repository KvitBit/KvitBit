/**
 * Document detail screen (`app/w/[ws]/documents/[id]/index.tsx`): summary, parties, lines,
 * VAT breakdown & CZK conversion, chain links, payments (record/remove), lifecycle actions,
 * email delivery, public share link, PDF download/share via `useTransfer()`, and audit history.
 */
import type {
  DocumentId,
  DocumentView,
  Locale,
  PaymentId,
  PdfTemplate,
} from "@kvitbit/domain/contract";
import { MoneyMath } from "@kvitbit/domain/contract";
import { describeError, idempotencyHeaders, ifMatchHeaders } from "@kvitbit/ui-port/api";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatVatRate,
} from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import type { DocumentDialog } from "@kvitbit/ui-port/view-models";
import { BigDecimal } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import {
  Ban,
  Copy,
  CreditCard,
  Download,
  Edit3,
  FileCheck2,
  FileMinus2,
  Link2,
  Lock,
  Mail,
  Send,
  Share2,
  Trash2,
  Unlock,
} from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Share, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate, param } from "../../navigation/routes";
import { useTransfer } from "../../platform/transfer";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  Banner,
  Button,
  Card,
  type Choice,
  EmptyState,
  ListRow,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  Text,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  deliveryStatusTone,
  documentActions,
  documentStatusBadge,
  kindBadge,
  settlementBadge,
} from "./badges";
import { copyText } from "./clipboard";
import {
  formatAddress,
  parseContactSnapshot,
  parseIssuerSnapshot,
  parseLineView,
  parsePaymentView,
} from "./codecs";
import {
  CancelDocumentModal,
  type CreditNoteFormValues,
  CreditNoteModal,
  type RecordPaymentFormValues,
  RecordPaymentModal,
  RemovePaymentModal,
  type SendEmailFormValues,
  SendEmailModal,
  UnlockDocumentModal,
} from "./modals";
import {
  requestErrorText,
  usePaymentMutation,
  useRequestMutation,
  useRequestOwner,
} from "./request-mutation";
import { recordImportedDraftWrite } from "./template-import";

type DetailTab = "preview" | "payments" | "share" | "history";

const parseTab = (value: string | undefined): DetailTab =>
  value === "payments" || value === "share" || value === "history" ? value : "preview";

const parseDialog = (value: string | undefined): DocumentDialog | null =>
  value === "issue" ||
  value === "payment" ||
  value === "send" ||
  value === "cancel" ||
  value === "correct"
    ? value
    : null;

export function DocumentDetailScreen() {
  const { workspace } = useWorkspace();
  const { t, locale, local, text: resolveText } = useI18n();
  const { run } = useApi();
  const requestOwner = useRequestOwner(workspace.id);
  const runMutation = useRequestMutation(workspace.id);
  const runPayment = usePaymentMutation(workspace.id);
  const transfer = useTransfer();
  const overlay = useOverlay();
  const params = useLocalSearchParams<{
    id?: string | string[];
    tab?: string | string[];
    dialog?: string | string[];
  }>();

  const documentId = (param(params.id) ?? "") as DocumentId;
  const [tab, setTab] = useState<DetailTab>(() => parseTab(param(params.tab)));
  const [activeDialog, setActiveDialog] = useState<DocumentDialog | "unlock" | null>(() =>
    parseDialog(param(params.dialog)),
  );
  const [removingPayment, setRemovingPayment] = useState<{
    readonly id: PaymentId;
    readonly hasTaxDocument: boolean;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pdfTemplate, setPdfTemplate] = useState<PdfTemplate>("classic");
  const [pdfLanguage, setPdfLanguage] = useState<Locale>(locale);

  const docRemote = useRemote(
    documentId === ""
      ? null
      : (api) =>
          api.documents.get({
            params: { workspaceId: workspace.id, documentId },
          }),
    [workspace.id, documentId],
  );

  const paymentsRemote = useRemote(
    documentId === ""
      ? null
      : (api) =>
          api.payments.listForDocument({
            params: { workspaceId: workspace.id, documentId },
          }),
    [workspace.id, documentId],
  );

  const historyRemote = useRemote(
    documentId === "" || tab !== "history"
      ? null
      : (api) =>
          api.documents.history({
            params: { workspaceId: workspace.id, documentId },
          }),
    [workspace.id, documentId, tab],
  );

  const shareViewsRemote = useRemote(
    documentId === "" || tab !== "share"
      ? null
      : (api) =>
          api.shareLinks.views({
            params: { workspaceId: workspace.id, documentId },
            query: { limit: 50 },
          }),
    [workspace.id, documentId, tab],
  );

  const reloadAll = useCallback(() => {
    docRemote.reload();
    paymentsRemote.reload();
    if (tab === "history") historyRemote.reload();
    if (tab === "share") shareViewsRemote.reload();
  }, [docRemote, paymentsRemote, historyRemote, shareViewsRemote, tab]);

  const tabChoices: ReadonlyArray<Choice<DetailTab>> = useMemo(
    () => [
      { value: "preview", label: t("documents.detail.tab.overview") },
      { value: "payments", label: t("documents.detail.tab.payments") },
      { value: "share", label: t("documents.share.title") },
      { value: "history", label: t("documents.detail.tab.history") },
    ],
    [t],
  );

  const reportError = useCallback(
    (message: string) => {
      setActionError(message);
      overlay.toast(message);
    },
    [overlay],
  );

  const handleIssue = async (doc: DocumentView) => {
    const confirmed = await overlay.confirm({
      title: t("documents.issue.title", { kind: t(enumKey("documentKind", doc.kind)) }),
      body: t("documents.issue.irreversible"),
      confirmLabel: t("documents.issue.confirm"),
      cancelLabel: t("common.action.cancel"),
    });
    if (!confirmed) return;
    setBusyAction("issue");
    setActionError(null);
    const result = await runMutation(
      `documents.issueDraft:${doc.id}`,
      { revision: doc.revision },
      (api, key) =>
        api.documents.issueDraft({
          params: { workspaceId: workspace.id, documentId: doc.id },
          headers: { ...ifMatchHeaders(doc.revision), ...idempotencyHeaders(key) },
          payload: {},
        }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    docRemote.set(result.value);
    if (requestOwner !== null) {
      try {
        await recordImportedDraftWrite(
          requestOwner,
          doc.id,
          null,
          doc.revision,
          result.value.revision,
        );
      } catch {
        reportError(
          local({
            cs: "Doklad byl vystaven, ale nastavení šablony se na tomto zařízení nepodařilo uložit.",
            en: "The document was issued, but its template settings could not be saved on this device.",
          }),
        );
        return;
      }
    }
    overlay.toast(t("documents.issue.done", { number: result.value.number ?? "" }));
  };

  const handleDiscard = async (doc: DocumentView) => {
    const confirmed = await overlay.confirm({
      title: t("documents.list.deleteDraft.title"),
      body: t("documents.list.deleteDraft.body"),
      confirmLabel: t("documents.list.deleteDraft.confirm"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusyAction("discard");
    setActionError(null);
    const result = await run((api) =>
      api.documents.discardDraft({
        params: { workspaceId: workspace.id, documentId: doc.id },
        headers: ifMatchHeaders(doc.revision),
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    overlay.toast(t("common.toast.deleted"));
    navigate({ _tag: "Documents", ws: workspace.slug, query: {} }, { replace: true });
  };

  const handleLock = async (doc: DocumentView) => {
    const confirmed = await overlay.confirm({
      title: t("documents.detail.lock"),
      body: t("documents.editor.locked"),
      confirmLabel: t("documents.detail.lock"),
      cancelLabel: t("common.action.cancel"),
    });
    if (!confirmed) return;
    setBusyAction("lock");
    setActionError(null);
    const result = await run((api) =>
      api.documents.lock({
        params: { workspaceId: workspace.id, documentId: doc.id },
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    docRemote.set(result.value);
    overlay.toast(t("documents.detail.locked"));
  };

  const handleUnlock = async (doc: DocumentView, reason: string) => {
    setBusyAction("unlock");
    setActionError(null);
    const result = await run((api) =>
      api.documents.unlock({
        params: { workspaceId: workspace.id, documentId: doc.id },
        payload: { reason },
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    setActiveDialog(null);
    docRemote.set(result.value);
    overlay.toast(t("documents.detail.unlock"));
  };

  const handleCancel = async (
    doc: DocumentView,
    values: { readonly reason: string; readonly on?: DocumentView["dates"]["issuedOn"] },
  ) => {
    setBusyAction("cancel");
    setActionError(null);
    const payload = {
      reason: values.reason,
      ...(values.on !== undefined ? { on: values.on } : {}),
    };
    const result = await runMutation(`documents.cancel:${doc.id}`, payload, (api, key) =>
      api.documents.cancel({
        params: { workspaceId: workspace.id, documentId: doc.id },
        headers: idempotencyHeaders(key),
        payload,
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    setActiveDialog(null);
    docRemote.set(result.value.document);
    overlay.toast(t("documents.cancel.done"));
    if (result.value.creditNote !== null) {
      navigate({
        _tag: "Document",
        ws: workspace.slug,
        id: result.value.creditNote.id,
        tab: "preview",
      });
    }
  };

  const handleIssueFinalInvoice = async (doc: DocumentView) => {
    const confirmed = await overlay.confirm({
      title: t("documents.settlement.issueFinal"),
      body: t("documents.settlement.deductionPreview", {
        amount: formatMoney(locale, doc.totals.gross),
      }),
      confirmLabel: t("documents.settlement.issueFinal"),
      cancelLabel: t("common.action.cancel"),
    });
    if (!confirmed) return;
    setBusyAction("final");
    setActionError(null);
    const payload = {};
    const result = await runMutation(`documents.issueFinalInvoice:${doc.id}`, payload, (api, key) =>
      api.documents.issueFinalInvoice({
        params: { workspaceId: workspace.id, documentId: doc.id },
        headers: idempotencyHeaders(key),
        payload,
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    docRemote.reload();
    overlay.toast(t("documents.settlement.finalIssued", { number: result.value.number ?? "" }));
    navigate({
      _tag: "Document",
      ws: workspace.slug,
      id: result.value.id,
      tab: "preview",
    });
  };

  const handleCreateCreditNote = async (doc: DocumentView, values: CreditNoteFormValues) => {
    setBusyAction("creditNote");
    setActionError(null);
    const payload = {
      reason: values.reason,
      lines: values.lines === "full" ? ("full" as const) : [...values.lines],
      ...(values.correctedOn !== undefined ? { correctedOn: values.correctedOn } : {}),
    };
    const result = await runMutation(`documents.correct:${doc.id}`, payload, (api, key) =>
      api.documents.correct({
        params: { workspaceId: workspace.id, documentId: doc.id },
        headers: idempotencyHeaders(key),
        payload,
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    setActiveDialog(null);
    docRemote.reload();
    overlay.toast(t("documents.creditNote.issued", { number: result.value.number ?? "" }));
    navigate({
      _tag: "Document",
      ws: workspace.slug,
      id: result.value.id,
      tab: "preview",
    });
  };

  const handleRecordPayment = async (doc: DocumentView, values: RecordPaymentFormValues) => {
    setBusyAction("payment");
    setActionError(null);
    const payload = {
      target: { document: doc.id },
      amount: MoneyMath.make(values.amount, doc.totals.gross.currency),
      paidOn: values.paidOn,
      method: values.method,
      ...(values.note !== "" ? { note: values.note } : {}),
    };
    const result = await runPayment(`payments.record:document:${doc.id}`, payload, (api, key) =>
      api.payments.record({
        params: { workspaceId: workspace.id },
        headers: idempotencyHeaders(key),
        payload,
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    setActiveDialog(null);
    docRemote.reload();
    paymentsRemote.reload();
    const issuedPtd = result.value.issued[0];
    overlay.toast(
      issuedPtd !== undefined
        ? `${t("documents.payment.recorded")} · ${issuedPtd.number ?? ""}`
        : t("documents.payment.recorded"),
    );
  };

  const handleRemovePayment = async (paymentId: PaymentId, reason: string) => {
    setBusyAction("removePayment");
    setActionError(null);
    const result = await run((api) =>
      api.payments.remove({
        params: { workspaceId: workspace.id, paymentId },
        payload: { reason },
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    setRemovingPayment(null);
    docRemote.reload();
    paymentsRemote.reload();
    overlay.toast(t("common.toast.deleted"));
  };

  const handleSendEmail = async (doc: DocumentView, values: SendEmailFormValues) => {
    setBusyAction("send");
    setActionError(null);
    const payload = {
      to: [...values.to],
      language: values.language,
      purpose: values.purpose,
      ...(values.purpose === "document" ? { reminders: values.reminders } : {}),
    };
    const result = await runMutation(`documents.send:${doc.id}`, payload, (api, key) =>
      api.documents.send({
        params: { workspaceId: workspace.id, documentId: doc.id },
        headers: idempotencyHeaders(key),
        payload,
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    setActiveDialog(null);
    docRemote.reload();
    overlay.toast(t("documents.send.sent", { email: values.to.join(", ") }));
  };

  const handleCreateShareLink = async (doc: DocumentView) => {
    setBusyAction("shareCreate");
    setActionError(null);
    const result = await run((api) =>
      api.shareLinks.create({
        params: { workspaceId: workspace.id, documentId: doc.id },
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    docRemote.reload();
    await copyText(result.value.url);
    overlay.toast(t("common.toast.linkCopied"));
  };

  const handleRevokeShareLink = async (doc: DocumentView) => {
    const confirmed = await overlay.confirm({
      title: t("documents.share.revokeTitle"),
      body: t("documents.share.revokeBody"),
      confirmLabel: t("documents.share.revoke"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusyAction("shareRevoke");
    setActionError(null);
    const result = await run((api) =>
      api.shareLinks.revoke({
        params: { workspaceId: workspace.id, documentId: doc.id },
      }),
    );
    setBusyAction(null);
    if (result._tag === "Err") {
      reportError(requestErrorText(result.error, { local, text: resolveText }));
      return;
    }
    docRemote.reload();
    overlay.toast(t("common.action.revoke"));
  };

  const handleCopyShareLink = async (url: string) => {
    const copied = await copyText(url);
    overlay.toast(
      copied
        ? t("common.toast.linkCopied")
        : local({ cs: "Odkaz se nepodařilo zkopírovat.", en: "Could not copy link." }),
    );
  };

  const handleShareLinkSheet = async (url: string, numberLabel: string) => {
    try {
      await Share.share({ message: url, url, title: numberLabel });
    } catch {
      await handleCopyShareLink(url);
    }
  };

  const handlePdf = async (doc: DocumentView, mode: "open" | "share") => {
    setBusyAction(`pdf-${mode}`);
    setActionError(null);
    const filename = `${(doc.number ?? "draft").replace(/[^a-zA-Z0-9._-]+/g, "_")}.pdf`;
    const downloaded = await transfer.download({
      path: `/workspaces/${workspace.id}/documents/${doc.id}/pdf`,
      query: {
        template: pdfTemplate,
        language: pdfLanguage,
        disposition: mode === "open" ? "inline" : "attachment",
      },
      filename,
      contentType: "application/pdf",
    });
    if (downloaded._tag === "Err") {
      setBusyAction(null);
      reportError(resolveText(describeError(downloaded.error).text));
      return;
    }
    const delivered =
      mode === "open"
        ? await transfer.open(downloaded.value)
        : await transfer.share(downloaded.value);
    setBusyAction(null);
    if (delivered._tag === "Err") {
      reportError(resolveText(describeError(delivered.error).text));
      return;
    }
    overlay.toast(
      mode === "open" ? t("documents.detail.actions.downloadPdf") : t("common.action.share"),
    );
  };

  return (
    <Screen
      title={
        docRemote.state._tag === "Ready"
          ? (docRemote.state.value.number ?? t("documents.list.draftNumber"))
          : t("documents.list.title")
      }
      back={() =>
        router.canGoBack()
          ? router.back()
          : navigate({ _tag: "Documents", ws: workspace.slug, query: {} }, { replace: true })
      }
      onRefresh={reloadAll}
      refreshing={docRemote.state._tag === "Loading"}
    >
      {actionError !== null ? <Banner text={actionError} /> : null}
      <RemoteView state={docRemote.state} onRetry={docRemote.reload}>
        {(doc) => {
          const actions = documentActions(doc, workspace.role);
          const contact = parseContactSnapshot(doc.contact);
          const issuer = parseIssuerSnapshot(doc.issuer);
          const lines = doc.lines.map(parseLineView);
          const numberLabel = doc.number ?? t("documents.list.draftNumber");
          const statusB = documentStatusBadge(doc.status, t);
          const settleB = settlementBadge(doc.settlement, doc.overdue, t);
          const kindB = kindBadge(doc.kind, t);
          const payments =
            paymentsRemote.state._tag === "Ready"
              ? paymentsRemote.state.value.map(parsePaymentView)
              : [];
          const currency = doc.totals.gross.currency;
          const paidTotal = BigDecimal.sumAll(
            payments.filter((p) => p.amount.currency === currency).map((p) => p.amount.amount),
          );
          const remainingAmount = BigDecimal.subtract(doc.totals.gross.amount, paidTotal);
          const defaultPaymentAmount = BigDecimal.isGreaterThan(
            remainingAmount,
            BigDecimal.fromBigInt(0n),
          )
            ? remainingAmount
            : doc.totals.gross.amount;

          return (
            <View className="gap-4">
              {/* Summary header */}
              <Card>
                <View className="flex-row items-start gap-3">
                  <View className="flex-1">
                    <Text variant="titleMedium">{numberLabel}</Text>
                    <Text variant="meta" color="onSurfaceVariant">
                      {contact.name}
                    </Text>
                  </View>
                  <View className="items-end gap-0.5">
                    <Text variant="titleLarge" numeric>
                      {formatMoney(locale, doc.totals.gross)}
                    </Text>
                    {doc.totals.vatCzk !== null ? (
                      <Text variant="meta" color="onSurfaceVariant" numeric>
                        {`${t("common.field.vat")} ${formatMoney(locale, doc.totals.vatCzk)}`}
                      </Text>
                    ) : null}
                  </View>
                </View>

                <View className="flex-row flex-wrap gap-1">
                  <Badge label={kindB.label} tone={kindB.tone} />
                  <Badge label={statusB.label} tone={statusB.tone} />
                  {doc.status === "issued" ? (
                    <Badge label={settleB.label} tone={settleB.tone} />
                  ) : null}
                  {doc.locked ? <Badge label={t("enum.badge.locked")} tone="neutral" /> : null}
                </View>

                <View className="gap-1">
                  <Text variant="meta" color="onSurfaceVariant" numeric>
                    {`${t("documents.editor.issueDate")}: ${formatDate(locale, doc.dates.issuedOn)}`}
                  </Text>
                  {doc.dates.taxableSupplyOn !== null ? (
                    <Text variant="meta" color="onSurfaceVariant" numeric>
                      {`${t("documents.editor.taxableSupplyDate")}: ${formatDate(locale, doc.dates.taxableSupplyOn)}`}
                    </Text>
                  ) : null}
                  <Text variant="meta" color="onSurfaceVariant" numeric>
                    {`${t("documents.editor.dueDate")}: ${formatDate(locale, doc.dates.dueOn)}`}
                  </Text>
                  <Text variant="meta" color="onSurfaceVariant">
                    {`${t("documents.editor.paymentMethod")}: ${t(enumKey("paymentMethod", doc.paymentMethod))}`}
                  </Text>
                  {doc.fx !== null ? (
                    <Text variant="meta" color="onSurfaceVariant" numeric>
                      {`${t(enumKey("fxSource", doc.fx.source))}: ${doc.fx.quantity} ${currency} = ${BigDecimal.format(doc.fx.rate)} CZK${
                        doc.fx.fixingDate !== null
                          ? ` (${formatDate(locale, doc.fx.fixingDate)})`
                          : ""
                      }`}
                    </Text>
                  ) : null}
                </View>
              </Card>

              {doc.locked ? <Banner tone="info" text={t("documents.editor.locked")} /> : null}

              {/* Tabs */}
              <SegmentedChoice value={tab} choices={tabChoices} onChange={setTab} />

              {/* OVERVIEW TAB */}
              {tab === "preview" ? (
                <View className="gap-4">
                  {/* Lifecycle Actions */}
                  <Section title={local({ cs: "Akce", en: "Actions" })}>
                    <Card>
                      <View className="flex-row flex-wrap gap-2">
                        {actions.canIssue ? (
                          <Button
                            kind="filled"
                            icon={Send}
                            label={t("documents.detail.actions.issue")}
                            busy={busyAction === "issue"}
                            testID="detail-action-issue"
                            onPress={() => void handleIssue(doc)}
                          />
                        ) : null}
                        {actions.canEdit ? (
                          <Button
                            kind="tonal"
                            icon={Edit3}
                            label={t("documents.detail.actions.edit")}
                            testID="detail-action-edit"
                            onPress={() =>
                              navigate({ _tag: "DocumentEdit", ws: workspace.slug, id: doc.id })
                            }
                          />
                        ) : null}
                        {actions.canRecordPayment ? (
                          <Button
                            kind="filled"
                            icon={CreditCard}
                            label={t("documents.detail.actions.recordPayment")}
                            testID="detail-action-payment"
                            onPress={() => setActiveDialog("payment")}
                          />
                        ) : null}
                        {actions.canSendEmail ? (
                          <Button
                            kind="tonal"
                            icon={Mail}
                            label={t("documents.detail.actions.send")}
                            testID="detail-action-send"
                            onPress={() => setActiveDialog("send")}
                          />
                        ) : null}
                        {actions.canIssueFinalInvoice ? (
                          <Button
                            kind="tonal"
                            icon={FileCheck2}
                            label={t("documents.detail.actions.finalInvoice")}
                            busy={busyAction === "final"}
                            testID="detail-action-final"
                            onPress={() => void handleIssueFinalInvoice(doc)}
                          />
                        ) : null}
                        {actions.canCreateCreditNote ? (
                          <Button
                            kind="outlined"
                            icon={FileMinus2}
                            label={t("documents.detail.actions.creditNote")}
                            testID="detail-action-credit-note"
                            onPress={() => setActiveDialog("correct")}
                          />
                        ) : null}
                        {actions.canLock ? (
                          <Button
                            kind="outlined"
                            icon={Lock}
                            label={t("documents.detail.lock")}
                            busy={busyAction === "lock"}
                            testID="detail-action-lock"
                            onPress={() => void handleLock(doc)}
                          />
                        ) : null}
                        {actions.canUnlock ? (
                          <Button
                            kind="outlined"
                            icon={Unlock}
                            label={t("documents.detail.unlock")}
                            testID="detail-action-unlock"
                            onPress={() => setActiveDialog("unlock")}
                          />
                        ) : null}
                        {actions.canDuplicate ? (
                          <Button
                            kind="outlined"
                            icon={Copy}
                            label={t("documents.detail.actions.duplicate")}
                            testID="detail-action-duplicate"
                            onPress={() =>
                              navigate({
                                _tag: "DocumentNew",
                                ws: workspace.slug,
                                kind: doc.kind === "proforma" ? "proforma" : "invoice",
                                from: { _tag: "Duplicate", id: doc.id },
                              })
                            }
                          />
                        ) : null}
                        {actions.canCancel ? (
                          <Button
                            kind="danger"
                            icon={Ban}
                            label={t("documents.detail.actions.cancel")}
                            testID="detail-action-cancel"
                            onPress={() => setActiveDialog("cancel")}
                          />
                        ) : null}
                        {actions.canDiscard ? (
                          <Button
                            kind="danger"
                            icon={Trash2}
                            label={t("documents.editor.discard")}
                            busy={busyAction === "discard"}
                            testID="detail-action-discard"
                            onPress={() => void handleDiscard(doc)}
                          />
                        ) : null}
                      </View>
                    </Card>
                  </Section>

                  {/* PDF download / share */}
                  <Section title={t("documents.detail.tab.pdf")}>
                    <Card>
                      <SegmentedChoice
                        label={t("shared.pdfPreview.template")}
                        value={pdfTemplate}
                        choices={[
                          { value: "classic", label: t(enumKey("pdfTemplate", "classic")) },
                          {
                            value: "modern_minimal",
                            label: t(enumKey("pdfTemplate", "modern_minimal")),
                          },
                        ]}
                        onChange={setPdfTemplate}
                      />
                      <SegmentedChoice
                        label={t("shared.pdfPreview.language")}
                        value={pdfLanguage}
                        choices={[
                          { value: "cs", label: t(enumKey("locale", "cs")) },
                          { value: "en", label: t(enumKey("locale", "en")) },
                        ]}
                        onChange={setPdfLanguage}
                      />
                      <View className="flex-row flex-wrap gap-2">
                        <Button
                          kind="tonal"
                          icon={Download}
                          label={t("documents.detail.actions.downloadPdf")}
                          busy={busyAction === "pdf-open"}
                          testID="detail-pdf-download"
                          onPress={() => void handlePdf(doc, "open")}
                        />
                        <Button
                          kind="outlined"
                          icon={Share2}
                          label={t("common.action.share")}
                          busy={busyAction === "pdf-share"}
                          testID="detail-pdf-share"
                          onPress={() => void handlePdf(doc, "share")}
                        />
                      </View>
                    </Card>
                  </Section>

                  {/* Parties */}
                  <Section title={t("documents.editor.section.parties")}>
                    <Card>
                      <Text variant="labelMedium" color="onSurfaceVariant">
                        {local({ cs: "Dodavatel", en: "Issuer" })}
                      </Text>
                      <Text variant="titleSmall">{issuer.name}</Text>
                      {formatAddress(issuer.address) !== "" ? (
                        <Text variant="meta" color="onSurfaceVariant">
                          {formatAddress(issuer.address)}
                        </Text>
                      ) : null}
                      {issuer.ico !== null || issuer.dic !== null ? (
                        <Text variant="meta" color="onSurfaceVariant" numeric>
                          {[
                            issuer.ico !== null ? `IČO ${issuer.ico}` : null,
                            issuer.dic !== null ? `DIČ ${issuer.dic}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      ) : null}
                      {issuer.bankAccount !== null ? (
                        <Text variant="meta" color="onSurfaceVariant" numeric>
                          {`${t("documents.editor.bankAccount")}: ${issuer.bankAccount.iban ?? issuer.bankAccount.accountNumber ?? ""}`}
                        </Text>
                      ) : null}

                      <View className="h-2" />

                      <Text variant="labelMedium" color="onSurfaceVariant">
                        {t("documents.editor.contact")}
                      </Text>
                      <Text variant="titleSmall">{contact.name}</Text>
                      {formatAddress(contact.address) !== "" ? (
                        <Text variant="meta" color="onSurfaceVariant">
                          {formatAddress(contact.address)}
                        </Text>
                      ) : null}
                      {contact.ico !== null || contact.dic !== null ? (
                        <Text variant="meta" color="onSurfaceVariant" numeric>
                          {[
                            contact.ico !== null ? `IČO ${contact.ico}` : null,
                            contact.dic !== null ? `DIČ ${contact.dic}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      ) : null}
                      {contact.billingEmails.length > 0 ? (
                        <Text variant="meta" color="onSurfaceVariant">
                          {contact.billingEmails.join(", ")}
                        </Text>
                      ) : null}
                    </Card>
                  </Section>

                  {/* Line items */}
                  <Section title={t("documents.editor.section.lines")}>
                    <Card className="px-2 py-1">
                      {lines.map((line) => (
                        <ListRow
                          key={line.id}
                          title={line.description}
                          subtitle={`${formatQuantity(locale, line.quantity)}${line.unit ? ` ${line.unit}` : ""} × ${formatMoney(
                            locale,
                            MoneyMath.make(line.unitPrice, currency),
                          )} · ${t("common.field.vat")} ${formatVatRate(locale, Number(BigDecimal.format(line.ratePercent)))}`}
                          trailing={formatMoney(locale, MoneyMath.make(line.amount, currency))}
                        />
                      ))}
                    </Card>
                  </Section>

                  {/* VAT Breakdown & CZK conversion */}
                  <Section title={t("documents.editor.totals.total")}>
                    <Card>
                      {doc.totals.buckets.map((bucket) => (
                        <View
                          key={`${bucket.treatment}-${String(bucket.ratePercent)}`}
                          className="flex-row items-center justify-between gap-3"
                        >
                          <View className="flex-1">
                            <Text variant="bodyMedium">
                              {`${t(enumKey("vatTreatment", bucket.treatment))} (${formatVatRate(locale, Number(BigDecimal.format(bucket.ratePercent)))})`}
                            </Text>
                            <Text variant="meta" color="onSurfaceVariant" numeric>
                              {`${t("documents.editor.totals.base")}: ${formatMoney(
                                locale,
                                MoneyMath.make(bucket.base, currency),
                              )}`}
                            </Text>
                          </View>
                          <View className="items-end gap-0.5">
                            <Text variant="bodyMedium" numeric>
                              {formatMoney(locale, MoneyMath.make(bucket.vat, currency))}
                            </Text>
                            {bucket.vatCzk !== null ? (
                              <Text variant="meta" color="onSurfaceVariant" numeric>
                                {formatMoney(
                                  locale,
                                  MoneyMath.make(bucket.vatCzk, "CZK" as typeof currency),
                                )}
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      ))}

                      <View className="h-2" />

                      <View className="flex-row items-center justify-between gap-3">
                        <Text variant="bodyMedium" color="onSurfaceVariant">
                          {t("documents.editor.totals.base")}
                        </Text>
                        <Text variant="bodyMedium" numeric>
                          {formatMoney(locale, doc.totals.net)}
                        </Text>
                      </View>
                      <View className="flex-row items-center justify-between gap-3">
                        <Text variant="bodyMedium" color="onSurfaceVariant">
                          {t("common.field.vat")}
                        </Text>
                        <Text variant="bodyMedium" numeric>
                          {formatMoney(locale, doc.totals.vat)}
                        </Text>
                      </View>
                      {!BigDecimal.isZero(doc.totals.roundingAdjustment.amount) ? (
                        <View className="flex-row items-center justify-between gap-3">
                          <Text variant="bodyMedium" color="onSurfaceVariant">
                            {t("documents.editor.totals.rounding")}
                          </Text>
                          <Text variant="bodyMedium" numeric>
                            {formatMoney(locale, doc.totals.roundingAdjustment, { signed: true })}
                          </Text>
                        </View>
                      ) : null}
                      <View className="flex-row items-center justify-between gap-3">
                        <Text variant="titleMedium">{t("documents.editor.totals.total")}</Text>
                        <Text variant="titleMedium" numeric>
                          {formatMoney(locale, doc.totals.gross)}
                        </Text>
                      </View>
                      {doc.totals.vatCzk !== null ? (
                        <View className="flex-row items-center justify-between gap-3">
                          <Text variant="meta" color="onSurfaceVariant">
                            {`${t("common.field.vat")} (CZK)`}
                          </Text>
                          <Text variant="meta" color="onSurfaceVariant" numeric>
                            {formatMoney(locale, doc.totals.vatCzk)}
                          </Text>
                        </View>
                      ) : null}
                      {doc.statutoryNotes.map((note) => (
                        <Text key={note.text} variant="meta" color="onSurfaceVariant">
                          {note.text}
                        </Text>
                      ))}
                    </Card>
                  </Section>

                  {/* Chain links */}
                  {doc.related.length > 0 ? (
                    <Section title={t("documents.detail.related")}>
                      <Card className="px-2 py-1">
                        {doc.related.map((rel) => (
                          <ListRow
                            key={`${rel.relation}-${rel.id}`}
                            testID={`related-doc-${rel.id}`}
                            title={rel.number}
                            subtitle={`${t(enumKey("documentRelation", rel.relation))} · ${t(enumKey("documentKind", rel.kind))}`}
                            onPress={() =>
                              navigate({
                                _tag: "Document",
                                ws: workspace.slug,
                                id: rel.id,
                                tab: "preview",
                              })
                            }
                          />
                        ))}
                      </Card>
                    </Section>
                  ) : null}

                  {/* Deliveries */}
                  {doc.deliveries.length > 0 ? (
                    <Section title={t("documents.detail.deliveries")}>
                      <Card className="px-2 py-1">
                        {doc.deliveries.map((del) => (
                          <ListRow
                            key={del.id}
                            title={t("documents.detail.deliveryTo", { email: del.to.join(", ") })}
                            subtitle={`${t(enumKey("deliveryPurpose", del.purpose))} · ${formatDateTime(locale, del.at)}`}
                            badge={
                              <Badge
                                label={t(enumKey("deliveryStatus", del.status))}
                                tone={deliveryStatusTone(del.status)}
                              />
                            }
                          />
                        ))}
                      </Card>
                    </Section>
                  ) : null}
                </View>
              ) : null}

              {/* PAYMENTS TAB */}
              {tab === "payments" ? (
                <Section
                  title={t("documents.payment.list")}
                  action={
                    actions.canRecordPayment ? (
                      <Button
                        kind="filled"
                        icon={CreditCard}
                        label={t("documents.detail.actions.recordPayment")}
                        testID="payments-tab-record"
                        onPress={() => setActiveDialog("payment")}
                      />
                    ) : null
                  }
                >
                  {doc.kind === "proforma" &&
                  doc.status === "issued" &&
                  doc.settlement === "unpaid" ? (
                    <Banner tone="info" text={t("documents.settlement.notPaidYet")} />
                  ) : null}
                  <RemoteView state={paymentsRemote.state} onRetry={paymentsRemote.reload}>
                    {(rawPayments) => {
                      const list = rawPayments.map(parsePaymentView);
                      if (list.length === 0) {
                        return (
                          <EmptyState
                            title={t("documents.payment.empty")}
                            {...(actions.canRecordPayment
                              ? {
                                  action: {
                                    label: t("documents.detail.actions.recordPayment"),
                                    onPress: () => setActiveDialog("payment"),
                                  },
                                }
                              : {})}
                          />
                        );
                      }
                      return (
                        <Card className="px-2 py-1">
                          {list.map((payment) => (
                            <View key={payment.id} className="gap-1">
                              <ListRow
                                title={formatMoney(locale, payment.amount)}
                                subtitle={`${formatDate(locale, payment.paidOn)} · ${t(enumKey("paymentMethod", payment.method))}${
                                  payment.note ? ` · ${payment.note}` : ""
                                }`}
                                {...(payment.taxDocument !== null
                                  ? {
                                      badge: (
                                        <Badge
                                          label={t(enumKey("documentKind", "payment_tax_document"))}
                                          tone="info"
                                        />
                                      ),
                                      onPress: () =>
                                        navigate({
                                          _tag: "Document",
                                          ws: workspace.slug,
                                          id: payment.taxDocument as DocumentId,
                                          tab: "preview",
                                        }),
                                    }
                                  : {})}
                              />
                              {actions.canRemovePayment ? (
                                <View className="items-end pb-1">
                                  <Button
                                    kind="text"
                                    icon={Trash2}
                                    label={t("common.action.remove")}
                                    testID={`remove-payment-${payment.id}`}
                                    onPress={() =>
                                      setRemovingPayment({
                                        id: payment.id,
                                        hasTaxDocument: payment.taxDocument !== null,
                                      })
                                    }
                                  />
                                </View>
                              ) : null}
                            </View>
                          ))}
                        </Card>
                      );
                    }}
                  </RemoteView>
                </Section>
              ) : null}

              {/* SHARE LINK TAB */}
              {tab === "share" ? (
                <View className="gap-4">
                  <Section title={t("documents.share.title")}>
                    <Card>
                      <Text variant="bodyMedium" color="onSurfaceVariant">
                        {t("documents.share.body")}
                      </Text>
                      {doc.share !== null ? (
                        <>
                          <Text variant="bodyMedium" selectable testID="share-link-url">
                            {doc.share.url}
                          </Text>
                          <Text variant="meta" color="onSurfaceVariant">
                            {doc.share.views > 0
                              ? t("documents.share.views", { count: doc.share.views })
                              : t("documents.share.noViews")}
                            {doc.share.lastViewedAt !== null
                              ? ` · ${t("documents.detail.lastViewed", {
                                  date: formatDateTime(locale, doc.share.lastViewedAt),
                                })}`
                              : ""}
                          </Text>
                          <View className="flex-row flex-wrap gap-2">
                            <Button
                              kind="filled"
                              icon={Copy}
                              label={t("documents.share.copy")}
                              testID="share-link-copy"
                              onPress={() => void handleCopyShareLink(doc.share?.url ?? "")}
                            />
                            <Button
                              kind="tonal"
                              icon={Share2}
                              label={t("documents.share.share")}
                              onPress={() =>
                                void handleShareLinkSheet(doc.share?.url ?? "", numberLabel)
                              }
                            />
                            {actions.canManageShareLink ? (
                              <>
                                <Button
                                  kind="outlined"
                                  icon={Link2}
                                  label={t("documents.share.regenerate")}
                                  busy={busyAction === "shareCreate"}
                                  onPress={() => void handleCreateShareLink(doc)}
                                />
                                <Button
                                  kind="danger"
                                  label={t("documents.share.revoke")}
                                  busy={busyAction === "shareRevoke"}
                                  testID="share-link-revoke"
                                  onPress={() => void handleRevokeShareLink(doc)}
                                />
                              </>
                            ) : null}
                          </View>
                        </>
                      ) : actions.canManageShareLink ? (
                        <Button
                          kind="filled"
                          icon={Link2}
                          label={t("documents.share.create")}
                          busy={busyAction === "shareCreate"}
                          testID="share-link-create"
                          onPress={() => void handleCreateShareLink(doc)}
                        />
                      ) : (
                        <Text variant="meta" color="onSurfaceVariant">
                          {local({
                            cs: "Odkaz pro sdílení je k dispozici po vystavení dokladu.",
                            en: "Share links are available once the document is issued.",
                          })}
                        </Text>
                      )}
                    </Card>
                  </Section>

                  {doc.share !== null ? (
                    <Section title={t("documents.share.views", { count: doc.share.views })}>
                      <RemoteView state={shareViewsRemote.state} onRetry={shareViewsRemote.reload}>
                        {(viewsPage) =>
                          viewsPage.items.length === 0 ? (
                            <EmptyState title={t("documents.share.noViews")} />
                          ) : (
                            <Card className="px-2 py-1">
                              {viewsPage.items.map((ev) => (
                                <ListRow
                                  key={ev.id}
                                  title={t(enumKey("shareEvent", ev.kind))}
                                  subtitle={`${t(enumKey("device", ev.device))} · ${formatDateTime(locale, ev.at)}`}
                                />
                              ))}
                            </Card>
                          )
                        }
                      </RemoteView>
                    </Section>
                  ) : null}
                </View>
              ) : null}

              {/* HISTORY TAB */}
              {tab === "history" ? (
                <Section title={t("documents.history.title")}>
                  <RemoteView state={historyRemote.state} onRetry={historyRemote.reload}>
                    {(entries) =>
                      entries.length === 0 ? (
                        <EmptyState title={t("documents.history.empty")} />
                      ) : (
                        <Card className="px-2 py-1">
                          {entries.map((entry) => {
                            const actorText =
                              entry.actor._tag === "System"
                                ? t("documents.history.bySystem")
                                : entry.actor.client !== null
                                  ? t("documents.history.via", {
                                      name: entry.actor.userId,
                                      client: entry.actor.client.name,
                                    })
                                  : entry.actor.userId;
                            const changesText = entry.changes
                              .map((c) =>
                                t("documents.history.changed", {
                                  field: c.path,
                                  before: String(c.before ?? "—"),
                                  after: String(c.after ?? "—"),
                                }),
                              )
                              .join("; ");
                            const parts = [
                              formatDateTime(locale, entry.at),
                              actorText,
                              entry.reason !== null
                                ? t("documents.history.unlockReason", { reason: entry.reason })
                                : null,
                              changesText !== "" ? changesText : null,
                            ].filter(Boolean);
                            return (
                              <ListRow
                                key={entry.id}
                                title={entry.action}
                                subtitle={parts.join(" · ")}
                              />
                            );
                          })}
                        </Card>
                      )
                    }
                  </RemoteView>
                </Section>
              ) : null}

              {/* Modals */}
              <RecordPaymentModal
                visible={activeDialog === "payment"}
                currency={currency}
                defaultAmount={defaultPaymentAmount}
                defaultMethod={doc.paymentMethod}
                showPtdNotice={doc.kind === "proforma" && workspace.taxRegime === "vat_payer"}
                busy={busyAction === "payment"}
                onClose={() => setActiveDialog(null)}
                onSubmit={(values) => void handleRecordPayment(doc, values)}
              />

              <RemovePaymentModal
                visible={removingPayment !== null}
                hasTaxDocument={removingPayment?.hasTaxDocument === true}
                busy={busyAction === "removePayment"}
                onClose={() => setRemovingPayment(null)}
                onSubmit={(reason) => {
                  if (removingPayment !== null) {
                    void handleRemovePayment(removingPayment.id, reason);
                  }
                }}
              />

              <SendEmailModal
                visible={activeDialog === "send"}
                numberLabel={numberLabel}
                defaultRecipients={contact.billingEmails}
                defaultLanguage={locale}
                busy={busyAction === "send"}
                onClose={() => setActiveDialog(null)}
                onSubmit={(values) => void handleSendEmail(doc, values)}
              />

              <CancelDocumentModal
                visible={activeDialog === "cancel"}
                numberLabel={numberLabel}
                isTaxDocument={doc.taxDocument}
                busy={busyAction === "cancel"}
                onClose={() => setActiveDialog(null)}
                onSubmit={(values) => void handleCancel(doc, values)}
              />

              <CreditNoteModal
                visible={activeDialog === "correct"}
                doc={doc}
                parsedLines={lines}
                busy={busyAction === "creditNote"}
                onClose={() => setActiveDialog(null)}
                onSubmit={(values) => void handleCreateCreditNote(doc, values)}
              />

              <UnlockDocumentModal
                visible={activeDialog === "unlock"}
                busy={busyAction === "unlock"}
                onClose={() => setActiveDialog(null)}
                onSubmit={(reason) => void handleUnlock(doc, reason)}
              />
            </View>
          );
        }}
      </RemoteView>
    </Screen>
  );
}
