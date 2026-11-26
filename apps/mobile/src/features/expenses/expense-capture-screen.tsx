import type { ExpenseId } from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import {
  Camera,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import {
  Badge,
  Banner,
  Button,
  Card,
  IconButton,
  Screen,
  Section,
  SegmentedChoice,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { defaultReceiptPicker, type PickerOutcome, type ReceiptPicker } from "./capture-picker";
import {
  type CaptureAccess,
  type CaptureFields,
  type CaptureJob,
  canRetryCapture,
} from "./capture-queue";
import { COMMON_CURRENCIES, formatBytes } from "./model";
import { captureQueue, useCaptureAccess, useCaptureNetwork } from "./use-expense-capture";

interface CaptureScreenProps {
  readonly picker?: ReceiptPicker;
  readonly targetExpenseId?: ExpenseId;
  readonly captureId?: string;
}

const initialFields: CaptureFields = { supplierName: "", total: "", currency: "CZK", note: "" };

export function ExpenseCaptureScreen(props: CaptureScreenProps) {
  const { current } = useCaptureAccess();
  const { t } = useI18n();
  if (current === null) {
    return (
      <Screen title={t("expenses.capture.title")} back>
        <Banner text={t("error.forbidden")} />
      </Screen>
    );
  }
  const { principalId, workspaceId } = current.scope;
  return (
    <CaptureForm
      key={JSON.stringify([principalId, workspaceId, props.targetExpenseId, props.captureId])}
      {...props}
      access={current}
    />
  );
}

function CaptureForm(props: CaptureScreenProps & { readonly access: CaptureAccess }) {
  const { access, targetExpenseId = null } = props;
  const picker = props.picker ?? defaultReceiptPicker;
  const { t, text, local } = useI18n();
  const network = useCaptureNetwork();
  const overlay = useOverlay();
  const [captureId, setCaptureId] = useState(props.captureId);
  const [jobs, setJobs] = useState<readonly CaptureJob[]>([]);
  const [fields, setFields] = useState(initialFields);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [progress, setProgress] = useState<{ key: string; percent: number } | null>(null);
  const job = jobs.find(
    (item) =>
      item.targetExpenseId === targetExpenseId &&
      item.done !== true &&
      (captureId === undefined || item.key === captureId),
  );
  const staged = job?.files ?? [];
  const failure = job?.submission?.failure;
  const submitted = job?.submission !== undefined;
  const visibleFields = job?.submission?.fields ?? fields;

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const loaded = await captureQueue.load(access.scope);
        if (active) setJobs(loaded);
      } catch {
        if (active) setBannerError(t("error.unknown"));
      }
    }
    const unsubscribe = captureQueue.subscribe((scope) => {
      if (
        scope.workspaceId === access.scope.workspaceId &&
        scope.principalId === access.scope.principalId
      ) {
        void refresh();
      }
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [access, t]);

  function updateField(key: keyof CaptureFields, value: string) {
    if (!submitted && !busy.current) setFields((previous) => ({ ...previous, [key]: value }));
  }

  async function pick(open: () => Promise<PickerOutcome>) {
    if (!access.canWrite() || submitted || busy.current) return;
    busy.current = true;
    setBannerError(null);
    try {
      const outcome = await open();
      if (!access.canWrite() || outcome._tag === "Cancelled") return;
      if (outcome._tag === "PermissionDenied") {
        setBannerError(t("expenses.capture.cameraDenied"));
        return;
      }
      if (outcome._tag === "Error") {
        setBannerError(outcome.message);
        return;
      }
      const result = await captureQueue.stage(access, targetExpenseId, outcome.files);
      if (captureId !== undefined && result.job !== undefined) setCaptureId(result.job.key);
      for (const issue of result.issues) {
        if (issue === "too_large") {
          setBannerError(
            local({ cs: "Soubor je větší než 20 MB.", en: "File exceeds 20 MB limit." }),
          );
        } else if (issue === "unsupported_type") {
          setBannerError(
            t("expenses.attachmentViewer.allowedTypes", { types: "PDF, JPEG, PNG, HEIC" }),
          );
        } else {
          setBannerError(t("error.unknown"));
        }
      }
    } catch {
      setBannerError(t("error.unknown"));
    } finally {
      busy.current = false;
    }
  }

  async function uploadAll() {
    if (!access.canWrite() || busy.current || job === undefined || !canRetryCapture(job)) return;
    busy.current = true;
    setBannerError(null);
    setSubmitting(true);
    try {
      const result = await captureQueue.submit(access, network, job.key, fields, (key, value) =>
        setProgress({ key, percent: Math.round(value * 100) }),
      );
      if (result?.done === true && result.expenseId !== null && access.canWrite()) {
        const rejected = result.files.some((receipt) => receipt.result?.kind === "rejected");
        if (rejected) {
          const fileError = result.files.find(
            (receipt) => receipt.result?.kind === "rejected",
          )?.result;
          if (fileError?.kind === "rejected")
            setBannerError(text(describeError(fileError.error).text));
        } else {
          overlay.toast(t("common.toast.saved"));
        }
        if (!rejected) {
          navigate(
            { _tag: "Expense", ws: access.scope.workspaceSlug, id: result.expenseId, mode: "edit" },
            { replace: true },
          );
        }
      }
    } catch {
      setBannerError(t("error.unknown"));
    } finally {
      setProgress(null);
      setSubmitting(false);
      busy.current = false;
    }
  }

  async function discardJob() {
    if (!access.canWrite() || job === undefined || busy.current) return;
    const confirmed = await overlay.confirm({
      title: local({ cs: "Odstranit místní kopie?", en: "Discard local copies?" }),
      body: local({
        cs: "Přijaté účtenky budou z tohoto zařízení odstraněny.",
        en: "The queued receipts will be removed from this device.",
      }),
      confirmLabel: t("common.action.discard"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed || !access.canWrite()) return;
    try {
      await captureQueue.discard(access, job.key);
      setCaptureId(undefined);
      setBannerError(null);
    } catch {
      setBannerError(t("error.unknown"));
    }
  }

  const shownError =
    bannerError ??
    (failure === undefined
      ? null
      : failure.kind === "expired"
        ? local({
            cs: "Uložení se nepodařilo potvrdit. Zkontrolujte, zda už je výdaj v seznamu.",
            en: "We couldn't confirm the save. Check your Expenses list for this receipt.",
          })
        : text(describeError(failure.error).text));
  return (
    <Screen
      title={t("expenses.capture.title")}
      back
      footer={
        <Button
          icon={failure === undefined ? Upload : RefreshCw}
          label={failure === undefined ? t("common.action.upload") : t("common.action.retry")}
          busy={submitting}
          disabled={job === undefined || !canRetryCapture(job)}
          onPress={() => void uploadAll()}
          testID="capture-upload-btn"
        />
      }
    >
      {shownError === null ? null : <Banner text={shownError} />}
      {failure?.kind === "blocked" || failure?.kind === "expired" ? (
        <Button kind="text" label={t("common.action.discard")} onPress={() => void discardJob()} />
      ) : null}

      {submitted ? null : (
        <Card>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {t("expenses.capture.edgeHint")}
          </Text>
          <View style={styles.captureButtons}>
            <Button
              icon={Camera}
              label={t("expenses.capture.takePhoto")}
              onPress={() => void pick(picker.takePhoto)}
              testID="capture-camera-btn"
            />
            <Button
              kind="tonal"
              icon={ImageIcon}
              label={t("expenses.capture.gallery")}
              onPress={() => void pick(picker.pickFromGallery)}
              testID="capture-gallery-btn"
            />
            <Button
              kind="outlined"
              icon={FileText}
              label={t("expenses.capture.files")}
              onPress={() => void pick(picker.pickDocument)}
              testID="capture-file-btn"
            />
          </View>
        </Card>
      )}

      {job === undefined ? null : (
        <Section title={t("expenses.capture.pages", { count: staged.length })}>
          {staged.map((item) => {
            const active = progress?.key === item.key;
            const state =
              item.result?.kind === "uploaded"
                ? "done"
                : item.result?.kind === "rejected"
                  ? "failed"
                  : active
                    ? "uploading"
                    : failure === undefined
                      ? "queued"
                      : "blocked";
            return (
              <Card key={item.key}>
                <View style={styles.fileRow}>
                  <View style={styles.flex}>
                    <Text variant="row" numberOfLines={1}>
                      {item.file.name}
                    </Text>
                    <Text variant="meta" color="onSurfaceVariant">
                      {item.file.contentType} · {formatBytes(item.file.size)}
                    </Text>
                    {active ? (
                      <Text variant="meta" color="primary">
                        {t("common.state.uploadingPercent", { percent: progress.percent })}
                      </Text>
                    ) : null}
                    {item.result?.kind === "rejected" ? (
                      <Text variant="bodySmall" color="error">
                        {text(describeError(item.result.error).text)}
                      </Text>
                    ) : null}
                  </View>
                  <Badge
                    label={t(`enum.captureJob.${state}`)}
                    tone={state === "done" ? "success" : state === "failed" ? "danger" : "info"}
                  />
                  {submitted ? null : (
                    <IconButton
                      icon={Trash2}
                      label={t("common.action.remove")}
                      onPress={() => {
                        if (!access.canWrite() || busy.current) return;
                        void captureQueue
                          .remove(access, job.key, item.key)
                          .catch(() => setBannerError(t("error.unknown")));
                      }}
                    />
                  )}
                </View>
              </Card>
            );
          })}
        </Section>
      )}

      {targetExpenseId !== null ? null : (
        <Section title={local({ cs: "Rychlé údaje (nepovinné)", en: "Quick details (optional)" })}>
          <TextField
            label={t("expenses.editor.supplier")}
            value={visibleFields.supplierName}
            disabled={submitted}
            onChangeText={(value) => updateField("supplierName", value)}
          />
          {submitted ? (
            <Text>{visibleFields.currency}</Text>
          ) : (
            <SegmentedChoice
              label={t("common.field.currency")}
              value={visibleFields.currency}
              choices={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
              onChange={(value) => updateField("currency", value)}
            />
          )}
          <TextField
            label={t("expenses.editor.gross")}
            keyboardType="decimal-pad"
            value={visibleFields.total}
            disabled={submitted}
            onChangeText={(value) => updateField("total", value)}
          />
          <TextField
            label={t("common.field.note")}
            value={visibleFields.note}
            disabled={submitted}
            onChangeText={(value) => updateField("note", value)}
          />
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  captureButtons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  fileRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
