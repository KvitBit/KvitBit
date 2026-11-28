import type { RecordPaymentInput } from "@kvitbit/api-contract";
import type { ExpenseId, PaymentId, PaymentMethod, VatTreatment } from "@kvitbit/domain/contract";
import { CurrencyCode, IsoDate, MoneyMath } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { describeError, idempotencyHeaders, ifMatchHeaders, UiError } from "@kvitbit/ui-port/api";
import { formatDate, formatMoney, parseIsoDate } from "@kvitbit/ui-port/format";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import type * as Types from "effect/Types";
import { Download, Edit3, Paperclip, Plus, Share2, Trash2, Upload } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useTransfer } from "../../platform/transfer";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { fromMobilePromise } from "../../runtime/request-intent";
import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  IconButton,
  ListRow,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canWriteWorkspace } from "../dashboard/model";
import { usePaymentMutation, useRequestMutation } from "../documents/request-mutation";
import { runFeatureEffect, runFeatureSync } from "../ui-effect";
import { defaultReceiptPicker, type ReceiptPicker } from "./capture-picker";
import type { RejectedReceipt } from "./capture-queue";
import {
  buildExpensePayload,
  COMMON_CURRENCIES,
  type DeductibilityMode,
  decodeExpenseDetail,
  decodePayment,
  deductibilityPercent,
  EXPENSE_VAT_TREATMENTS,
  type ExpenseAttachmentData,
  type ExpenseDetailData,
  type ExpenseFormState,
  type ExpenseSettlement,
  emptyExpenseForm,
  expenseFormFromDetail,
  formatBytes,
  PAYMENT_METHODS,
  remainingAmount,
  todayIsoDate,
  validateAttachmentFile,
  vatBreakdownDifference,
} from "./model";
import { useRejectedReceipts } from "./use-expense-capture";

const settlementTone = (s: ExpenseSettlement): BadgeTone => {
  switch (s) {
    case "paid":
      return "success";
    case "partially_paid":
      return "warning";
    case "overpaid":
      return "info";
    case "unpaid":
      return "neutral";
  }
};

export function ExpenseDetailScreen(props: {
  readonly expenseId: ExpenseId | "new";
  readonly initialMode?: "view" | "edit";
  readonly picker?: ReceiptPicker;
}) {
  const isNew = props.expenseId === "new";
  const expenseId = isNew ? null : props.expenseId;
  const picker = props.picker ?? defaultReceiptPicker;

  const { workspace } = useWorkspace();
  const writable = canWriteWorkspace(workspace);
  const { t, text, locale, local } = useI18n();
  const api = useApi();
  const runMutation = useRequestMutation(workspace.id);
  const runPayment = usePaymentMutation(workspace.id);
  const transfer = useTransfer();
  const overlay = useOverlay();
  const rejectedReceipts = useRejectedReceipts(expenseId);

  const [mode, setMode] = useState<"view" | "edit">(isNew ? "edit" : (props.initialMode ?? "view"));
  const [form, setForm] = useState<ExpenseFormState>(() => emptyExpenseForm());
  const formInitialized = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Payments form state
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState<string>(() => todayIsoDate());
  const [payMethod, setPayMethod] = useState<PaymentMethod>("bank_transfer");
  const [payNote, setPayNote] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [removeReason, setRemoveReason] = useState("");

  // Attachment transfer state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [transferBusyId, setTransferBusyId] = useState<string | null>(null);

  const detailRemote = useRemote(
    useMemo(
      () =>
        expenseId === null
          ? null
          : (client: KvitbitApiClient) =>
              client.expenses.get({ params: { workspaceId: workspace.id, expenseId } }),
      [workspace.id, expenseId],
    ),
  );

  const paymentsRemote = useRemote(
    useMemo(
      () =>
        expenseId === null
          ? null
          : (client: KvitbitApiClient) =>
              client.payments.listForExpense({ params: { workspaceId: workspace.id, expenseId } }),
      [workspace.id, expenseId],
    ),
  );

  const loadedDetail = useMemo(
    () =>
      detailRemote.state._tag === "Ready" ? decodeExpenseDetail(detailRemote.state.value) : null,
    [detailRemote.state],
  );

  useEffect(() => {
    if (loadedDetail !== null && (mode === "view" || !formInitialized.current)) {
      setForm(expenseFormFromDetail(loadedDetail));
      formInitialized.current = true;
    }
  }, [loadedDetail, mode]);

  const startEdit = useCallback(() => {
    if (!writable) return;
    if (loadedDetail !== null) setForm(expenseFormFromDetail(loadedDetail));
    setFieldErrors({});
    setBannerError(null);
    setMode("edit");
  }, [loadedDetail, writable]);

  const handleSave = useCallback(
    () =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable || saving === true) return;
          setBannerError(null);
          const { payload, errors } = buildExpensePayload(form);
          if (Rec.keys(errors).length > 0) {
            setFieldErrors(errors);
            return;
          }
          setFieldErrors({});
          setSaving(true);
          if (isNew) {
            const res = yield* fromMobilePromise(() =>
              runMutation("expenses.record", payload, (client, key) =>
                client.expenses.record({
                  params: { workspaceId: workspace.id },
                  headers: idempotencyHeaders(key),
                  payload,
                }),
              ),
            );
            setSaving(false);
            if (res._tag === "Ok") {
              const created = decodeExpenseDetail(res.value);
              if (created === null) {
                setBannerError(text(describeError(UiError.unexpected()).text));
                return;
              }
              overlay.toast(t("common.toast.saved"));
              navigate(
                { _tag: "Expense", ws: workspace.slug, id: created.id, mode: "view" },
                { replace: true },
              );
            } else {
              const view = describeError(res.error);
              setBannerError(text(view.text));
              const mapped: Record<string, string> = {};
              for (const issue of view.issues) {
                const keyPath = Arr.join(Arr.map(issue.path, String), ".");
                if (keyPath !== "") mapped[keyPath] = text(issue.text);
              }
              setFieldErrors(mapped);
            }
            return;
          }

          if (expenseId === null || loadedDetail === null) {
            setSaving(false);
            return;
          }
          const res = yield* fromMobilePromise(() =>
            api.run((client) =>
              client.expenses.edit({
                params: { workspaceId: workspace.id, expenseId },
                headers: ifMatchHeaders(loadedDetail.revision),
                payload,
              }),
            ),
          );
          setSaving(false);
          if (res._tag === "Ok") {
            detailRemote.set(res.value);
            setMode("view");
            overlay.toast(t("common.toast.saved"));
          } else {
            const view = describeError(res.error);
            setBannerError(text(view.text));
            const mapped: Record<string, string> = {};
            for (const issue of view.issues) {
              const keyPath = Arr.join(Arr.map(issue.path, String), ".");
              if (keyPath !== "") mapped[keyPath] = text(issue.text);
            }
            setFieldErrors(mapped);
            if (view.staleRevision) detailRemote.reload();
          }
        }),
      ),
    [
      api,
      detailRemote,
      expenseId,
      form,
      isNew,
      loadedDetail,
      overlay,
      runMutation,
      saving,
      t,
      text,
      workspace,
      writable,
    ],
  );

  const handleDeleteExpense = useCallback(
    () =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable || expenseId === null || loadedDetail === null) return;
          const confirmed = yield* fromMobilePromise(() =>
            overlay.confirm({
              title: t("expenses.detail.removeTitle"),
              body: t("expenses.detail.removeBody"),
              confirmLabel: t("common.action.delete"),
              cancelLabel: t("common.action.cancel"),
              destructive: true,
            }),
          );
          if (!confirmed) return;
          const res = yield* fromMobilePromise(() =>
            api.run((client) =>
              client.expenses.remove({
                params: { workspaceId: workspace.id, expenseId },
                headers: ifMatchHeaders(loadedDetail.revision),
              }),
            ),
          );
          if (res._tag === "Ok") {
            yield* fromMobilePromise(() => rejectedReceipts.clearAll().catch(() => undefined));
            overlay.toast(t("common.toast.deleted"));
            navigate({ _tag: "Expenses", ws: workspace.slug, query: {} }, { replace: true });
          } else {
            setBannerError(text(describeError(res.error).text));
          }
        }),
      ),
    [api, expenseId, loadedDetail, overlay, rejectedReceipts, t, text, workspace, writable],
  );

  const openPaymentEditor = useCallback(
    (detail: ExpenseDetailData) => {
      if (!writable) return;
      setPayAmount(remainingAmount(detail) ?? detail.total ?? "");
      setPayDate(todayIsoDate());
      setPayMethod("bank_transfer");
      setPayNote("");
      setShowPaymentForm(true);
    },
    [writable],
  );

  const handleRecordPayment = useCallback(
    (detail: ExpenseDetailData) =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable || expenseId === null || payBusy === true) return;
          setBannerError(null);
          const cleanedAmount = Str.replace(",", ".")(Str.replace(/\s+/g, "")(Str.trim(payAmount)));
          const amount = BigDecimal.fromString(cleanedAmount);
          if (cleanedAmount !== "" && Option.isNone(amount)) {
            setBannerError(
              local({ cs: "Zadejte platnou částku.", en: "Enter a valid payment amount." }),
            );
            return;
          }
          const paidOn = Str.trim(payDate);
          if (paidOn !== "" && parseIsoDate(paidOn) === undefined) {
            setBannerError(
              local({ cs: "Použijte datum RRRR-MM-DD.", en: "Use YYYY-MM-DD date format." }),
            );
            return;
          }
          const payload: Types.Mutable<RecordPaymentInput> = {
            target: { expense: expenseId },
            method: payMethod,
          };
          if (cleanedAmount !== "" && Option.isSome(amount) && detail.currency !== null) {
            payload.amount = MoneyMath.make(amount.value, detail.currency);
          }
          if (paidOn !== "") payload.paidOn = IsoDate.make(paidOn);
          const note = Str.trim(payNote);
          if (note !== "") payload.note = note;
          setPayBusy(true);
          const res = yield* fromMobilePromise(() =>
            runPayment(`payments.record:expense:${expenseId}`, payload, (client, key) =>
              client.payments.record({
                params: { workspaceId: workspace.id },
                headers: idempotencyHeaders(key),
                payload,
              }),
            ),
          );
          setPayBusy(false);
          if (res._tag === "Ok") {
            setShowPaymentForm(false);
            detailRemote.reload();
            paymentsRemote.reload();
            overlay.toast(t("common.toast.saved"));
          } else {
            setBannerError(text(describeError(res.error).text));
          }
        }),
      ),
    [
      detailRemote,
      expenseId,
      local,
      overlay,
      payAmount,
      payBusy,
      payDate,
      payMethod,
      payNote,
      paymentsRemote,
      runPayment,
      t,
      text,
      workspace.id,
      writable,
    ],
  );

  const handleRemovePayment = useCallback(
    (paymentId: PaymentId) =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable) return;
          const confirmed = yield* fromMobilePromise(() =>
            overlay.confirm({
              title: local({ cs: "Odebrat platbu?", en: "Remove payment?" }),
              body: t("common.confirm.reasonLabel"),
              confirmLabel: t("common.action.remove"),
              cancelLabel: t("common.action.cancel"),
              destructive: true,
            }),
          );
          if (!confirmed) return;
          const reason =
            Str.trim(removeReason) === ""
              ? local({ cs: "Odebráno z mobilní aplikace", en: "Removed from mobile app" })
              : Str.trim(removeReason);
          const res = yield* fromMobilePromise(() =>
            api.run((client) =>
              client.payments.remove({
                params: { workspaceId: workspace.id, paymentId },
                payload: { reason },
              }),
            ),
          );
          if (res._tag === "Ok") {
            setRemoveReason("");
            detailRemote.reload();
            paymentsRemote.reload();
            overlay.toast(t("common.toast.deleted"));
          } else {
            setBannerError(text(describeError(res.error).text));
          }
        }),
      ),
    [
      api,
      detailRemote,
      local,
      overlay,
      paymentsRemote,
      removeReason,
      t,
      text,
      workspace.id,
      writable,
    ],
  );

  const handleAttachmentAction = useCallback(
    (att: ExpenseAttachmentData, action: "open" | "share") =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (expenseId === null) return;
          setBannerError(null);
          setTransferBusyId(att.id);
          const dl = yield* fromMobilePromise(() =>
            transfer.download({
              path: `/workspaces/${workspace.id}/expenses/${expenseId}/attachments/${att.id}`,
              query: { disposition: action === "open" ? "inline" : "attachment" },
              filename: att.name,
              contentType: att.contentType,
            }),
          );
          if (dl._tag === "Err") {
            setTransferBusyId(null);
            setBannerError(text(describeError(dl.error).text));
            return;
          }
          const next =
            action === "open"
              ? yield* fromMobilePromise(() => transfer.open(dl.value))
              : yield* fromMobilePromise(() => transfer.share(dl.value));
          setTransferBusyId(null);
          if (next._tag === "Err") {
            setBannerError(text(describeError(next.error).text));
          }
        }),
      ),
    [expenseId, text, transfer, workspace.id],
  );

  const handleDetachAttachment = useCallback(
    (att: ExpenseAttachmentData) =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable || expenseId === null) return;
          const confirmed = yield* fromMobilePromise(() =>
            overlay.confirm({
              title: t("expenses.attachmentViewer.detachTitle"),
              body: att.name,
              confirmLabel: t("common.action.remove"),
              cancelLabel: t("common.action.cancel"),
              destructive: true,
            }),
          );
          if (!confirmed) return;
          const res = yield* fromMobilePromise(() =>
            api.run((client) =>
              client.expenses.detach({
                params: { workspaceId: workspace.id, expenseId, attachmentId: att.id },
              }),
            ),
          );
          if (res._tag === "Ok") {
            detailRemote.reload();
            overlay.toast(t("common.toast.deleted"));
          } else {
            setBannerError(text(describeError(res.error).text));
          }
        }),
      ),
    [api, detailRemote, expenseId, overlay, t, text, workspace.id, writable],
  );

  const handleAddAttachment = useCallback(
    () =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable || expenseId === null) return;
          setBannerError(null);
          const picked = yield* fromMobilePromise(() => picker.pickDocument());
          if (picked._tag === "Cancelled") return;
          if (picked._tag === "PermissionDenied") {
            setBannerError(t("expenses.capture.cameraDenied"));
            return;
          }
          if (picked._tag === "Error") {
            setBannerError(picked.message);
            return;
          }
          setUploading(true);
          setUploadProgress(0);
          for (const file of picked.files) {
            const invalid = validateAttachmentFile(file);
            if (invalid !== null) {
              setBannerError(
                invalid === "too_large"
                  ? local({ cs: "Soubor je větší než 20 MB.", en: "File exceeds 20 MB limit." })
                  : t("expenses.attachmentViewer.allowedTypes", { types: "PDF, JPEG, PNG, HEIC" }),
              );
              continue;
            }
            const uploaded = yield* fromMobilePromise(() =>
              transfer.upload({
                path: `/workspaces/${workspace.id}/expenses/${expenseId}/attachments`,
                file,
                onProgress: (p) => setUploadProgress(Math.round(p * 100)),
              }),
            );
            if (uploaded._tag === "Err") {
              setBannerError(text(describeError(uploaded.error).text));
            }
          }
          setUploading(false);
          detailRemote.reload();
        }),
      ),
    [detailRemote, expenseId, local, picker, t, text, transfer, workspace.id, writable],
  );

  const errMsg = (key: string): string | null => {
    const code = fieldErrors[key];
    if (code === undefined) return null;
    if (code === "required") return t("common.state.required");
    if (code === "invalid_date") return local({ cs: "Formát RRRR-MM-DD", en: "Use YYYY-MM-DD" });
    if (code === "invalid_number")
      return local({ cs: "Zadejte platné číslo", en: "Enter a valid number" });
    if (code === "invalid_percent") return local({ cs: "Zadejte 1 až 99 %", en: "Enter 1 to 99%" });
    return code;
  };

  const renderRejectedReceipt = (item: RejectedReceipt) => {
    const view = describeError(item.error);
    const issueText =
      view.issues.length > 0
        ? Arr.join(
            Arr.map(view.issues, (issue) => text(issue.text)),
            " · ",
          )
        : text(view.text);
    return (
      <Card key={item.key}>
        <View style={styles.headerRow}>
          <Paperclip size={18} />
          <View style={styles.flex}>
            <Text variant="row" numberOfLines={1}>
              {item.name}
            </Text>
            <Text variant="meta" color="onSurfaceVariant">
              {item.contentType} · {formatBytes(item.size)}
            </Text>
            <Text variant="bodySmall" color="error">
              {issueText}
            </Text>
          </View>
          <Badge label={t("enum.captureJob.failed")} tone="danger" />
          {writable ? (
            <IconButton
              icon={Trash2}
              label={t("common.action.discard")}
              onPress={() => rejectedReceipts.dismiss(item.key)}
            />
          ) : null}
        </View>
      </Card>
    );
  };

  if (isNew && !writable) {
    return (
      <Screen title={t("expenses.list.new")} back>
        <Banner text={t(workspace.closed ? "shell.closedWorkspace" : "error.forbidden")} />
      </Screen>
    );
  }

  if (writable && mode === "edit") {
    const vatDiff = vatBreakdownDifference(form.total, form.vatRows);
    return (
      <Screen
        title={isNew ? t("expenses.list.new") : t("expenses.editor.title")}
        back={
          isNew
            ? true
            : () => {
                setMode("view");
                setBannerError(null);
              }
        }
        footer={
          <>
            {isNew ? null : (
              <Button
                kind="text"
                label={t("common.action.cancel")}
                onPress={() => setMode("view")}
              />
            )}
            <Button
              label={t("common.action.save")}
              busy={saving}
              disabled={!isNew && loadedDetail === null}
              onPress={() => handleSave()}
              testID="expense-save"
            />
          </>
        }
      >
        {bannerError === null ? null : <Banner text={bannerError} />}
        {rejectedReceipts.rejected.length === 0 ? null : (
          <Section title={t("expenses.detail.attachments")}>
            {Arr.map(rejectedReceipts.rejected, renderRejectedReceipt)}
          </Section>
        )}

        <SegmentedChoice
          label={t("common.field.status")}
          value={form.status}
          choices={[
            { value: "complete", label: t("enum.expenseStatus.complete") },
            { value: "incomplete", label: t("enum.expenseStatus.incomplete") },
          ]}
          onChange={(status) => setForm((f) => ({ ...f, status }))}
        />

        <Section title={t("expenses.editor.supplier")}>
          <TextField
            label={t("common.field.name")}
            value={form.supplierName}
            onChangeText={(supplierName) => setForm((f) => ({ ...f, supplierName }))}
            error={errMsg("supplier.manual.name")}
          />
          <TextField
            label={t("common.field.ico")}
            value={form.supplierIco}
            onChangeText={(supplierIco) => setForm((f) => ({ ...f, supplierIco }))}
            error={errMsg("supplier.ico")}
          />
          <TextField
            label={t("common.field.dic")}
            value={form.supplierDic}
            onChangeText={(supplierDic) => setForm((f) => ({ ...f, supplierDic }))}
          />
          <TextField
            label={t("expenses.editor.number")}
            value={form.supplierDocumentNumber}
            onChangeText={(supplierDocumentNumber) =>
              setForm((f) => ({ ...f, supplierDocumentNumber }))
            }
          />
        </Section>

        <Section title={t("common.field.date")}>
          <TextField
            label={t("expenses.editor.issueDate")}
            placeholder="YYYY-MM-DD"
            value={form.issuedOn}
            onChangeText={(issuedOn) => setForm((f) => ({ ...f, issuedOn }))}
            error={errMsg("issuedOn")}
          />
          <TextField
            label={t("expenses.editor.taxableSupplyDate")}
            placeholder="YYYY-MM-DD"
            value={form.taxableSupplyOn}
            onChangeText={(taxableSupplyOn) => setForm((f) => ({ ...f, taxableSupplyOn }))}
            error={errMsg("taxableSupplyOn")}
          />
          <TextField
            label={t("expenses.editor.dueDate")}
            placeholder="YYYY-MM-DD"
            value={form.dueOn}
            onChangeText={(dueOn) => setForm((f) => ({ ...f, dueOn }))}
            error={errMsg("dueOn")}
          />
        </Section>

        <Section title={t("common.field.amount")}>
          <SegmentedChoice
            label={t("common.field.currency")}
            value={form.currency}
            choices={Arr.map(COMMON_CURRENCIES, (c) => ({ value: c, label: c }))}
            onChange={(currency) => setForm((f) => ({ ...f, currency }))}
          />
          <TextField
            label={t("expenses.editor.gross")}
            keyboardType="decimal-pad"
            value={form.total}
            onChangeText={(total) => setForm((f) => ({ ...f, total }))}
            error={errMsg("total")}
            testID="expense-total"
          />

          <SegmentedChoice<DeductibilityMode>
            label={local({ cs: "Odpočet DPH", en: "VAT deductibility" })}
            value={form.deductibilityMode}
            choices={[
              { value: "full", label: local({ cs: "100 %", en: "Full (100%)" }) },
              { value: "partial", label: local({ cs: "Částečný", en: "Partial %" }) },
              { value: "none", label: local({ cs: "0 %", en: "None (0%)" }) },
            ]}
            onChange={(deductibilityMode) => setForm((f) => ({ ...f, deductibilityMode }))}
          />
          {form.deductibilityMode !== "partial" ? null : (
            <TextField
              label={local({ cs: "Procento odpočtu (1–99)", en: "Deductible % (1–99)" })}
              keyboardType="number-pad"
              value={form.deductiblePercent}
              onChangeText={(deductiblePercent) => setForm((f) => ({ ...f, deductiblePercent }))}
              error={errMsg("deductiblePercent")}
            />
          )}
        </Section>

        <Section
          title={t("expenses.editor.vatBreakdown")}
          action={
            <Button
              kind="text"
              icon={Plus}
              label={t("expenses.editor.addVatRow")}
              onPress={() =>
                setForm((f) => ({
                  ...f,
                  vatRows: [
                    ...f.vatRows,
                    {
                      id: `vat-${runFeatureSync(Clock.currentTimeMillis)}-${f.vatRows.length}`,
                      treatment: "standard",
                      base: "",
                      vat: "0",
                    },
                  ],
                }))
              }
            />
          }
        >
          {Arr.map(form.vatRows, (row, idx) => (
            <Card key={row.id}>
              <SegmentedChoice<VatTreatment>
                value={row.treatment}
                choices={Arr.map(EXPENSE_VAT_TREATMENTS, (tr) => ({
                  value: tr,
                  label: t(`enum.vatTreatment.${tr}`),
                }))}
                onChange={(treatment) =>
                  setForm((f) => ({
                    ...f,
                    vatRows: Arr.map(f.vatRows, (r, i) => (i === idx ? { ...r, treatment } : r)),
                  }))
                }
              />
              <View style={styles.rowFields}>
                <View style={styles.flex}>
                  <TextField
                    label={t("expenses.editor.base")}
                    keyboardType="decimal-pad"
                    value={row.base}
                    onChangeText={(base) =>
                      setForm((f) => ({
                        ...f,
                        vatRows: Arr.map(f.vatRows, (r, i) => (i === idx ? { ...r, base } : r)),
                      }))
                    }
                    error={errMsg(`vat.${idx}.base`)}
                  />
                </View>
                <View style={styles.flex}>
                  <TextField
                    label={t("expenses.editor.vat")}
                    keyboardType="decimal-pad"
                    value={row.vat}
                    onChangeText={(vat) =>
                      setForm((f) => ({
                        ...f,
                        vatRows: Arr.map(f.vatRows, (r, i) => (i === idx ? { ...r, vat } : r)),
                      }))
                    }
                    error={errMsg(`vat.${idx}.vat`)}
                  />
                </View>
              </View>
              <Button
                kind="text"
                label={t("common.action.remove")}
                onPress={() =>
                  setForm((f) => ({ ...f, vatRows: Arr.filter(f.vatRows, (_, i) => i !== idx) }))
                }
              />
            </Card>
          ))}
          {vatDiff !== null && vatDiff !== 0 ? (
            <Banner
              tone="warning"
              text={t("expenses.editor.difference", { amount: `${vatDiff} ${form.currency}` })}
            />
          ) : null}
        </Section>

        <Section title={t("common.field.category")}>
          <TextField
            label={t("common.field.category")}
            value={form.category}
            onChangeText={(category) => setForm((f) => ({ ...f, category }))}
          />
          <TextField
            label={t("common.field.tags")}
            supporting={t("expenses.editor.tagsHint")}
            value={form.tags}
            onChangeText={(tags) => setForm((f) => ({ ...f, tags }))}
          />
          <TextField
            label={t("common.field.note")}
            multiline
            value={form.note}
            onChangeText={(note) => setForm((f) => ({ ...f, note }))}
          />
        </Section>
      </Screen>
    );
  }

  return (
    <Screen
      title={t("expenses.editor.title")}
      back
      onRefresh={() => {
        detailRemote.reload();
        paymentsRemote.reload();
      }}
      refreshing={detailRemote.state._tag === "Loading"}
      actions={
        !writable || loadedDetail === null ? null : (
          <>
            <IconButton icon={Edit3} label={t("common.action.edit")} onPress={startEdit} />
            <IconButton
              icon={Trash2}
              label={t("common.action.delete")}
              onPress={() => handleDeleteExpense()}
            />
          </>
        )
      }
    >
      {bannerError === null ? null : <Banner text={bannerError} />}

      <RemoteView state={detailRemote.state} onRetry={detailRemote.reload}>
        {(raw) => {
          const detail = decodeExpenseDetail(raw);
          if (detail === null) {
            return <Banner text={text(describeError(UiError.unexpected()).text)} />;
          }
          const totalLabel =
            detail.total !== null && detail.currency !== null
              ? formatMoney(locale, {
                  amount: detail.total,
                  currency: detail.currency,
                })
              : (detail.total ?? "—");
          const czkLabel =
            detail.totalCzk !== null && detail.currency !== "CZK"
              ? formatMoney(locale, { amount: detail.totalCzk, currency: CurrencyCode.make("CZK") })
              : null;

          return (
            <>
              <Card>
                <View style={styles.headerRow}>
                  <Text variant="headlineSmall" style={styles.flex}>
                    {detail.supplier?.name ??
                      detail.supplierDocumentNumber ??
                      local({ cs: "Neúplný náklad", en: "Incomplete expense" })}
                  </Text>
                  <Badge
                    label={t(`enum.expenseStatus.${detail.status}`)}
                    tone={detail.status === "complete" ? "info" : "warning"}
                  />
                </View>
                <Text variant="titleLarge" numeric>
                  {totalLabel}
                </Text>
                {czkLabel === null ? null : (
                  <Text variant="meta" color="onSurfaceVariant" numeric>
                    {t("expenses.editor.czkEquivalent", { amount: czkLabel })}
                  </Text>
                )}
                <View style={styles.badges}>
                  <Badge
                    label={t(`enum.settlement.${detail.payment.settlement}`)}
                    tone={settlementTone(detail.payment.settlement)}
                  />
                  <Badge
                    label={`${local({ cs: "Odpočet DPH", en: "Deductible" })}: ${deductibilityPercent(detail.deductibility)} %`}
                    tone="neutral"
                  />
                </View>
                {detail.supplierDocumentNumber === null ? null : (
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("expenses.editor.number")}: {detail.supplierDocumentNumber}
                  </Text>
                )}
                {detail.issuedOn === null ? null : (
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("expenses.editor.issueDate")}:{" "}
                    {formatDate({ locale, date: detail.issuedOn })}
                  </Text>
                )}
                {detail.dueOn === null ? null : (
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("expenses.editor.dueDate")}: {formatDate({ locale, date: detail.dueOn })}
                  </Text>
                )}
                {detail.category === null ? null : (
                  <Text variant="bodyMedium" color="onSurfaceVariant">
                    {t("common.field.category")}: {detail.category}
                  </Text>
                )}
                {detail.note === null ? null : <Text variant="bodyMedium">{detail.note}</Text>}
              </Card>

              {detail.buckets.length === 0 ? null : (
                <Section title={t("expenses.editor.vatBreakdown")}>
                  {Arr.map(detail.buckets, (b) => (
                    <ListRow
                      key={`${b.treatment}-${b.ratePercent}`}
                      title={`${t(`enum.vatTreatment.${b.treatment}`)} (${b.ratePercent} %)`}
                      subtitle={`${t("expenses.editor.base")}: ${b.base} · ${t("expenses.editor.vat")}: ${b.vat}`}
                      trailing={
                        detail.currency !== null
                          ? formatMoney(locale, {
                              amount: b.gross,
                              currency: detail.currency,
                            })
                          : b.gross
                      }
                    />
                  ))}
                </Section>
              )}

              <Section
                title={t("enum.scopeArea.payments")}
                action={
                  writable ? (
                    <Button
                      kind="tonal"
                      label={
                        detail.payment.settlement === "unpaid"
                          ? t("expenses.detail.markPaid")
                          : t("expenses.detail.partialPayment")
                      }
                      onPress={() => openPaymentEditor(detail)}
                      testID="expense-record-payment-toggle"
                    />
                  ) : null
                }
              >
                {!writable || showPaymentForm !== true ? null : (
                  <Card>
                    <TextField
                      label={t("common.field.amount")}
                      keyboardType="decimal-pad"
                      value={payAmount}
                      onChangeText={setPayAmount}
                    />
                    <TextField
                      label={t("common.field.date")}
                      placeholder="YYYY-MM-DD"
                      value={payDate}
                      onChangeText={setPayDate}
                    />
                    <SegmentedChoice<PaymentMethod>
                      value={payMethod}
                      choices={Arr.map(PAYMENT_METHODS, (m) => ({
                        value: m,
                        label: t(`enum.paymentMethod.${m}`),
                      }))}
                      onChange={setPayMethod}
                    />
                    <TextField
                      label={t("common.field.note")}
                      value={payNote}
                      onChangeText={setPayNote}
                    />
                    <View style={styles.rowActions}>
                      <Button
                        kind="text"
                        label={t("common.action.cancel")}
                        onPress={() => setShowPaymentForm(false)}
                      />
                      <Button
                        label={t("common.action.confirm")}
                        busy={payBusy}
                        onPress={() => handleRecordPayment(detail)}
                        testID="expense-record-payment-submit"
                      />
                    </View>
                  </Card>
                )}

                <RemoteView state={paymentsRemote.state} onRetry={paymentsRemote.reload}>
                  {(rawPayments) => {
                    const payments = Arr.filter(
                      Arr.map(rawPayments, (payment) => decodePayment(payment)),
                      (p): p is NonNullable<typeof p> => p !== null,
                    );
                    if (payments.length === 0) {
                      return (
                        <Text variant="meta" color="onSurfaceVariant">
                          {t("common.state.none")}
                        </Text>
                      );
                    }
                    return (
                      <>
                        {Arr.map(payments, (p) => (
                          <Card key={p.id}>
                            <View style={styles.headerRow}>
                              <View style={styles.flex}>
                                <Text variant="row" numeric>
                                  {formatMoney(locale, p.amount)}
                                </Text>
                                <Text variant="meta" color="onSurfaceVariant">
                                  {formatDate({ locale, date: p.paidOn })} ·{" "}
                                  {t(`enum.paymentMethod.${p.method}`)}
                                </Text>
                                {p.note === null ? null : <Text variant="bodySmall">{p.note}</Text>}
                              </View>
                              {writable ? (
                                <IconButton
                                  icon={Trash2}
                                  label={t("common.action.remove")}
                                  onPress={() => handleRemovePayment(p.id)}
                                />
                              ) : null}
                            </View>
                          </Card>
                        ))}
                      </>
                    );
                  }}
                </RemoteView>
              </Section>

              <Section
                title={t("expenses.detail.attachments")}
                action={
                  writable ? (
                    <Button
                      kind="outlined"
                      icon={Upload}
                      label={
                        uploading === true
                          ? t("common.state.uploadingPercent", { percent: uploadProgress })
                          : t("expenses.detail.addFiles")
                      }
                      busy={uploading}
                      onPress={() => handleAddAttachment()}
                      testID="expense-add-attachment"
                    />
                  ) : null
                }
              >
                {detail.attachments.length === 0 && rejectedReceipts.rejected.length === 0 ? (
                  <Text variant="meta" color="onSurfaceVariant">
                    {t("common.state.none")}
                  </Text>
                ) : (
                  <>
                    {Arr.map(rejectedReceipts.rejected, renderRejectedReceipt)}
                    {Arr.map(detail.attachments, (att) => (
                      <Card key={att.id}>
                        <View style={styles.headerRow}>
                          <Paperclip size={18} />
                          <View style={styles.flex}>
                            <Text variant="row" numberOfLines={1}>
                              {att.name}
                            </Text>
                            <Text variant="meta" color="onSurfaceVariant">
                              {att.contentType} · {formatBytes(att.bytes)}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.rowActions}>
                          <Button
                            kind="tonal"
                            icon={Download}
                            label={t("common.action.open")}
                            busy={transferBusyId === att.id}
                            onPress={() => handleAttachmentAction(att, "open")}
                            testID={`attachment-open-${att.id}`}
                          />
                          <Button
                            kind="outlined"
                            icon={Share2}
                            label={t("common.action.share")}
                            disabled={transferBusyId === att.id}
                            onPress={() => handleAttachmentAction(att, "share")}
                            testID={`attachment-share-${att.id}`}
                          />
                          {writable ? (
                            <IconButton
                              icon={Trash2}
                              label={t("expenses.attachmentViewer.detach")}
                              onPress={() => handleDetachAttachment(att)}
                            />
                          ) : null}
                        </View>
                      </Card>
                    ))}
                  </>
                )}
              </Section>
            </>
          );
        }}
      </RemoteView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  rowFields: { flexDirection: "row", gap: space.sm },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "flex-end" },
});
