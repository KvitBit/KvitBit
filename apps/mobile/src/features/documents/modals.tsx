/**
 * Action modals for the Document detail screen: record/remove payment, send email, cancel,
 * create credit note, and unlock.
 */
import type {
  CurrencyCode,
  DeliveryPurpose,
  DocumentView,
  IsoDate,
  LineId,
  Locale,
  PaymentMethod,
} from "@kvitbit/domain/contract";
import { MoneyMath } from "@kvitbit/domain/contract";
import { formatMoney, parseIsoDate } from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import { BigDecimal } from "effect";
import { useEffect, useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useTheme } from "../../theme/theme-provider";
import { Banner, Button, SegmentedChoice, SwitchRow, Text, TextField } from "../../ui";
import {
  decimalToInputString,
  type LineItemView,
  parseDecimalInput,
  todayIsoPrague,
} from "./codecs";
import { PAYMENT_METHODS } from "./editor-model";

function DialogShell(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly actions: React.ReactNode;
}) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Modal transparent visible={props.visible} animationType="fade" onRequestClose={props.onClose}>
      <View
        className="flex-1 items-center justify-center p-4"
        style={{ backgroundColor: `${c.scrim}66` }}
      >
        <View
          className="max-h-[88%] w-full max-w-[560px] gap-3 bg-surface-container-high p-6"
          style={{ borderRadius: theme.shape.panel + 12 }}
        >
          <Text variant="headlineSmall">{props.title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3">
            {props.children}
          </ScrollView>
          <View className="flex-row justify-end gap-2">{props.actions}</View>
        </View>
      </View>
    </Modal>
  );
}

// --- Record payment modal -----------------------------------------------------------------------

export interface RecordPaymentFormValues {
  readonly amount: BigDecimal.BigDecimal;
  readonly paidOn: IsoDate;
  readonly method: PaymentMethod;
  readonly note: string;
}

export function RecordPaymentModal(props: {
  readonly visible: boolean;
  readonly currency: CurrencyCode;
  readonly defaultAmount: BigDecimal.BigDecimal;
  readonly defaultMethod: PaymentMethod;
  readonly showPtdNotice: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: RecordPaymentFormValues) => void;
}) {
  const { t, local } = useI18n();
  const [amountText, setAmountText] = useState(() => decimalToInputString(props.defaultAmount));
  const [paidOn, setPaidOn] = useState<string>(() => todayIsoPrague());
  const [method, setMethod] = useState<PaymentMethod>(props.defaultMethod);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) {
      setAmountText(decimalToInputString(props.defaultAmount));
      setPaidOn(todayIsoPrague());
      setMethod(props.defaultMethod);
      setNote("");
      setError(null);
    }
  }, [props.visible, props.defaultAmount, props.defaultMethod]);

  const submit = () => {
    const parsedAmount = parseDecimalInput(amountText);
    if (
      parsedAmount === null ||
      BigDecimal.isLessThanOrEqualTo(parsedAmount, BigDecimal.fromBigInt(0n))
    ) {
      setError(local({ cs: "Zadejte kladnou částku.", en: "Enter a positive amount." }));
      return;
    }
    if (parseIsoDate(paidOn) === undefined) {
      setError(local({ cs: "Použijte datum RRRR-MM-DD.", en: "Use YYYY-MM-DD date format." }));
      return;
    }
    setError(null);
    props.onSubmit({
      amount: parsedAmount,
      paidOn: paidOn as IsoDate,
      method,
      note: note.trim(),
    });
  };

  return (
    <DialogShell
      visible={props.visible}
      title={t("documents.payment.title")}
      onClose={props.onClose}
      actions={
        <>
          <Button kind="text" label={t("common.action.cancel")} onPress={props.onClose} />
          <Button
            kind="filled"
            label={t("documents.payment.title")}
            busy={props.busy}
            testID="payment-modal-submit"
            onPress={submit}
          />
        </>
      }
    >
      {error !== null ? <Banner text={error} /> : null}
      {props.showPtdNotice ? <Banner tone="info" text={t("documents.payment.ptdNotice")} /> : null}
      <Text variant="meta" color="onSurfaceVariant">
        {t("documents.payment.currencyFixed", { currency: props.currency })}
      </Text>
      <TextField
        label={t("documents.payment.amount")}
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="decimal-pad"
        testID="payment-amount-input"
      />
      <TextField
        label={t("documents.payment.date")}
        value={paidOn}
        onChangeText={setPaidOn}
        placeholder="YYYY-MM-DD"
        testID="payment-date-input"
      />
      <SegmentedChoice
        label={t("documents.payment.method")}
        value={method}
        choices={PAYMENT_METHODS.map((m) => ({ value: m, label: t(enumKey("paymentMethod", m)) }))}
        onChange={setMethod}
      />
      <TextField label={t("common.field.note")} value={note} onChangeText={setNote} />
    </DialogShell>
  );
}

// --- Remove payment modal -----------------------------------------------------------------------

export function RemovePaymentModal(props: {
  readonly visible: boolean;
  readonly hasTaxDocument: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => void;
}) {
  const { t, local } = useI18n();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) {
      setReason("");
      setError(null);
    }
  }, [props.visible]);

  const submit = () => {
    if (reason.trim() === "") {
      setError(local({ cs: "Zadejte důvod odstranění.", en: "Enter a reason." }));
      return;
    }
    setError(null);
    props.onSubmit(reason.trim());
  };

  return (
    <DialogShell
      visible={props.visible}
      title={t("documents.payment.removeTitle")}
      onClose={props.onClose}
      actions={
        <>
          <Button kind="text" label={t("common.action.cancel")} onPress={props.onClose} />
          <Button
            kind="danger"
            label={t("common.action.remove")}
            busy={props.busy}
            testID="remove-payment-submit"
            onPress={submit}
          />
        </>
      }
    >
      <Text variant="bodyMedium" color="onSurfaceVariant">
        {t("documents.payment.removeBody")}
      </Text>
      {props.hasTaxDocument ? (
        <Banner
          tone="warning"
          text={local({
            cs: "Vystavený daňový doklad k přijaté platbě zůstane zachován; opravte jej dobropisem.",
            en: "The issued payment tax document stays issued and needs a credit note if wrong.",
          })}
        />
      ) : null}
      <TextField
        label={t("common.confirm.reasonLabel")}
        value={reason}
        onChangeText={setReason}
        error={error}
        testID="remove-payment-reason"
      />
    </DialogShell>
  );
}

// --- Send email modal ---------------------------------------------------------------------------

export interface SendEmailFormValues {
  readonly to: ReadonlyArray<string>;
  readonly language: Locale;
  readonly purpose: DeliveryPurpose;
  readonly reminders: boolean;
}

export function SendEmailModal(props: {
  readonly visible: boolean;
  readonly numberLabel: string;
  readonly defaultRecipients: ReadonlyArray<string>;
  readonly defaultLanguage: Locale;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: SendEmailFormValues) => void;
}) {
  const { t } = useI18n();
  const [recipientsText, setRecipientsText] = useState(() => props.defaultRecipients.join(", "));
  const [language, setLanguage] = useState<Locale>(props.defaultLanguage);
  const [purpose, setPurpose] = useState<DeliveryPurpose>("document");
  const [reminders, setReminders] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) {
      setRecipientsText(props.defaultRecipients.join(", "));
      setLanguage(props.defaultLanguage);
      setPurpose("document");
      setReminders(true);
      setError(null);
    }
  }, [props.visible, props.defaultRecipients, props.defaultLanguage]);

  const submit = () => {
    const emails = recipientsText
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (emails.length === 0) {
      setError(t("documents.send.noRecipient"));
      return;
    }
    setError(null);
    props.onSubmit({ to: emails, language, purpose, reminders });
  };

  return (
    <DialogShell
      visible={props.visible}
      title={t("documents.send.title", { number: props.numberLabel })}
      onClose={props.onClose}
      actions={
        <>
          <Button kind="text" label={t("common.action.cancel")} onPress={props.onClose} />
          <Button
            kind="filled"
            label={t("documents.send.submit")}
            busy={props.busy}
            testID="send-email-submit"
            onPress={submit}
          />
        </>
      }
    >
      <TextField
        label={t("documents.send.to")}
        value={recipientsText}
        onChangeText={setRecipientsText}
        placeholder="billing@example.cz"
        keyboardType="email-address"
        autoCapitalize="none"
        error={error}
        testID="send-email-to"
      />
      <SegmentedChoice
        label={t("documents.send.language")}
        value={language}
        choices={[
          { value: "cs", label: t(enumKey("locale", "cs")) },
          { value: "en", label: t(enumKey("locale", "en")) },
        ]}
        onChange={setLanguage}
      />
      <SegmentedChoice
        label={t("documents.send.purpose")}
        value={purpose}
        choices={[
          { value: "document", label: t(enumKey("deliveryPurpose", "document")) },
          { value: "reminder", label: t(enumKey("deliveryPurpose", "reminder")) },
        ]}
        onChange={setPurpose}
      />
      {purpose === "document" ? (
        <SwitchRow
          label={t("documents.send.reminders")}
          description={t("documents.send.remindersHint")}
          value={reminders}
          onChange={setReminders}
        />
      ) : null}
      <Text variant="meta" color="onSurfaceVariant">
        {t("documents.send.attachPdf")}
      </Text>
    </DialogShell>
  );
}

// --- Cancel document modal ----------------------------------------------------------------------

export function CancelDocumentModal(props: {
  readonly visible: boolean;
  readonly numberLabel: string;
  readonly isTaxDocument: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: { readonly reason: string; readonly on?: IsoDate }) => void;
}) {
  const { t, local } = useI18n();
  const [reason, setReason] = useState("");
  const [onDate, setOnDate] = useState<string>(() => todayIsoPrague());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) {
      setReason("");
      setOnDate(todayIsoPrague());
      setError(null);
    }
  }, [props.visible]);

  const submit = () => {
    if (reason.trim() === "") {
      setError(local({ cs: "Zadejte důvod storna.", en: "Enter a reason." }));
      return;
    }
    if (onDate.trim() !== "" && parseIsoDate(onDate) === undefined) {
      setError(local({ cs: "Použijte datum RRRR-MM-DD.", en: "Use YYYY-MM-DD date format." }));
      return;
    }
    setError(null);
    props.onSubmit({
      reason: reason.trim(),
      ...(onDate.trim() !== "" ? { on: onDate as IsoDate } : {}),
    });
  };

  return (
    <DialogShell
      visible={props.visible}
      title={t("documents.cancel.title", { number: props.numberLabel })}
      onClose={props.onClose}
      actions={
        <>
          <Button kind="text" label={t("common.action.cancel")} onPress={props.onClose} />
          <Button
            kind="danger"
            label={t("documents.cancel.confirm")}
            busy={props.busy}
            testID="cancel-document-submit"
            onPress={submit}
          />
        </>
      }
    >
      <Banner
        tone="warning"
        text={
          props.isTaxDocument ? t("documents.cancel.taxBody") : t("documents.cancel.nonTaxBody")
        }
      />
      <TextField
        label={t("documents.cancel.reason")}
        value={reason}
        onChangeText={setReason}
        error={error}
        testID="cancel-reason-input"
      />
      <TextField
        label={t("documents.cancel.date")}
        value={onDate}
        onChangeText={setOnDate}
        placeholder="YYYY-MM-DD"
      />
    </DialogShell>
  );
}

// --- Credit note modal --------------------------------------------------------------------------

export interface CreditNoteFormValues {
  readonly reason: string;
  readonly correctedOn?: IsoDate;
  readonly lines:
    | "full"
    | ReadonlyArray<{
        readonly line: LineId;
        readonly quantity?: BigDecimal.BigDecimal;
      }>;
}

export function CreditNoteModal(props: {
  readonly visible: boolean;
  readonly doc: DocumentView;
  readonly parsedLines: ReadonlyArray<LineItemView>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (values: CreditNoteFormValues) => void;
}) {
  const { t, locale, local } = useI18n();
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [reason, setReason] = useState("");
  const [correctedOn, setCorrectedOn] = useState<string>(() => todayIsoPrague());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) {
      setMode("full");
      setReason("");
      setCorrectedOn(todayIsoPrague());
      const init: Record<string, string> = {};
      for (const line of props.parsedLines) {
        init[line.id] = decimalToInputString(line.quantity);
      }
      setQuantities(init);
      setError(null);
    }
  }, [props.visible, props.parsedLines]);

  const submit = () => {
    if (reason.trim() === "") {
      setError(local({ cs: "Zadejte důvod opravy.", en: "Enter a correction reason." }));
      return;
    }
    if (correctedOn.trim() !== "" && parseIsoDate(correctedOn) === undefined) {
      setError(local({ cs: "Použijte datum RRRR-MM-DD.", en: "Use YYYY-MM-DD date format." }));
      return;
    }
    if (mode === "full") {
      setError(null);
      props.onSubmit({
        reason: reason.trim(),
        lines: "full",
        ...(correctedOn.trim() !== "" ? { correctedOn: correctedOn as IsoDate } : {}),
      });
      return;
    }
    const selected: Array<{ readonly line: LineId; readonly quantity: BigDecimal.BigDecimal }> = [];
    for (const line of props.parsedLines) {
      const parsed = parseDecimalInput(quantities[line.id] ?? "");
      if (parsed !== null && BigDecimal.isGreaterThan(parsed, BigDecimal.fromBigInt(0n))) {
        selected.push({ line: line.id, quantity: parsed });
      }
    }
    if (selected.length === 0) {
      setError(
        local({
          cs: "Vyberte alespoň jednu položku s kladným množstvím.",
          en: "Enter a positive quantity on at least one line.",
        }),
      );
      return;
    }
    setError(null);
    props.onSubmit({
      reason: reason.trim(),
      lines: selected,
      ...(correctedOn.trim() !== "" ? { correctedOn: correctedOn as IsoDate } : {}),
    });
  };

  return (
    <DialogShell
      visible={props.visible}
      title={t("documents.creditNote.title", { number: props.doc.number ?? "" })}
      onClose={props.onClose}
      actions={
        <>
          <Button kind="text" label={t("common.action.cancel")} onPress={props.onClose} />
          <Button
            kind="filled"
            label={t("documents.creditNote.submit")}
            busy={props.busy}
            testID="credit-note-submit"
            onPress={submit}
          />
        </>
      }
    >
      {error !== null ? <Banner text={error} /> : null}
      <Banner tone="info" text={t("documents.creditNote.inheritsRate")} />
      <SegmentedChoice
        value={mode}
        choices={[
          { value: "full", label: t("documents.creditNote.full") },
          { value: "partial", label: t("documents.creditNote.partial") },
        ]}
        onChange={setMode}
      />
      <TextField
        label={t("documents.creditNote.reason")}
        placeholder={t("documents.creditNote.reasonHint")}
        value={reason}
        onChangeText={setReason}
        testID="credit-note-reason"
      />
      <TextField
        label={t("common.field.date")}
        value={correctedOn}
        onChangeText={setCorrectedOn}
        placeholder="YYYY-MM-DD"
      />
      {mode === "partial" ? (
        <View className="gap-2">
          <Text variant="labelMedium" color="onSurfaceVariant">
            {t("documents.creditNote.pickLines")}
          </Text>
          {props.parsedLines.map((line) => (
            <TextField
              key={line.id}
              label={`${line.description} (${formatMoney(
                locale,
                MoneyMath.make(line.unitPrice, props.doc.totals.gross.currency),
              )})`}
              value={quantities[line.id] ?? ""}
              onChangeText={(value) => setQuantities((prev) => ({ ...prev, [line.id]: value }))}
              keyboardType="decimal-pad"
            />
          ))}
        </View>
      ) : null}
    </DialogShell>
  );
}

// --- Unlock document modal ----------------------------------------------------------------------

export function UnlockDocumentModal(props: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => void;
}) {
  const { t, local } = useI18n();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.visible) {
      setReason("");
      setError(null);
    }
  }, [props.visible]);

  const submit = () => {
    if (reason.trim() === "") {
      setError(local({ cs: "Zadejte důvod odemknutí.", en: "Enter a reason." }));
      return;
    }
    setError(null);
    props.onSubmit(reason.trim());
  };

  return (
    <DialogShell
      visible={props.visible}
      title={t("documents.detail.unlockTitle")}
      onClose={props.onClose}
      actions={
        <>
          <Button kind="text" label={t("common.action.cancel")} onPress={props.onClose} />
          <Button
            kind="filled"
            label={t("documents.detail.unlock")}
            busy={props.busy}
            testID="unlock-document-submit"
            onPress={submit}
          />
        </>
      }
    >
      <Text variant="bodyMedium" color="onSurfaceVariant">
        {t("documents.detail.unlockBody")}
      </Text>
      <TextField
        label={t("common.confirm.reasonLabel")}
        value={reason}
        onChangeText={setReason}
        error={error}
        testID="unlock-reason-input"
      />
    </DialogShell>
  );
}
