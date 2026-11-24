import type { ExpenseId, ExpenseInput } from "@kvitbit/domain/contract";
import { describeError, idempotencyHeaders, uuidV7 } from "@kvitbit/ui-port/api";
import { Effect } from "effect";
import {
  Camera,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { type LocalFile, useTransfer } from "../../platform/transfer";
import { useApi } from "../../runtime/api-runtime";
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
import { useWorkspace } from "../../workspace/workspace-provider";
import { defaultReceiptPicker, type PickerOutcome, type ReceiptPicker } from "./capture-picker";
import {
  COMMON_CURRENCIES,
  decodeExpenseDetail,
  formatBytes,
  validateAttachmentFile,
} from "./model";

interface StagedReceipt {
  readonly id: string;
  readonly file: LocalFile;
  readonly state: "queued" | "uploading" | "done" | "failed";
  readonly progress: number;
  readonly error?: string;
}

export function ExpenseCaptureScreen(props: {
  readonly picker?: ReceiptPicker;
  readonly targetExpenseId?: ExpenseId;
}) {
  const picker = props.picker ?? defaultReceiptPicker;
  const { workspace } = useWorkspace();
  const { t, text, local } = useI18n();
  const api = useApi();
  const transfer = useTransfer();
  const overlay = useOverlay();

  const [staged, setStaged] = useState<ReadonlyArray<StagedReceipt>>([]);
  const [supplierName, setSupplierName] = useState("");
  const [total, setTotal] = useState("");
  const [currency, setCurrency] = useState("CZK");
  const [note, setNote] = useState("");
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [createdExpenseId, setCreatedExpenseId] = useState<ExpenseId | null>(
    props.targetExpenseId ?? null,
  );
  const [submitting, setSubmitting] = useState(false);

  const acceptPickerOutcome = useCallback(
    (outcome: PickerOutcome) => {
      setBannerError(null);
      if (outcome._tag === "Cancelled") return;
      if (outcome._tag === "PermissionDenied") {
        setBannerError(t("expenses.capture.cameraDenied"));
        return;
      }
      if (outcome._tag === "Error") {
        setBannerError(outcome.message);
        return;
      }
      const next: Array<StagedReceipt> = [];
      for (const file of outcome.files) {
        const issue = validateAttachmentFile(file);
        if (issue === "too_large") {
          setBannerError(
            local({ cs: "Soubor je větší než 20 MB.", en: "File exceeds 20 MB limit." }),
          );
          continue;
        }
        if (issue === "unsupported_type") {
          setBannerError(
            t("expenses.attachmentViewer.allowedTypes", { types: "PDF, JPEG, PNG, HEIC" }),
          );
          continue;
        }
        next.push({
          id: `${file.sha256}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          state: "queued",
          progress: 0,
        });
      }
      if (next.length > 0) {
        setStaged((prev) => [...prev, ...next]);
      }
    },
    [local, t],
  );

  const handleTakePhoto = useCallback(async () => {
    acceptPickerOutcome(await picker.takePhoto());
  }, [acceptPickerOutcome, picker]);

  const handlePickGallery = useCallback(async () => {
    acceptPickerOutcome(await picker.pickFromGallery());
  }, [acceptPickerOutcome, picker]);

  const handlePickDocument = useCallback(async () => {
    acceptPickerOutcome(await picker.pickDocument());
  }, [acceptPickerOutcome, picker]);

  const removeStaged = useCallback((index: number) => {
    setStaged((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const uploadAll = useCallback(async () => {
    if (staged.length === 0) {
      setBannerError(
        local({
          cs: "Nejprve vyfoťte účtenku nebo vyberte soubor.",
          en: "Take a photo or choose a file first.",
        }),
      );
      return;
    }
    setBannerError(null);
    setSubmitting(true);

    let targetId = createdExpenseId;
    if (targetId === null) {
      const key = await Effect.runPromise(uuidV7);
      const cleanedTotal = total.trim().replace(/\s+/g, "").replace(",", ".");
      const payload: Record<string, unknown> = {
        status: "incomplete",
        currency: currency.trim().toUpperCase() || "CZK",
        ...(supplierName.trim() !== ""
          ? { supplier: { manual: { name: supplierName.trim() } } }
          : {}),
        ...(cleanedTotal !== "" && /^\d+(?:\.\d+)?$/.test(cleanedTotal)
          ? { total: cleanedTotal }
          : {}),
        ...(note.trim() !== "" ? { note: note.trim() } : {}),
      };
      const created = await api.run((client) =>
        client.expenses.record({
          params: { workspaceId: workspace.id },
          headers: idempotencyHeaders(key),
          payload: payload as ExpenseInput,
        }),
      );
      if (created._tag === "Err") {
        setSubmitting(false);
        setBannerError(text(describeError(created.error).text));
        return;
      }
      targetId = decodeExpenseDetail(created.value).id;
      setCreatedExpenseId(targetId);
    }

    let anyFailed = false;
    for (let i = 0; i < staged.length; i++) {
      const item = staged[i];
      if (item === undefined || item.state === "done") continue;
      setStaged((prev) =>
        prev.map((entry, idx) =>
          idx === i ? { ...entry, state: "uploading", progress: 0 } : entry,
        ),
      );
      const res = await transfer.upload({
        path: `/workspaces/${workspace.id}/expenses/${targetId}/attachments`,
        file: item.file,
        onProgress: (p) => {
          setStaged((prev) =>
            prev.map((entry, idx) =>
              idx === i ? { ...entry, progress: Math.round(p * 100) } : entry,
            ),
          );
        },
      });
      if (res._tag === "Ok") {
        setStaged((prev) =>
          prev.map((entry, idx) =>
            idx === i ? { ...entry, state: "done", progress: 100 } : entry,
          ),
        );
      } else {
        anyFailed = true;
        const msg = text(describeError(res.error).text);
        setStaged((prev) =>
          prev.map((entry, idx) => (idx === i ? { ...entry, state: "failed", error: msg } : entry)),
        );
      }
    }

    setSubmitting(false);
    if (anyFailed) {
      setBannerError(
        local({
          cs: "Některé soubory se nepodařilo nahrát. Zkuste to znovu.",
          en: "Some files failed to upload. Retry to finish.",
        }),
      );
      return;
    }

    overlay.toast(t("common.toast.saved"));
    navigate(
      { _tag: "Expense", ws: workspace.slug, id: targetId, mode: "edit" },
      { replace: true },
    );
  }, [
    api,
    createdExpenseId,
    currency,
    local,
    note,
    overlay,
    staged,
    supplierName,
    t,
    text,
    total,
    transfer,
    workspace,
  ]);

  const hasFailed = staged.some((s) => s.state === "failed");

  return (
    <Screen
      title={t("expenses.capture.title")}
      back
      footer={
        <Button
          icon={hasFailed ? RefreshCw : Upload}
          label={hasFailed ? t("common.action.retry") : t("common.action.upload")}
          busy={submitting}
          disabled={staged.length === 0}
          onPress={() => void uploadAll()}
          testID="capture-upload-btn"
        />
      }
    >
      {bannerError === null ? null : <Banner text={bannerError} />}

      <Card>
        <Text variant="bodyMedium" color="onSurfaceVariant">
          {t("expenses.capture.edgeHint")}
        </Text>
        <View style={styles.captureButtons}>
          <Button
            icon={Camera}
            label={t("expenses.capture.takePhoto")}
            onPress={() => void handleTakePhoto()}
            testID="capture-camera-btn"
          />
          <Button
            kind="tonal"
            icon={ImageIcon}
            label={t("expenses.capture.gallery")}
            onPress={() => void handlePickGallery()}
            testID="capture-gallery-btn"
          />
          <Button
            kind="outlined"
            icon={FileText}
            label={t("expenses.capture.files")}
            onPress={() => void handlePickDocument()}
            testID="capture-file-btn"
          />
        </View>
      </Card>

      {staged.length === 0 ? null : (
        <Section title={t("expenses.capture.pages", { count: staged.length })}>
          {staged.map((item, idx) => (
            <Card key={item.id}>
              <View style={styles.fileRow}>
                <View style={styles.flex}>
                  <Text variant="row" numberOfLines={1}>
                    {item.file.name}
                  </Text>
                  <Text variant="meta" color="onSurfaceVariant">
                    {item.file.contentType} · {formatBytes(item.file.size)}
                  </Text>
                  {item.state === "uploading" ? (
                    <Text variant="meta" color="primary">
                      {t("common.state.uploadingPercent", { percent: item.progress })}
                    </Text>
                  ) : null}
                  {item.error === undefined ? null : (
                    <Text variant="bodySmall" color="error">
                      {item.error}
                    </Text>
                  )}
                </View>
                <Badge
                  label={t(`enum.captureJob.${item.state}`)}
                  tone={
                    item.state === "done" ? "success" : item.state === "failed" ? "danger" : "info"
                  }
                />
                {item.state === "uploading" ? null : (
                  <IconButton
                    icon={Trash2}
                    label={t("common.action.remove")}
                    onPress={() => removeStaged(idx)}
                  />
                )}
              </View>
            </Card>
          ))}
        </Section>
      )}

      {props.targetExpenseId !== undefined ? null : (
        <Section title={local({ cs: "Rychlé údaje (nepovinné)", en: "Quick details (optional)" })}>
          <TextField
            label={t("expenses.editor.supplier")}
            value={supplierName}
            onChangeText={setSupplierName}
          />
          <SegmentedChoice
            label={t("common.field.currency")}
            value={currency}
            choices={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
            onChange={setCurrency}
          />
          <TextField
            label={t("expenses.editor.gross")}
            keyboardType="decimal-pad"
            value={total}
            onChangeText={setTotal}
          />
          <TextField label={t("common.field.note")} value={note} onChangeText={setNote} />
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
