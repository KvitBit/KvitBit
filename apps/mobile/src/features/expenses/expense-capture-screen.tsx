import type { ExpenseId } from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Camera,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { fromMobilePromise } from "../../runtime/request-intent";
import {
  Badge,
  Banner,
  Button,
  Card,
  IconButton,
  Screen,
  Section,
  SegmentedChoice,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { runFeatureEffect, runFeatureSync } from "../ui-effect";
import { encodeCaptureJournal } from "./capture-journal";
import { defaultReceiptPicker, type PickerOutcome, type ReceiptPicker } from "./capture-picker";
import {
  type CaptureAccess,
  type CaptureFields,
  type CaptureJob,
  canRetryCapture,
} from "./capture-queue";
import { captureQueue } from "./capture-queue-instance";
import { COMMON_CURRENCIES, formatBytes } from "./model";
import { useCaptureAccess, useCaptureNetwork } from "./use-expense-capture";

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
      key={runFeatureSync(
        encodeCaptureJournal([
          principalId,
          workspaceId,
          props.targetExpenseId ?? null,
          props.captureId ?? null,
        ]),
      )}
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
  const job = Option.getOrUndefined(
    Arr.findFirst(
      jobs,
      (item) =>
        item.targetExpenseId === targetExpenseId &&
        item.done !== true &&
        (captureId === undefined || item.key === captureId),
    ),
  );
  const staged = job?.files ?? [];
  const failure = job?.submission?.failure;
  const submitted = job?.submission !== undefined;
  const visibleFields = job?.submission?.fields ?? fields;

  useEffect(() => {
    let active = true;
    const refresh = () =>
      runFeatureEffect(
        fromMobilePromise(() => captureQueue.load(access.scope)).pipe(
          Effect.match({
            onSuccess: (loaded) => {
              if (active) setJobs(loaded);
            },
            onFailure: () => {
              if (active) setBannerError(t("error.unknown"));
            },
          }),
        ),
      );
    const unsubscribe = captureQueue.subscribe((scope) => {
      if (
        scope.workspaceId === access.scope.workspaceId &&
        scope.principalId === access.scope.principalId
      ) {
        refresh();
      }
    });
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [access, t]);

  function updateField(key: keyof CaptureFields, value: string) {
    if (!(submitted || busy.current)) setFields((previous) => ({ ...previous, [key]: value }));
  }

  const pick = Effect.fn("ExpenseCapture.pick")(function* (open: () => Promise<PickerOutcome>) {
    if (!access.canWrite() || submitted || busy.current) return;
    busy.current = true;
    setBannerError(null);
    yield* Effect.gen(function* () {
      const outcome = yield* fromMobilePromise(open);
      if (!access.canWrite() || outcome._tag === "Cancelled") return;
      if (outcome._tag === "PermissionDenied") {
        setBannerError(t("expenses.capture.cameraDenied"));
        return;
      }
      if (outcome._tag === "Error") {
        setBannerError(outcome.message);
        return;
      }
      const result = yield* fromMobilePromise(() =>
        captureQueue.stage(access, targetExpenseId, outcome.files),
      );
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
    }).pipe(
      Effect.orElseSucceed(() => setBannerError(t("error.unknown"))),
      Effect.ensuring(
        Effect.sync(() => {
          busy.current = false;
        }),
      ),
    );
  }, runFeatureEffect);

  const uploadAll = Effect.fn("ExpenseCapture.uploadAll")(function* () {
    if (!access.canWrite() || busy.current || job === undefined || !canRetryCapture(job)) return;
    busy.current = true;
    setBannerError(null);
    setSubmitting(true);
    yield* Effect.gen(function* () {
      const result = yield* fromMobilePromise(() =>
        captureQueue.submit(access, network, job.key, fields, (key, value) =>
          setProgress({ key, percent: Math.round(value * 100) }),
        ),
      );
      if (result?.done === true && result.expenseId !== null && access.canWrite()) {
        const rejected = Arr.some(result.files, (receipt) => receipt.result?.kind === "rejected");
        overlay.toast(t(rejected ? "error.invalid" : "common.toast.saved"));
        navigate(
          { _tag: "Expense", ws: access.scope.workspaceSlug, id: result.expenseId, mode: "edit" },
          { replace: true },
        );
      }
    }).pipe(
      Effect.orElseSucceed(() => setBannerError(t("error.unknown"))),
      Effect.ensuring(
        Effect.sync(() => {
          setProgress(null);
          setSubmitting(false);
          busy.current = false;
        }),
      ),
    );
  }, runFeatureEffect);

  const discardJob = Effect.fn("ExpenseCapture.discard")(function* () {
    if (!access.canWrite() || job === undefined || busy.current) return;
    const confirmed = yield* fromMobilePromise(() =>
      overlay.confirm({
        title: local({ cs: "Odstranit místní kopie?", en: "Discard local copies?" }),
        body: local({
          cs: "Přijaté účtenky budou z tohoto zařízení odstraněny.",
          en: "The queued receipts will be removed from this device.",
        }),
        confirmLabel: t("common.action.discard"),
        cancelLabel: t("common.action.cancel"),
        destructive: true,
      }),
    );
    if (!(confirmed && access.canWrite())) return;
    yield* fromMobilePromise(() => captureQueue.discard(access, job.key)).pipe(
      Effect.match({
        onFailure: () => setBannerError(t("error.unknown")),
        onSuccess: () => {
          setCaptureId(undefined);
          setBannerError(null);
        },
      }),
    );
  }, runFeatureEffect);

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
          onPress={() => uploadAll()}
          testID="capture-upload-btn"
        />
      }
    >
      {shownError === null ? null : <Banner text={shownError} />}
      {failure?.kind === "blocked" || failure?.kind === "expired" ? (
        <Button kind="text" label={t("common.action.discard")} onPress={() => discardJob()} />
      ) : null}

      {submitted ? null : (
        <Card>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {t("expenses.capture.edgeHint")}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              icon={Camera}
              label={t("expenses.capture.takePhoto")}
              onPress={() => pick(picker.takePhoto)}
              testID="capture-camera-btn"
            />
            <Button
              kind="tonal"
              icon={ImageIcon}
              label={t("expenses.capture.gallery")}
              onPress={() => pick(picker.pickFromGallery)}
              testID="capture-gallery-btn"
            />
            <Button
              kind="outlined"
              icon={FileText}
              label={t("expenses.capture.files")}
              onPress={() => pick(picker.pickDocument)}
              testID="capture-file-btn"
            />
          </View>
        </Card>
      )}

      {job === undefined ? null : (
        <Section title={t("expenses.capture.pages", { count: staged.length })}>
          {Arr.map(staged, (item) => {
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
                <View className="flex-row items-center gap-2">
                  <View className="flex-1">
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
                        {(() => {
                          const view = describeError(item.result.error);
                          return view.issues.length > 0
                            ? Arr.join(
                                Arr.map(view.issues, (issue) => text(issue.text)),
                                " · ",
                              )
                            : text(view.text);
                        })()}
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
                        captureQueue
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
              choices={Arr.map(COMMON_CURRENCIES, (c) => ({ value: c, label: c }))}
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
