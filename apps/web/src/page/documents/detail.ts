/**
 * Screen 11 — Document Detail & Action Dialogs: invoice preview, Payments list, Share Link
 * create/copy/revoke, Send email dialog, Record Payment dialog, Proforma -> PTD -> Final Invoice
 * settlement flow, Issue Credit Note dialog, Lock/Unlock/Cancel, PDF download link, Audit History.
 */
import {
  AuditEntry,
  type DeliveryPurpose,
  type DocumentId,
  DocumentView,
  type Locale,
  MoneyMath,
  type PaymentId,
  type PaymentMethod,
  ShareViewEvent,
  type WorkspaceId,
} from "@kvitbit/domain";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Effect, Schema } from "effect";
import { type Command, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Failure, type WebServices } from "../../app/api";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import {
  amount,
  badge,
  banner,
  button,
  card,
  cardTitle,
  checkbox,
  dialog,
  dl,
  emptyState,
  linkButton,
  mono,
  page,
  pageHeader,
  selectField,
  skeleton,
  table,
  tabs,
  textField,
} from "../../ui/kit";
import {
  apiCommand,
  copyTextCommand,
  documentBadges,
  documentHasFinalInvoice,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtNum,
  fmtVatRate,
  formatAddress,
  ifMatch,
  isIsoDateString,
  kindBadge,
  PaymentViewData,
  parseDecimalText,
  readContactSnapshot,
  readIssuerSnapshot,
  readLines,
  readPayments,
  sharedCopy,
  todayPrague,
  withIdempotencyKey,
} from "./shared";

export type Route = RouteOf<"Document">;

const CopyTable: Copy<
  | "title"
  | "draftTitle"
  | "backToList"
  | "editAction"
  | "issueAction"
  | "sendAction"
  | "recordPaymentAction"
  | "finalInvoiceAction"
  | "creditNoteAction"
  | "lockAction"
  | "unlockAction"
  | "cancelAction"
  | "pdfAction"
  | "discardDraftAction"
  | "tabPreview"
  | "tabPayments"
  | "tabShare"
  | "tabHistory"
  | "tabsLabel"
  | "issuerLabel"
  | "customerLabel"
  | "issuedOn"
  | "taxableSupplyOn"
  | "dueOn"
  | "paymentMethod"
  | "bankAccount"
  | "colDesc"
  | "colQty"
  | "colPrice"
  | "colVat"
  | "colTotal"
  | "linesCaption"
  | "vatSummary"
  | "netTotal"
  | "vatTotal"
  | "grandTotal"
  | "vatCzkTotal"
  | "statutoryNotes"
  | "relatedDocs"
  | "deliveriesTitle"
  | "noDeliveries"
  | "paymentsEmpty"
  | "paymentsCaption"
  | "payColDate"
  | "payColMethod"
  | "payColAmount"
  | "payColNote"
  | "payColTaxDoc"
  | "payColActions"
  | "removePayment"
  | "viewTaxDoc"
  | "shareTitle"
  | "shareCreate"
  | "shareCopy"
  | "shareRevoke"
  | "shareNone"
  | "shareDraftBlocked"
  | "shareStats"
  | "shareEventsTitle"
  | "shareEventsEmpty"
  | "historyEmpty"
  | "dlgSendTitle"
  | "dlgSendTo"
  | "dlgSendLanguage"
  | "dlgSendPurpose"
  | "dlgSendReminders"
  | "dlgSendSubmit"
  | "dlgPayTitle"
  | "dlgPayAmount"
  | "dlgPayDate"
  | "dlgPayMethod"
  | "dlgPayNote"
  | "dlgPaySubmit"
  | "dlgPayPtdToast"
  | "dlgCancelTitle"
  | "dlgCancelReason"
  | "dlgCancelSubmit"
  | "dlgCreditTitle"
  | "dlgCreditReason"
  | "dlgCreditSubmit"
  | "dlgUnlockTitle"
  | "dlgUnlockReason"
  | "dlgUnlockSubmit"
  | "dlgRemovePayTitle"
  | "dlgRemovePayReason"
  | "dlgRemovePaySubmit"
  | "dlgFinalTitle"
  | "dlgFinalBody"
  | "dlgFinalSubmit"
  | "dlgIssueTitle"
  | "dlgIssueBody"
  | "dlgIssueSubmit"
  | "toastSent"
  | "toastPaid"
  | "toastLocked"
  | "toastUnlocked"
  | "toastCancelled"
  | "toastShareCreated"
  | "toastShareRevoked"
  | "toastPaymentRemoved"
  | "toastIssued"
> = {
  cs: {
    title: "Doklad",
    draftTitle: "Koncept dokladu",
    backToList: "Zpět na doklady",
    editAction: "Upravit",
    issueAction: "Vystavit",
    sendAction: "Odeslat e-mailem",
    recordPaymentAction: "Zaznamenat platbu",
    finalInvoiceAction: "Vystavit vyúčtovací fakturu",
    creditNoteAction: "Vystavit opravný doklad",
    lockAction: "Uzamknout",
    unlockAction: "Odemknout",
    cancelAction: "Stornovat",
    pdfAction: "Stáhnout PDF",
    discardDraftAction: "Smazat koncept",
    tabPreview: "Náhled",
    tabPayments: "Platby",
    tabShare: "Sdílený odkaz",
    tabHistory: "Historie",
    tabsLabel: "Sekce dokladu",
    issuerLabel: "Vystavitel",
    customerLabel: "Odběratel",
    issuedOn: "Datum vystavení",
    taxableSupplyOn: "DUZP",
    dueOn: "Datum splatnosti",
    paymentMethod: "Způsob úhrady",
    bankAccount: "Bankovní účet",
    colDesc: "Položka",
    colQty: "Množství",
    colPrice: "Cena / ks",
    colVat: "DPH",
    colTotal: "Celkem",
    linesCaption: "Položky dokladu",
    vatSummary: "Rekapitulace DPH",
    netTotal: "Základ celkem",
    vatTotal: "DPH celkem",
    grandTotal: "Celkem k úhradě",
    vatCzkTotal: "DPH v CZK",
    statutoryNotes: "Zákonné údaje",
    relatedDocs: "Související doklady",
    deliveriesTitle: "Odeslání e-mailem",
    noDeliveries: "Doklad zatím nebyl odeslán.",
    paymentsEmpty: "K tomuto dokladu nejsou zaznamenány žádné platby.",
    paymentsCaption: "Seznam plateb",
    payColDate: "Datum",
    payColMethod: "Způsob",
    payColAmount: "Částka",
    payColNote: "Poznámka",
    payColTaxDoc: "Daňový doklad",
    payColActions: "Akce",
    removePayment: "Odebrat",
    viewTaxDoc: "Zobrazit DDP",
    shareTitle: "Veřejný odkaz pro odběratele",
    shareCreate: "Vytvořit sdílený odkaz",
    shareCopy: "Kopírovat odkaz",
    shareRevoke: "Zneplatnit odkaz",
    shareNone: "Sdílený odkaz zatím nebyl vytvořen.",
    shareDraftBlocked: "Sdílený odkaz lze vytvořit až po vystavení dokladu.",
    shareStats: "Zobrazení: {views}",
    shareEventsTitle: "Poslední přístupy",
    shareEventsEmpty: "Zatím žádná zobrazení ani stažení.",
    historyEmpty: "Zatím žádné záznamy v historii.",
    dlgSendTitle: "Odeslat doklad e-mailem",
    dlgSendTo: "Příjemci (oddělení čárkou)",
    dlgSendLanguage: "Jazyk e-mailu",
    dlgSendPurpose: "Typ zprávy",
    dlgSendReminders: "Zapnout automatické upomínky",
    dlgSendSubmit: "Odeslat",
    dlgPayTitle: "Zaznamenat platbu",
    dlgPayAmount: "Částka",
    dlgPayDate: "Datum platby",
    dlgPayMethod: "Způsob úhrady",
    dlgPayNote: "Poznámka",
    dlgPaySubmit: "Uložit platbu",
    dlgPayPtdToast: "Platba uložena a vystaven daňový doklad k platbě {number}.",
    dlgCancelTitle: "Stornovat doklad",
    dlgCancelReason: "Důvod storna",
    dlgCancelSubmit: "Stornovat doklad",
    dlgCreditTitle: "Vystavit opravný daňový doklad",
    dlgCreditReason: "Důvod opravy",
    dlgCreditSubmit: "Vystavit dobropis",
    dlgUnlockTitle: "Odemknout doklad",
    dlgUnlockReason: "Důvod odemčení",
    dlgUnlockSubmit: "Odemknout",
    dlgRemovePayTitle: "Odebrat platbu",
    dlgRemovePayReason: "Důvod odebrání",
    dlgRemovePaySubmit: "Odebrat platbu",
    dlgFinalTitle: "Vystavit vyúčtovací fakturu",
    dlgFinalBody: "Vystaví konečnou fakturu k této záloze a odečte zaplacené zálohy (§37a).",
    dlgFinalSubmit: "Vystavit vyúčtovací fakturu",
    dlgIssueTitle: "Vystavit koncept",
    dlgIssueBody: "Konceptu bude přiděleno číslo z číselné řady a doklad bude vystaven.",
    dlgIssueSubmit: "Vystavit doklad",
    toastSent: "E-mail byl zařazen k odeslání.",
    toastPaid: "Platba byla zaznamenána.",
    toastLocked: "Doklad byl uzamčen.",
    toastUnlocked: "Doklad byl odemčen.",
    toastCancelled: "Doklad byl stornován.",
    toastShareCreated: "Sdílený odkaz byl vytvořen.",
    toastShareRevoked: "Sdílený odkaz byl zneplatněn.",
    toastPaymentRemoved: "Platba byla odebrána.",
    toastIssued: "Doklad byl vystaven.",
  },
  en: {
    title: "Document",
    draftTitle: "Draft document",
    backToList: "Back to documents",
    editAction: "Edit",
    issueAction: "Issue",
    sendAction: "Send email",
    recordPaymentAction: "Record payment",
    finalInvoiceAction: "Issue final invoice",
    creditNoteAction: "Issue credit note",
    lockAction: "Lock",
    unlockAction: "Unlock",
    cancelAction: "Cancel document",
    pdfAction: "Download PDF",
    discardDraftAction: "Discard draft",
    tabPreview: "Preview",
    tabPayments: "Payments",
    tabShare: "Share link",
    tabHistory: "History",
    tabsLabel: "Document sections",
    issuerLabel: "Issuer",
    customerLabel: "Customer",
    issuedOn: "Issue date",
    taxableSupplyOn: "Tax point",
    dueOn: "Due date",
    paymentMethod: "Payment method",
    bankAccount: "Bank account",
    colDesc: "Description",
    colQty: "Qty",
    colPrice: "Unit price",
    colVat: "VAT",
    colTotal: "Total",
    linesCaption: "Document line items",
    vatSummary: "VAT summary",
    netTotal: "Net total",
    vatTotal: "VAT total",
    grandTotal: "Amount due",
    vatCzkTotal: "VAT in CZK",
    statutoryNotes: "Statutory notes",
    relatedDocs: "Related documents",
    deliveriesTitle: "Email deliveries",
    noDeliveries: "This document has not been emailed yet.",
    paymentsEmpty: "No payments recorded for this document.",
    paymentsCaption: "Payments list",
    payColDate: "Date",
    payColMethod: "Method",
    payColAmount: "Amount",
    payColNote: "Note",
    payColTaxDoc: "Tax document",
    payColActions: "Actions",
    removePayment: "Remove",
    viewTaxDoc: "View PTD",
    shareTitle: "Public share link",
    shareCreate: "Create share link",
    shareCopy: "Copy link",
    shareRevoke: "Revoke link",
    shareNone: "No active share link yet.",
    shareDraftBlocked: "Share links are available once the document is issued.",
    shareStats: "Views: {views}",
    shareEventsTitle: "Recent activity",
    shareEventsEmpty: "No views or downloads yet.",
    historyEmpty: "No audit entries yet.",
    dlgSendTitle: "Send document by email",
    dlgSendTo: "Recipients (comma-separated)",
    dlgSendLanguage: "Email language",
    dlgSendPurpose: "Message type",
    dlgSendReminders: "Enable automatic overdue reminders",
    dlgSendSubmit: "Send",
    dlgPayTitle: "Record payment",
    dlgPayAmount: "Amount",
    dlgPayDate: "Payment date",
    dlgPayMethod: "Payment method",
    dlgPayNote: "Note",
    dlgPaySubmit: "Record payment",
    dlgPayPtdToast: "Payment recorded and payment tax document {number} issued.",
    dlgCancelTitle: "Cancel document",
    dlgCancelReason: "Cancellation reason",
    dlgCancelSubmit: "Cancel document",
    dlgCreditTitle: "Issue credit note",
    dlgCreditReason: "Correction reason",
    dlgCreditSubmit: "Issue credit note",
    dlgUnlockTitle: "Unlock document",
    dlgUnlockReason: "Unlock reason",
    dlgUnlockSubmit: "Unlock",
    dlgRemovePayTitle: "Remove payment",
    dlgRemovePayReason: "Removal reason",
    dlgRemovePaySubmit: "Remove payment",
    dlgFinalTitle: "Issue final invoice",
    dlgFinalBody: "Issues the final invoice for this proforma and deducts paid advances (§37a).",
    dlgFinalSubmit: "Issue final invoice",
    dlgIssueTitle: "Issue draft",
    dlgIssueBody: "Assigns the next number from the numbering series and issues this document.",
    dlgIssueSubmit: "Issue document",
    toastSent: "Email queued for delivery.",
    toastPaid: "Payment recorded.",
    toastLocked: "Document locked.",
    toastUnlocked: "Document unlocked.",
    toastCancelled: "Document cancelled.",
    toastShareCreated: "Share link created.",
    toastShareRevoked: "Share link revoked.",
    toastPaymentRemoved: "Payment removed.",
    toastIssued: "Document issued.",
  },
};

const txt = copy(CopyTable);

const ActiveDialog = Schema.NullOr(
  Schema.Literals([
    "issue",
    "payment",
    "send",
    "cancel",
    "correct",
    "unlock",
    "final",
    "removePayment",
  ]),
);

const DetailBundle = Schema.Struct({
  doc: DocumentView,
  payments: Schema.Array(PaymentViewData),
  history: Schema.Array(AuditEntry),
  shareViews: Schema.Array(ShareViewEvent),
});

export const Model = Schema.Struct({
  route: ViewModels.Route,
  detail: Remote.remoteSchema(DetailBundle),
  activeDialog: ActiveDialog,
  busy: Schema.Boolean,
  dialogError: Schema.NullOr(Schema.String),
  // Send dialog
  sendTo: Schema.String,
  sendLanguage: Schema.Literals(["cs", "en"]),
  sendPurpose: Schema.Literals(["document", "reminder"]),
  sendReminders: Schema.Boolean,
  // Payment dialog
  payAmount: Schema.String,
  payDate: Schema.String,
  payMethod: Schema.Literals(["bank_transfer", "cash", "card", "other"]),
  payNote: Schema.String,
  // Reason dialogs (cancel, credit note, unlock, removePayment)
  reasonText: Schema.String,
  removingPaymentId: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  LoadedDetail: { seq: Remote.Seq, data: DetailBundle },
  FailedDetail: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  OpenedDialog: { dialog: ActiveDialog, paymentId: Schema.optionalKey(Schema.String) },
  ClosedDialog: {},
  ChangedSendTo: { value: Schema.String },
  ChangedSendLanguage: { value: Schema.String },
  ChangedSendPurpose: { value: Schema.String },
  ToggledSendReminders: { checked: Schema.Boolean },
  SubmittedSend: {},
  ChangedPayAmount: { value: Schema.String },
  ChangedPayDate: { value: Schema.String },
  ChangedPayMethod: { value: Schema.String },
  ChangedPayNote: { value: Schema.String },
  SubmittedPayment: {},
  ChangedReason: { value: Schema.String },
  SubmittedCancel: {},
  SubmittedCreditNote: {},
  SubmittedUnlock: {},
  SubmittedRemovePayment: {},
  SubmittedFinalInvoice: {},
  SubmittedIssueDraft: {},
  ClickedLock: {},
  ClickedDiscardDraft: {},
  ClickedCreateShare: {},
  ClickedCopyShare: { url: Schema.String },
  CopiedShare: { ok: Schema.Boolean },
  ClickedRevokeShare: {},
  ActionSucceeded: {
    toast: Schema.String,
    navigateTo: Schema.optionalKey(Schema.String),
    reload: Schema.Boolean,
  },
  ActionFailed: { failure: Failure },
});
export type Message = typeof Message.Type;

const loadDetailCommand = (
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  seq: Remote.Seq,
): Command.Command<Message, never, WebServices> =>
  apiCommand(
    "LoadDocumentDetail",
    (c) =>
      Effect.all({
        doc: c.documents.get({ params: { workspaceId, documentId } }),
        payments: c.payments.listForDocument({ params: { workspaceId, documentId } }),
        history: c.documents.history({ params: { workspaceId, documentId } }),
        shareViews: c.shareLinks
          .views({ params: { workspaceId, documentId }, query: { limit: 25 } })
          .pipe(
            Effect.map((p) => p.items),
            Effect.catch(() => Effect.succeed([])),
          ),
      }),
    (res): Message =>
      Message.LoadedDetail({
        seq,
        data: {
          doc: res.doc,
          payments: readPayments(res.payments),
          history: res.history,
          shareViews: res.shareViews,
        },
      }),
    (failure): Message => Message.FailedDetail({ seq, failure }),
  );

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const today = todayPrague();
  const base: Model = {
    route,
    detail: Remote.idle,
    activeDialog: route.dialog ?? null,
    busy: false,
    dialogError: null,
    sendTo: "",
    sendLanguage: ctx.locale,
    sendPurpose: "document",
    sendReminders: true,
    payAmount: "",
    payDate: today,
    payMethod: "bank_transfer",
    payNote: "",
    reasonText: "",
    removingPaymentId: null,
  };
  if (ctx.workspace === null) return { model: base };
  const detail = Remote.load(Remote.idle);
  return {
    model: { ...base, detail },
    commands: [loadDetailCommand(ctx.workspace.id, route.id, Remote.seqOf(detail))],
  };
};

const reloadDetail = (
  model: Model,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): {
  readonly model: Model;
  readonly commands: ReadonlyArray<Command.Command<Message, never, WebServices>>;
} => {
  const detail = Remote.load(model.detail);
  return {
    model: { ...model, detail },
    commands: [loadDetailCommand(workspaceId, documentId, Remote.seqOf(detail))],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  const route = model.route as Route;
  const bundle = Remote.dataOf(model.detail);

  return Message.match<PageReturn<Model, Message>>(message, {
    LoadedDetail: ({ seq, data }) => {
      const contact = readContactSnapshot(data.doc.contact);
      return {
        model: {
          ...model,
          detail: Remote.succeed(model.detail, seq, data),
          sendTo: model.sendTo === "" ? (contact?.billingEmails.join(", ") ?? "") : model.sendTo,
          payAmount:
            model.payAmount === ""
              ? BigDecimal.format(BigDecimal.normalize(data.doc.totals.gross.amount))
              : model.payAmount,
          payMethod: data.doc.paymentMethod,
        },
      };
    },
    FailedDetail: ({ seq, failure }) => ({
      model: { ...model, detail: Remote.fail(model.detail, seq, failure) },
    }),
    ClickedRetry: () => {
      if (ws === null) return { model };
      return reloadDetail(model, ws.id, route.id);
    },
    OpenedDialog: ({ dialog: dlg, paymentId }) => ({
      model: {
        ...model,
        activeDialog: dlg,
        dialogError: null,
        reasonText: "",
        removingPaymentId: paymentId ?? null,
      },
    }),
    ClosedDialog: () => ({
      model: { ...model, activeDialog: null, dialogError: null, removingPaymentId: null },
    }),
    ChangedSendTo: ({ value }) => ({ model: { ...model, sendTo: value } }),
    ChangedSendLanguage: ({ value }) => ({
      model: { ...model, sendLanguage: value === "en" ? "en" : "cs" },
    }),
    ChangedSendPurpose: ({ value }) => ({
      model: { ...model, sendPurpose: value === "reminder" ? "reminder" : "document" },
    }),
    ToggledSendReminders: ({ checked }) => ({ model: { ...model, sendReminders: checked } }),
    SubmittedSend: () => {
      if (ws === null || model.busy) return { model };
      const recipients = model.sendTo
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "SendDocument",
            (c) =>
              withIdempotencyKey((headers) =>
                c.documents.send({
                  params: { workspaceId: ws.id, documentId: route.id },
                  headers,
                  payload: {
                    ...(recipients.length === 0 ? {} : { to: recipients }),
                    language: model.sendLanguage as Locale,
                    purpose: model.sendPurpose as DeliveryPurpose,
                    reminders: model.sendReminders,
                  },
                }),
              ),
            (): Message =>
              Message.ActionSucceeded({ toast: txt(ctx.locale, "toastSent"), reload: true }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ChangedPayAmount: ({ value }) => ({ model: { ...model, payAmount: value } }),
    ChangedPayDate: ({ value }) => ({ model: { ...model, payDate: value } }),
    ChangedPayMethod: ({ value }) => ({
      model: {
        ...model,
        payMethod:
          value === "cash" || value === "card" || value === "other" ? value : "bank_transfer",
      },
    }),
    ChangedPayNote: ({ value }) => ({ model: { ...model, payNote: value } }),
    SubmittedPayment: () => {
      if (ws === null || bundle === undefined || model.busy) return { model };
      const parsed = parseDecimalText(model.payAmount);
      const amountVal =
        parsed !== undefined ? MoneyMath.make(parsed, bundle.doc.totals.gross.currency) : undefined;
      const paidOn = isIsoDateString(model.payDate) ? model.payDate : undefined;
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "RecordPayment",
            (c) =>
              withIdempotencyKey((headers) =>
                c.payments.record({
                  params: { workspaceId: ws.id },
                  headers,
                  payload: {
                    target: { document: route.id },
                    ...(amountVal === undefined ? {} : { amount: amountVal }),
                    ...(paidOn === undefined ? {} : { paidOn }),
                    method: model.payMethod as PaymentMethod,
                    ...(model.payNote.trim() === "" ? {} : { note: model.payNote.trim() }),
                  },
                }),
              ),
            (res): Message => {
              const ptd = res.issued[0];
              const toast =
                ptd !== undefined && ptd.number !== null
                  ? txt(ctx.locale, "dlgPayPtdToast", { number: ptd.number })
                  : txt(ctx.locale, "toastPaid");
              return Message.ActionSucceeded({ toast, reload: true });
            },
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ChangedReason: ({ value }) => ({ model: { ...model, reasonText: value } }),
    SubmittedCancel: () => {
      if (ws === null || model.busy || model.reasonText.trim() === "") return { model };
      const reason = model.reasonText.trim();
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "CancelDocument",
            (c) =>
              withIdempotencyKey((headers) =>
                c.documents.cancel({
                  params: { workspaceId: ws.id, documentId: route.id },
                  headers,
                  payload: { reason },
                }),
              ),
            (): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastCancelled"),
                reload: true,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    SubmittedCreditNote: () => {
      if (ws === null || model.busy || model.reasonText.trim() === "") return { model };
      const reason = model.reasonText.trim();
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "IssueCreditNote",
            (c) =>
              withIdempotencyKey((headers) =>
                c.documents.correct({
                  params: { workspaceId: ws.id, documentId: route.id },
                  headers,
                  payload: { reason, lines: "full" },
                }),
              ),
            (creditNote): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastIssued"),
                navigateTo: href({
                  _tag: "Document",
                  ws: route.ws,
                  id: creditNote.id,
                  tab: "preview",
                }),
                reload: false,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    SubmittedUnlock: () => {
      if (ws === null || model.busy || model.reasonText.trim() === "") return { model };
      const reason = model.reasonText.trim();
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "UnlockDocument",
            (c) =>
              c.documents.unlock({
                params: { workspaceId: ws.id, documentId: route.id },
                payload: { reason },
              }),
            (): Message =>
              Message.ActionSucceeded({ toast: txt(ctx.locale, "toastUnlocked"), reload: true }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    SubmittedRemovePayment: () => {
      if (
        ws === null ||
        model.busy ||
        model.removingPaymentId === null ||
        model.reasonText.trim() === ""
      ) {
        return { model };
      }
      const paymentId = model.removingPaymentId as PaymentId;
      const reason = model.reasonText.trim();
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "RemovePayment",
            (c) =>
              c.payments.remove({
                params: { workspaceId: ws.id, paymentId },
                payload: { reason },
              }),
            (): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastPaymentRemoved"),
                reload: true,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    SubmittedFinalInvoice: () => {
      if (ws === null || model.busy) return { model };
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "IssueFinalInvoice",
            (c) =>
              withIdempotencyKey((headers) =>
                c.documents.issueFinalInvoice({
                  params: { workspaceId: ws.id, documentId: route.id },
                  headers,
                  payload: {},
                }),
              ),
            (finalInv): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastIssued"),
                navigateTo: href({
                  _tag: "Document",
                  ws: route.ws,
                  id: finalInv.id,
                  tab: "preview",
                }),
                reload: false,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    SubmittedIssueDraft: () => {
      if (ws === null || bundle === undefined || model.busy) return { model };
      return {
        model: { ...model, busy: true, dialogError: null },
        commands: [
          apiCommand(
            "IssueDraftFromDetail",
            (c) =>
              withIdempotencyKey((idemp) =>
                c.documents.issueDraft({
                  params: { workspaceId: ws.id, documentId: route.id },
                  headers: { ...idemp, ...ifMatch(bundle.doc.revision) },
                  payload: {},
                }),
              ),
            (): Message =>
              Message.ActionSucceeded({ toast: txt(ctx.locale, "toastIssued"), reload: true }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ClickedLock: () => {
      if (ws === null || model.busy) return { model };
      return {
        model: { ...model, busy: true },
        commands: [
          apiCommand(
            "LockDocument",
            (c) => c.documents.lock({ params: { workspaceId: ws.id, documentId: route.id } }),
            (): Message =>
              Message.ActionSucceeded({ toast: txt(ctx.locale, "toastLocked"), reload: true }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ClickedDiscardDraft: () => {
      if (ws === null || bundle === undefined || model.busy) return { model };
      return {
        model: { ...model, busy: true },
        commands: [
          apiCommand(
            "DiscardDraft",
            (c) =>
              c.documents.discardDraft({
                params: { workspaceId: ws.id, documentId: route.id },
                headers: ifMatch(bundle.doc.revision),
              }),
            (): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastCancelled"),
                navigateTo: href({ _tag: "Documents", ws: route.ws, query: {} }),
                reload: false,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ClickedCreateShare: () => {
      if (ws === null || model.busy) return { model };
      return {
        model: { ...model, busy: true },
        commands: [
          apiCommand(
            "CreateShareLink",
            (c) => c.shareLinks.create({ params: { workspaceId: ws.id, documentId: route.id } }),
            (): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastShareCreated"),
                reload: true,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ClickedCopyShare: ({ url }) => ({
      model,
      commands: [copyTextCommand(url, (ok) => Message.CopiedShare({ ok }))],
    }),
    CopiedShare: ({ ok }) => ({
      model,
      outMessage: Intent_.toast(
        ok ? sharedCopy(ctx.locale, "copied") : sharedCopy(ctx.locale, "copyFailed"),
        ok ? "info" : "error",
      ),
    }),
    ClickedRevokeShare: () => {
      if (ws === null || model.busy) return { model };
      return {
        model: { ...model, busy: true },
        commands: [
          apiCommand(
            "RevokeShareLink",
            (c) => c.shareLinks.revoke({ params: { workspaceId: ws.id, documentId: route.id } }),
            (): Message =>
              Message.ActionSucceeded({
                toast: txt(ctx.locale, "toastShareRevoked"),
                reload: true,
              }),
            (failure): Message => Message.ActionFailed({ failure }),
          ),
        ],
      };
    },
    ActionSucceeded: ({ toast, navigateTo, reload }) => {
      const nextBase: Model = {
        ...model,
        busy: false,
        activeDialog: null,
        dialogError: null,
        removingPaymentId: null,
      };
      if (navigateTo !== undefined) {
        return { model: nextBase, outMessage: Intent_.navigate(navigateTo) };
      }
      if (reload && ws !== null) {
        const refreshed = reloadDetail(nextBase, ws.id, route.id);
        return { ...refreshed, outMessage: Intent_.toast(toast) };
      }
      return { model: nextBase, outMessage: Intent_.toast(toast) };
    },
    ActionFailed: ({ failure }) => ({
      model: {
        ...model,
        busy: false,
        dialogError: textOf(translator(ctx.locale), failure.text),
      },
      ...(model.activeDialog === null
        ? { outMessage: Intent_.toast(textOf(translator(ctx.locale), failure.text), "error") }
        : {}),
    }),
  });
};

export const title = (model: Model, ctx: PageContext): string => {
  const bundle = Remote.dataOf(model.detail);
  if (bundle === undefined) return txt(ctx.locale, "title");
  return bundle.doc.number ?? txt(ctx.locale, "draftTitle");
};

const renderActiveDialog = (
  h: HtmlBuilder<Message>,
  model: Model,
  locale: PageContext["locale"],
): ReadonlyArray<Html> => {
  const t = translator(locale);
  const err =
    model.dialogError !== null ? [banner(h, { text: model.dialogError, tone: "error" })] : [];
  switch (model.activeDialog) {
    case null:
      return [];
    case "send":
      return [
        dialog(h, {
          id: "dlg-send",
          title: txt(locale, "dlgSendTitle"),
          onClose: Message.ClosedDialog(),
          body: [
            ...err,
            textField(h, {
              id: "send-to",
              label: txt(locale, "dlgSendTo"),
              value: model.sendTo,
              onInput: (value) => Message.ChangedSendTo({ value }),
            }),
            selectField(h, {
              id: "send-lang",
              label: txt(locale, "dlgSendLanguage"),
              value: model.sendLanguage,
              onChange: (value) => Message.ChangedSendLanguage({ value }),
              options: [
                { value: "cs", label: textOf(t, I18n.enumText("locale", "cs")) },
                { value: "en", label: textOf(t, I18n.enumText("locale", "en")) },
              ],
            }),
            selectField(h, {
              id: "send-purpose",
              label: txt(locale, "dlgSendPurpose"),
              value: model.sendPurpose,
              onChange: (value) => Message.ChangedSendPurpose({ value }),
              options: [
                {
                  value: "document",
                  label: textOf(t, I18n.enumText("deliveryPurpose", "document")),
                },
                {
                  value: "reminder",
                  label: textOf(t, I18n.enumText("deliveryPurpose", "reminder")),
                },
              ],
            }),
            checkbox(h, {
              id: "send-reminders",
              label: txt(locale, "dlgSendReminders"),
              checked: model.sendReminders,
              onToggle: (checked) => Message.ToggledSendReminders({ checked }),
            }),
          ],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgSendSubmit"),
              onClick: Message.SubmittedSend(),
              variant: "primary",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "payment":
      return [
        dialog(h, {
          id: "dlg-payment",
          title: txt(locale, "dlgPayTitle"),
          onClose: Message.ClosedDialog(),
          body: [
            ...err,
            textField(h, {
              id: "pay-amount",
              label: txt(locale, "dlgPayAmount"),
              value: model.payAmount,
              onInput: (value) => Message.ChangedPayAmount({ value }),
              mono: true,
            }),
            textField(h, {
              id: "pay-date",
              label: txt(locale, "dlgPayDate"),
              type: "date",
              value: model.payDate,
              onInput: (value) => Message.ChangedPayDate({ value }),
            }),
            selectField(h, {
              id: "pay-method",
              label: txt(locale, "dlgPayMethod"),
              value: model.payMethod,
              onChange: (value) => Message.ChangedPayMethod({ value }),
              options: [
                {
                  value: "bank_transfer",
                  label: textOf(t, I18n.enumText("paymentMethod", "bank_transfer")),
                },
                { value: "cash", label: textOf(t, I18n.enumText("paymentMethod", "cash")) },
                { value: "card", label: textOf(t, I18n.enumText("paymentMethod", "card")) },
                { value: "other", label: textOf(t, I18n.enumText("paymentMethod", "other")) },
              ],
            }),
            textField(h, {
              id: "pay-note",
              label: txt(locale, "dlgPayNote"),
              value: model.payNote,
              onInput: (value) => Message.ChangedPayNote({ value }),
            }),
          ],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgPaySubmit"),
              onClick: Message.SubmittedPayment(),
              variant: "primary",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "cancel":
      return [
        dialog(h, {
          id: "dlg-cancel",
          title: txt(locale, "dlgCancelTitle"),
          onClose: Message.ClosedDialog(),
          body: [
            ...err,
            textField(h, {
              id: "cancel-reason",
              label: txt(locale, "dlgCancelReason"),
              value: model.reasonText,
              onInput: (value) => Message.ChangedReason({ value }),
              required: true,
            }),
          ],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgCancelSubmit"),
              onClick: Message.SubmittedCancel(),
              variant: "danger",
              disabled: model.reasonText.trim() === "",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "correct":
      return [
        dialog(h, {
          id: "dlg-correct",
          title: txt(locale, "dlgCreditTitle"),
          onClose: Message.ClosedDialog(),
          body: [
            ...err,
            textField(h, {
              id: "credit-reason",
              label: txt(locale, "dlgCreditReason"),
              value: model.reasonText,
              onInput: (value) => Message.ChangedReason({ value }),
              required: true,
            }),
          ],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgCreditSubmit"),
              onClick: Message.SubmittedCreditNote(),
              variant: "primary",
              disabled: model.reasonText.trim() === "",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "unlock":
      return [
        dialog(h, {
          id: "dlg-unlock",
          title: txt(locale, "dlgUnlockTitle"),
          onClose: Message.ClosedDialog(),
          body: [
            ...err,
            textField(h, {
              id: "unlock-reason",
              label: txt(locale, "dlgUnlockReason"),
              value: model.reasonText,
              onInput: (value) => Message.ChangedReason({ value }),
              required: true,
            }),
          ],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgUnlockSubmit"),
              onClick: Message.SubmittedUnlock(),
              variant: "primary",
              disabled: model.reasonText.trim() === "",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "removePayment":
      return [
        dialog(h, {
          id: "dlg-remove-pay",
          title: txt(locale, "dlgRemovePayTitle"),
          onClose: Message.ClosedDialog(),
          body: [
            ...err,
            textField(h, {
              id: "remove-pay-reason",
              label: txt(locale, "dlgRemovePayReason"),
              value: model.reasonText,
              onInput: (value) => Message.ChangedReason({ value }),
              required: true,
            }),
          ],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgRemovePaySubmit"),
              onClick: Message.SubmittedRemovePayment(),
              variant: "danger",
              disabled: model.reasonText.trim() === "",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "final":
      return [
        dialog(h, {
          id: "dlg-final",
          title: txt(locale, "dlgFinalTitle"),
          onClose: Message.ClosedDialog(),
          body: [...err, h.p([], [txt(locale, "dlgFinalBody")])],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgFinalSubmit"),
              onClick: Message.SubmittedFinalInvoice(),
              variant: "primary",
              busy: model.busy,
            }),
          ],
        }),
      ];
    case "issue":
      return [
        dialog(h, {
          id: "dlg-issue",
          title: txt(locale, "dlgIssueTitle"),
          onClose: Message.ClosedDialog(),
          body: [...err, h.p([], [txt(locale, "dlgIssueBody")])],
          actions: [
            button(h, { label: sharedCopy(locale, "cancel"), onClick: Message.ClosedDialog() }),
            button(h, {
              label: txt(locale, "dlgIssueSubmit"),
              onClick: Message.SubmittedIssueDraft(),
              variant: "primary",
              busy: model.busy,
            }),
          ],
        }),
      ];
  }
};

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const { locale } = ctx;
  const t = translator(locale);
  const ws = ctx.workspace;
  const route = model.route as Route;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const slug = ws.slug;
  const bundle = Remote.dataOf(model.detail);

  if (model.detail._tag === "Failed") {
    return page(h, [
      pageHeader(h, {
        title: txt(locale, "title"),
        actions: [
          linkButton(h, {
            label: txt(locale, "backToList"),
            href: href({ _tag: "Documents", ws: slug, query: {} }),
            variant: "ghost",
          }),
        ],
      }),
      banner(h, {
        text: textOf(t, model.detail.failure.text),
        tone: "error",
        action: button(h, {
          label: sharedCopy(locale, "retry"),
          onClick: Message.ClickedRetry(),
          small: true,
        }),
      }),
    ]);
  }

  if (bundle === undefined) {
    return page(h, [
      pageHeader(h, { title: txt(locale, "title") }),
      card(h, [
        h.div(
          [h.Class("kb-stack"), h.AriaBusy(true)],
          [skeleton(h, "35%", "1.5rem"), skeleton(h, "100%", "8rem"), skeleton(h, "100%", "10rem")],
        ),
      ]),
    ]);
  }

  const { doc, payments, history, shareViews } = bundle;
  const issuer = readIssuerSnapshot(doc.issuer);
  const contact = readContactSnapshot(doc.contact);
  const lines = readLines(doc.lines);
  const pdfUrl = `/api/v1/workspaces/${ws.id}/documents/${doc.id}/pdf`;

  const canIssueDraft = doc.status === "draft";
  const canEdit = doc.status === "draft" || (doc.status === "issued" && !doc.locked);
  const canRecordPayment =
    doc.status === "issued" && (doc.kind === "invoice" || doc.kind === "proforma");
  const canFinalInvoice =
    doc.status === "issued" &&
    doc.kind === "proforma" &&
    (doc.settlement === "paid" ||
      doc.settlement === "partially_paid" ||
      doc.settlement === "overpaid") &&
    !documentHasFinalInvoice(doc);
  const canCreditNote =
    doc.status === "issued" && (doc.kind === "invoice" || doc.kind === "payment_tax_document");

  const actions: Array<Html> = [];
  if (canIssueDraft) {
    actions.push(
      button(h, {
        label: txt(locale, "issueAction"),
        onClick: Message.OpenedDialog({ dialog: "issue" }),
        variant: "primary",
      }),
    );
  }
  if (canRecordPayment) {
    actions.push(
      button(h, {
        label: txt(locale, "recordPaymentAction"),
        onClick: Message.OpenedDialog({ dialog: "payment" }),
        variant: "primary",
      }),
    );
  }
  if (canFinalInvoice) {
    actions.push(
      button(h, {
        label: txt(locale, "finalInvoiceAction"),
        onClick: Message.OpenedDialog({ dialog: "final" }),
        variant: "primary",
      }),
    );
  }
  if (doc.status === "issued") {
    actions.push(
      button(h, {
        label: txt(locale, "sendAction"),
        onClick: Message.OpenedDialog({ dialog: "send" }),
      }),
    );
  }
  if (canEdit) {
    actions.push(
      linkButton(h, {
        label: txt(locale, "editAction"),
        href: href({ _tag: "DocumentEdit", ws: slug, id: doc.id }),
      }),
    );
  }
  if (canCreditNote) {
    actions.push(
      button(h, {
        label: txt(locale, "creditNoteAction"),
        onClick: Message.OpenedDialog({ dialog: "correct" }),
      }),
    );
  }
  if (doc.status === "issued") {
    actions.push(
      h.a(
        [h.Class("kb-btn"), h.Href(pdfUrl), h.Target("_blank"), h.Rel("noopener")],
        [txt(locale, "pdfAction")],
      ),
    );
    actions.push(
      doc.locked
        ? button(h, {
            label: txt(locale, "unlockAction"),
            onClick: Message.OpenedDialog({ dialog: "unlock" }),
            variant: "ghost",
          })
        : button(h, {
            label: txt(locale, "lockAction"),
            onClick: Message.ClickedLock(),
            variant: "ghost",
            busy: model.busy,
          }),
    );
    actions.push(
      button(h, {
        label: txt(locale, "cancelAction"),
        onClick: Message.OpenedDialog({ dialog: "cancel" }),
        variant: "danger",
      }),
    );
  }
  if (doc.status === "draft") {
    actions.push(
      button(h, {
        label: txt(locale, "discardDraftAction"),
        onClick: Message.ClickedDiscardDraft(),
        variant: "danger",
        busy: model.busy,
      }),
    );
  }

  const tabBar = tabs(h, {
    label: txt(locale, "tabsLabel"),
    selected: route.tab,
    items: [
      {
        id: "preview",
        label: txt(locale, "tabPreview"),
        href: href({ _tag: "Document", ws: slug, id: doc.id, tab: "preview" }),
      },
      {
        id: "payments",
        label: `${txt(locale, "tabPayments")} (${payments.length})`,
        href: href({ _tag: "Document", ws: slug, id: doc.id, tab: "payments" }),
      },
      {
        id: "share",
        label: txt(locale, "tabShare"),
        href: href({ _tag: "Document", ws: slug, id: doc.id, tab: "share" }),
      },
      {
        id: "history",
        label: txt(locale, "tabHistory"),
        href: href({ _tag: "Document", ws: slug, id: doc.id, tab: "history" }),
      },
    ],
  });

  const previewTab = h.div(
    [h.Class("kb-detail-layout")],
    [
      h.section(
        [h.Class("kb-invoice-sheet")],
        [
          h.div(
            [h.Class("kb-spread")],
            [
              h.div(
                [h.Class("kb-row")],
                [kindBadge(h, locale, doc.kind), mono(h, doc.number ?? txt(locale, "draftTitle"))],
              ),
              amount(h, fmtMoney(locale, doc.totals.gross)),
            ],
          ),
          h.div(
            [h.Class("kb-invoice-parties")],
            [
              h.div(
                [h.Class("kb-party-block")],
                [
                  h.span([h.Class("kb-party-block__label")], [txt(locale, "issuerLabel")]),
                  h.strong([], [issuer?.name ?? ws.name]),
                  ...(issuer !== undefined
                    ? [
                        h.span([h.Class("kb-small")], [formatAddress(issuer.address)]),
                        ...(issuer.ico !== null
                          ? [h.span([h.Class("kb-small kb-mono")], [`IČO ${issuer.ico}`])]
                          : []),
                        ...(issuer.dic !== null
                          ? [h.span([h.Class("kb-small kb-mono")], [`DIČ ${issuer.dic}`])]
                          : []),
                      ]
                    : []),
                ],
              ),
              h.div(
                [h.Class("kb-party-block")],
                [
                  h.span([h.Class("kb-party-block__label")], [txt(locale, "customerLabel")]),
                  h.strong([], [contact?.name ?? "—"]),
                  ...(contact !== undefined
                    ? [
                        h.span([h.Class("kb-small")], [formatAddress(contact.address)]),
                        ...(contact.ico !== null
                          ? [h.span([h.Class("kb-small kb-mono")], [`IČO ${contact.ico}`])]
                          : []),
                        ...(contact.dic !== null
                          ? [h.span([h.Class("kb-small kb-mono")], [`DIČ ${contact.dic}`])]
                          : []),
                      ]
                    : []),
                ],
              ),
            ],
          ),
          dl(h, [
            [
              txt(locale, "issuedOn"),
              h.span([h.Class("kb-num")], [fmtDate(locale, doc.dates.issuedOn)]),
            ],
            ...(doc.dates.taxableSupplyOn !== null
              ? [
                  [
                    txt(locale, "taxableSupplyOn"),
                    h.span([h.Class("kb-num")], [fmtDate(locale, doc.dates.taxableSupplyOn)]),
                  ] as const,
                ]
              : []),
            [txt(locale, "dueOn"), h.span([h.Class("kb-num")], [fmtDate(locale, doc.dates.dueOn)])],
            [
              txt(locale, "paymentMethod"),
              textOf(t, I18n.enumText("paymentMethod", doc.paymentMethod)),
            ],
            ...(issuer?.bankAccount !== null && issuer?.bankAccount !== undefined
              ? [
                  [
                    txt(locale, "bankAccount"),
                    mono(h, issuer.bankAccount.iban ?? issuer.bankAccount.accountNumber ?? "—"),
                  ] as const,
                ]
              : []),
          ]),
          table(h, {
            caption: txt(locale, "linesCaption"),
            rows: lines,
            rowKey: (l) => l.id,
            columns: [
              { header: txt(locale, "colDesc"), cell: (l) => l.description },
              {
                header: txt(locale, "colQty"),
                align: "end",
                numeric: true,
                cell: (l) => `${fmtNum(locale, l.quantity)}${l.unit ? ` ${l.unit}` : ""}`,
              },
              {
                header: txt(locale, "colPrice"),
                align: "end",
                numeric: true,
                cell: (l) => fmtNum(locale, l.unitPrice, 2),
              },
              {
                header: txt(locale, "colVat"),
                align: "end",
                numeric: true,
                cell: (l) => fmtVatRate(locale, l.ratePercent),
              },
              {
                header: txt(locale, "colTotal"),
                align: "end",
                numeric: true,
                cell: (l) => fmtNum(locale, l.amount, 2),
              },
            ],
          }),
          h.div(
            [h.Class("kb-stack")],
            [
              h.div(
                [h.Class("kb-vat-total-row")],
                [
                  h.span([h.Class("kb-muted")], [txt(locale, "netTotal")]),
                  amount(h, fmtMoney(locale, doc.totals.net)),
                ],
              ),
              h.div(
                [h.Class("kb-vat-total-row")],
                [
                  h.span([h.Class("kb-muted")], [txt(locale, "vatTotal")]),
                  amount(h, fmtMoney(locale, doc.totals.vat)),
                ],
              ),
              h.div(
                [h.Class("kb-vat-total-row kb-vat-total-row--grand")],
                [
                  h.span([], [txt(locale, "grandTotal")]),
                  amount(h, fmtMoney(locale, doc.totals.gross)),
                ],
              ),
              ...(doc.totals.vatCzk !== null
                ? [
                    h.div(
                      [h.Class("kb-vat-total-row kb-small kb-muted")],
                      [
                        h.span([], [txt(locale, "vatCzkTotal")]),
                        amount(h, fmtMoney(locale, doc.totals.vatCzk)),
                      ],
                    ),
                  ]
                : []),
            ],
          ),
          ...(doc.statutoryNotes.length > 0
            ? [
                h.hr([h.Class("kb-divider")]),
                h.div(
                  [h.Class("kb-stack")],
                  [
                    h.span([h.Class("kb-small kb-muted")], [txt(locale, "statutoryNotes")]),
                    ...doc.statutoryNotes.map((n) => h.p([h.Class("kb-small")], [n.text])),
                  ],
                ),
              ]
            : []),
        ],
      ),
      h.div(
        [h.Class("kb-stack")],
        [
          ...(doc.related.length > 0
            ? [
                card(h, [
                  cardTitle(h, txt(locale, "relatedDocs")),
                  h.div(
                    [h.Class("kb-related-list")],
                    doc.related.map((rel) =>
                      h.a(
                        [
                          h.Class("kb-related-link"),
                          h.Href(href({ _tag: "Document", ws: slug, id: rel.id, tab: "preview" })),
                        ],
                        [
                          h.div(
                            [h.Class("kb-stack")],
                            [
                              h.span(
                                [h.Class("kb-small kb-muted")],
                                [textOf(t, I18n.enumText("documentRelation", rel.relation))],
                              ),
                              mono(h, rel.number),
                            ],
                          ),
                          kindBadge(h, locale, rel.kind),
                        ],
                      ),
                    ),
                  ),
                ]),
              ]
            : []),
          card(h, [
            cardTitle(h, txt(locale, "deliveriesTitle")),
            doc.deliveries.length === 0
              ? h.p([h.Class("kb-small kb-muted")], [txt(locale, "noDeliveries")])
              : h.ul(
                  [h.Class("kb-audit-list")],
                  doc.deliveries.map((del) =>
                    h.keyed("li")(
                      del.id,
                      [h.Class("kb-audit-item")],
                      [
                        h.div(
                          [h.Class("kb-spread")],
                          [
                            h.span([h.Class("kb-small")], [del.to.join(", ")]),
                            badge(
                              h,
                              textOf(t, I18n.enumText("deliveryStatus", del.status)),
                              del.status === "sent"
                                ? "paid"
                                : del.status === "failed"
                                  ? "error"
                                  : "neutral",
                            ),
                          ],
                        ),
                        h.span([h.Class("kb-footnote kb-num")], [fmtDateTime(locale, del.at)]),
                      ],
                    ),
                  ),
                ),
          ]),
        ],
      ),
    ],
  );

  const paymentsTab = card(h, [
    cardTitle(h, txt(locale, "tabPayments"), [
      ...(canRecordPayment
        ? [
            button(h, {
              label: txt(locale, "recordPaymentAction"),
              onClick: Message.OpenedDialog({ dialog: "payment" }),
              variant: "primary",
              small: true,
            }),
          ]
        : []),
    ]),
    payments.length === 0
      ? emptyState(h, { title: txt(locale, "paymentsEmpty") })
      : table(h, {
          caption: txt(locale, "paymentsCaption"),
          rows: payments,
          rowKey: (p) => p.id,
          columns: [
            {
              header: txt(locale, "payColDate"),
              numeric: true,
              cell: (p) => fmtDate(locale, p.paidOn),
            },
            {
              header: txt(locale, "payColMethod"),
              cell: (p) => textOf(t, I18n.enumText("paymentMethod", p.method)),
            },
            {
              header: txt(locale, "payColAmount"),
              align: "end",
              numeric: true,
              cell: (p) => amount(h, fmtMoney(locale, p.amount)),
            },
            { header: txt(locale, "payColNote"), cell: (p) => p.note ?? "—" },
            {
              header: txt(locale, "payColTaxDoc"),
              cell: (p) =>
                p.taxDocument === null
                  ? "—"
                  : linkButton(h, {
                      label: txt(locale, "viewTaxDoc"),
                      href: href({ _tag: "Document", ws: slug, id: p.taxDocument, tab: "preview" }),
                      small: true,
                    }),
            },
            {
              header: txt(locale, "payColActions"),
              align: "end",
              cell: (p) =>
                button(h, {
                  label: txt(locale, "removePayment"),
                  onClick: Message.OpenedDialog({ dialog: "removePayment", paymentId: p.id }),
                  variant: "ghost",
                  small: true,
                }),
            },
          ],
        }),
  ]);

  const shareTab = card(h, [
    cardTitle(h, txt(locale, "shareTitle")),
    doc.status === "draft"
      ? banner(h, { text: txt(locale, "shareDraftBlocked"), tone: "info" })
      : doc.share === null
        ? emptyState(h, {
            title: txt(locale, "shareNone"),
            action: button(h, {
              label: txt(locale, "shareCreate"),
              onClick: Message.ClickedCreateShare(),
              variant: "primary",
              busy: model.busy,
            }),
          })
        : h.div(
            [h.Class("kb-stack")],
            [
              h.div(
                [h.Class("kb-share-url")],
                [
                  h.span([h.Class("kb-mono"), h.Style({ flex: "1" })], [doc.share.url]),
                  button(h, {
                    label: txt(locale, "shareCopy"),
                    onClick: Message.ClickedCopyShare({ url: doc.share.url }),
                    small: true,
                  }),
                  button(h, {
                    label: txt(locale, "shareRevoke"),
                    onClick: Message.ClickedRevokeShare(),
                    variant: "danger",
                    small: true,
                    busy: model.busy,
                  }),
                ],
              ),
              h.span(
                [h.Class("kb-small kb-muted kb-num")],
                [txt(locale, "shareStats", { views: doc.share.views })],
              ),
              h.h3([], [txt(locale, "shareEventsTitle")]),
              shareViews.length === 0
                ? h.p([h.Class("kb-small kb-muted")], [txt(locale, "shareEventsEmpty")])
                : h.ul(
                    [h.Class("kb-audit-list")],
                    shareViews.map((ev) =>
                      h.keyed("li")(
                        ev.id,
                        [h.Class("kb-audit-item")],
                        [
                          h.div(
                            [h.Class("kb-spread")],
                            [
                              h.span(
                                [],
                                [
                                  `${textOf(t, I18n.enumText("shareEvent", ev.kind))} · ${textOf(t, I18n.enumText("device", ev.device))}`,
                                ],
                              ),
                              h.span(
                                [h.Class("kb-small kb-muted kb-num")],
                                [fmtDateTime(locale, ev.at)],
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
            ],
          ),
  ]);

  const historyTab = card(h, [
    cardTitle(h, txt(locale, "tabHistory")),
    history.length === 0
      ? emptyState(h, { title: txt(locale, "historyEmpty") })
      : h.ul(
          [h.Class("kb-audit-list")],
          history.map((entry) =>
            h.keyed("li")(
              entry.id,
              [h.Class("kb-audit-item")],
              [
                h.div(
                  [h.Class("kb-spread")],
                  [
                    h.span([h.Class("kb-mono")], [entry.action]),
                    h.span([h.Class("kb-small kb-muted kb-num")], [fmtDateTime(locale, entry.at)]),
                  ],
                ),
                ...(entry.reason !== null
                  ? [h.span([h.Class("kb-small kb-muted")], [entry.reason])]
                  : []),
              ],
            ),
          ),
        ),
  ]);

  const tabContent =
    route.tab === "payments"
      ? paymentsTab
      : route.tab === "share"
        ? shareTab
        : route.tab === "history"
          ? historyTab
          : previewTab;

  return page(h, [
    pageHeader(h, {
      eyebrow: h.div(
        [h.Class("kb-row")],
        [kindBadge(h, locale, doc.kind), ...documentBadges(h, locale, doc)],
      ),
      title: doc.number ?? txt(locale, "draftTitle"),
      ...(contact?.name === undefined ? {} : { subtitle: contact.name }),
      actions,
    }),
    tabBar,
    tabContent,
    ...renderActiveDialog(h, model, locale),
  ]);
});
