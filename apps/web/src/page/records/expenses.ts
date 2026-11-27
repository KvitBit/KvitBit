import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Expenses screen (Screens 13 & 14, routes `Expenses` | `ExpenseCapture` | `Expense`).
 * Czech term: Náklady (#171).
 * - List with search, status/settlement filter chips & incomplete badge, Quick Capture file drop
 *   & picker target, zero-CLS shimmer skeleton
 * - Quick Capture route for uploading/queuing receipts & invoices (PDF/JPEG/PNG/HEIC)
 * - Split Expense Editor & Detail with PDF/photo attachment viewer (zoom, download, detach, upload),
 *   supplier ARES lookup, VAT breakdown & deductibility %, multi-currency CNB FX rate conversion,
 *   and record/remove payment workflow
 */
import type {
  AttachmentId,
  CurrencyCode,
  ExpenseId,
  ExpenseInput,
  ExpensePatch,
  IsoDate,
  Money,
  PaymentId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Result, Schema } from "effect";
import { Failure, request } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { attribute, type Markup, withAttributes } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  dialog,
  dl,
  emptyState,
  linkButton,
  mono,
  page,
  pageHeader,
  segmented,
  selectField,
  skeleton,
  skeletonTable,
  table,
  textArea,
  textField,
} from "../../ui/kit";
import {
  buttonVariants,
  cardVariants,
  chipVariants,
  cn,
  controlVariants,
  dropzoneVariants,
  ui,
} from "../../ui/styles";
import {
  apiCommand,
  CURRENCIES,
  canWrite,
  computeExpensePreview,
  dateText,
  downloadUrlCommand,
  ExpenseAttachmentRecord,
  ExpenseSummaryRecord,
  ExpenseViewRecord,
  enumLabel,
  formatBytes,
  formatDecimalFixed,
  moneyText,
  newIdempotencyKey,
  normalizeContact,
  normalizeExpenseSummary,
  normalizeExpenseView,
  normalizePayment,
  PAYMENT_METHODS,
  PaymentRecord,
  parseUserDecimal,
  settlementTone,
  todayIso,
  uploadAttachmentCommand,
  VAT_TREATMENTS,
  vatRatePercent,
} from "./shared";

export type Route = RouteOf<"Expenses" | "ExpenseCapture" | "Expense">;

const ALLOWED_MIME_TYPES = "application/pdf,image/jpeg,image/png,image/heic";

const tLocal = copy({
  cs: {
    subtitle: "Přijaté faktury a účtenky s rozpisem DPH, odpočtem, kurzem ČNB a přílohami.",
    snapUpload: "Vyfotit / Nahrát",
    filterAll: "Vše ({count})",
    filterIncomplete: "Neúplné ({count})",
    filterUnpaid: "Nezaplaceno",
    filterPaid: "Zaplaceno",
    colCategory: "Kategorie",
    colStatus: "Stav",
    dropTitle: "Přetáhněte sem PDF nebo fotku účtenky",
    dropSub: "Vytvoří se neúplný náklad s přílohou, který můžete ihned doplnit.",
    captureSubtitle: "Nahrajte účtenky nebo faktury (PDF, JPG, PNG, HEIC) přímo do nákladů.",
    captureQueue: "Fronta nahrávání",
    captureEmpty: "Zatím jste nevybrali žádné soubory.",
    backToList: "Zpět na náklady",
    supplierIco: "IČO dodavatele",
    supplierName: "Název dodavatele",
    supplierDic: "DIČ dodavatele",
    aresLookup: "Načíst z ARES",
    aresLoaded: "Dodavatel načten z ARES.",
    icoInvalid: "Zadejte platné 8místné IČO.",
    deductibility: "Nárok na odpočet DPH",
    dedFull: "Plný (100 %)",
    dedPartial: "Krácený (%)",
    dedNone: "Bez nároku (0 %)",
    dedPercent: "Koeficient (%)",
    deductibleVat: "Odpočitatelná DPH",
    fxRateLabel: "Kurz ČNB ({currency} / CZK)",
    fxLoading: "Načítám kurz ČNB…",
    fxFixingNote: "Kurz ČNB ze dne {date}: {qty} {currency} = {rate} Kč",
    statusComplete: "Kompletní náklad",
    statusIncomplete: "Uložit jako neúplný",
    paymentsTitle: "Úhrady nákladu",
    paymentsEmpty: "Zatím nejsou zapsány žádné platby.",
    recordPaymentTitle: "Zapsat platbu nákladu",
    removePaymentTitle: "Odebrat platbu?",
    removePaymentReason: "Důvod odebrání (auditní záznam)",
    paidOn: "Datum platby",
    method: "Způsob úhrady",
    amountPaid: "Uhrazeno",
    noAttachments: "K nákladu zatím není připojena žádná příloha.",
    zoomLabel: "Přiblížení: {pct} %",
    previewFallback: "Náhled souboru {name}",
    totalRequired: "Pro kompletní náklad zadejte celkovou částku a datum vystavení.",
    vatMismatch: "Součet řádků DPH se liší od celkové částky o {diff}.",
    staleNotice: "Náklad byl mezitím upraven. Načtěte aktuální stav.",
    savedToast: "Náklad uložen.",
    paymentRecorded: "Platba zapsána.",
    paymentRemoved: "Platba odebrána.",
    attachmentAdded: "Příloha připojena.",
    attachmentRemoved: "Příloha odebrána.",
    selfAssessedRate: "Samovyměření",
    readOnlyBadge: "Režim účetní (jen pro čtení)",
  },
  en: {
    subtitle:
      "Received invoices and receipts with VAT breakdown, deductibility, CNB FX and attachments.",
    snapUpload: "Snap / Upload",
    filterAll: "All ({count})",
    filterIncomplete: "Incomplete ({count})",
    filterUnpaid: "Unpaid",
    filterPaid: "Paid",
    colCategory: "Category",
    colStatus: "Status",
    dropTitle: "Drop a PDF or receipt photo here",
    dropSub: "Creates an incomplete expense with the attachment ready to complete.",
    captureSubtitle: "Upload receipts or invoices (PDF, JPG, PNG, HEIC) directly into expenses.",
    captureQueue: "Upload queue",
    captureEmpty: "No files selected yet.",
    backToList: "Back to expenses",
    supplierIco: "Supplier IČO",
    supplierName: "Supplier name",
    supplierDic: "Supplier VAT ID",
    aresLookup: "ARES lookup",
    aresLoaded: "Supplier loaded from ARES.",
    icoInvalid: "Enter a valid 8-digit Czech IČO.",
    deductibility: "VAT deductibility",
    dedFull: "Full (100%)",
    dedPartial: "Partial (%)",
    dedNone: "None (0%)",
    dedPercent: "Deductible %",
    deductibleVat: "Deductible VAT",
    fxRateLabel: "CNB rate ({currency} / CZK)",
    fxLoading: "Fetching CNB rate…",
    fxFixingNote: "CNB fixing from {date}: {qty} {currency} = {rate} CZK",
    statusComplete: "Complete expense",
    statusIncomplete: "Save as incomplete",
    paymentsTitle: "Expense payments",
    paymentsEmpty: "No payments recorded yet.",
    recordPaymentTitle: "Record expense payment",
    removePaymentTitle: "Remove payment?",
    removePaymentReason: "Reason for removal (audit log)",
    paidOn: "Payment date",
    method: "Payment method",
    amountPaid: "Paid",
    noAttachments: "No attachments linked to this expense yet.",
    zoomLabel: "Zoom: {pct}%",
    previewFallback: "Preview of {name}",
    totalRequired: "Enter total amount and issue date for a complete expense.",
    vatMismatch: "VAT breakdown sum differs from total by {diff}.",
    staleNotice: "This expense changed elsewhere. Reload to get the latest version.",
    savedToast: "Expense saved.",
    paymentRecorded: "Payment recorded.",
    paymentRemoved: "Payment removed.",
    attachmentAdded: "Attachment added.",
    attachmentRemoved: "Attachment removed.",
    selfAssessedRate: "Self-assessed",
    readOnlyBadge: "Accountant mode (read-only)",
  },
});

const ListFilterLiteral = Schema.Literals(["all", "incomplete", "unpaid", "paid"]);
type ListFilterLiteral = typeof ListFilterLiteral.Type;

const CaptureJob = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  fileSize: Schema.Number,
  status: Schema.Literals(["creating", "uploading", "done", "failed"]),
  expenseId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
type CaptureJob = typeof CaptureJob.Type;

const VatRowDraft = Schema.Struct({
  treatment: Schema.String,
  base: Schema.String,
  vat: Schema.String,
  selfAssessed: Schema.NullOr(Schema.Literals(["standard", "reduced"])),
});

const ExpenseEditorDraft = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.Int),
  status: Schema.Literals(["complete", "incomplete"]),
  supplierContactId: Schema.NullOr(Schema.String),
  supplierIco: Schema.String,
  supplierName: Schema.String,
  supplierDic: Schema.String,
  aresBusy: Schema.Boolean,
  aresSeq: Schema.Int,
  aresError: Schema.NullOr(Schema.String),
  supplierDocumentNumber: Schema.String,
  issuedOn: Schema.String,
  taxableSupplyOn: Schema.String,
  dueOn: Schema.String,
  currency: Schema.String,
  total: Schema.String,
  vatLines: Schema.Array(VatRowDraft),
  deductibilityMode: Schema.Literals(["full", "none", "partial"]),
  deductibilityPercent: Schema.String,
  fxRate: Schema.String,
  fxQuantity: Schema.Int,
  fxFixingDate: Schema.NullOr(Schema.String),
  fxBusy: Schema.Boolean,
  fxSeq: Schema.Int,
  category: Schema.String,
  tagsText: Schema.String,
  note: Schema.String,
  idempotencyKey: Schema.String,
  saving: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type ExpenseEditorDraft = typeof ExpenseEditorDraft.Type;

const PaymentDialogState = Schema.Struct({
  amount: Schema.String,
  paidOn: Schema.String,
  method: Schema.String,
  note: Schema.String,
  idempotencyKey: Schema.String,
  submitting: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type PaymentDialogState = typeof PaymentDialogState.Type;

export const Model = Schema.Struct({
  route: ViewModels.Route,
  search: Schema.String,
  filter: ListFilterLiteral,
  dragActive: Schema.Boolean,
  list: Remote.remoteSchema(Schema.Array(ExpenseSummaryRecord)),
  captureJobs: Schema.Array(CaptureJob),
  detail: Remote.remoteSchema(ExpenseViewRecord),
  payments: Remote.remoteSchema(Schema.Array(PaymentRecord)),
  editor: Schema.NullOr(ExpenseEditorDraft),
  selectedAttachmentId: Schema.NullOr(Schema.String),
  viewerZoom: Schema.Int,
  uploadingAttachment: Schema.Boolean,
  confirmDetachId: Schema.NullOr(Schema.String),
  detaching: Schema.Boolean,
  confirmRemove: Schema.Boolean,
  removing: Schema.Boolean,
  paymentDialog: Schema.NullOr(PaymentDialogState),
  confirmRemovePaymentId: Schema.NullOr(Schema.String),
  removePaymentReason: Schema.String,
  removingPayment: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  LoadedList: { seq: Schema.Int, items: Schema.Array(ExpenseSummaryRecord) },
  FailedList: { seq: Schema.Int, failure: Failure },
  ChangedSearch: { value: Schema.String },
  SelectedFilter: { filter: ListFilterLiteral },
  ClickedRetryList: {},
  DraggedEnter: {},
  DraggedLeave: {},
  SelectedCaptureFiles: { files: Schema.Array(Schema.Unknown) },
  CaptureCreatedExpense: { jobId: Schema.String, expense: ExpenseViewRecord, file: Schema.Unknown },
  CaptureUploadedFile: {
    jobId: Schema.String,
    expenseId: Schema.String,
    attachment: ExpenseAttachmentRecord,
  },
  CaptureFailed: { jobId: Schema.String, failure: Failure },

  LoadedDetail: { seq: Schema.Int, expense: ExpenseViewRecord },
  FailedDetail: { seq: Schema.Int, failure: Failure },
  ClickedRetryDetail: {},
  LoadedPayments: { seq: Schema.Int, payments: Schema.Array(PaymentRecord) },
  FailedPayments: { seq: Schema.Int, failure: Failure },

  ChangedEditorField: {
    field: Schema.Literals([
      "supplierIco",
      "supplierName",
      "supplierDic",
      "supplierDocumentNumber",
      "issuedOn",
      "taxableSupplyOn",
      "dueOn",
      "currency",
      "total",
      "deductibilityPercent",
      "category",
      "tagsText",
      "note",
    ]),
    value: Schema.String,
  },
  ChangedExpenseStatus: { status: Schema.Literals(["complete", "incomplete"]) },
  ChangedDeductibilityMode: { mode: Schema.Literals(["full", "none", "partial"]) },
  AddedVatRow: {},
  RemovedVatRow: { index: Schema.Int },
  ChangedVatRow: {
    index: Schema.Int,
    field: Schema.Literals(["treatment", "base", "vat", "selfAssessed"]),
    value: Schema.String,
  },
  ClickedAresLookup: {},
  LoadedAresSupplier: {
    seq: Schema.Int,
    contactId: Schema.String,
    name: Schema.String,
    ico: Schema.NullOr(Schema.String),
    dic: Schema.NullOr(Schema.String),
  },
  FailedAresSupplier: { seq: Schema.Int, failure: Failure },
  LoadedFxRate: {
    seq: Schema.Int,
    rate: Schema.String,
    quantity: Schema.Int,
    fixingDate: Schema.String,
  },
  FailedFxRate: { seq: Schema.Int },
  SubmittedEditor: {},
  SavedExpense: { expense: ExpenseViewRecord },
  FailedSave: { failure: Failure },

  SelectedAttachment: { id: Schema.String },
  ChangedZoom: { delta: Schema.Int },
  SelectedDetailFiles: { files: Schema.Array(Schema.Unknown) },
  UploadedAttachment: { attachment: ExpenseAttachmentRecord },
  FailedUploadAttachment: { failure: Failure },
  ClickedDownloadAttachment: { attachment: ExpenseAttachmentRecord },
  CompletedDownload: {},
  FailedDownload: { failure: Failure },
  RequestedDetach: { id: Schema.String },
  CancelledDetach: {},
  ConfirmedDetach: {},
  DetachedAttachment: { id: Schema.String },
  FailedDetach: { failure: Failure },

  RequestedRemove: {},
  CancelledRemove: {},
  ConfirmedRemove: {},
  RemovedExpense: {},
  FailedRemove: { failure: Failure },

  OpenedPaymentDialog: { presetFull: Schema.Boolean },
  ClosedPaymentDialog: {},
  ChangedPaymentField: {
    field: Schema.Literals(["amount", "paidOn", "method", "note"]),
    value: Schema.String,
  },
  SubmittedPayment: {},
  RecordedPayment: { payment: PaymentRecord },
  FailedRecordPayment: { failure: Failure },
  RequestedRemovePayment: { id: Schema.String },
  ChangedRemovePaymentReason: { value: Schema.String },
  CancelledRemovePayment: {},
  ConfirmedRemovePayment: {},
  RemovedPayment: { id: Schema.String },
  FailedRemovePayment: { failure: Failure },
});
export type Message = typeof Message.Type;

// --- Commands ------------------------------------------------------------------------------------

const loadListCommand = (
  workspaceId: string,
  seq: number,
  incompleteOnly: boolean,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesList",
    request(
      (client) =>
        client.expenses.list({
          params: { workspaceId: workspaceId as WorkspaceId },
          query: incompleteOnly ? { incomplete: true } : {},
        }),
      (pageRes): Message =>
        Message.LoadedList({ seq, items: pageRes.items.map(normalizeExpenseSummary) }),
      (failure): Message => Message.FailedList({ seq, failure }),
    ),
  );

const loadDetailCommand = (
  workspaceId: string,
  expenseId: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesGet",
    request(
      (client) =>
        client.expenses.get({
          params: { workspaceId: workspaceId as WorkspaceId, expenseId: expenseId as ExpenseId },
        }),
      (raw): Message => Message.LoadedDetail({ seq, expense: normalizeExpenseView(raw) }),
      (failure): Message => Message.FailedDetail({ seq, failure }),
    ),
  );

const loadPaymentsCommand = (
  workspaceId: string,
  expenseId: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    "ExpensePaymentsList",
    request(
      (client) =>
        client.payments.listForExpense({
          params: { workspaceId: workspaceId as WorkspaceId, expenseId: expenseId as ExpenseId },
        }),
      (items): Message => Message.LoadedPayments({ seq, payments: items.map(normalizePayment) }),
      (failure): Message => Message.FailedPayments({ seq, failure }),
    ),
  );

const fetchFxCommand = (
  workspaceId: string,
  currency: string,
  on: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesFetchFx",
    request(
      (client) =>
        client.reports.fxRate({
          params: {
            workspaceId: workspaceId as WorkspaceId,
            currency: currency as CurrencyCode,
          },
          query: { on: (on || todayIso()) as IsoDate },
        }),
      (fx): Message =>
        Message.LoadedFxRate({
          seq,
          rate: BigDecimal.format(BigDecimal.normalize(fx.rate)),
          quantity: fx.quantity,
          fixingDate: fx.fixingDate,
        }),
      (): Message => Message.FailedFxRate({ seq }),
    ),
  );

const lookupSupplierAresCommand = (
  workspaceId: string,
  ico: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesSupplierAres",
    request(
      (client) =>
        client.contacts.fromIco({
          params: { workspaceId: workspaceId as WorkspaceId },
          payload: { ico, role: "supplier" },
        }),
      (raw): Message => {
        const c = normalizeContact(raw);
        return Message.LoadedAresSupplier({
          seq,
          contactId: c.id,
          name: c.name,
          ico: c.ico,
          dic: c.dic,
        });
      },
      (failure): Message => Message.FailedAresSupplier({ seq, failure }),
    ),
  );

const createCaptureExpenseCommand = (
  workspaceId: string,
  jobId: string,
  file: File,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesQuickCaptureCreate",
    request(
      (client) =>
        client.expenses.record({
          params: { workspaceId: workspaceId as WorkspaceId },
          headers: { "idempotency-key": newIdempotencyKey("cap") },
          payload: {
            status: "incomplete",
            note: file.name,
          } as unknown as ExpenseInput,
        }),
      (raw): Message =>
        Message.CaptureCreatedExpense({
          jobId,
          expense: normalizeExpenseView(raw),
          file,
        }),
      (failure): Message => Message.CaptureFailed({ jobId, failure }),
    ),
  );

const buildExpensePayload = (ed: ExpenseEditorDraft): Record<string, unknown> => {
  const supplier =
    ed.supplierContactId !== null
      ? { contact: ed.supplierContactId }
      : ed.supplierName.trim() !== ""
        ? {
            manual: {
              name: ed.supplierName.trim(),
              ico: ed.supplierIco.trim() === "" ? null : Format.normalizeIco(ed.supplierIco),
              dic: ed.supplierDic.trim() === "" ? null : Format.normalizeVatId(ed.supplierDic),
            },
          }
        : null;

  const totalNum = parseUserDecimal(ed.total);
  const vat =
    ed.vatLines.length === 0
      ? null
      : ed.vatLines.map((row) => ({
          treatment: row.treatment,
          base: formatDecimalFixed(parseUserDecimal(row.base) ?? 0, 2),
          vat: formatDecimalFixed(parseUserDecimal(row.vat) ?? 0, 2),
          ...(row.selfAssessed !== null ? { selfAssessed: row.selfAssessed } : {}),
        }));

  const deductibility =
    ed.deductibilityMode === "full"
      ? "full"
      : ed.deductibilityMode === "none"
        ? "none"
        : {
            partial: Math.max(
              1,
              Math.min(99, Math.trunc(parseUserDecimal(ed.deductibilityPercent) ?? 50)),
            ),
          };

  const tags = ed.tagsText
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");

  return {
    status: ed.status,
    supplier,
    supplierDocumentNumber:
      ed.supplierDocumentNumber.trim() === "" ? null : ed.supplierDocumentNumber.trim(),
    issuedOn: ed.issuedOn.trim() === "" ? null : ed.issuedOn.trim(),
    taxableSupplyOn: ed.taxableSupplyOn.trim() === "" ? null : ed.taxableSupplyOn.trim(),
    dueOn: ed.dueOn.trim() === "" ? null : ed.dueOn.trim(),
    currency: ed.currency,
    total: totalNum === null ? null : formatDecimalFixed(totalNum, 2),
    vat,
    deductibility,
    category: ed.category.trim() === "" ? null : ed.category.trim(),
    tags,
    note: ed.note.trim() === "" ? null : ed.note.trim(),
  };
};

const saveExpenseCommand = (workspaceId: string, ed: ExpenseEditorDraft): PageCommand<Message> => {
  const payload = buildExpensePayload(ed);
  return apiCommand(
    "ExpensesSave",
    request(
      (client) =>
        ed.id === null
          ? client.expenses.record({
              params: { workspaceId: workspaceId as WorkspaceId },
              headers: { "idempotency-key": ed.idempotencyKey },
              payload: payload as unknown as ExpenseInput,
            })
          : client.expenses.edit({
              params: { workspaceId: workspaceId as WorkspaceId, expenseId: ed.id as ExpenseId },
              headers: { "if-match": `"${ed.revision ?? 1}"` },
              payload: payload as unknown as ExpensePatch,
            }),
      (raw): Message => Message.SavedExpense({ expense: normalizeExpenseView(raw) }),
      (failure): Message => Message.FailedSave({ failure }),
    ),
  );
};

const removeExpenseCommand = (
  workspaceId: string,
  expenseId: string,
  revision: number,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesRemove",
    request(
      (client) =>
        client.expenses.remove({
          params: { workspaceId: workspaceId as WorkspaceId, expenseId: expenseId as ExpenseId },
          headers: { "if-match": `"${revision}"` },
        }),
      (): Message => Message.RemovedExpense(),
      (failure): Message => Message.FailedRemove({ failure }),
    ),
  );

const detachAttachmentCommand = (
  workspaceId: string,
  expenseId: string,
  attachmentId: string,
): PageCommand<Message> =>
  apiCommand(
    "ExpensesDetach",
    request(
      (client) =>
        client.expenses.detach({
          params: {
            workspaceId: workspaceId as WorkspaceId,
            expenseId: expenseId as ExpenseId,
            attachmentId: attachmentId as AttachmentId,
          },
        }),
      (): Message => Message.DetachedAttachment({ id: attachmentId }),
      (failure): Message => Message.FailedDetach({ failure }),
    ),
  );

const recordPaymentCommand = (
  workspaceId: string,
  expenseId: string,
  currency: string,
  dlg: PaymentDialogState,
): PageCommand<Message> => {
  const parsed = parseUserDecimal(dlg.amount);
  const amount: Money | undefined =
    parsed !== null && parsed > 0
      ? {
          amount: BigDecimal.fromStringUnsafe(formatDecimalFixed(parsed, 2)),
          currency: currency as CurrencyCode,
        }
      : undefined;
  return apiCommand(
    "ExpenseRecordPayment",
    request(
      (client) =>
        client.payments.record({
          params: { workspaceId: workspaceId as WorkspaceId },
          headers: { "idempotency-key": dlg.idempotencyKey },
          payload: {
            target: { expense: expenseId as ExpenseId },
            ...(amount !== undefined ? { amount } : {}),
            ...(dlg.paidOn.trim() !== "" ? { paidOn: dlg.paidOn.trim() as IsoDate } : {}),
            method: dlg.method as PaymentMethod,
            ...(dlg.note.trim() !== "" ? { note: dlg.note.trim() } : {}),
          },
        }),
      (res): Message => Message.RecordedPayment({ payment: normalizePayment(res.payment) }),
      (failure): Message => Message.FailedRecordPayment({ failure }),
    ),
  );
};

const removePaymentCommand = (
  workspaceId: string,
  paymentId: string,
  reason: string,
): PageCommand<Message> =>
  apiCommand(
    "ExpenseRemovePayment",
    request(
      (client) =>
        client.payments.remove({
          params: { workspaceId: workspaceId as WorkspaceId, paymentId: paymentId as PaymentId },
          payload: { reason },
        }),
      (): Message => Message.RemovedPayment({ id: paymentId }),
      (failure): Message => Message.FailedRemovePayment({ failure }),
    ),
  );

// --- Editor builders -----------------------------------------------------------------------------

const emptyEditor = (): ExpenseEditorDraft => {
  const today = todayIso();
  return {
    id: null,
    revision: null,
    status: "complete",
    supplierContactId: null,
    supplierIco: "",
    supplierName: "",
    supplierDic: "",
    aresBusy: false,
    aresSeq: 0,
    aresError: null,
    supplierDocumentNumber: "",
    issuedOn: today,
    taxableSupplyOn: today,
    dueOn: "",
    currency: "CZK",
    total: "",
    vatLines: [{ treatment: "standard", base: "", vat: "", selfAssessed: null }],
    deductibilityMode: "full",
    deductibilityPercent: "100",
    fxRate: "",
    fxQuantity: 1,
    fxFixingDate: null,
    fxBusy: false,
    fxSeq: 0,
    category: "",
    tagsText: "",
    note: "",
    idempotencyKey: newIdempotencyKey("exp"),
    saving: false,
    error: null,
  };
};

const editorFromExpense = (e: ExpenseViewRecord): ExpenseEditorDraft => {
  const dedMode =
    e.deductibility === "full" ? "full" : e.deductibility === "none" ? "none" : "partial";
  const dedPct =
    e.deductibility === "full"
      ? "100"
      : e.deductibility === "none"
        ? "0"
        : String(e.deductibility.partial);
  return {
    id: e.id,
    revision: e.revision,
    status: e.status,
    supplierContactId: e.supplier?.contactId ?? null,
    supplierIco: e.supplier?.ico ?? "",
    supplierName: e.supplier?.name ?? "",
    supplierDic: e.supplier?.dic ?? "",
    aresBusy: false,
    aresSeq: 0,
    aresError: null,
    supplierDocumentNumber: e.supplierDocumentNumber ?? "",
    issuedOn: e.issuedOn ?? todayIso(),
    taxableSupplyOn: e.taxableSupplyOn ?? e.issuedOn ?? todayIso(),
    dueOn: e.dueOn ?? "",
    currency: e.currency ?? "CZK",
    total: e.total ?? "",
    vatLines:
      e.vat !== null && e.vat.length > 0
        ? e.vat.map((v) => ({
            treatment: v.treatment,
            base: v.base,
            vat: v.vat,
            selfAssessed: v.selfAssessed,
          }))
        : [],
    deductibilityMode: dedMode,
    deductibilityPercent: dedPct,
    fxRate: e.fx?.rate ?? "",
    fxQuantity: e.fx?.quantity ?? 1,
    fxFixingDate: e.fx?.fixingDate ?? null,
    fxBusy: false,
    fxSeq: 0,
    category: e.category ?? "",
    tagsText: e.tags.join(", "),
    note: e.note ?? "",
    idempotencyKey: newIdempotencyKey("exp"),
    saving: false,
    error: null,
  };
};

// --- Init & Update -------------------------------------------------------------------------------

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const wsId = ctx.workspace?.id;
  const base: Omit<
    Model,
    "route" | "list" | "detail" | "payments" | "editor" | "filter" | "search"
  > = {
    dragActive: false,
    captureJobs: [],
    selectedAttachmentId: null,
    viewerZoom: 100,
    uploadingAttachment: false,
    confirmDetachId: null,
    detaching: false,
    confirmRemove: false,
    removing: false,
    paymentDialog: null,
    confirmRemovePaymentId: null,
    removePaymentReason: "",
    removingPayment: false,
  };

  if (route._tag === "Expenses") {
    const search = route.query.text ?? "";
    const filter: ListFilterLiteral = route.query.incomplete === true ? "incomplete" : "all";
    const list = Remote.load<ReadonlyArray<ExpenseSummaryRecord>>(Remote.idle);
    return {
      model: {
        ...base,
        route,
        search,
        filter,
        list,
        detail: Remote.idle,
        payments: Remote.idle,
        editor: null,
      },
      commands:
        wsId === undefined
          ? []
          : [loadListCommand(wsId, Remote.seqOf(list), filter === "incomplete")],
    };
  }

  if (route._tag === "ExpenseCapture") {
    return {
      model: {
        ...base,
        route,
        search: "",
        filter: "all",
        list: Remote.idle,
        detail: Remote.idle,
        payments: Remote.idle,
        editor: null,
      },
    };
  }

  if (route.id === "new") {
    return {
      model: {
        ...base,
        route,
        search: "",
        filter: "all",
        list: Remote.idle,
        detail: Remote.idle,
        payments: Remote.idle,
        editor: emptyEditor(),
      },
    };
  }

  const detail = Remote.load<ExpenseViewRecord>(Remote.idle);
  const payments = Remote.load<ReadonlyArray<PaymentRecord>>(Remote.idle);
  return {
    model: {
      ...base,
      route,
      search: "",
      filter: "all",
      list: Remote.idle,
      detail,
      payments,
      editor: null,
      selectedAttachmentId: route.attachment ?? null,
    },
    commands:
      wsId === undefined
        ? []
        : [
            loadDetailCommand(wsId, route.id, Remote.seqOf(detail)),
            loadPaymentsCommand(wsId, route.id, Remote.seqOf(payments)),
          ],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  const wsId = ctx.workspace?.id;

  return Message.match(message, {
    LoadedList: ({ seq, items }) => ({
      model: { ...model, list: Remote.succeed(model.list, seq, items) },
    }),

    FailedList: ({ seq, failure }) => ({
      model: { ...model, list: Remote.fail(model.list, seq, failure) },
    }),

    ChangedSearch: ({ value }) => ({
      model: { ...model, search: value },
    }),

    SelectedFilter: ({ filter }) => {
      const nextList = Remote.load(model.list);
      return {
        model: { ...model, filter, list: nextList },
        commands:
          wsId === undefined
            ? []
            : [loadListCommand(wsId, Remote.seqOf(nextList), filter === "incomplete")],
      };
    },

    ClickedRetryList: () => {
      const nextList = Remote.load(model.list);
      return {
        model: { ...model, list: nextList },
        commands:
          wsId === undefined
            ? []
            : [loadListCommand(wsId, Remote.seqOf(nextList), model.filter === "incomplete")],
      };
    },

    DraggedEnter: () => ({ model: { ...model, dragActive: true } }),
    DraggedLeave: () => ({ model: { ...model, dragActive: false } }),

    SelectedCaptureFiles: ({ files }) => {
      if (wsId === undefined || files.length === 0) {
        return { model: { ...model, dragActive: false } };
      }
      const realFiles = files.filter(
        (f): f is File => typeof File !== "undefined" && f instanceof File,
      );
      if (realFiles.length === 0) return { model: { ...model, dragActive: false } };
      const newJobs: Array<CaptureJob> = realFiles.map((f, idx) => ({
        id: newIdempotencyKey(`job${idx}`),
        fileName: f.name,
        fileSize: f.size,
        status: "creating",
        expenseId: null,
        error: null,
      }));
      const cmds = realFiles.map((f, idx) => {
        // biome-ignore lint/style/noNonNullAssertion: aligned with realFiles length
        const job = newJobs[idx]!;
        return createCaptureExpenseCommand(wsId, job.id, f);
      });
      return {
        model: {
          ...model,
          dragActive: false,
          captureJobs: [...newJobs, ...model.captureJobs],
        },
        commands: cmds,
      };
    },

    CaptureCreatedExpense: ({ jobId, expense, file }) => {
      const jobs = model.captureJobs.map((j) =>
        j.id === jobId ? { ...j, status: "uploading" as const, expenseId: expense.id } : j,
      );
      if (wsId === undefined || !(typeof File !== "undefined" && file instanceof File)) {
        return { model: { ...model, captureJobs: jobs } };
      }
      return {
        model: { ...model, captureJobs: jobs },
        commands: [
          uploadAttachmentCommand(
            "ExpensesCaptureUpload",
            wsId,
            expense.id,
            file,
            (attachment) =>
              Message.CaptureUploadedFile({ jobId, expenseId: expense.id, attachment }),
            (failure) => Message.CaptureFailed({ jobId, failure }),
          ),
        ],
      };
    },

    CaptureUploadedFile: ({ jobId, expenseId }) => {
      const jobs = model.captureJobs.map((j) =>
        j.id === jobId ? { ...j, status: "done" as const, expenseId } : j,
      );
      return {
        model: { ...model, captureJobs: jobs },
        outMessage:
          route._tag === "Expenses"
            ? Intent_.navigate(
                href({ _tag: "Expense", ws: route.ws, id: expenseId as ExpenseId, mode: "edit" }),
                false,
              )
            : Intent_.toast(tLocal(ctx.locale, "attachmentAdded"), "info"),
      };
    },

    CaptureFailed: ({ jobId, failure }) => ({
      model: {
        ...model,
        captureJobs: model.captureJobs.map((j) =>
          j.id === jobId ? { ...j, status: "failed" as const, error: textOf(tr, failure.text) } : j,
        ),
      },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),

    LoadedDetail: ({ seq, expense }) => {
      const nextDetail = Remote.succeed(model.detail, seq, expense);
      const shouldEdit = route._tag === "Expense" && route.mode === "edit" && canWrite(ctx);
      const firstAtt = model.selectedAttachmentId ?? expense.attachments[0]?.id ?? null;
      return {
        model: {
          ...model,
          detail: nextDetail,
          editor: shouldEdit ? editorFromExpense(expense) : model.editor,
          selectedAttachmentId: firstAtt,
        },
      };
    },

    FailedDetail: ({ seq, failure }) => ({
      model: { ...model, detail: Remote.fail(model.detail, seq, failure) },
    }),

    ClickedRetryDetail: () => {
      if (route._tag !== "Expense" || route.id === "new" || wsId === undefined) return { model };
      const nextDetail = Remote.load(model.detail);
      return {
        model: { ...model, detail: nextDetail },
        commands: [loadDetailCommand(wsId, route.id, Remote.seqOf(nextDetail))],
      };
    },

    LoadedPayments: ({ seq, payments }) => ({
      model: { ...model, payments: Remote.succeed(model.payments, seq, payments) },
    }),

    FailedPayments: ({ seq, failure }) => ({
      model: { ...model, payments: Remote.fail(model.payments, seq, failure) },
    }),

    ChangedEditorField: ({ field, value }) => {
      if (model.editor === null) return { model };
      const nextEd: ExpenseEditorDraft = {
        ...model.editor,
        [field]: value,
        ...(field === "supplierName" || field === "supplierIco" ? { supplierContactId: null } : {}),
        error: null,
        aresError: null,
      };
      const needsFx =
        wsId !== undefined &&
        (field === "currency" || field === "taxableSupplyOn" || field === "issuedOn") &&
        nextEd.currency !== "CZK";
      if (needsFx) {
        const nextFxSeq = nextEd.fxSeq + 1;
        return {
          model: { ...model, editor: { ...nextEd, fxBusy: true, fxSeq: nextFxSeq } },
          commands: [
            fetchFxCommand(
              wsId,
              nextEd.currency,
              nextEd.taxableSupplyOn || nextEd.issuedOn || todayIso(),
              nextFxSeq,
            ),
          ],
        };
      }
      if (field === "currency" && value === "CZK") {
        return {
          model: {
            ...model,
            editor: { ...nextEd, fxRate: "", fxQuantity: 1, fxFixingDate: null, fxBusy: false },
          },
        };
      }
      return { model: { ...model, editor: nextEd } };
    },

    ChangedExpenseStatus: ({ status }) => {
      if (model.editor === null) return { model };
      return { model: { ...model, editor: { ...model.editor, status, error: null } } };
    },

    ChangedDeductibilityMode: ({ mode }) => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            deductibilityMode: mode,
            deductibilityPercent: mode === "full" ? "100" : mode === "none" ? "0" : "50",
          },
        },
      };
    },

    AddedVatRow: () => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            vatLines: [
              ...model.editor.vatLines,
              { treatment: "standard", base: "", vat: "", selfAssessed: null },
            ],
          },
        },
      };
    },

    RemovedVatRow: ({ index }) => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            vatLines: model.editor.vatLines.filter((_, i) => i !== index),
          },
        },
      };
    },

    ChangedVatRow: ({ index, field, value }) => {
      if (model.editor === null) return { model };
      const vatLines = model.editor.vatLines.map((row, i) => {
        if (i !== index) return row;
        if (field === "treatment") {
          const isSelfAssessed = value === "reverse_charge" || value === "exempt_intra_eu_goods";
          const rate = vatRatePercent(value);
          const baseNum = parseUserDecimal(row.base);
          const computedVat =
            rate === 0
              ? "0.00"
              : baseNum !== null
                ? formatDecimalFixed((baseNum * rate) / 100, 2)
                : row.vat;
          return {
            ...row,
            treatment: value,
            vat: computedVat,
            selfAssessed: isSelfAssessed ? ("standard" as const) : null,
          };
        }
        if (field === "selfAssessed") {
          return {
            ...row,
            selfAssessed: value === "reduced" ? ("reduced" as const) : ("standard" as const),
          };
        }
        if (field === "base") {
          const rate = vatRatePercent(row.treatment);
          const baseNum = parseUserDecimal(value);
          const autoVat =
            baseNum !== null && rate > 0
              ? formatDecimalFixed((baseNum * rate) / 100, 2)
              : rate === 0
                ? "0.00"
                : row.vat;
          return { ...row, base: value, vat: autoVat };
        }
        return { ...row, vat: value };
      });
      return { model: { ...model, editor: { ...model.editor, vatLines, error: null } } };
    },

    ClickedAresLookup: () => {
      if (model.editor === null || wsId === undefined) return { model };
      const normalized = Format.normalizeIco(model.editor.supplierIco);
      if (Result.isFailure(Format.validateIco(normalized))) {
        return {
          model: {
            ...model,
            editor: { ...model.editor, aresError: tLocal(ctx.locale, "icoInvalid") },
          },
        };
      }
      const nextSeq = model.editor.aresSeq + 1;
      return {
        model: {
          ...model,
          editor: { ...model.editor, aresBusy: true, aresSeq: nextSeq, aresError: null },
        },
        commands: [lookupSupplierAresCommand(wsId, normalized, nextSeq)],
      };
    },

    LoadedAresSupplier: ({ seq, contactId, name, ico, dic }) => {
      if (model.editor === null || model.editor.aresSeq !== seq) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            aresBusy: false,
            supplierContactId: contactId,
            supplierName: name,
            supplierIco: ico ?? model.editor.supplierIco,
            supplierDic: dic ?? model.editor.supplierDic,
          },
        },
        outMessage: Intent_.toast(tLocal(ctx.locale, "aresLoaded"), "info"),
      };
    },

    FailedAresSupplier: ({ seq, failure }) => {
      if (model.editor === null || model.editor.aresSeq !== seq) return { model };
      return {
        model: {
          ...model,
          editor: { ...model.editor, aresBusy: false, aresError: textOf(tr, failure.text) },
        },
      };
    },

    LoadedFxRate: ({ seq, rate, quantity, fixingDate }) => {
      if (model.editor === null || model.editor.fxSeq !== seq) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            fxBusy: false,
            fxRate: rate,
            fxQuantity: quantity,
            fxFixingDate: fixingDate,
          },
        },
      };
    },

    FailedFxRate: ({ seq }) => {
      if (model.editor === null || model.editor.fxSeq !== seq) return { model };
      return {
        model: { ...model, editor: { ...model.editor, fxBusy: false } },
      };
    },

    SubmittedEditor: () => {
      if (model.editor === null || model.editor.saving || wsId === undefined) return { model };
      if (model.editor.status === "complete") {
        if (parseUserDecimal(model.editor.total) === null || model.editor.issuedOn.trim() === "") {
          return {
            model: {
              ...model,
              editor: { ...model.editor, error: tLocal(ctx.locale, "totalRequired") },
            },
          };
        }
        const preview = computeExpensePreview(model.editor);
        if (preview.difference !== null && Math.abs(preview.difference) > 0.001) {
          return {
            model: {
              ...model,
              editor: {
                ...model.editor,
                error: tLocal(ctx.locale, "vatMismatch", {
                  diff: moneyText(
                    ctx.locale,
                    formatDecimalFixed(preview.difference, 2),
                    model.editor.currency,
                  ),
                }),
              },
            },
          };
        }
      }
      const nextEd: ExpenseEditorDraft = { ...model.editor, saving: true, error: null };
      return {
        model: { ...model, editor: nextEd },
        commands: [saveExpenseCommand(wsId, nextEd)],
      };
    },

    SavedExpense: ({ expense }) => ({
      model: {
        ...model,
        detail: { _tag: "Loaded", seq: Remote.seqOf(model.detail) + 1, data: expense },
        editor: null,
      },
      outMessage: Intent_.navigate(
        href({ _tag: "Expense", ws: route.ws, id: expense.id as ExpenseId, mode: "view" }),
        false,
      ),
    }),

    FailedSave: ({ failure }) => {
      if (model.editor === null) return { model };
      const msg = failure.staleRevision
        ? tLocal(ctx.locale, "staleNotice")
        : textOf(tr, failure.text);
      return {
        model: { ...model, editor: { ...model.editor, saving: false, error: msg } },
      };
    },

    SelectedAttachment: ({ id }) => ({
      model: { ...model, selectedAttachmentId: id },
    }),

    ChangedZoom: ({ delta }) => ({
      model: { ...model, viewerZoom: Math.max(50, Math.min(200, model.viewerZoom + delta)) },
    }),

    SelectedDetailFiles: ({ files }) => {
      const expense = Remote.dataOf(model.detail);
      if (wsId === undefined || expense === undefined) return { model };
      const first = files.find((f): f is File => typeof File !== "undefined" && f instanceof File);
      if (first === undefined) return { model };
      return {
        model: { ...model, uploadingAttachment: true },
        commands: [
          uploadAttachmentCommand(
            "ExpensesDetailUpload",
            wsId,
            expense.id,
            first,
            (attachment) => Message.UploadedAttachment({ attachment }),
            (failure) => Message.FailedUploadAttachment({ failure }),
          ),
        ],
      };
    },

    UploadedAttachment: ({ attachment }) => {
      const expense = Remote.dataOf(model.detail);
      if (expense === undefined) return { model: { ...model, uploadingAttachment: false } };
      const updated: ExpenseViewRecord = {
        ...expense,
        revision: expense.revision + 1,
        attachments: [...expense.attachments, attachment],
      };
      return {
        model: {
          ...model,
          uploadingAttachment: false,
          selectedAttachmentId: attachment.id,
          detail: { _tag: "Loaded", seq: Remote.seqOf(model.detail), data: updated },
        },
        outMessage: Intent_.toast(tLocal(ctx.locale, "attachmentAdded"), "info"),
      };
    },

    FailedUploadAttachment: ({ failure }) => ({
      model: { ...model, uploadingAttachment: false },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),

    ClickedDownloadAttachment: ({ attachment }) => {
      if (wsId === undefined) return { model };
      const path = `/api/v1/workspaces/${encodeURIComponent(wsId)}/expenses/${encodeURIComponent(attachment.expenseId)}/attachments/${encodeURIComponent(attachment.id)}?disposition=attachment`;
      return {
        model,
        commands: [
          downloadUrlCommand(
            "ExpensesDownloadAttachment",
            path,
            attachment.name,
            () => Message.CompletedDownload(),
            (failure) => Message.FailedDownload({ failure }),
          ),
        ],
      };
    },

    CompletedDownload: () => ({ model }),
    FailedDownload: ({ failure }) => ({
      model,
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),

    RequestedDetach: ({ id }) => ({ model: { ...model, confirmDetachId: id } }),
    CancelledDetach: () => ({ model: { ...model, confirmDetachId: null } }),

    ConfirmedDetach: () => {
      const expense = Remote.dataOf(model.detail);
      if (wsId === undefined || expense === undefined || model.confirmDetachId === null) {
        return { model };
      }
      return {
        model: { ...model, detaching: true },
        commands: [detachAttachmentCommand(wsId, expense.id, model.confirmDetachId)],
      };
    },

    DetachedAttachment: ({ id }) => {
      const expense = Remote.dataOf(model.detail);
      if (expense === undefined) {
        return { model: { ...model, detaching: false, confirmDetachId: null } };
      }
      const nextAtts = expense.attachments.filter((a) => a.id !== id);
      return {
        model: {
          ...model,
          detaching: false,
          confirmDetachId: null,
          selectedAttachmentId:
            model.selectedAttachmentId === id
              ? (nextAtts[0]?.id ?? null)
              : model.selectedAttachmentId,
          detail: {
            _tag: "Loaded",
            seq: Remote.seqOf(model.detail),
            data: { ...expense, attachments: nextAtts },
          },
        },
        outMessage: Intent_.toast(tLocal(ctx.locale, "attachmentRemoved"), "info"),
      };
    },

    FailedDetach: ({ failure }) => ({
      model: { ...model, detaching: false, confirmDetachId: null },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),

    RequestedRemove: () => ({ model: { ...model, confirmRemove: true } }),
    CancelledRemove: () => ({ model: { ...model, confirmRemove: false } }),

    ConfirmedRemove: () => {
      const expense = Remote.dataOf(model.detail);
      if (wsId === undefined || expense === undefined) return { model };
      return {
        model: { ...model, removing: true },
        commands: [removeExpenseCommand(wsId, expense.id, expense.revision)],
      };
    },

    RemovedExpense: () => ({
      model: { ...model, removing: false, confirmRemove: false },
      outMessage: Intent_.navigate(href({ _tag: "Expenses", ws: route.ws, query: {} }), false),
    }),

    FailedRemove: ({ failure }) => ({
      model: { ...model, removing: false, confirmRemove: false },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),

    OpenedPaymentDialog: ({ presetFull }) => {
      const expense = Remote.dataOf(model.detail);
      if (expense === undefined) return { model };
      const total = parseUserDecimal(expense.total ?? "0") ?? 0;
      const paid = parseUserDecimal(expense.payment.paid?.amount ?? "0") ?? 0;
      const remaining = Math.max(0, total - paid);
      return {
        model: {
          ...model,
          paymentDialog: {
            amount: presetFull ? formatDecimalFixed(remaining, 2) : "",
            paidOn: todayIso(),
            method: "bank_transfer",
            note: "",
            idempotencyKey: newIdempotencyKey("pay"),
            submitting: false,
            error: null,
          },
        },
      };
    },

    ClosedPaymentDialog: () => ({ model: { ...model, paymentDialog: null } }),

    ChangedPaymentField: ({ field, value }) => {
      if (model.paymentDialog === null) return { model };
      return {
        model: {
          ...model,
          paymentDialog: { ...model.paymentDialog, [field]: value, error: null },
        },
      };
    },

    SubmittedPayment: () => {
      const expense = Remote.dataOf(model.detail);
      if (
        wsId === undefined ||
        expense === undefined ||
        model.paymentDialog === null ||
        model.paymentDialog.submitting
      ) {
        return { model };
      }
      const nextDlg: PaymentDialogState = { ...model.paymentDialog, submitting: true, error: null };
      return {
        model: { ...model, paymentDialog: nextDlg },
        commands: [recordPaymentCommand(wsId, expense.id, expense.currency ?? "CZK", nextDlg)],
      };
    },

    RecordedPayment: ({ payment }) => {
      const expense = Remote.dataOf(model.detail);
      const nextPayments = [payment, ...(Remote.dataOf(model.payments) ?? [])];
      const nextDetail = Remote.load(model.detail);
      return {
        model: {
          ...model,
          paymentDialog: null,
          payments: { _tag: "Loaded", seq: Remote.seqOf(model.payments), data: nextPayments },
          detail: expense !== undefined ? nextDetail : model.detail,
        },
        commands:
          wsId !== undefined && expense !== undefined
            ? [loadDetailCommand(wsId, expense.id, Remote.seqOf(nextDetail))]
            : [],
        outMessage: Intent_.toast(tLocal(ctx.locale, "paymentRecorded"), "info"),
      };
    },

    FailedRecordPayment: ({ failure }) => {
      if (model.paymentDialog === null) return { model };
      return {
        model: {
          ...model,
          paymentDialog: {
            ...model.paymentDialog,
            submitting: false,
            error: textOf(tr, failure.text),
          },
        },
      };
    },

    RequestedRemovePayment: ({ id }) => ({
      model: { ...model, confirmRemovePaymentId: id, removePaymentReason: "" },
    }),

    ChangedRemovePaymentReason: ({ value }) => ({
      model: { ...model, removePaymentReason: value },
    }),

    CancelledRemovePayment: () => ({
      model: { ...model, confirmRemovePaymentId: null, removePaymentReason: "" },
    }),

    ConfirmedRemovePayment: () => {
      if (wsId === undefined || model.confirmRemovePaymentId === null) return { model };
      const reason = model.removePaymentReason.trim() || "Removed by user";
      return {
        model: { ...model, removingPayment: true },
        commands: [removePaymentCommand(wsId, model.confirmRemovePaymentId, reason)],
      };
    },

    RemovedPayment: ({ id }) => {
      const expense = Remote.dataOf(model.detail);
      const remaining = (Remote.dataOf(model.payments) ?? []).filter((p) => p.id !== id);
      const nextDetail = Remote.load(model.detail);
      return {
        model: {
          ...model,
          removingPayment: false,
          confirmRemovePaymentId: null,
          removePaymentReason: "",
          payments: { _tag: "Loaded", seq: Remote.seqOf(model.payments), data: remaining },
          detail: expense !== undefined ? nextDetail : model.detail,
        },
        commands:
          wsId !== undefined && expense !== undefined
            ? [loadDetailCommand(wsId, expense.id, Remote.seqOf(nextDetail))]
            : [],
        outMessage: Intent_.toast(tLocal(ctx.locale, "paymentRemoved"), "info"),
      };
    },

    FailedRemovePayment: ({ failure }) => ({
      model: { ...model, removingPayment: false, confirmRemovePaymentId: null },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

export const title = (model: Model, ctx: PageContext): string => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  if (route._tag === "Expenses") return tr.t("expenses.list.title");
  if (route._tag === "ExpenseCapture") return tr.t("expenses.capture.title");
  if (route.id === "new") return tr.t("expenses.list.new");
  const detail = Remote.dataOf(model.detail);
  return detail?.supplier?.name ?? detail?.supplierDocumentNumber ?? tr.t("expenses.editor.title");
};

// --- Attachment Viewer Helper --------------------------------------------------------------------

const renderAttachmentViewer = (
  h: Html.H<Message>,
  ctx: PageContext,
  model: Model,
  expense: ExpenseViewRecord | undefined,
  writable: boolean,
): Markup<Message> => {
  const tr = translator(ctx.locale);
  const attachments = expense?.attachments ?? [];
  const selected = attachments.find((a) => a.id === model.selectedAttachmentId) ?? attachments[0];
  const wsId = ctx.workspace?.id ?? "";
  const inlineUrl =
    selected !== undefined
      ? `/api/v1/workspaces/${encodeURIComponent(wsId)}/expenses/${encodeURIComponent(selected.expenseId)}/attachments/${encodeURIComponent(selected.id)}?disposition=inline`
      : "";

  return card(
    h,
    [
      cardTitle(h, tr.t("expenses.detail.attachments"), [
        ...(writable && expense !== undefined
          ? [
              h.label
                .class(cn(buttonVariants({ size: "small" }), "relative overflow-hidden"))
                .children([
                  icon(h, "upload", 14),
                  tr.t("expenses.detail.addFiles"),
                  h.input
                    .class("absolute inset-0 cursor-pointer opacity-0")
                    .attr("type", "file")
                    .attr("accept", ALLOWED_MIME_TYPES)
                    .on("change", ({ files }) => Message.SelectedDetailFiles({ files })),
                ]),
            ]
          : []),
      ]),
      selected === undefined
        ? h.div
            .class(
              "flex min-h-[320px] flex-col items-center justify-center gap-2.5 overflow-hidden rounded-control border border-outline-variant bg-surface-container-low p-4",
            )
            .children([h.p.class(ui.muted).children([tLocal(ctx.locale, "noAttachments")])])
        : h.div.class(ui.stack).children([
            h.div
              .attr("data-slot", "spread")
              .class(ui.spread)
              .children([
                h.span.class(cn(ui.small, ui.mono)).children([selected.name]),
                h.div.class(ui.row).children([
                  button(h, {
                    label: "−",
                    small: true,
                    ariaLabel: "Zoom out",
                    onClick: Message.ChangedZoom({ delta: -25 }),
                  }),
                  h.span.class(cn(ui.small, ui.num)).children([`${model.viewerZoom} %`]),
                  button(h, {
                    label: "+",
                    small: true,
                    ariaLabel: "Zoom in",
                    onClick: Message.ChangedZoom({ delta: 25 }),
                  }),
                  button(h, {
                    label: tr.t("common.action.download"),
                    small: true,
                    icon: icon(h, "download", 14),
                    onClick: Message.ClickedDownloadAttachment({ attachment: selected }),
                  }),
                  ...(writable
                    ? [
                        button(h, {
                          label: tr.t("common.action.remove"),
                          variant: "ghost",
                          small: true,
                          onClick: Message.RequestedDetach({ id: selected.id }),
                        }),
                      ]
                    : []),
                ]),
              ]),
            h.div
              .class(
                "flex min-h-[320px] flex-col items-center justify-center gap-2.5 overflow-hidden rounded-control border border-outline-variant bg-surface-container-low p-4 [&_iframe]:min-h-[400px] [&_iframe]:w-full [&_iframe]:rounded-control [&_iframe]:border-0 [&_iframe]:bg-surface-container-lowest [&_img]:max-h-[440px] [&_img]:w-auto [&_img]:rounded-control [&_img]:object-contain [&_object]:min-h-[400px] [&_object]:w-full [&_object]:rounded-control [&_object]:border-0 [&_object]:bg-surface-container-lowest",
              )
              .children([
                selected.contentType.startsWith("image/")
                  ? h.img
                      .attr("src", inlineUrl)
                      .attr("alt", selected.name)
                      .style({ transform: `scale(${model.viewerZoom / 100})` })
                  : h
                      .el("object")
                      .attr("data", inlineUrl)
                      .attr("type", selected.contentType)
                      .children([
                        h.p
                          .class(ui.muted)
                          .children([
                            tLocal(ctx.locale, "previewFallback", { name: selected.name }),
                          ]),
                      ]),
              ]),
            ...(attachments.length > 1
              ? [
                  h.div
                    .class("flex flex-wrap gap-2")
                    .children(
                      attachments.map((att) =>
                        withAttributes(h.button.class(), [
                          (element) =>
                            element.class(
                              "inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-outline-variant bg-surface-container-lowest px-2.5 py-1.5 text-[0.75rem] aria-[current=true]:border-primary aria-[current=true]:bg-primary-container aria-[current=true]:text-on-primary-container",
                            ),
                          (element) => element.attr("type", "button"),
                          (node) =>
                            att.id === selected.id ? node.attr("aria-current", "true") : node,
                          (element) =>
                            element.on("click", Message.SelectedAttachment({ id: att.id })),
                        ]).children([
                          h.span.class(ui.mono).children([att.name]),
                          h.span.class(ui.muted).children([formatBytes(att.bytes)]),
                        ]),
                      ),
                    ),
                ]
              : []),
          ]),
    ],
    [attribute("class", cn(cardVariants(), "flex flex-col gap-3 lg:sticky lg:top-4"))],
  );
};

// --- Main View -----------------------------------------------------------------------------------

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  const writable = canWrite(ctx);

  // --- Screen 13: Expenses List ---
  if (route._tag === "Expenses") {
    const allItems = Remote.dataOf(model.list) ?? [];
    const incompleteCount = allItems.filter((i) => i.status === "incomplete").length;
    const query = model.search.trim().toLowerCase();
    const filtered = allItems.filter((item) => {
      if (model.filter === "incomplete" && item.status !== "incomplete") return false;
      if (
        model.filter === "unpaid" &&
        item.settlement !== "unpaid" &&
        item.settlement !== "partially_paid"
      )
        return false;
      if (model.filter === "paid" && item.settlement !== "paid" && item.settlement !== "overpaid")
        return false;
      if (query === "") return true;
      return (
        (item.supplierName ?? "").toLowerCase().includes(query) ||
        (item.supplierDocumentNumber ?? "").toLowerCase().includes(query) ||
        (item.category ?? "").toLowerCase().includes(query)
      );
    });

    const headers = [
      tr.t("expenses.list.column.supplier"),
      tr.t("expenses.list.column.date"),
      tLocal(ctx.locale, "colCategory"),
      tLocal(ctx.locale, "colStatus"),
      tr.t("expenses.list.column.total"),
    ];

    const listBody = (() => {
      if (model.list._tag === "Loading" || model.list._tag === "Idle") {
        return skeletonTable(h, headers, 6);
      }
      if (model.list._tag === "Failed") {
        return banner(h, {
          text: textOf(tr, model.list.failure.text),
          tone: "error",
          action: button(h, {
            label: tr.t("common.action.retry"),
            small: true,
            onClick: Message.ClickedRetryList(),
          }),
        });
      }
      if (filtered.length === 0) {
        return emptyState(h, {
          title: tr.t("expenses.list.empty.title"),
          body: tr.t("expenses.list.empty.web"),
          ...(writable
            ? {
                action: linkButton(h, {
                  label: tr.t("expenses.list.new"),
                  href: href({ _tag: "Expense", ws: route.ws, id: "new", mode: "edit" }),
                  variant: "primary",
                }),
              }
            : {}),
        });
      }
      return table(h, {
        caption: tr.t("expenses.list.title"),
        rows: filtered,
        rowKey: (item) => item.id,
        columns: [
          {
            header: tr.t("expenses.list.column.supplier"),
            cell: (item) =>
              h.div
                .class(ui.stack)
                .style({ "--kb-gap": "2px" })
                .children([
                  h.a
                    .attr(
                      "href",
                      href({
                        _tag: "Expense",
                        ws: route.ws,
                        id: item.id as ExpenseId,
                        mode: item.status === "incomplete" && writable ? "edit" : "view",
                      }),
                    )
                    .children([
                      h.strong.children([item.supplierName ?? tr.t("common.state.unknown")]),
                    ]),
                  ...(item.supplierDocumentNumber !== null
                    ? [
                        h.span
                          .class(cn(ui.small, ui.mono, ui.muted))
                          .children([item.supplierDocumentNumber]),
                      ]
                    : []),
                ]),
          },
          {
            header: tr.t("expenses.list.column.date"),
            cell: (item) => dateText(ctx.locale, item.issuedOn),
          },
          {
            header: tLocal(ctx.locale, "colCategory"),
            cell: (item) => h.span.class(ui.muted).children([item.category ?? "—"]),
          },
          {
            header: tLocal(ctx.locale, "colStatus"),
            cell: (item) =>
              h.div
                .class(ui.row)
                .children([
                  ...(item.status === "incomplete"
                    ? [badge(h, enumLabel(tr, "badge", "incomplete"), "proforma")]
                    : []),
                  badge(
                    h,
                    enumLabel(tr, "settlement", item.settlement),
                    settlementTone(item.settlement),
                  ),
                  ...(item.attachments > 0 ? [badge(h, `${item.attachments} 📎`, "outline")] : []),
                ]),
          },
          {
            header: tr.t("expenses.list.column.total"),
            align: "end",
            numeric: true,
            cell: (item) =>
              item.total !== null && item.currency !== null
                ? h.strong.children([moneyText(ctx.locale, item.total, item.currency)])
                : h.span.class(ui.muted).children(["—"]),
          },
        ],
      });
    })();

    return page(h, [
      pageHeader(h, {
        title: tr.t("expenses.list.title"),
        subtitle: tLocal(ctx.locale, "subtitle"),
        actions: writable
          ? [
              linkButton(h, {
                label: tLocal(ctx.locale, "snapUpload"),
                href: href({ _tag: "ExpenseCapture", ws: route.ws }),
              }),
              linkButton(h, {
                label: tr.t("expenses.list.new"),
                href: href({ _tag: "Expense", ws: route.ws, id: "new", mode: "edit" }),
                variant: "primary",
              }),
            ]
          : [],
      }),
      ...(writable
        ? [
            h.div
              .attr("data-slot", "dropzone")
              .class(dropzoneVariants({ active: model.dragActive }))
              .on("dragenter", Message.DraggedEnter(), { preventDefault: true })
              .on("dragleave", Message.DraggedLeave())
              .on("drop", ({ files }) => Message.SelectedCaptureFiles({ files }), {
                preventDefault: true,
              })
              .children([
                h.div.class("flex min-w-0 items-center gap-3").children([
                  h.span
                    .class(
                      "grid h-10 w-10 flex-none place-items-center rounded-control bg-surface-container-high text-on-surface",
                    )
                    .children([icon(h, "upload", 20)]),
                  h.div
                    .class(ui.stack)
                    .style({ "--kb-gap": "2px" })
                    .children([
                      h.strong.children([tLocal(ctx.locale, "dropTitle")]),
                      h.span
                        .class(cn(ui.small, ui.muted))
                        .children([tLocal(ctx.locale, "dropSub")]),
                    ]),
                ]),
                h.label
                  .class(cn(buttonVariants({ size: "small" }), "relative overflow-hidden"))
                  .children([
                    tr.t("expenses.capture.files"),
                    h.input
                      .class("absolute inset-0 cursor-pointer opacity-0")
                      .attr("type", "file")
                      .attr("accept", ALLOWED_MIME_TYPES)
                      .attr("multiple", "")
                      .on("change", ({ files }) => Message.SelectedCaptureFiles({ files })),
                  ]),
              ]),
          ]
        : []),
      h.div
        .attr("data-slot", "rec-toolbar")
        .class("flex flex-wrap items-center justify-between gap-3")
        .children([
          h.div.class("relative max-w-[380px] flex-[1_1_240px]").children([
            h.span
              .class(
                "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant",
              )
              .children([icon(h, "search", 16)]),
            h.input
              .class(cn(controlVariants({ kind: "input" }), "pl-[34px]"))
              .attr("type", "search")
              .attr("placeholder", tr.t("expenses.list.search"))
              .attr("aria-label", tr.t("expenses.list.search"))
              .value(model.search)
              .on("input", ({ value }) => Message.ChangedSearch({ value })),
          ]),
          h.div.class("flex flex-wrap items-center gap-1.5").children([
            h.button
              .class(chipVariants({ active: model.filter === "all" }))
              .attr("type", "button")
              .attr("aria-pressed", String(model.filter === "all" ? "true" : "false"))
              .on("click", Message.SelectedFilter({ filter: "all" }))
              .children([tLocal(ctx.locale, "filterAll", { count: allItems.length })]),
            h.button
              .class(chipVariants({ active: model.filter === "incomplete" }))
              .attr("type", "button")
              .attr("aria-pressed", String(model.filter === "incomplete" ? "true" : "false"))
              .on("click", Message.SelectedFilter({ filter: "incomplete" }))
              .children([tLocal(ctx.locale, "filterIncomplete", { count: incompleteCount })]),
            h.button
              .class(chipVariants({ active: model.filter === "unpaid" }))
              .attr("type", "button")
              .attr("aria-pressed", String(model.filter === "unpaid" ? "true" : "false"))
              .on("click", Message.SelectedFilter({ filter: "unpaid" }))
              .children([tLocal(ctx.locale, "filterUnpaid")]),
            h.button
              .class(chipVariants({ active: model.filter === "paid" }))
              .attr("type", "button")
              .attr("aria-pressed", String(model.filter === "paid" ? "true" : "false"))
              .on("click", Message.SelectedFilter({ filter: "paid" }))
              .children([tLocal(ctx.locale, "filterPaid")]),
          ]),
        ]),
      listBody,
    ]);
  }

  // --- Screen 13: Quick Capture ---
  if (route._tag === "ExpenseCapture") {
    return page(h, [
      pageHeader(h, {
        title: tr.t("expenses.capture.title"),
        subtitle: tLocal(ctx.locale, "captureSubtitle"),
        eyebrow: linkButton(h, {
          label: tLocal(ctx.locale, "backToList"),
          href: href({ _tag: "Expenses", ws: route.ws, query: {} }),
          variant: "ghost",
          small: true,
        }),
      }),
      h.div
        .class("grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]")
        .children([
          h.div
            .attr("data-slot", "capture-stage")
            .class(
              cn(
                "flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-panel border border-dashed px-5 py-7 text-center transition-[background-color,border-color] duration-150 ease-out",
                model.dragActive
                  ? "border-primary bg-primary-container text-on-primary-container"
                  : "border-outline bg-surface-container-low",
              ),
            )
            .on("dragenter", Message.DraggedEnter(), { preventDefault: true })
            .on("dragleave", Message.DraggedLeave())
            .on("drop", ({ files }) => Message.SelectedCaptureFiles({ files }), {
              preventDefault: true,
            })
            .children([
              icon(h, "upload", 28),
              h.strong.children([tLocal(ctx.locale, "dropTitle")]),
              h.p.class(cn(ui.small, ui.muted)).children([tr.t("expenses.capture.edgeHint")]),
              h.label
                .class(cn(buttonVariants({ variant: "primary" }), "relative overflow-hidden"))
                .children([
                  tr.t("expenses.capture.files"),
                  h.input
                    .class("absolute inset-0 cursor-pointer opacity-0")
                    .attr("type", "file")
                    .attr("accept", ALLOWED_MIME_TYPES)
                    .attr("multiple", "")
                    .on("change", ({ files }) => Message.SelectedCaptureFiles({ files })),
                ]),
            ]),
          card(h, [
            cardTitle(h, tLocal(ctx.locale, "captureQueue")),
            model.captureJobs.length === 0
              ? h.p.class(ui.muted).children([tLocal(ctx.locale, "captureEmpty")])
              : h.div.class(ui.stack).children(
                  model.captureJobs.map((job) =>
                    h.div
                      .attr("data-slot", "spread")
                      .class(ui.spread)
                      .children([
                        h.div
                          .class(ui.stack)
                          .style({ "--kb-gap": "2px" })
                          .children([
                            h.span.class(ui.mono).children([job.fileName]),
                            h.span
                              .class(cn(ui.small, ui.muted))
                              .children([formatBytes(job.fileSize)]),
                            ...(job.error !== null
                              ? [h.span.class(ui.fieldError).children([job.error])]
                              : []),
                          ]),
                        h.div.class(ui.row).children([
                          badge(
                            h,
                            job.status === "done"
                              ? enumLabel(tr, "captureJob", "done")
                              : job.status === "failed"
                                ? enumLabel(tr, "captureJob", "failed")
                                : enumLabel(tr, "captureJob", "uploading"),
                            job.status === "done"
                              ? "paid"
                              : job.status === "failed"
                                ? "error"
                                : "proforma",
                          ),
                          ...(job.expenseId !== null
                            ? [
                                linkButton(h, {
                                  label: tr.t("expenses.capture.openJob"),
                                  href: href({
                                    _tag: "Expense",
                                    ws: route.ws,
                                    id: job.expenseId as ExpenseId,
                                    mode: "edit",
                                  }),
                                  small: true,
                                }),
                              ]
                            : []),
                        ]),
                      ]),
                  ),
                ),
          ]),
        ]),
    ]);
  }

  // --- Screen 14: Expense Editor / Detail ---
  const loadedExpense = Remote.dataOf(model.detail);

  if (route.id !== "new" && (model.detail._tag === "Loading" || model.detail._tag === "Idle")) {
    return page(h, [
      pageHeader(h, { title: tr.t("expenses.editor.title") }),
      card(h, [skeleton(h, "45%", "1.4rem"), skeleton(h, "100%", "14rem")]),
    ]);
  }

  if (route.id !== "new" && model.detail._tag === "Failed") {
    return page(h, [
      pageHeader(h, { title: tr.t("expenses.editor.title") }),
      banner(h, {
        text: textOf(tr, model.detail.failure.text),
        tone: "error",
        action: button(h, {
          label: tr.t("common.action.retry"),
          small: true,
          onClick: Message.ClickedRetryDetail(),
        }),
      }),
    ]);
  }

  // Editor mode
  if ((route.id === "new" || route.mode === "edit") && model.editor !== null && writable) {
    const ed = model.editor;
    const preview = computeExpensePreview(ed);
    const cancelHref =
      route.id === "new"
        ? href({ _tag: "Expenses", ws: route.ws, query: {} })
        : href({ _tag: "Expense", ws: route.ws, id: route.id, mode: "view" });

    return page(h, [
      pageHeader(h, {
        title:
          route.id === "new"
            ? tr.t("expenses.list.new")
            : ed.supplierName || tr.t("expenses.editor.title"),
        eyebrow: linkButton(h, {
          label: tLocal(ctx.locale, "backToList"),
          href: href({ _tag: "Expenses", ws: route.ws, query: {} }),
          variant: "ghost",
          small: true,
        }),
        actions: [
          linkButton(h, { label: tr.t("common.action.cancel"), href: cancelHref }),
          button(h, {
            label: tr.t("common.action.save"),
            variant: "primary",
            busy: ed.saving,
            onClick: Message.SubmittedEditor(),
          }),
        ],
      }),
      h.div
        .attr("data-slot", "expense-split")
        .class(
          "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(280px,0.95fr)_minmax(0,1.35fr)]",
        )
        .children([
          renderAttachmentViewer(h, ctx, model, loadedExpense, writable),
          h.form
            .class(ui.stack)
            .on("submit", Message.SubmittedEditor(), { preventDefault: true })
            .children([
              ...(ed.error !== null ? [banner(h, { text: ed.error, tone: "error" })] : []),
              ...(ed.aresError !== null ? [banner(h, { text: ed.aresError, tone: "error" })] : []),
              card(h, [
                cardTitle(h, tr.t("expenses.editor.supplier")),
                h.div
                  .attr("data-slot", "form-grid")
                  .class(ui.formGrid)
                  .children([
                    h.div.class("flex items-end gap-2 [&>[data-slot=field]]:flex-1").children([
                      textField(h, {
                        id: "exp-supplier-ico",
                        label: tLocal(ctx.locale, "supplierIco"),
                        value: ed.supplierIco,
                        mono: true,
                        placeholder: "27082440",
                        onInput: (value) =>
                          Message.ChangedEditorField({ field: "supplierIco", value }),
                      }),
                      button(h, {
                        label: tLocal(ctx.locale, "aresLookup"),
                        busy: ed.aresBusy,
                        small: true,
                        onClick: Message.ClickedAresLookup(),
                      }),
                    ]),
                    textField(h, {
                      id: "exp-doc-number",
                      label: tr.t("expenses.editor.number"),
                      value: ed.supplierDocumentNumber,
                      mono: true,
                      onInput: (value) =>
                        Message.ChangedEditorField({ field: "supplierDocumentNumber", value }),
                    }),
                    textField(h, {
                      id: "exp-supplier-name",
                      label: tLocal(ctx.locale, "supplierName"),
                      value: ed.supplierName,
                      onInput: (value) =>
                        Message.ChangedEditorField({ field: "supplierName", value }),
                    }),
                    textField(h, {
                      id: "exp-supplier-dic",
                      label: tLocal(ctx.locale, "supplierDic"),
                      value: ed.supplierDic,
                      mono: true,
                      onInput: (value) =>
                        Message.ChangedEditorField({ field: "supplierDic", value }),
                    }),
                  ]),
              ]),
              card(h, [
                cardTitle(h, tr.t("expenses.editor.title")),
                h.div
                  .attr("data-slot", "form-grid")
                  .class(ui.formGrid3)
                  .children([
                    textField(h, {
                      id: "exp-issued-on",
                      label: tr.t("expenses.editor.issueDate"),
                      type: "date",
                      value: ed.issuedOn,
                      onInput: (value) => Message.ChangedEditorField({ field: "issuedOn", value }),
                    }),
                    textField(h, {
                      id: "exp-duzp",
                      label: tr.t("expenses.editor.taxableSupplyDate"),
                      type: "date",
                      value: ed.taxableSupplyOn,
                      onInput: (value) =>
                        Message.ChangedEditorField({ field: "taxableSupplyOn", value }),
                    }),
                    textField(h, {
                      id: "exp-due-on",
                      label: tr.t("expenses.editor.dueDate"),
                      type: "date",
                      value: ed.dueOn,
                      onInput: (value) => Message.ChangedEditorField({ field: "dueOn", value }),
                    }),
                  ]),
                h.div
                  .attr("data-slot", "form-grid")
                  .class(ui.formGrid)
                  .children([
                    textField(h, {
                      id: "exp-total",
                      label: tr.t("expenses.editor.gross"),
                      value: ed.total,
                      mono: true,
                      onInput: (value) => Message.ChangedEditorField({ field: "total", value }),
                    }),
                    selectField(h, {
                      id: "exp-currency",
                      label: tr.t("common.field.currency"),
                      value: ed.currency,
                      options: CURRENCIES.map((c) => ({ value: c, label: c })),
                      onChange: (value) => Message.ChangedEditorField({ field: "currency", value }),
                    }),
                  ]),
                ...(ed.currency !== "CZK"
                  ? [
                      banner(h, {
                        tone: "info",
                        text: ed.fxBusy
                          ? tLocal(ctx.locale, "fxLoading")
                          : ed.fxRate !== ""
                            ? tLocal(ctx.locale, "fxFixingNote", {
                                date: dateText(ctx.locale, ed.fxFixingDate),
                                qty: ed.fxQuantity,
                                currency: ed.currency,
                                rate: ed.fxRate,
                              })
                            : tLocal(ctx.locale, "fxRateLabel", { currency: ed.currency }),
                      }),
                    ]
                  : []),
                h.div.class(ui.stack).children([
                  h.div
                    .attr("data-slot", "spread")
                    .class(ui.spread)
                    .children([
                      h.h3.children([tr.t("expenses.editor.vatBreakdown")]),
                      button(h, {
                        label: tr.t("expenses.editor.addVatRow"),
                        small: true,
                        icon: icon(h, "plus", 14),
                        onClick: Message.AddedVatRow(),
                      }),
                    ]),
                  h.div.class("flex flex-col gap-2").children(
                    ed.vatLines.map((row, idx) =>
                      h.div
                        .class(
                          "grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(140px,1.3fr)_minmax(90px,1fr)_minmax(90px,1fr)_auto]",
                        )
                        .children([
                          selectField(h, {
                            id: `exp-vat-tr-${idx}`,
                            label: tr.t("common.field.vatRate"),
                            value: row.treatment,
                            options: VAT_TREATMENTS.map((v) => ({
                              value: v,
                              label: enumLabel(tr, "vatTreatment", v),
                            })),
                            onChange: (value) =>
                              Message.ChangedVatRow({ index: idx, field: "treatment", value }),
                          }),
                          textField(h, {
                            id: `exp-vat-base-${idx}`,
                            label: tr.t("expenses.editor.base"),
                            value: row.base,
                            mono: true,
                            onInput: (value) =>
                              Message.ChangedVatRow({ index: idx, field: "base", value }),
                          }),
                          textField(h, {
                            id: `exp-vat-tax-${idx}`,
                            label: tr.t("expenses.editor.vat"),
                            value: row.vat,
                            mono: true,
                            onInput: (value) =>
                              Message.ChangedVatRow({ index: idx, field: "vat", value }),
                          }),
                          button(h, {
                            label: tr.t("common.action.remove"),
                            variant: "ghost",
                            small: true,
                            onClick: Message.RemovedVatRow({ index: idx }),
                          }),
                        ]),
                    ),
                  ),
                ]),
                h.div
                  .attr("data-slot", "form-grid")
                  .class(ui.formGrid)
                  .children([
                    h.div
                      .attr("data-slot", "field")
                      .class(ui.field)
                      .children([
                        h.span.class(ui.fieldLabel).children([tLocal(ctx.locale, "deductibility")]),
                        segmented(h, {
                          label: tLocal(ctx.locale, "deductibility"),
                          selected: ed.deductibilityMode,
                          items: [
                            { id: "full", label: tLocal(ctx.locale, "dedFull") },
                            { id: "partial", label: tLocal(ctx.locale, "dedPartial") },
                            { id: "none", label: tLocal(ctx.locale, "dedNone") },
                          ],
                          onSelect: (id) =>
                            Message.ChangedDeductibilityMode({
                              mode: id as "full" | "none" | "partial",
                            }),
                        }),
                      ]),
                    ...(ed.deductibilityMode === "partial"
                      ? [
                          textField(h, {
                            id: "exp-ded-pct",
                            label: tLocal(ctx.locale, "dedPercent"),
                            type: "number",
                            value: ed.deductibilityPercent,
                            mono: true,
                            onInput: (value) =>
                              Message.ChangedEditorField({ field: "deductibilityPercent", value }),
                          }),
                        ]
                      : []),
                  ]),
                h.div
                  .class(
                    "flex flex-wrap justify-between gap-4 rounded-control border border-outline-variant bg-surface-container-low px-3.5 py-3",
                  )
                  .children([
                    h.div
                      .class("flex flex-col gap-0.5")
                      .children([
                        h.span
                          .class("text-[0.75rem] text-on-surface-variant")
                          .children([tr.t("expenses.editor.base")]),
                        h.span
                          .class("font-semibold kb-num")
                          .children([
                            moneyText(
                              ctx.locale,
                              formatDecimalFixed(preview.sumBase, 2),
                              ed.currency,
                            ),
                          ]),
                      ]),
                    h.div
                      .class("flex flex-col gap-0.5")
                      .children([
                        h.span
                          .class("text-[0.75rem] text-on-surface-variant")
                          .children([tLocal(ctx.locale, "deductibleVat")]),
                        h.span
                          .class("font-semibold kb-num")
                          .children([
                            moneyText(
                              ctx.locale,
                              formatDecimalFixed(preview.deductibleVat, 2),
                              ed.currency,
                            ),
                          ]),
                      ]),
                    ...(preview.totalCzk !== null && ed.currency !== "CZK"
                      ? [
                          h.div.class("flex flex-col gap-0.5").children([
                            h.span
                              .class("text-[0.75rem] text-on-surface-variant")
                              .children(["CZK"]),
                            h.span.class("font-semibold kb-num").children([
                              tr.t("expenses.editor.czkEquivalent", {
                                amount: moneyText(
                                  ctx.locale,
                                  formatDecimalFixed(preview.totalCzk, 2),
                                  "CZK",
                                ),
                              }),
                            ]),
                          ]),
                        ]
                      : []),
                    ...(preview.difference !== null && Math.abs(preview.difference) > 0.001
                      ? [
                          badge(
                            h,
                            tr.t("expenses.editor.difference", {
                              amount: moneyText(
                                ctx.locale,
                                formatDecimalFixed(preview.difference, 2),
                                ed.currency,
                              ),
                            }),
                            "error",
                          ),
                        ]
                      : []),
                  ]),
                h.div
                  .attr("data-slot", "form-grid")
                  .class(ui.formGrid)
                  .children([
                    textField(h, {
                      id: "exp-category",
                      label: tr.t("common.field.category"),
                      value: ed.category,
                      onInput: (value) => Message.ChangedEditorField({ field: "category", value }),
                    }),
                    textField(h, {
                      id: "exp-tags",
                      label: tr.t("common.field.tags"),
                      value: ed.tagsText,
                      hint: tr.t("expenses.editor.tagsHint"),
                      onInput: (value) => Message.ChangedEditorField({ field: "tagsText", value }),
                    }),
                  ]),
                textArea(h, {
                  id: "exp-note",
                  label: tr.t("common.field.note"),
                  value: ed.note,
                  onInput: (value) => Message.ChangedEditorField({ field: "note", value }),
                }),
                h.div
                  .attr("data-slot", "spread")
                  .class(ui.spread)
                  .children([
                    segmented(h, {
                      label: tr.t("common.field.status"),
                      selected: ed.status,
                      items: [
                        { id: "complete", label: tLocal(ctx.locale, "statusComplete") },
                        { id: "incomplete", label: tLocal(ctx.locale, "statusIncomplete") },
                      ],
                      onSelect: (id) =>
                        Message.ChangedExpenseStatus({ status: id as "complete" | "incomplete" }),
                    }),
                    button(h, {
                      label: tr.t("common.action.save"),
                      variant: "primary",
                      type: "submit",
                      busy: ed.saving,
                    }),
                  ]),
              ]),
            ]),
        ]),
    ]);
  }

  // Detail (read-only / accountant view)
  if (loadedExpense === undefined)
    return page(h, [pageHeader(h, { title: tr.t("expenses.editor.title") })]);
  const payments = Remote.dataOf(model.payments) ?? [];

  return page(h, [
    pageHeader(h, {
      title:
        loadedExpense.supplier?.name ??
        loadedExpense.supplierDocumentNumber ??
        tr.t("expenses.editor.title"),
      eyebrow: linkButton(h, {
        label: tLocal(ctx.locale, "backToList"),
        href: href({ _tag: "Expenses", ws: route.ws, query: {} }),
        variant: "ghost",
        small: true,
      }),
      actions: writable
        ? [
            ...(loadedExpense.status === "complete" && loadedExpense.payment.settlement !== "paid"
              ? [
                  button(h, {
                    label: tr.t("expenses.detail.markPaid"),
                    variant: "primary",
                    onClick: Message.OpenedPaymentDialog({ presetFull: true }),
                  }),
                ]
              : []),
            linkButton(h, {
              label: tr.t("common.action.edit"),
              href: href({
                _tag: "Expense",
                ws: route.ws,
                id: loadedExpense.id as ExpenseId,
                mode: "edit",
              }),
            }),
            button(h, {
              label: tr.t("common.action.delete"),
              variant: "danger",
              onClick: Message.RequestedRemove(),
            }),
          ]
        : [badge(h, tLocal(ctx.locale, "readOnlyBadge"), "outline")],
    }),
    h.div
      .class(ui.row)
      .children([
        badge(
          h,
          enumLabel(tr, "expenseStatus", loadedExpense.status),
          loadedExpense.status === "complete" ? "paid" : "proforma",
        ),
        badge(
          h,
          enumLabel(tr, "settlement", loadedExpense.payment.settlement),
          settlementTone(loadedExpense.payment.settlement),
        ),
      ]),
    h.div
      .attr("data-slot", "expense-split")
      .class(
        "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(280px,0.95fr)_minmax(0,1.35fr)]",
      )
      .children([
        renderAttachmentViewer(h, ctx, model, loadedExpense, writable),
        h.div.class(ui.stack).children([
          card(h, [
            cardTitle(h, tr.t("expenses.editor.title")),
            dl(h, [
              [tr.t("expenses.editor.supplier"), loadedExpense.supplier?.name ?? "—"],
              [
                tr.t("common.field.ico"),
                loadedExpense.supplier?.ico !== null && loadedExpense.supplier?.ico !== undefined
                  ? mono(h, loadedExpense.supplier.ico)
                  : "—",
              ],
              [
                tr.t("expenses.editor.number"),
                loadedExpense.supplierDocumentNumber !== null
                  ? mono(h, loadedExpense.supplierDocumentNumber)
                  : "—",
              ],
              [tr.t("expenses.editor.issueDate"), dateText(ctx.locale, loadedExpense.issuedOn)],
              [
                tr.t("expenses.editor.taxableSupplyDate"),
                dateText(ctx.locale, loadedExpense.taxableSupplyOn),
              ],
              [tr.t("expenses.editor.dueDate"), dateText(ctx.locale, loadedExpense.dueOn)],
              [
                tr.t("expenses.editor.gross"),
                loadedExpense.total !== null && loadedExpense.currency !== null
                  ? h.strong.children([
                      moneyText(ctx.locale, loadedExpense.total, loadedExpense.currency),
                    ])
                  : "—",
              ],
              ...(loadedExpense.totalCzk !== null && loadedExpense.currency !== "CZK"
                ? [["CZK", moneyText(ctx.locale, loadedExpense.totalCzk, "CZK")] as const]
                : []),
              [
                tLocal(ctx.locale, "deductibleVat"),
                loadedExpense.deductibleVat !== null
                  ? moneyText(
                      ctx.locale,
                      loadedExpense.deductibleVat.amount,
                      loadedExpense.deductibleVat.currency,
                    )
                  : "—",
              ],
              [tr.t("common.field.category"), loadedExpense.category ?? "—"],
              [
                tr.t("common.field.tags"),
                loadedExpense.tags.length > 0 ? loadedExpense.tags.join(", ") : "—",
              ],
              [tr.t("common.field.note"), loadedExpense.note ?? "—"],
            ]),
          ]),
          card(h, [
            cardTitle(
              h,
              tLocal(ctx.locale, "paymentsTitle"),
              writable && loadedExpense.status === "complete"
                ? [
                    button(h, {
                      label: tr.t("expenses.detail.partialPayment"),
                      small: true,
                      onClick: Message.OpenedPaymentDialog({ presetFull: false }),
                    }),
                  ]
                : [],
            ),
            payments.length === 0
              ? h.p.class(ui.muted).children([tLocal(ctx.locale, "paymentsEmpty")])
              : table(h, {
                  caption: tLocal(ctx.locale, "paymentsTitle"),
                  rows: payments,
                  rowKey: (p) => p.id,
                  columns: [
                    {
                      header: tLocal(ctx.locale, "paidOn"),
                      cell: (p) => dateText(ctx.locale, p.paidOn),
                    },
                    {
                      header: tLocal(ctx.locale, "method"),
                      cell: (p) => enumLabel(tr, "paymentMethod", p.method as PaymentMethod),
                    },
                    {
                      header: tr.t("common.field.amount"),
                      align: "end",
                      numeric: true,
                      cell: (p) => moneyText(ctx.locale, p.amount.amount, p.amount.currency),
                    },
                    {
                      header: "",
                      align: "end",
                      cell: (p) =>
                        writable
                          ? button(h, {
                              label: tr.t("common.action.remove"),
                              variant: "ghost",
                              small: true,
                              onClick: Message.RequestedRemovePayment({ id: p.id }),
                            })
                          : h.text(""),
                    },
                  ],
                }),
          ]),
        ]),
      ]),
    model.confirmDetachId !== null
      ? dialog(h, {
          id: "expense-detach-dialog",
          title: tr.t("expenses.attachmentViewer.detachTitle"),
          onClose: Message.CancelledDetach(),
          body: [h.p.children([tr.t("expenses.attachmentViewer.detach")])],
          actions: [
            button(h, { label: tr.t("common.action.cancel"), onClick: Message.CancelledDetach() }),
            button(h, {
              label: tr.t("common.action.remove"),
              variant: "danger",
              busy: model.detaching,
              onClick: Message.ConfirmedDetach(),
            }),
          ],
        })
      : h.text(""),
    model.confirmRemove
      ? dialog(h, {
          id: "expense-remove-dialog",
          title: tr.t("expenses.detail.removeTitle"),
          onClose: Message.CancelledRemove(),
          body: [h.p.children([tr.t("expenses.detail.removeBody")])],
          actions: [
            button(h, { label: tr.t("common.action.cancel"), onClick: Message.CancelledRemove() }),
            button(h, {
              label: tr.t("common.action.delete"),
              variant: "danger",
              busy: model.removing,
              onClick: Message.ConfirmedRemove(),
            }),
          ],
        })
      : h.text(""),
    model.paymentDialog !== null
      ? dialog(h, {
          id: "expense-payment-dialog",
          title: tLocal(ctx.locale, "recordPaymentTitle"),
          onClose: Message.ClosedPaymentDialog(),
          body: [
            ...(model.paymentDialog.error !== null
              ? [banner(h, { text: model.paymentDialog.error, tone: "error" })]
              : []),
            textField(h, {
              id: "pay-amount",
              label: tr.t("common.field.amount"),
              value: model.paymentDialog.amount,
              mono: true,
              onInput: (value) => Message.ChangedPaymentField({ field: "amount", value }),
            }),
            textField(h, {
              id: "pay-date",
              label: tLocal(ctx.locale, "paidOn"),
              type: "date",
              value: model.paymentDialog.paidOn,
              onInput: (value) => Message.ChangedPaymentField({ field: "paidOn", value }),
            }),
            selectField(h, {
              id: "pay-method",
              label: tLocal(ctx.locale, "method"),
              value: model.paymentDialog.method,
              options: PAYMENT_METHODS.map((pm) => ({
                value: pm,
                label: enumLabel(tr, "paymentMethod", pm),
              })),
              onChange: (value) => Message.ChangedPaymentField({ field: "method", value }),
            }),
            textField(h, {
              id: "pay-note",
              label: tr.t("common.field.note"),
              value: model.paymentDialog.note,
              onInput: (value) => Message.ChangedPaymentField({ field: "note", value }),
            }),
          ],
          actions: [
            button(h, {
              label: tr.t("common.action.cancel"),
              onClick: Message.ClosedPaymentDialog(),
            }),
            button(h, {
              label: tr.t("common.action.confirm"),
              variant: "primary",
              busy: model.paymentDialog.submitting,
              onClick: Message.SubmittedPayment(),
            }),
          ],
        })
      : h.text(""),
    model.confirmRemovePaymentId !== null
      ? dialog(h, {
          id: "expense-remove-payment-dialog",
          title: tLocal(ctx.locale, "removePaymentTitle"),
          onClose: Message.CancelledRemovePayment(),
          body: [
            textField(h, {
              id: "pay-remove-reason",
              label: tLocal(ctx.locale, "removePaymentReason"),
              value: model.removePaymentReason,
              onInput: (value) => Message.ChangedRemovePaymentReason({ value }),
            }),
          ],
          actions: [
            button(h, {
              label: tr.t("common.action.cancel"),
              onClick: Message.CancelledRemovePayment(),
            }),
            button(h, {
              label: tr.t("common.action.remove"),
              variant: "danger",
              busy: model.removingPayment,
              onClick: Message.ConfirmedRemovePayment(),
            }),
          ],
        })
      : h.text(""),
  ]);
};
