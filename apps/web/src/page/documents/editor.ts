import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 10 — Document Editor (Draft & Issued-edit): split-screen editor with VAT/FX preview
 * via @kvitbit/ui-port ViewModels.calculate, Tax Regime variants, ARES quick-add contact,
 * Quick Template start, line items add/remove/reorder, Document->Contact->Workspace->Default
 * override badges, and save draft / issue / save issued edit flows.
 */
import {
  BankAccountId,
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentInput,
  DocumentPatch,
  DocumentView,
  FxRateView,
  type IsoDate,
  type LineInput,
  NumberingSeriesId,
  NumberingSeriesView,
  PriceListItemId,
  type TaxRegime,
  type VatTreatment,
  type WorkspaceId,
} from "@kvitbit/domain";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import type * as Types from "effect/Types";
import { renderSVG } from "uqr";
import { Failure } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { svgImage } from "../../ui/html";
import {
  amount,
  badge,
  banner,
  button,
  card,
  cardTitle,
  checkbox,
  linkButton,
  mono,
  page,
  pageHeader,
  select,
  selectField,
  separator,
  skeleton,
  textArea,
  textField,
} from "../../ui/kit";
import { UiInput } from "../../ui/sdk";
import { cn, controlVariants, ui } from "../../ui/styles";
import {
  addDaysIso,
  apiCommand,
  BankAccountData,
  ContactOptionData,
  canRole,
  decimalToInput,
  delayCommand,
  fmtDate,
  fmtMoney,
  fmtNum,
  fmtVatRate,
  idempotencyHeaders,
  ifMatch,
  isIsoDateString,
  mintRequestKeyCommand,
  PriceListOptionData,
  parseDecimalText,
  preserveRequestKey,
  readBankAccounts,
  readContact,
  readContactSnapshot,
  readContacts,
  readLines,
  readPriceList,
  readTemplates,
  readWorkspaceInfo,
  sharedCopy,
  sourceBadge,
  TemplateViewData,
  todayPrague,
  WorkspaceInfoData,
} from "./shared";

export const Route = Schema.Union([RouteCases.DocumentNew, RouteCases.DocumentEdit]);
export type Route = typeof Route.Type;

const CopyTable: Copy<
  | "newInvoiceTitle"
  | "newProformaTitle"
  | "editDraftTitle"
  | "editIssuedTitle"
  | "subtitle"
  | "backToList"
  | "saveDraft"
  | "issue"
  | "saveChanges"
  | "quickTemplate"
  | "quickTemplateNone"
  | "sectionCustomer"
  | "customerLabel"
  | "customerPlaceholder"
  | "aresToggle"
  | "aresIcoLabel"
  | "aresIcoPlaceholder"
  | "aresLookup"
  | "aresAdded"
  | "sectionDates"
  | "issuedOn"
  | "taxableSupplyOn"
  | "dueDays"
  | "dueDateHint"
  | "sectionBilling"
  | "currency"
  | "language"
  | "paymentMethod"
  | "series"
  | "seriesDefault"
  | "bankAccount"
  | "bankAccountAuto"
  | "variableSymbol"
  | "variableSymbolRetained"
  | "variableSymbolUnchanged"
  | "orderNumber"
  | "numberOverride"
  | "refreshParties"
  | "pricesIncludeVat"
  | "fxSection"
  | "fxManualToggle"
  | "fxRate"
  | "fxQuantity"
  | "fxCnbNote"
  | "sectionLines"
  | "addFromPriceList"
  | "addLine"
  | "lineDesc"
  | "lineQty"
  | "lineUnit"
  | "linePrice"
  | "lineVat"
  | "moveUp"
  | "moveDown"
  | "removeLine"
  | "noteLabel"
  | "previewTitle"
  | "vatSummaryTitle"
  | "vatColRate"
  | "vatColBase"
  | "vatColVat"
  | "vatColTotal"
  | "netTotal"
  | "vatTotal"
  | "roundingAdj"
  | "grandTotal"
  | "vatCzkTotal"
  | "regimeNonVat"
  | "regimeIdentified"
  | "savingDraft"
  | "draftSaved"
  | "reloadRevision"
  | "reviewRevision"
  | "changedFields"
  | "readOnly"
  | "previewQr"
  | "needContact"
  | "needLines"
  | "clearOverride"
  | "draftPreviewNumber"
> = {
  cs: {
    newInvoiceTitle: "Nová faktura",
    newProformaTitle: "Nová zálohová faktura",
    editDraftTitle: "Upravit koncept",
    editIssuedTitle: "Upravit vystavený doklad",
    subtitle: "Vyplňte údaje dokladu a zkontrolujte souhrn vpravo",
    backToList: "Zpět na doklady",
    saveDraft: "Uložit koncept",
    issue: "Vystavit doklad",
    saveChanges: "Uložit změny",
    quickTemplate: "Začít ze šablony",
    quickTemplateNone: "Bez šablony",
    sectionCustomer: "Odběratel",
    customerLabel: "Vyberte odběratele",
    customerPlaceholder: "— Vyberte kontakt —",
    aresToggle: "Přidat přes IČO (ARES)",
    aresIcoLabel: "IČO (8 číslic)",
    aresIcoPlaceholder: "27082440",
    aresLookup: "Vyhledat a přidat",
    aresAdded: "Kontakt načten z ARES.",
    sectionDates: "Data a splatnost",
    issuedOn: "Datum vystavení",
    taxableSupplyOn: "DUZP",
    dueDays: "Splatnost (dny)",
    dueDateHint: "Datum splatnosti: {date}",
    sectionBilling: "Fakturační údaje",
    currency: "Měna",
    language: "Jazyk dokladu",
    paymentMethod: "Způsob úhrady",
    series: "Číselná řada",
    seriesDefault: "Výchozí řada",
    bankAccount: "Bankovní účet",
    bankAccountAuto: "Automaticky dle měny",
    variableSymbol: "Variabilní symbol",
    variableSymbolRetained:
      "Uložený variabilní symbol {symbol} nelze vymazat. Zadejte jej znovu nebo jej nahraďte.",
    variableSymbolUnchanged: "Prázdné pole ponechá uloženou hodnotu beze změny.",
    orderNumber: "Číslo objednávky",
    numberOverride: "Číslo dokladu (úprava)",
    refreshParties: "Aktualizovat údaje vystavitele a odběratele",
    pricesIncludeVat: "Ceny jsou včetně DPH",
    fxSection: "Kurz cizí měny",
    fxManualToggle: "Zadat vlastní kurz",
    fxRate: "Kurz (Kč)",
    fxQuantity: "Množství měny",
    fxCnbNote: "Kurz ČNB ze dne {date}: {qty} {cur} = {rate} Kč",
    sectionLines: "Položky dokladu",
    addFromPriceList: "Přidat z ceníku…",
    addLine: "Přidat položku",
    lineDesc: "Popis",
    lineQty: "Množství",
    lineUnit: "Jedn.",
    linePrice: "Cena / ks",
    lineVat: "DPH",
    moveUp: "Nahoru",
    moveDown: "Dolů",
    removeLine: "Odstranit",
    noteLabel: "Poznámka na dokladu",
    previewTitle: "Náhled faktury",
    vatSummaryTitle: "Rekapitulace DPH",
    vatColRate: "Sazba",
    vatColBase: "Základ",
    vatColVat: "DPH",
    vatColTotal: "Celkem",
    netTotal: "Celkem bez DPH",
    vatTotal: "DPH celkem",
    roundingAdj: "Zaokrouhlení",
    grandTotal: "Celkem k úhradě",
    vatCzkTotal: "DPH v CZK",
    regimeNonVat: "Neplátce DPH — doklad neobsahuje DPH.",
    regimeIdentified: "Identifikovaná osoba — u tuzemských plnění se DPH neúčtuje.",
    savingDraft: "Ukládání konceptu…",
    draftSaved: "Koncept uložen.",
    reloadRevision: "Načíst aktuální verzi",
    reviewRevision: "Zkontrolujte své úpravy před uložením do aktuální verze.",
    changedFields: "Změny v aktuální verzi",
    readOnly: "Tento doklad zde nelze upravit.",
    previewQr: "Platební QR kód",
    needContact: "Vyberte prosím odběratele.",
    needLines: "Přidejte alespoň jednu položku s popisem a cenou.",
    clearOverride: "Použít výchozí",
    draftPreviewNumber: "KONCEPT",
  },
  en: {
    newInvoiceTitle: "New invoice",
    newProformaTitle: "New proforma",
    editDraftTitle: "Edit draft",
    editIssuedTitle: "Edit issued document",
    subtitle: "Fill in document details and check the summary on the right",
    backToList: "Back to documents",
    saveDraft: "Save draft",
    issue: "Issue document",
    saveChanges: "Save changes",
    quickTemplate: "Start from template",
    quickTemplateNone: "No template",
    sectionCustomer: "Customer",
    customerLabel: "Select customer",
    customerPlaceholder: "— Select contact —",
    aresToggle: "Quick-add by IČO (ARES)",
    aresIcoLabel: "IČO (8 digits)",
    aresIcoPlaceholder: "27082440",
    aresLookup: "Lookup and add",
    aresAdded: "Contact added from ARES.",
    sectionDates: "Dates and due term",
    issuedOn: "Issue date",
    taxableSupplyOn: "Tax point (DUZP)",
    dueDays: "Due days",
    dueDateHint: "Due date: {date}",
    sectionBilling: "Billing details",
    currency: "Currency",
    language: "Document language",
    paymentMethod: "Payment method",
    series: "Numbering series",
    seriesDefault: "Default series",
    bankAccount: "Bank account",
    bankAccountAuto: "Automatic by currency",
    variableSymbol: "Variable symbol",
    variableSymbolRetained:
      "The saved variable symbol {symbol} cannot be cleared. Enter it again or replace it.",
    variableSymbolUnchanged: "Leaving this field blank keeps the stored value.",
    orderNumber: "Order number",
    numberOverride: "Document number override",
    refreshParties: "Refresh issuer and customer particulars",
    pricesIncludeVat: "Prices include VAT",
    fxSection: "Foreign currency exchange rate",
    fxManualToggle: "Use manual rate",
    fxRate: "Rate (CZK)",
    fxQuantity: "Currency units",
    fxCnbNote: "CNB rate on {date}: {qty} {cur} = {rate} CZK",
    sectionLines: "Line items",
    addFromPriceList: "Add from price list…",
    addLine: "Add line",
    lineDesc: "Description",
    lineQty: "Qty",
    lineUnit: "Unit",
    linePrice: "Unit price",
    lineVat: "VAT",
    moveUp: "Up",
    moveDown: "Down",
    removeLine: "Remove",
    noteLabel: "Printed note",
    previewTitle: "Invoice preview",
    vatSummaryTitle: "VAT summary",
    vatColRate: "Rate",
    vatColBase: "Base",
    vatColVat: "VAT",
    vatColTotal: "Total",
    netTotal: "Subtotal",
    vatTotal: "Total VAT",
    roundingAdj: "Rounding",
    grandTotal: "Amount due",
    vatCzkTotal: "VAT in CZK",
    regimeNonVat: "Non-VAT payer — no VAT is charged on this document.",
    regimeIdentified: "Identified person — domestic supplies carry no VAT.",
    savingDraft: "Saving draft…",
    draftSaved: "Draft saved.",
    reloadRevision: "Reload latest version",
    reviewRevision: "Review your edits before saving them to the latest version.",
    changedFields: "Changes in the latest version",
    readOnly: "This document cannot be edited here.",
    previewQr: "Payment QR code",
    needContact: "Please select a customer.",
    needLines: "Add at least one line item with a description and price.",
    clearOverride: "Use default",
    draftPreviewNumber: "DRAFT",
  },
};

const txt = copy(CopyTable);

const EditorLine = Schema.Struct({
  key: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  description: Schema.String,
  quantity: Schema.String,
  unit: Schema.String,
  unitPrice: Schema.String,
  vat: Schema.Literals([
    "standard",
    "reduced",
    "exempt_intra_eu_goods",
    "reverse_charge",
    "outside_scope",
  ]),
});
type EditorLine = typeof EditorLine.Type;

const LookupsData = Schema.Struct({
  workspace: Schema.NullOr(WorkspaceInfoData),
  contacts: Schema.Array(ContactOptionData),
  priceList: Schema.Array(PriceListOptionData),
  series: Schema.Array(NumberingSeriesView),
  bankAccounts: Schema.Array(BankAccountData),
  templates: Schema.Array(TemplateViewData),
  existingDoc: Schema.NullOr(DocumentView),
});

const WriteIntent = Schema.Literals(["save_draft", "issue", "autosave"]);
type WriteIntent = typeof WriteIntent.Type;

const DraftOperation = Schema.Union([
  Schema.TaggedStruct("Create", { input: DocumentInput, key: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("Edit", {
    id: DocumentId,
    revision: Schema.Int,
    input: DocumentInput,
    patch: DocumentPatch,
  }),
  Schema.TaggedStruct("IssueNew", { input: DocumentInput, key: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("IssueDraft", {
    id: DocumentId,
    revision: Schema.Int,
    key: Schema.NullOr(Schema.String),
  }),
]);
const DraftWrite = Schema.Struct({
  intent: WriteIntent,
  seq: Remote.Seq,
  running: Schema.Boolean,
  operation: DraftOperation,
});
type DraftWrite = typeof DraftWrite.Type;

export const Model = Schema.Struct({
  route: Route,
  lookups: Remote.remoteSchema(LookupsData),
  fxLookup: Remote.remoteSchema(FxRateView),
  kind: Schema.Literals(["invoice", "proforma"]),
  savedDoc: Schema.NullOr(DocumentView),
  savedInput: Schema.NullOr(DocumentInput),
  contactId: Schema.String,
  issuedOn: Schema.String,
  taxableSupplyOn: Schema.String,
  dueDaysOverride: Schema.NullOr(Schema.String),
  currencyOverride: Schema.NullOr(Schema.String),
  languageOverride: Schema.NullOr(Schema.Literals(["cs", "en"])),
  paymentMethodOverride: Schema.NullOr(Schema.Literals(["bank_transfer", "cash", "card", "other"])),
  seriesOverride: Schema.NullOr(Schema.String),
  bankAccountId: Schema.String,
  variableSymbol: Schema.String,
  orderNumber: Schema.String,
  noteOverride: Schema.NullOr(Schema.String),
  pricesIncludeVat: Schema.Boolean,
  numberOverride: Schema.String,
  refreshParties: Schema.Boolean,
  manualFx: Schema.Boolean,
  fxRateInput: Schema.String,
  fxQuantityInput: Schema.String,
  lines: Schema.Array(EditorLine),
  nextLineKey: Schema.Int,
  aresOpen: Schema.Boolean,
  aresIco: Schema.String,
  aresBusy: Schema.Boolean,
  aresError: Schema.NullOr(Schema.String),
  dirty: Schema.Boolean,
  previewSeq: Remote.Seq,
  serverPreview: Remote.remoteSchema(DocumentView),
  calcDrift: Schema.Boolean,
  autosaveReady: Schema.Boolean,
  autosaveError: Schema.NullOr(Schema.String),
  draftWrite: Schema.NullOr(DraftWrite),
  revisionState: Schema.Literals(["current", "stale", "loading", "review", "blocked"]),
  revisionChanges: Schema.Array(Schema.String),
  submitting: Schema.Boolean,
  submitError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  LoadedLookups: { seq: Remote.Seq, data: LookupsData },
  FailedLookups: { seq: Remote.Seq, failure: Failure },
  LoadedFx: { seq: Remote.Seq, data: FxRateView },
  FailedFx: { seq: Remote.Seq, failure: Failure },
  SelectedTemplate: { templateId: Schema.String },
  SelectedContact: { contactId: Schema.String },
  ToggledAres: {},
  ChangedAresIco: { value: Schema.String },
  SubmittedAres: {},
  AresSucceeded: { contact: ContactOptionData },
  AresFailed: { failure: Failure },
  ChangedIssuedOn: { value: Schema.String },
  ChangedTaxableSupplyOn: { value: Schema.String },
  ChangedDueDays: { value: Schema.String },
  ClearedDueDays: {},
  ChangedCurrency: { value: Schema.String },
  ClearedCurrency: {},
  ChangedLanguage: { value: Schema.String },
  ClearedLanguage: {},
  ChangedPaymentMethod: { value: Schema.String },
  ClearedPaymentMethod: {},
  ChangedSeries: { value: Schema.String },
  ClearedSeries: {},
  ChangedBankAccount: { value: Schema.String },
  ChangedVariableSymbol: { value: Schema.String },
  ChangedOrderNumber: { value: Schema.String },
  ChangedNote: { value: Schema.String },
  ClearedNote: {},
  ChangedNumberOverride: { value: Schema.String },
  ToggledRefreshParties: { checked: Schema.Boolean },
  ToggledPricesIncludeVat: { checked: Schema.Boolean },
  ToggledManualFx: { checked: Schema.Boolean },
  ChangedFxRate: { value: Schema.String },
  ChangedFxQuantity: { value: Schema.String },
  AddedLine: {},
  AddedPriceListItem: { itemId: Schema.String },
  UpdatedLineField: {
    key: Schema.String,
    field: Schema.Literals(["description", "quantity", "unit", "unitPrice", "vat"]),
    value: Schema.String,
  },
  MovedLine: { key: Schema.String, direction: Schema.Literals(["up", "down"]) },
  RemovedLine: { key: Schema.String },
  DebouncedPreview: { seq: Remote.Seq },
  GotPreview: { seq: Remote.Seq, doc: DocumentView },
  FailedPreview: { seq: Remote.Seq, failure: Failure },
  AutosaveDue: { seq: Remote.Seq },
  GotRequestKey: { key: Schema.String },
  DraftWriteSucceeded: { doc: DocumentView },
  DraftWriteFailed: { failure: Failure },
  ClickedRetryAutosave: {},
  ClickedReloadRevision: {},
  LoadedRevision: { doc: DocumentView },
  FailedRevision: { failure: Failure },
  ClickedSaveDraft: {},
  ClickedIssue: {},
  ClickedSaveIssued: {},
  SavedDocument: { doc: DocumentView },
  FailedSubmit: { failure: Failure },
  ClickedRetry: {},
});
export type Message = typeof Message.Type;

const emptyLine = (key: number, regime: TaxRegime): EditorLine => ({
  key: `l${key}`,
  itemId: null,
  description: "",
  quantity: "1",
  unit: "ks",
  unitPrice: "0",
  vat: regime === "vat_payer" ? "standard" : "outside_scope",
});

const loadLookupsCommand = (
  workspaceId: WorkspaceId,
  route: Route,
  seq: Remote.Seq,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "LoadEditorLookups",
    (c) =>
      Effect.all(
        {
          workspace: c.workspace.current({ params: { workspaceId } }).pipe(Effect.option),
          contacts: c.contacts.search({ params: { workspaceId }, query: { limit: 100 } }),
          priceList: c.priceList.list({ params: { workspaceId }, query: {} }),
          series: c.workspace.listSeries({ params: { workspaceId } }),
          bankAccounts: c.workspace.listBankAccounts({ params: { workspaceId } }),
          templates: c.templates.list({ params: { workspaceId } }),
          existingDoc:
            route._tag === "DocumentEdit"
              ? c.documents.get({ params: { workspaceId, documentId: route.id } })
              : route.from?._tag === "Duplicate"
                ? c.documents.get({ params: { workspaceId, documentId: route.from.id } })
                : Effect.succeed(null),
        },
        { concurrency: 1 },
      ),
    (res): Message =>
      Message.LoadedLookups({
        seq,
        data: {
          workspace:
            res.workspace._tag === "Some" ? (readWorkspaceInfo(res.workspace.value) ?? null) : null,
          contacts: readContacts(res.contacts.items),
          priceList: readPriceList(res.priceList),
          series: res.series,
          bankAccounts: readBankAccounts(res.bankAccounts),
          templates: readTemplates(res.templates),
          existingDoc: res.existingDoc,
        },
      }),
    (failure): Message => Message.FailedLookups({ seq, failure }),
  );

const loadFxCommand = (
  workspaceId: WorkspaceId,
  currency: CurrencyCode,
  on: IsoDate,
  seq: Remote.Seq,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "LoadFxRate",
    (c) => c.reports.fxRate({ params: { workspaceId, currency }, query: { on } }),
    (data): Message => Message.LoadedFx({ seq, data }),
    (failure): Message => Message.FailedFx({ seq, failure }),
  );

const applyTemplateToModel = (model: Model, tpl: TemplateViewData): Model => {
  const lines: Array<EditorLine> = Arr.map(tpl.input.lines, (line, i) => ({
    key: `tpl-${i + 1}`,
    itemId: line.item ?? null,
    description: line.description ?? "",
    quantity: line.quantity !== undefined ? decimalToInput(line.quantity) : "1",
    unit: line.unit ?? "ks",
    unitPrice: line.unitPrice !== undefined ? decimalToInput(line.unitPrice) : "0",
    vat: line.vat ?? "standard",
  }));
  return {
    ...model,
    kind: tpl.input.kind,
    contactId: tpl.input.contact,
    currencyOverride: tpl.input.currency ?? null,
    languageOverride: tpl.input.language ?? null,
    dueDaysOverride: tpl.input.due !== undefined ? String(tpl.input.due.inDays) : null,
    paymentMethodOverride: tpl.input.paymentMethod ?? null,
    seriesOverride: tpl.input.series ?? null,
    bankAccountId: tpl.input.bankAccount ?? "",
    pricesIncludeVat: tpl.input.pricesIncludeVat ?? false,
    noteOverride: tpl.input.note ?? null,
    lines: lines.length > 0 ? lines : model.lines,
    nextLineKey: lines.length + 1,
  };
};

const hydrateFromDocument = (model: Model, doc: DocumentView, isEdit: boolean): Model => {
  const contact = readContactSnapshot(doc.contact);
  const rawLines = readLines(doc.lines);
  const lines: Array<EditorLine> = Arr.map(rawLines, (l, idx) => ({
    key: `doc-${idx + 1}`,
    itemId: l.item,
    description: l.description,
    quantity: decimalToInput(l.quantity),
    unit: l.unit ?? "ks",
    unitPrice: decimalToInput(l.unitPrice),
    vat: l.treatment,
  }));
  const kind = doc.kind === "proforma" ? "proforma" : "invoice";
  return {
    ...model,
    kind,
    savedDoc: isEdit ? doc : null,
    contactId: contact?.contactId ?? "",
    issuedOn: isEdit ? doc.dates.issuedOn : model.issuedOn,
    taxableSupplyOn: isEdit
      ? (doc.dates.taxableSupplyOn ?? doc.dates.issuedOn)
      : model.taxableSupplyOn,
    currencyOverride: doc.totals.gross.currency,
    paymentMethodOverride: doc.paymentMethod,
    dueDaysOverride: isEdit
      ? String((Date.parse(doc.dates.dueOn) - Date.parse(doc.dates.issuedOn)) / 86_400_000)
      : model.dueDaysOverride,
    numberOverride: isEdit ? (doc.number ?? "") : "",
    manualFx: doc.fx?.source === "manual",
    fxRateInput: doc.fx !== null ? decimalToInput(doc.fx.rate) : "",
    fxQuantityInput: doc.fx !== null ? String(doc.fx.quantity) : "1",
    lines: lines.length > 0 ? lines : model.lines,
    nextLineKey: lines.length + 1,
  };
};

const initImpl = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const today = todayPrague();
  const regime: TaxRegime = ctx.workspace?.taxRegime ?? "vat_payer";
  const base: Model = {
    route,
    lookups: Remote.idle,
    fxLookup: Remote.idle,
    kind: route._tag === "DocumentNew" ? route.kind : "invoice",
    savedDoc: null,
    savedInput: null,
    contactId: route._tag === "DocumentNew" && route.from?._tag === "Contact" ? route.from.id : "",
    issuedOn: today,
    taxableSupplyOn: today,
    dueDaysOverride: null,
    currencyOverride: null,
    languageOverride: null,
    paymentMethodOverride: null,
    seriesOverride: null,
    bankAccountId: "",
    variableSymbol: "",
    orderNumber: "",
    noteOverride: null,
    pricesIncludeVat: false,
    numberOverride: "",
    refreshParties: false,
    manualFx: false,
    fxRateInput: "",
    fxQuantityInput: "1",
    lines: [emptyLine(1, regime)],
    nextLineKey: 2,
    aresOpen: false,
    aresIco: "",
    aresBusy: false,
    aresError: null,
    dirty: false,
    previewSeq: 0,
    serverPreview: Remote.idle,
    calcDrift: false,
    autosaveReady: false,
    autosaveError: null,
    draftWrite: null,
    revisionState: "current",
    revisionChanges: [],
    submitting: false,
    submitError: null,
  };
  if (ctx.workspace === null) return { model: base };
  const lookups = Remote.load(Remote.idle);
  return {
    model: { ...base, lookups },
    commands: [loadLookupsCommand(ctx.workspace.id, route, Remote.seqOf(lookups))],
  };
};

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const resolveEffective = (model: Model): ViewModels.EffectiveBilling => {
  const data = Remote.dataOf(model.lookups);
  const contact = Arr.findFirst(data?.contacts ?? [], (c) => c.id === model.contactId).pipe(
    Option.getOrUndefined,
  );
  const wsDefaults = data?.workspace?.defaults;
  const seriesByKind: Partial<Record<"invoice" | "proforma", NumberingSeriesId>> = {};
  for (const s of data?.series ?? []) {
    if (s.isDefault && (s.kind === "invoice" || s.kind === "proforma")) {
      seriesByKind[s.kind] = s.id;
    }
  }
  const parsedDue =
    model.dueDaysOverride !== null && wholeNumberText.test(model.dueDaysOverride)
      ? Number(model.dueDaysOverride)
      : undefined;

  const docValues: Types.Mutable<ViewModels.DocumentBillingValues> = {};
  if (model.currencyOverride !== null)
    docValues.currency = CurrencyCode.make(model.currencyOverride);
  if (model.languageOverride !== null) docValues.language = model.languageOverride;
  if (parsedDue !== undefined) docValues.dueDays = parsedDue;
  if (model.paymentMethodOverride !== null) docValues.paymentMethod = model.paymentMethodOverride;
  if (model.seriesOverride !== null)
    docValues.series = NumberingSeriesId.make(model.seriesOverride);
  if (model.noteOverride !== null) docValues.note = model.noteOverride;

  const wsValues: Types.Mutable<ViewModels.WorkspaceBillingDefaults> = { seriesByKind };
  if (wsDefaults !== undefined) {
    wsValues.currency = wsDefaults.currency;
    wsValues.language = wsDefaults.language;
    wsValues.dueDays = wsDefaults.dueDays;
    wsValues.paymentMethod = wsDefaults.paymentMethod;
    if (wsDefaults.defaultNote !== null) wsValues.defaultNote = wsDefaults.defaultNote;
  }

  return ViewModels.resolveBilling({
    kind: model.kind,
    document: docValues,
    contact: contact?.defaults,
    workspace: wsValues,
  });
};

const buildDocumentInput = (
  model: Model,
  locale: PageContext["locale"],
):
  | { readonly ok: true; readonly input: DocumentInput }
  | { readonly ok: false; readonly error: string } => {
  if (model.contactId === "") return { ok: false, error: txt(locale, "needContact") };
  const validLines: Array<LineInput> = [];
  for (const line of model.lines) {
    if (Str.trim(line.description) === "") continue;
    const qty = parseDecimalText(line.quantity);
    const price = parseDecimalText(line.unitPrice);
    if (qty === undefined || price === undefined)
      return { ok: false, error: txt(locale, "needLines") };
    const entry: Types.Mutable<LineInput> = {
      description: Str.trim(line.description),
      quantity: qty,
      unitPrice: price,
      vat: line.vat,
    };
    if (line.itemId !== null) entry.item = PriceListItemId.make(line.itemId);
    const unit = Str.trim(line.unit);
    if (unit !== "") entry.unit = unit;
    validLines.push(entry);
  }
  if (!Arr.isArrayNonEmpty(validLines)) return { ok: false, error: txt(locale, "needLines") };

  const effective = resolveEffective(model);
  const issuedOn = isIsoDateString(model.issuedOn) ? model.issuedOn : todayPrague();
  const taxableSupplyOn = isIsoDateString(model.taxableSupplyOn) ? model.taxableSupplyOn : issuedOn;

  const fxRate = model.manualFx ? parseDecimalText(model.fxRateInput) : undefined;
  const fxQty = Number.parseInt(model.fxQuantityInput, 10);

  const input: Types.Mutable<DocumentInput> = {
    kind: model.kind,
    contact: ContactId.make(model.contactId),
    lines: validLines,
    currency: effective.currency.value,
    issuedOn,
    taxableSupplyOn,
    due: { inDays: effective.dueDays.value },
    language: effective.language.value,
    pricesIncludeVat: model.pricesIncludeVat,
    paymentMethod: effective.paymentMethod.value,
  };
  if (effective.series.value !== null) input.series = effective.series.value;
  if (model.bankAccountId !== "") input.bankAccount = BankAccountId.make(model.bankAccountId);
  const variableSymbol = Str.trim(model.variableSymbol);
  if (variableSymbol !== "") input.variableSymbol = variableSymbol;
  const orderNumber = Str.trim(model.orderNumber);
  if (orderNumber !== "") input.orderNumber = orderNumber;
  if (effective.note.value !== "") input.note = effective.note.value;
  if (model.manualFx && fxRate !== undefined && Number.isInteger(fxQty) && fxQty >= 1) {
    input.fx = { manual: { rate: fxRate, quantity: fxQty } };
  }
  return { ok: true, input };
};

const PREVIEW_DEBOUNCE_MS = 400;
const AUTOSAVE_DEBOUNCE_MS = 3000;

const encodeDocumentInput = Schema.encodeOption(DocumentInput);

const buildDraftPatch = (input: DocumentInput, savedInput: DocumentInput | null): DocumentPatch => {
  const patch = {
    contact: input.contact,
    lines: input.lines,
    currency: input.currency,
    issuedOn: input.issuedOn,
    taxableSupplyOn: input.taxableSupplyOn,
    due: input.due,
    language: input.language,
    series: input.series,
    bankAccount: input.bankAccount,
    pricesIncludeVat: input.pricesIncludeVat,
    variableSymbol: input.variableSymbol,
    orderNumber: input.orderNumber ?? (savedInput?.orderNumber === undefined ? undefined : ""),
    note: input.note ?? (savedInput?.note === undefined ? undefined : ""),
    paymentMethod: input.paymentMethod,
    fx: input.fx ?? null,
  } satisfies DocumentPatch;

  // The view omits some saved settings. Preserve those when the user edits unrelated fields.
  const before =
    savedInput === null ? undefined : Option.getOrUndefined(encodeDocumentInput(savedInput));
  const after = Option.getOrUndefined(encodeDocumentInput(input));
  const fields = Struct.keys(patch);
  return EffectRecord.fromEntries(
    Arr.map(
      Arr.filter(
        fields,
        (field) =>
          patch[field] !== undefined &&
          (before === undefined || !Equal.equals(before[field], after?.[field])),
      ),
      (field) => [field, patch[field]],
    ),
  );
};

const scheduleAfterEdit = (
  model: Model,
  workspaceId: WorkspaceId | undefined,
  extraCommands: ReadonlyArray<PageCommand<Message>> = [],
): PageReturn<Model, Message> => {
  const previewSeq = model.previewSeq + 1;
  const shouldAutosave =
    workspaceId !== undefined &&
    model.revisionState === "current" &&
    (model.savedDoc === null || model.savedDoc.status === "draft");
  const commands: Array<PageCommand<Message>> = [...extraCommands];
  if (workspaceId !== undefined) {
    commands.push(
      delayCommand(
        "DebouncePreview",
        PREVIEW_DEBOUNCE_MS,
        Message.DebouncedPreview({ seq: previewSeq }),
      ),
    );
  }
  if (shouldAutosave) {
    commands.push(
      delayCommand(
        "DebounceAutosave",
        AUTOSAVE_DEBOUNCE_MS,
        Message.AutosaveDue({ seq: previewSeq }),
      ),
    );
  }
  return {
    model: {
      ...model,
      dirty: true,
      previewSeq,
      serverPreview: Remote.idle,
      calcDrift: false,
      autosaveReady: false,
      autosaveError: model.draftWrite === null ? null : model.autosaveError,
    },
    commands,
  };
};

const canWriteDraft = (
  model: Model,
  intent: WriteIntent,
  ws: NonNullable<PageContext["workspace"]>,
): boolean => {
  const doc = model.savedDoc;
  return (
    (model.route._tag === "DocumentNew" || doc !== null) &&
    (doc === null || (doc.status === "draft" && !doc.locked)) &&
    (model.revisionState === "current" ||
      (model.revisionState === "review" && intent !== "autosave")) &&
    canRole(ws.role, intent === "issue" ? "document.issue" : "document.draft") &&
    (doc === null || (intent === "issue" && !model.dirty) || canRole(ws.role, "document.edit"))
  );
};

const runDraftWrite = (
  model: Model,
  write: DraftWrite,
  workspaceId: WorkspaceId,
): PageReturn<Model, Message> => {
  const operation = write.operation;
  const key = operation._tag === "Edit" ? undefined : operation.key;
  const next = {
    ...model,
    draftWrite: { ...write, running: true },
    ...(write.intent === "autosave" ? { autosaveError: null } : { submitError: null }),
  };
  if (key === null) {
    return {
      model: next,
      commands: [
        mintRequestKeyCommand("MintDraftWriteKey", (requestKey) =>
          Message.GotRequestKey({ key: requestKey }),
        ),
      ],
    };
  }
  const headers = key === undefined ? {} : idempotencyHeaders(key);
  return {
    model: next,
    commands: [
      apiCommand(
        Message,
        "WriteDraft",
        (c) => {
          switch (operation._tag) {
            case "Edit":
              return c.documents.edit({
                params: { workspaceId, documentId: operation.id },
                headers: ifMatch(operation.revision),
                payload: operation.patch,
              });
            case "Create":
              return c.documents.createDraft({
                params: { workspaceId },
                headers,
                payload: operation.input,
              });
            case "IssueNew":
              return c.documents.issueFromInput({
                params: { workspaceId },
                headers,
                payload: { input: operation.input },
              });
            case "IssueDraft":
              return c.documents.issueDraft({
                params: { workspaceId, documentId: operation.id },
                headers: { ...headers, ...ifMatch(operation.revision) },
                payload: {},
              });
          }
        },
        (doc): Message => Message.DraftWriteSucceeded({ doc }),
        (failure): Message => Message.DraftWriteFailed({ failure }),
      ),
    ],
  };
};

const retainedVariableSymbol = (model: Model): string | undefined =>
  Str.trim(model.variableSymbol) === "" ? model.savedInput?.variableSymbol : undefined;

const startDraftWrite = (
  model: Model,
  intent: WriteIntent,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  if (ws === null || model.submitting || model.aresBusy || !canWriteDraft(model, intent, ws))
    return { model };
  const pending = model.draftWrite;
  if (pending !== null) {
    return pending.running || pending.intent !== intent
      ? { model }
      : runDraftWrite(model, pending, ws.id);
  }

  if (retainedVariableSymbol(model) !== undefined) return { model };
  const doc = model.savedDoc;
  if (doc !== null && intent === "issue" && !model.dirty) {
    return runDraftWrite(
      model,
      {
        intent,
        seq: model.previewSeq,
        running: true,
        operation: { _tag: "IssueDraft", id: doc.id, revision: doc.revision, key: null },
      },
      ws.id,
    );
  }
  const built = buildDocumentInput(model, ctx.locale);
  if (!built.ok) {
    return { model: intent === "autosave" ? model : { ...model, submitError: built.error } };
  }
  const operation: DraftWrite["operation"] =
    doc !== null
      ? {
          _tag: "Edit",
          id: doc.id,
          revision: doc.revision,
          input: built.input,
          patch: buildDraftPatch(built.input, model.savedInput),
        }
      : intent === "issue"
        ? { _tag: "IssueNew", key: null, input: built.input }
        : { _tag: "Create", key: null, input: built.input };
  return runDraftWrite(
    { ...model, autosaveReady: false },
    { intent, seq: model.previewSeq, running: true, operation },
    ws.id,
  );
};

const writeFreezesForm = (model: Model): boolean =>
  model.submitting || (model.draftWrite !== null && model.draftWrite.intent !== "autosave");

const changedDocumentFields = (
  before: DocumentView,
  after: DocumentView,
  locale: PageContext["locale"],
): ReadonlyArray<string> => {
  const encode = Schema.encodeOption(DocumentView);
  const old = Option.getOrUndefined(encode(before));
  const latest = Option.getOrUndefined(encode(after));
  if (old === undefined || latest === undefined) return [];
  const fields = [
    ["customerLabel", old.contact, latest.contact],
    ["issuedOn", old.dates.issuedOn, latest.dates.issuedOn],
    ["taxableSupplyOn", old.dates.taxableSupplyOn, latest.dates.taxableSupplyOn],
    ["dueDays", old.dates.dueOn, latest.dates.dueOn],
    ["paymentMethod", old.paymentMethod, latest.paymentMethod],
    ["sectionLines", old.lines, latest.lines],
    ["numberOverride", old.number, latest.number],
    ["fxSection", old.fx, latest.fx],
    ["grandTotal", old.totals.gross, latest.totals.gross],
  ] as const;
  return Arr.map(
    Arr.filter(fields, ([, a, b]) => !Equal.equals(a, b)),
    ([label]) => txt(locale, label),
  );
};

const showSavedDocument = (model: Model, doc: DocumentView): PageReturn<Model, Message> => ({
  model: {
    ...model,
    savedDoc: doc,
    dirty: false,
    draftWrite: null,
    submitting: false,
    submitError: null,
  },
  outMessage: Intent_.navigate(
    href({ _tag: "Document", ws: model.route.ws, id: doc.id, tab: "preview" }),
  ),
});

const maybeLoadFx = (
  model: Model,
  workspaceId: WorkspaceId | undefined,
): {
  readonly model: Model;
  readonly commands: ReadonlyArray<PageCommand<Message>>;
} => {
  if (workspaceId === undefined || model.manualFx) return { model, commands: [] };
  const effective = resolveEffective(model);
  const currency = effective.currency.value;
  if (currency === "CZK") return { model: { ...model, fxLookup: Remote.idle }, commands: [] };
  const on = isIsoDateString(model.taxableSupplyOn) ? model.taxableSupplyOn : todayPrague();
  const fxLookup = Remote.load(model.fxLookup);
  return {
    model: { ...model, fxLookup },
    commands: [loadFxCommand(workspaceId, currency, on, Remote.seqOf(fxLookup))],
  };
};

const updateImpl = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  const route = model.route;
  const regime: TaxRegime = ws?.taxRegime ?? "vat_payer";

  if (writeFreezesForm(model) && editedFieldTag.test(message._tag)) return { model };

  return Message.match(message, {
    LoadedLookups: ({ seq, data }) => {
      const lookups = Remote.succeed(model.lookups, seq, data);
      let next: Model = { ...model, lookups };
      if (lookups === model.lookups) return { model };
      if (route._tag === "DocumentEdit" && data.existingDoc !== null) {
        next = hydrateFromDocument(next, data.existingDoc, true);
        const input = buildDocumentInput(next, ctx.locale);
        if (input.ok) next = { ...next, savedInput: input.input };
      } else if (
        route._tag === "DocumentNew" &&
        route.from?._tag === "Duplicate" &&
        data.existingDoc !== null
      ) {
        next = hydrateFromDocument(next, data.existingDoc, false);
      } else if (route._tag === "DocumentNew" && route.from?._tag === "Template") {
        const tpl = Arr.findFirst(data.templates, (t) => t.id === route.from?.id).pipe(
          Option.getOrUndefined,
        );
        if (tpl !== undefined) next = applyTemplateToModel(next, tpl);
      }
      return maybeLoadFx(next, ws?.id);
    },
    FailedLookups: ({ seq, failure }) => ({
      model: { ...model, lookups: Remote.fail(model.lookups, seq, failure) },
    }),
    LoadedFx: ({ seq, data }) => ({
      model: { ...model, fxLookup: Remote.succeed(model.fxLookup, seq, data) },
    }),
    FailedFx: ({ seq, failure }) => ({
      model: { ...model, fxLookup: Remote.fail(model.fxLookup, seq, failure) },
    }),
    SelectedTemplate: ({ templateId }) => {
      const data = Remote.dataOf(model.lookups);
      const tpl = Arr.findFirst(data?.templates ?? [], (t) => t.id === templateId).pipe(
        Option.getOrUndefined,
      );
      if (tpl === undefined) return { model };
      const fxRes = maybeLoadFx(applyTemplateToModel(model, tpl), ws?.id);
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    SelectedContact: ({ contactId }) => {
      const fxRes = maybeLoadFx({ ...model, contactId, submitError: null }, ws?.id);
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    ToggledAres: () => ({
      model: { ...model, aresOpen: !model.aresOpen, aresError: null },
    }),
    ChangedAresIco: ({ value }) => ({ model: { ...model, aresIco: value, aresError: null } }),
    SubmittedAres: () => {
      if (
        ws === null ||
        model.aresBusy ||
        writeFreezesForm(model) ||
        !canRole(ws.role, "document.draft")
      )
        return { model };
      const ico = Str.trim(model.aresIco);
      return {
        model: { ...model, aresBusy: true, aresError: null },
        commands: [
          apiCommand(
            Message,
            "AresQuickAdd",
            (c) =>
              c.contacts.fromIco({
                params: { workspaceId: ws.id },
                payload: { ico, role: "customer" },
              }),
            (raw): Message => {
              const contact = readContact(raw);
              if (contact === undefined) {
                return Message.AresFailed({
                  failure: {
                    tag: "Unexpected",
                    surface: "inline",
                    text: { key: "error.unknown" },
                    issues: [],
                    retryable: true,
                    staleRevision: false,
                    freshBotProof: false,
                    requestId: null,
                  },
                });
              }
              return Message.AresSucceeded({ contact });
            },
            (failure): Message => Message.AresFailed({ failure }),
          ),
        ],
      };
    },
    AresSucceeded: ({ contact }) => {
      const data = Remote.dataOf(model.lookups);
      const nextLookups =
        data === undefined || model.lookups._tag !== "Loaded"
          ? model.lookups
          : {
              ...model.lookups,
              data: {
                ...data,
                contacts: [
                  contact,
                  ...Arr.filter(data.contacts, (existing) => existing.id !== contact.id),
                ],
              },
            };
      const fx = maybeLoadFx(
        {
          ...model,
          lookups: nextLookups,
          contactId: contact.id,
          aresOpen: false,
          aresIco: "",
          aresBusy: false,
          aresError: null,
        },
        ws?.id,
      );
      return {
        ...scheduleAfterEdit(fx.model, ws?.id, fx.commands),
        outMessage: Intent_.toast(txt(ctx.locale, "aresAdded")),
      };
    },
    AresFailed: ({ failure }) => ({
      model: {
        ...model,
        aresBusy: false,
        aresError: textOf(translator(ctx.locale), failure.text),
      },
    }),
    ChangedIssuedOn: ({ value }) => {
      const fxRes = maybeLoadFx({ ...model, issuedOn: value }, ws?.id);
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    ChangedTaxableSupplyOn: ({ value }) => {
      const fxRes = maybeLoadFx({ ...model, taxableSupplyOn: value }, ws?.id);
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    ChangedDueDays: ({ value }) =>
      scheduleAfterEdit({ ...model, dueDaysOverride: value === "" ? null : value }, ws?.id),
    ClearedDueDays: () => scheduleAfterEdit({ ...model, dueDaysOverride: null }, ws?.id),
    ChangedCurrency: ({ value }) => {
      const fxRes = maybeLoadFx(
        { ...model, currencyOverride: value === "" ? null : value },
        ws?.id,
      );
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    ClearedCurrency: () => {
      const fxRes = maybeLoadFx({ ...model, currencyOverride: null }, ws?.id);
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    ChangedLanguage: ({ value }) =>
      scheduleAfterEdit(
        {
          ...model,
          languageOverride: value === "cs" || value === "en" ? value : null,
        },
        ws?.id,
      ),
    ClearedLanguage: () => scheduleAfterEdit({ ...model, languageOverride: null }, ws?.id),
    ChangedPaymentMethod: ({ value }) =>
      scheduleAfterEdit(
        {
          ...model,
          paymentMethodOverride:
            value === "bank_transfer" || value === "cash" || value === "card" || value === "other"
              ? value
              : null,
        },
        ws?.id,
      ),
    ClearedPaymentMethod: () =>
      scheduleAfterEdit({ ...model, paymentMethodOverride: null }, ws?.id),
    ChangedSeries: ({ value }) =>
      scheduleAfterEdit({ ...model, seriesOverride: value === "" ? null : value }, ws?.id),
    ClearedSeries: () => scheduleAfterEdit({ ...model, seriesOverride: null }, ws?.id),
    ChangedBankAccount: ({ value }) =>
      scheduleAfterEdit({ ...model, bankAccountId: value }, ws?.id),
    ChangedVariableSymbol: ({ value }) =>
      scheduleAfterEdit({ ...model, variableSymbol: value }, ws?.id),
    ChangedOrderNumber: ({ value }) => scheduleAfterEdit({ ...model, orderNumber: value }, ws?.id),
    ChangedNote: ({ value }) =>
      scheduleAfterEdit({ ...model, noteOverride: value === "" ? null : value }, ws?.id),
    ClearedNote: () => scheduleAfterEdit({ ...model, noteOverride: null }, ws?.id),
    ChangedNumberOverride: ({ value }) =>
      canRole(ws?.role, "document.overrideNumber") && model.savedDoc?.status === "issued"
        ? scheduleAfterEdit({ ...model, numberOverride: value }, ws?.id)
        : { model },
    ToggledRefreshParties: ({ checked }) =>
      scheduleAfterEdit({ ...model, refreshParties: checked }, ws?.id),
    ToggledPricesIncludeVat: ({ checked }) =>
      scheduleAfterEdit({ ...model, pricesIncludeVat: checked }, ws?.id),
    ToggledManualFx: ({ checked }) => {
      const fxRes = maybeLoadFx({ ...model, manualFx: checked }, ws?.id);
      return scheduleAfterEdit(fxRes.model, ws?.id, fxRes.commands);
    },
    ChangedFxRate: ({ value }) => scheduleAfterEdit({ ...model, fxRateInput: value }, ws?.id),
    ChangedFxQuantity: ({ value }) =>
      scheduleAfterEdit({ ...model, fxQuantityInput: value }, ws?.id),
    AddedLine: () =>
      scheduleAfterEdit(
        {
          ...model,
          lines: [...model.lines, emptyLine(model.nextLineKey, regime)],
          nextLineKey: model.nextLineKey + 1,
        },
        ws?.id,
      ),
    AddedPriceListItem: ({ itemId }) => {
      const data = Remote.dataOf(model.lookups);
      const item = Arr.findFirst(data?.priceList ?? [], (p) => p.id === itemId).pipe(
        Option.getOrUndefined,
      );
      if (item === undefined) return { model };
      const line: EditorLine = {
        key: `l${model.nextLineKey}`,
        itemId: item.id,
        description:
          item.description !== null && item.description !== ""
            ? `${item.name} — ${item.description}`
            : item.name,
        quantity: "1",
        unit: item.unit ?? "ks",
        unitPrice: decimalToInput(item.unitPrice),
        vat: item.vat ?? (regime === "vat_payer" ? "standard" : "outside_scope"),
      };
      return scheduleAfterEdit(
        {
          ...model,
          lines: [...model.lines, line],
          nextLineKey: model.nextLineKey + 1,
        },
        ws?.id,
      );
    },
    UpdatedLineField: ({ key, field, value }) =>
      scheduleAfterEdit(
        {
          ...model,
          lines: Arr.map(model.lines, (l) => (l.key === key ? { ...l, [field]: value } : l)),
        },
        ws?.id,
      ),
    MovedLine: ({ key, direction }) => {
      const idx = Option.getOrElse(
        Arr.findFirstIndex(model.lines, (l) => l.key === key),
        () => -1,
      );
      if (idx < 0) return { model };
      const swap = direction === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= model.lines.length) return { model };
      const copyLines = [...model.lines];
      const current = copyLines[idx];
      const target = copyLines[swap];
      if (current === undefined || target === undefined) return { model };
      copyLines[idx] = target;
      copyLines[swap] = current;
      return scheduleAfterEdit({ ...model, lines: copyLines }, ws?.id);
    },
    RemovedLine: ({ key }) =>
      scheduleAfterEdit(
        {
          ...model,
          lines:
            model.lines.length <= 1
              ? [emptyLine(model.nextLineKey, regime)]
              : Arr.filter(model.lines, (l) => l.key !== key),
          nextLineKey: model.lines.length <= 1 ? model.nextLineKey + 1 : model.nextLineKey,
        },
        ws?.id,
      ),
    DebouncedPreview: ({ seq }) => {
      if (ws === null || seq !== model.previewSeq || model.serverPreview._tag !== "Idle") {
        return { model };
      }
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model };
      return {
        model: { ...model, serverPreview: { _tag: "Loading", seq } },
        commands: [
          apiCommand(
            Message,
            "PreviewDocument",
            (c) =>
              c.documents.preview({
                params: { workspaceId: ws.id },
                payload: built.input,
              }),
            (doc): Message => Message.GotPreview({ seq, doc }),
            (failure): Message => Message.FailedPreview({ seq, failure }),
          ),
        ],
      };
    },
    GotPreview: ({ seq, doc }) => {
      const serverPreview = Remote.succeed(model.serverPreview, seq, doc);
      if (serverPreview === model.serverPreview) return { model };
      const local = computePreview(model, regime);
      return {
        model: {
          ...model,
          serverPreview,
          calcDrift: local !== null && !ViewModels.sameBreakdown(local.breakdown, doc.totals),
        },
      };
    },
    FailedPreview: ({ seq, failure }) => ({
      model: { ...model, serverPreview: Remote.fail(model.serverPreview, seq, failure) },
    }),
    AutosaveDue: ({ seq }) => {
      if (
        ws === null ||
        seq !== model.previewSeq ||
        !model.dirty ||
        !canWriteDraft(model, "autosave", ws)
      ) {
        return { model };
      }
      const ready = { ...model, autosaveReady: true };
      return model.draftWrite === null ? startDraftWrite(ready, "autosave", ctx) : { model: ready };
    },
    ClickedRetryAutosave: () =>
      model.dirty && model.autosaveError !== null
        ? startDraftWrite(model, "autosave", ctx)
        : { model },
    GotRequestKey: ({ key }) => {
      const write = model.draftWrite;
      if (ws === null || write === null || !write.running) return { model };
      const operation = write.operation;
      if (operation._tag === "Edit" || operation.key !== null) return { model };
      if (!canWriteDraft(model, write.intent, ws)) return { model: { ...model, draftWrite: null } };
      return runDraftWrite(model, { ...write, operation: { ...operation, key } }, ws.id);
    },
    DraftWriteSucceeded: ({ doc }) => {
      const write = model.draftWrite;
      if (write === null || !write.running) return { model };
      const saved: Model = {
        ...model,
        savedDoc: doc,
        savedInput: "input" in write.operation ? write.operation.input : model.savedInput,
        draftWrite: null,
        dirty: write.seq !== model.previewSeq,
        revisionState: "current",
        revisionChanges: [],
        autosaveError: null,
        submitError: null,
      };
      if (write.intent === "issue" && write.operation._tag === "Edit") {
        if (ws === null || saved.dirty || !canWriteDraft(saved, "issue", ws))
          return { model: saved };
        return runDraftWrite(
          saved,
          {
            ...write,
            operation: { _tag: "IssueDraft", id: doc.id, revision: doc.revision, key: null },
          },
          ws.id,
        );
      }
      if (write.intent !== "autosave") return showSavedDocument(saved, doc);
      return saved.dirty && saved.autosaveReady
        ? startDraftWrite(saved, "autosave", ctx)
        : { model: saved };
    },
    DraftWriteFailed: ({ failure }) => {
      const write = model.draftWrite;
      if (write === null || !write.running) return { model };
      const error = textOf(translator(ctx.locale), failure.text);
      const draftWrite = preserveRequestKey(failure) ? { ...write, running: false } : null;
      const failed: Model = {
        ...model,
        draftWrite,
        revisionState: failure.staleRevision ? "stale" : model.revisionState,
        ...(write.intent === "autosave" ? { autosaveError: error } : { submitError: error }),
      };
      return write.intent === "autosave" &&
        draftWrite === null &&
        !failure.staleRevision &&
        write.seq !== model.previewSeq &&
        model.autosaveReady
        ? startDraftWrite(failed, "autosave", ctx)
        : { model: failed };
    },
    ClickedSaveDraft: () => startDraftWrite(model, "save_draft", ctx),
    ClickedIssue: () => startDraftWrite(model, "issue", ctx),
    ClickedSaveIssued: () => {
      if (
        ws === null ||
        model.submitting ||
        model.savedDoc?.status !== "issued" ||
        retainedVariableSymbol(model) !== undefined ||
        model.savedDoc.locked ||
        model.aresBusy ||
        (model.revisionState !== "current" && model.revisionState !== "review") ||
        !canRole(ws.role, "document.edit")
      ) {
        return { model };
      }
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      const allowNumberOverride = canRole(ws.role, "document.overrideNumber");
      const { series: _draftSeries, ...changes } = buildDraftPatch(built.input, model.savedInput);
      const patch: Types.Mutable<DocumentPatch> = changes;
      const number = Str.trim(model.numberOverride);
      if (allowNumberOverride && number !== "" && number !== model.savedDoc.number)
        patch.number = number;
      if (model.refreshParties) patch.refreshParties = true;
      const { id: editId, revision: editRev } = model.savedDoc;
      return {
        model: { ...model, submitting: true, submitError: null },
        commands: [
          apiCommand(
            Message,
            "SaveIssuedEdit",
            (c) =>
              c.documents.edit({
                params: { workspaceId: ws.id, documentId: editId },
                headers: ifMatch(editRev),
                payload: patch,
              }),
            (doc): Message => Message.SavedDocument({ doc }),
            (failure): Message => Message.FailedSubmit({ failure }),
          ),
        ],
      };
    },
    SavedDocument: ({ doc }) => (model.submitting ? showSavedDocument(model, doc) : { model }),
    FailedSubmit: ({ failure }) => ({
      model: {
        ...model,
        submitting: false,
        submitError: textOf(translator(ctx.locale), failure.text),
        revisionState: failure.staleRevision ? "stale" : model.revisionState,
      },
    }),
    ClickedReloadRevision: () => {
      const doc = model.savedDoc;
      if (ws === null || doc === null || model.revisionState !== "stale") return { model };
      return {
        model: { ...model, revisionState: "loading" },
        commands: [
          apiCommand(
            Message,
            "ReloadDocumentRevision",
            (c) => c.documents.get({ params: { workspaceId: ws.id, documentId: doc.id } }),
            (loadedDoc): Message => Message.LoadedRevision({ doc: loadedDoc }),
            (failure): Message => Message.FailedRevision({ failure }),
          ),
        ],
      };
    },
    LoadedRevision: ({ doc }) => {
      const previous = model.savedDoc;
      if (previous === null || model.revisionState !== "loading" || previous.id !== doc.id) {
        return { model };
      }
      const canContinue = previous.status === doc.status && !doc.locked;
      return {
        model: {
          ...model,
          savedDoc: doc,
          revisionState: canContinue ? "review" : "blocked",
          revisionChanges: changedDocumentFields(previous, doc, ctx.locale),
          submitError: null,
          autosaveError: null,
        },
      };
    },
    FailedRevision: ({ failure }) =>
      model.revisionState === "loading"
        ? {
            model: {
              ...model,
              revisionState: "stale",
              submitError: textOf(translator(ctx.locale), failure.text),
            },
          }
        : { model },
    ClickedRetry: () => {
      if (ws === null) return { model };
      const lookups = Remote.load(model.lookups);
      return {
        model: { ...model, lookups },
        commands: [loadLookupsCommand(ws.id, route, Remote.seqOf(lookups))],
      };
    },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  if (model.savedDoc?.status === "issued") return txt(ctx.locale, "editIssuedTitle");
  if (model.route._tag === "DocumentEdit" || model.savedDoc !== null) {
    return txt(ctx.locale, "editDraftTitle");
  }
  return model.kind === "proforma"
    ? txt(ctx.locale, "newProformaTitle")
    : txt(ctx.locale, "newInvoiceTitle");
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const computePreview = (model: Model, regime: TaxRegime): ViewModels.LivePreview | null => {
  const effective = resolveEffective(model);
  const data = Remote.dataOf(model.lookups);
  const taxPoint = isIsoDateString(model.taxableSupplyOn) ? model.taxableSupplyOn : todayPrague();
  const cnbFx = Remote.dataOf(model.fxLookup);
  const manualRate = model.manualFx ? parseDecimalText(model.fxRateInput) : undefined;
  const manualQty = Number.parseInt(model.fxQuantityInput, 10);
  const fx: ViewModels.FxRate | null =
    effective.currency.value === "CZK"
      ? null
      : model.manualFx && manualRate !== undefined && Number.isInteger(manualQty) && manualQty >= 1
        ? { rate: manualRate, quantity: manualQty }
        : cnbFx !== undefined
          ? { rate: cnbFx.rate, quantity: cnbFx.quantity }
          : null;

  const previewLines: Array<ViewModels.PreviewLine> = Arr.map(model.lines, (l) => ({
    quantity: parseDecimalText(l.quantity) ?? BigDecimal.fromBigInt(0n),
    unitPrice: parseDecimalText(l.unitPrice) ?? BigDecimal.fromBigInt(0n),
    treatment: l.vat,
  }));

  const res = ViewModels.calculate({
    lines: previewLines,
    currency: effective.currency.value,
    taxPoint,
    pricesIncludeVat: model.pricesIncludeVat,
    fx,
    paymentRounding: data?.workspace?.defaults?.paymentRounding ?? "none",
    direction: "outgoing",
    taxRegime: regime,
    kind: model.kind,
  });
  return Result.isSuccess(res) ? res.success : null;
};

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const { locale } = ctx;
  const t = translator(locale);
  const ws = ctx.workspace;
  const route = model.route;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const regime = ws.taxRegime;
  const data = Remote.dataOf(model.lookups);
  const effective = resolveEffective(model);
  const preview = computePreview(model, regime);
  const serverDoc = Remote.dataOf(model.serverPreview) ?? (model.dirty ? null : model.savedDoc);
  const displayBuckets = serverDoc?.totals.buckets ?? preview?.breakdown.buckets ?? [];
  const displayTotals =
    serverDoc !== null
      ? {
          net: serverDoc.totals.net,
          vat: serverDoc.totals.vat,
          gross: serverDoc.totals.gross,
          vatCzk: serverDoc.totals.vatCzk,
          roundingAdjustment: serverDoc.totals.roundingAdjustment,
        }
      : preview !== null
        ? {
            net: preview.breakdown.net,
            vat: preview.breakdown.vat,
            gross: preview.breakdown.gross,
            vatCzk: preview.breakdown.vatCzk,
            roundingAdjustment: preview.breakdown.roundingAdjustment,
          }
        : null;
  const isIssuedEdit = model.savedDoc?.status === "issued";
  const selectedContact = Arr.findFirst(data?.contacts ?? [], (c) => c.id === model.contactId).pipe(
    Option.getOrUndefined,
  );
  const cnbFx = Remote.dataOf(model.fxLookup);

  const issuedIso = isIsoDateString(model.issuedOn) ? model.issuedOn : todayPrague();
  const computedDue = addDaysIso(issuedIso, effective.dueDays.value);

  const mayEdit =
    canRole(ws.role, "document.edit") &&
    (model.savedDoc === null ||
      (!model.savedDoc.locked && model.savedDoc.status !== "cancelled")) &&
    model.revisionState !== "blocked";
  const activeWrite = model.draftWrite?.running === true;
  const retainedSymbol = retainedVariableSymbol(model);
  const blockedFor = (intent: WriteIntent) =>
    retainedSymbol !== undefined ||
    model.aresBusy ||
    (model.draftWrite !== null && (model.draftWrite.running || model.draftWrite.intent !== intent));
  const headerActions = [
    linkButton(h, {
      label: txt(locale, "backToList"),
      href:
        isIssuedEdit && model.savedDoc !== null
          ? href({ _tag: "Document", ws: ws.slug, id: model.savedDoc.id, tab: "preview" })
          : href({ _tag: "Documents", ws: ws.slug, query: {} }),
      variant: "ghost",
    }),
    ...(isIssuedEdit && mayEdit
      ? [
          button(h, {
            label: txt(locale, "saveChanges"),
            onClick: Message.ClickedSaveIssued(),
            variant: "primary",
            busy: model.submitting,
            disabled:
              model.submitting ||
              retainedSymbol !== undefined ||
              model.aresBusy ||
              model.revisionState === "stale" ||
              model.revisionState === "loading",
          }),
        ]
      : []),
    ...(canWriteDraft(model, "save_draft", ws)
      ? [
          button(h, {
            label: txt(locale, "saveDraft"),
            onClick: Message.ClickedSaveDraft(),
            busy: activeWrite && model.draftWrite?.intent === "save_draft",
            disabled: blockedFor("save_draft"),
          }),
        ]
      : []),
    ...(canWriteDraft(model, "issue", ws)
      ? [
          button(h, {
            label: txt(locale, "issue"),
            onClick: Message.ClickedIssue(),
            variant: "primary",
            busy: activeWrite && model.draftWrite?.intent === "issue",
            disabled: blockedFor("issue"),
          }),
        ]
      : []),
  ];

  const error = model.submitError ?? model.autosaveError;
  const errorBanner =
    model.lookups._tag === "Failed"
      ? [
          banner(h, {
            text: textOf(t, model.lookups.failure.text),
            tone: "error",
            action: button(h, {
              label: sharedCopy(locale, "retry"),
              onClick: Message.ClickedRetry(),
              small: true,
            }),
          }),
        ]
      : error !== null
        ? [
            banner(h, {
              text: error,
              tone: "error",
              ...(model.revisionState === "stale" || model.revisionState === "loading"
                ? {
                    action: button(h, {
                      label: txt(locale, "reloadRevision"),
                      onClick: Message.ClickedReloadRevision(),
                      small: true,
                      disabled: model.revisionState === "loading",
                    }),
                  }
                : model.autosaveError !== null && model.submitError === null
                  ? {
                      action: button(h, {
                        label: sharedCopy(locale, "retry"),
                        onClick: Message.ClickedRetryAutosave(),
                        small: true,
                      }),
                    }
                  : {}),
            }),
          ]
        : [];

  const draftStatus =
    activeWrite && model.draftWrite?.intent === "autosave"
      ? txt(locale, "savingDraft")
      : !model.dirty && model.savedDoc?.status === "draft" && model.revisionState === "current"
        ? txt(locale, "draftSaved")
        : "";

  const regimeBanner =
    regime === "non_vat_payer"
      ? [banner(h, { text: txt(locale, "regimeNonVat"), tone: "info" })]
      : regime === "identified_person"
        ? [banner(h, { text: txt(locale, "regimeIdentified"), tone: "info" })]
        : [];

  const vatOptions: ReadonlyArray<{ readonly value: VatTreatment; readonly label: string }> =
    regime === "vat_payer"
      ? [
          {
            value: "standard",
            label: textOf(t, I18n.enumText({ name: "vatTreatment", value: "standard" })),
          },
          {
            value: "reduced",
            label: textOf(t, I18n.enumText({ name: "vatTreatment", value: "reduced" })),
          },
          {
            value: "reverse_charge",
            label: textOf(t, I18n.enumText({ name: "vatTreatment", value: "reverse_charge" })),
          },
          {
            value: "exempt_intra_eu_goods",
            label: textOf(
              t,
              I18n.enumText({ name: "vatTreatment", value: "exempt_intra_eu_goods" }),
            ),
          },
          {
            value: "outside_scope",
            label: textOf(t, I18n.enumText({ name: "vatTreatment", value: "outside_scope" })),
          },
        ]
      : [
          {
            value: "outside_scope",
            label: textOf(t, I18n.enumText({ name: "vatTreatment", value: "outside_scope" })),
          },
          ...(regime === "identified_person"
            ? [
                {
                  value: "reverse_charge" as const,
                  label: textOf(
                    t,
                    I18n.enumText({ name: "vatTreatment", value: "reverse_charge" }),
                  ),
                },
              ]
            : []),
        ];

  const formColumn =
    data === undefined
      ? card(h, [
          h.div
            .class(ui.stack)
            .attr("aria-busy", String(true))
            .children([
              skeleton(h, "40%", "1.2rem"),
              skeleton(h, "100%", "2.5rem"),
              skeleton(h, "100%", "6rem"),
            ]),
        ])
      : h.div.class(ui.stack).children([
          // Quick template start (only for new documents)
          ...(route._tag === "DocumentNew" && data.templates.length > 0
            ? [
                card(
                  h,
                  [
                    selectField(h, {
                      id: "editor-template",
                      label: txt(locale, "quickTemplate"),
                      value: "",
                      onChange: (templateId) => Message.SelectedTemplate({ templateId }),
                      options: [
                        { value: "", label: txt(locale, "quickTemplateNone") },
                        ...Arr.map(data.templates, (tpl) => ({ value: tpl.id, label: tpl.name })),
                      ],
                    }),
                  ],
                  [],
                  true,
                ),
              ]
            : []),
          // Customer + ARES quick-add
          card(h, [
            cardTitle(h, txt(locale, "sectionCustomer"), [
              button(h, {
                label: txt(locale, "aresToggle"),
                onClick: Message.ToggledAres(),
                small: true,
              }),
            ]),
            selectField(h, {
              id: "editor-contact",
              label: txt(locale, "customerLabel"),
              value: model.contactId,
              searchable: true,
              searchPlaceholder: txt(locale, "customerPlaceholder"),
              onChange: (contactId) => Message.SelectedContact({ contactId }),
              options: [
                { value: "", label: txt(locale, "customerPlaceholder") },
                ...Arr.map(data.contacts, (c) => ({
                  value: c.id,
                  label: c.ico !== null ? `${c.name} (${c.ico})` : c.name,
                })),
              ],
            }),
            ...(model.aresOpen
              ? [
                  h.div
                    .class(
                      "flex flex-col gap-2.5 rounded-control border border-outline-variant bg-surface-container-low p-3",
                    )
                    .children([
                      h.div.class(ui.row).children([
                        textField(h, {
                          id: "editor-ares-ico",
                          label: txt(locale, "aresIcoLabel"),
                          value: model.aresIco,
                          onInput: (value) => Message.ChangedAresIco({ value }),
                          placeholder: txt(locale, "aresIcoPlaceholder"),
                          mono: true,
                          error: model.aresError ?? undefined,
                        }),
                        button(h, {
                          label: txt(locale, "aresLookup"),
                          onClick: Message.SubmittedAres(),
                          variant: "primary",
                          busy: model.aresBusy,
                        }),
                      ]),
                    ]),
                ]
              : []),
          ]),
          // Dates
          card(h, [
            cardTitle(h, txt(locale, "sectionDates")),
            h.div.class(ui.formGrid3).children([
              textField(h, {
                id: "editor-issued-on",
                label: txt(locale, "issuedOn"),
                type: "date",
                value: model.issuedOn,
                onInput: (value) => Message.ChangedIssuedOn({ value }),
              }),
              textField(h, {
                id: "editor-duzp",
                label: txt(locale, "taxableSupplyOn"),
                type: "date",
                value: model.taxableSupplyOn,
                onInput: (value) => Message.ChangedTaxableSupplyOn({ value }),
              }),
              h.div.class(ui.stack).children([
                h.div.class("flex items-center justify-between gap-1.5").children([
                  h.label
                    .class(ui.fieldLabel)
                    .attr("for", "editor-due-days")
                    .children([txt(locale, "dueDays")]),
                  sourceBadge(h, locale, effective.dueDays.source),
                ]),
                UiInput(h)
                  .value(model.dueDaysOverride ?? String(effective.dueDays.value))
                  .on("valuechange", ({ value }) => Message.ChangedDueDays({ value }))
                  .children([
                    h.input
                      .class(cn(controlVariants({ kind: "input" }), ui.num))
                      .id("editor-due-days")
                      .attr("type", "number")
                      .value(model.dueDaysOverride ?? String(effective.dueDays.value)),
                  ]),
                h.span
                  .class(cn(ui.fieldHint, ui.num))
                  .children([txt(locale, "dueDateHint", { date: fmtDate(locale, computedDue) })]),
              ]),
            ]),
          ]),
          // Billing details with override source badges
          card(h, [
            cardTitle(h, txt(locale, "sectionBilling")),
            h.div.class(ui.formGrid).children([
              // Currency
              h.div
                .attr("data-slot", "field")
                .class(ui.field)
                .children([
                  h.div.class("flex items-center justify-between gap-1.5").children([
                    h.label
                      .class(ui.fieldLabel)
                      .attr("for", "editor-currency")
                      .children([txt(locale, "currency")]),
                    h.div.class(ui.row).children([
                      sourceBadge(h, locale, effective.currency.source),
                      ...(effective.currency.overridden
                        ? [
                            button(h, {
                              label: txt(locale, "clearOverride"),
                              onClick: Message.ClearedCurrency(),
                              variant: "ghost",
                              small: true,
                            }),
                          ]
                        : []),
                    ]),
                  ]),
                  select(h, {
                    id: "editor-currency",
                    label: txt(locale, "currency"),
                    value: effective.currency.value,
                    onChange: (value) => Message.ChangedCurrency({ value }),
                    options: [
                      { value: "CZK", label: "CZK" },
                      { value: "EUR", label: "EUR" },
                      { value: "USD", label: "USD" },
                      { value: "GBP", label: "GBP" },
                    ],
                  }),
                ]),
              // Language
              h.div
                .attr("data-slot", "field")
                .class(ui.field)
                .children([
                  h.div.class("flex items-center justify-between gap-1.5").children([
                    h.label
                      .class(ui.fieldLabel)
                      .attr("for", "editor-language")
                      .children([txt(locale, "language")]),
                    sourceBadge(h, locale, effective.language.source),
                  ]),
                  select(h, {
                    id: "editor-language",
                    label: txt(locale, "language"),
                    value: effective.language.value,
                    onChange: (value) => Message.ChangedLanguage({ value }),
                    options: [
                      {
                        value: "cs",
                        label: textOf(t, I18n.enumText({ name: "locale", value: "cs" })),
                      },
                      {
                        value: "en",
                        label: textOf(t, I18n.enumText({ name: "locale", value: "en" })),
                      },
                    ],
                  }),
                ]),
              // Payment method
              h.div
                .attr("data-slot", "field")
                .class(ui.field)
                .children([
                  h.div.class("flex items-center justify-between gap-1.5").children([
                    h.label
                      .class(ui.fieldLabel)
                      .attr("for", "editor-pm")
                      .children([txt(locale, "paymentMethod")]),
                    sourceBadge(h, locale, effective.paymentMethod.source),
                  ]),
                  select(h, {
                    id: "editor-pm",
                    label: txt(locale, "paymentMethod"),
                    value: effective.paymentMethod.value,
                    onChange: (value) => Message.ChangedPaymentMethod({ value }),
                    options: [
                      {
                        value: "bank_transfer",
                        label: textOf(
                          t,
                          I18n.enumText({ name: "paymentMethod", value: "bank_transfer" }),
                        ),
                      },
                      {
                        value: "cash",
                        label: textOf(t, I18n.enumText({ name: "paymentMethod", value: "cash" })),
                      },
                      {
                        value: "card",
                        label: textOf(t, I18n.enumText({ name: "paymentMethod", value: "card" })),
                      },
                      {
                        value: "other",
                        label: textOf(t, I18n.enumText({ name: "paymentMethod", value: "other" })),
                      },
                    ],
                  }),
                ]),
              // Numbering series (drafts only)
              ...(isIssuedEdit
                ? [
                    textField(h, {
                      id: "editor-number-override",
                      label: txt(locale, "numberOverride"),
                      value: model.numberOverride,
                      onInput: (value) => Message.ChangedNumberOverride({ value }),
                      mono: true,
                      disabled: !canRole(ws.role, "document.overrideNumber"),
                    }),
                  ]
                : [
                    h.div
                      .attr("data-slot", "field")
                      .class(ui.field)
                      .children([
                        h.div.class("flex items-center justify-between gap-1.5").children([
                          h.label
                            .class(ui.fieldLabel)
                            .attr("for", "editor-series")
                            .children([txt(locale, "series")]),
                          sourceBadge(h, locale, effective.series.source),
                        ]),
                        select(h, {
                          id: "editor-series",
                          label: txt(locale, "series"),
                          value: effective.series.value ?? "",
                          onChange: (value) => Message.ChangedSeries({ value }),
                          options: [
                            { value: "", label: txt(locale, "seriesDefault") },
                            ...Arr.map(
                              Arr.filter(data.series, (s) => s.kind === model.kind),
                              (s) => ({
                                value: s.id,
                                label: `${s.name} (${s.nextNumber})`,
                              }),
                            ),
                          ],
                        }),
                      ]),
                  ]),
              // Bank account
              selectField(h, {
                id: "editor-bank",
                label: txt(locale, "bankAccount"),
                value: model.bankAccountId,
                onChange: (value) => Message.ChangedBankAccount({ value }),
                options: [
                  { value: "", label: txt(locale, "bankAccountAuto") },
                  ...Arr.map(data.bankAccounts, (b) => ({
                    value: b.id,
                    label: `${b.name ?? b.iban ?? b.accountNumber ?? b.id} (${b.currency})`,
                  })),
                ],
              }),
              textField(h, {
                id: "editor-vs",
                label: txt(locale, "variableSymbol"),
                value: model.variableSymbol,
                onInput: (value) => Message.ChangedVariableSymbol({ value }),
                ...(retainedSymbol !== undefined
                  ? { error: txt(locale, "variableSymbolRetained", { symbol: retainedSymbol }) }
                  : model.savedDoc !== null
                    ? { hint: txt(locale, "variableSymbolUnchanged") }
                    : {}),
                mono: true,
              }),
              textField(h, {
                id: "editor-order",
                label: txt(locale, "orderNumber"),
                value: model.orderNumber,
                onInput: (value) => Message.ChangedOrderNumber({ value }),
                mono: true,
              }),
            ]),
            h.div.class(ui.row).children([
              ...(regime === "vat_payer"
                ? [
                    checkbox(h, {
                      id: "editor-incl-vat",
                      label: txt(locale, "pricesIncludeVat"),
                      checked: model.pricesIncludeVat,
                      onToggle: (checked) => Message.ToggledPricesIncludeVat({ checked }),
                    }),
                  ]
                : []),
              ...(isIssuedEdit
                ? [
                    checkbox(h, {
                      id: "editor-refresh-parties",
                      label: txt(locale, "refreshParties"),
                      checked: model.refreshParties,
                      onToggle: (checked) => Message.ToggledRefreshParties({ checked }),
                    }),
                  ]
                : []),
            ]),
            // FX section for non-CZK
            ...(effective.currency.value !== "CZK"
              ? [
                  separator(h),
                  h.div.class(ui.stack).children([
                    h.div.class(ui.spread).children([
                      h.strong.children([txt(locale, "fxSection")]),
                      checkbox(h, {
                        id: "editor-manual-fx",
                        label: txt(locale, "fxManualToggle"),
                        checked: model.manualFx,
                        onToggle: (checked) => Message.ToggledManualFx({ checked }),
                      }),
                    ]),
                    ...(model.manualFx
                      ? [
                          h.div.class(ui.formGrid).children([
                            textField(h, {
                              id: "editor-fx-rate",
                              label: txt(locale, "fxRate"),
                              value: model.fxRateInput,
                              onInput: (value) => Message.ChangedFxRate({ value }),
                              mono: true,
                            }),
                            textField(h, {
                              id: "editor-fx-qty",
                              label: txt(locale, "fxQuantity"),
                              type: "number",
                              value: model.fxQuantityInput,
                              onInput: (value) => Message.ChangedFxQuantity({ value }),
                              mono: true,
                            }),
                          ]),
                        ]
                      : cnbFx !== undefined
                        ? [
                            h.p.class(cn(ui.small, ui.muted, ui.num)).children([
                              txt(locale, "fxCnbNote", {
                                date: fmtDate(locale, cnbFx.fixingDate),
                                qty: cnbFx.quantity,
                                cur: cnbFx.currency,
                                rate: fmtNum(locale, cnbFx.rate, 3),
                              }),
                            ]),
                          ]
                        : []),
                  ]),
                ]
              : []),
          ]),
          // Line items
          card(h, [
            cardTitle(h, txt(locale, "sectionLines"), [
              ...(data.priceList.length > 0
                ? [
                    select(h, {
                      id: "editor-add-pricelist",
                      label: txt(locale, "addFromPriceList"),
                      value: "",
                      className: "w-auto min-w-[150px]",
                      searchable: true,
                      searchPlaceholder: txt(locale, "addFromPriceList"),
                      onChange: (itemId) => Message.AddedPriceListItem({ itemId }),
                      options: [
                        { value: "", label: txt(locale, "addFromPriceList") },
                        ...Arr.map(data.priceList, (p) => ({
                          value: p.id,
                          label: `${p.name} (${fmtNum(locale, p.unitPrice)} ${p.currency})`,
                        })),
                      ],
                    }),
                  ]
                : []),
              button(h, {
                label: txt(locale, "addLine"),
                onClick: Message.AddedLine(),
                small: true,
              }),
            ]),
            ...Arr.map(model.lines, (line, index) =>
              h.div
                .key(line.key)
                .class(
                  "grid grid-cols-2 items-start gap-2 border-b border-outline-variant py-2.5 last:border-b-0 lg:grid-cols-[minmax(0,2.2fr)_76px_76px_110px_140px_auto]",
                )
                .children([
                  textField(h, {
                    id: `line-desc-${line.key}`,
                    label: txt(locale, "lineDesc"),
                    value: line.description,
                    onInput: (value) =>
                      Message.UpdatedLineField({ key: line.key, field: "description", value }),
                  }),
                  textField(h, {
                    id: `line-qty-${line.key}`,
                    label: txt(locale, "lineQty"),
                    value: line.quantity,
                    onInput: (value) =>
                      Message.UpdatedLineField({ key: line.key, field: "quantity", value }),
                    mono: true,
                  }),
                  textField(h, {
                    id: `line-unit-${line.key}`,
                    label: txt(locale, "lineUnit"),
                    value: line.unit,
                    onInput: (value) =>
                      Message.UpdatedLineField({ key: line.key, field: "unit", value }),
                  }),
                  textField(h, {
                    id: `line-price-${line.key}`,
                    label: txt(locale, "linePrice"),
                    value: line.unitPrice,
                    onInput: (value) =>
                      Message.UpdatedLineField({ key: line.key, field: "unitPrice", value }),
                    mono: true,
                  }),
                  selectField(h, {
                    id: `line-vat-${line.key}`,
                    label: txt(locale, "lineVat"),
                    value: line.vat,
                    onChange: (value) =>
                      Message.UpdatedLineField({ key: line.key, field: "vat", value }),
                    options: vatOptions,
                  }),
                  h.div.class("flex items-center gap-1 pt-[22px]").children([
                    button(h, {
                      label: "↑",
                      ariaLabel: txt(locale, "moveUp"),
                      onClick: Message.MovedLine({ key: line.key, direction: "up" }),
                      disabled: index === 0,
                      small: true,
                    }),
                    button(h, {
                      label: "↓",
                      ariaLabel: txt(locale, "moveDown"),
                      onClick: Message.MovedLine({ key: line.key, direction: "down" }),
                      disabled: index === model.lines.length - 1,
                      small: true,
                    }),
                    button(h, {
                      label: "×",
                      ariaLabel: txt(locale, "removeLine"),
                      onClick: Message.RemovedLine({ key: line.key }),
                      variant: "ghost",
                      small: true,
                    }),
                  ]),
                ]),
            ),
          ]),
          // Printed note
          card(h, [
            h.div.class("flex items-center justify-between gap-1.5").children([
              h.label
                .class(ui.fieldLabel)
                .attr("for", "editor-note")
                .children([txt(locale, "noteLabel")]),
              sourceBadge(h, locale, effective.note.source),
            ]),
            textArea(h, {
              id: "editor-note",
              label: "",
              value: model.noteOverride ?? effective.note.value,
              onInput: (value) => Message.ChangedNote({ value }),
            }),
          ]),
        ]);

  const previewColumn = h.aside.class("flex flex-col gap-3 lg:sticky lg:top-4").children([
    card(h, [
      cardTitle(h, txt(locale, "previewTitle"), [
        badge(
          h,
          textOf(t, I18n.enumText({ name: "documentKind", value: model.kind })),
          model.kind === "proforma" ? "proforma" : "outline",
        ),
      ]),
      h.div
        .class(ui.spread)
        .children([
          mono(h, model.numberOverride || txt(locale, "draftPreviewNumber")),
          h.span.class(cn(ui.small, ui.muted, ui.num)).children([fmtDate(locale, issuedIso)]),
        ]),
      separator(h),
      h.div
        .class(ui.stack)
        .children([
          h.strong.children([selectedContact?.name ?? txt(locale, "customerPlaceholder")]),
          ...(selectedContact?.ico !== null && selectedContact?.ico !== undefined
            ? [
                h.span
                  .class(cn(ui.small, ui.muted, ui.mono))
                  .children([`IČO ${selectedContact.ico}`]),
              ]
            : []),
          ...(selectedContact?.dic !== null && selectedContact?.dic !== undefined
            ? [
                h.span
                  .class(cn(ui.small, ui.muted, ui.mono))
                  .children([`DIČ ${selectedContact.dic}`]),
              ]
            : []),
        ]),
      separator(h),
      h.h3.children([txt(locale, "vatSummaryTitle")]),
      ...(displayTotals === null
        ? []
        : [
            ...(regime === "vat_payer" && displayBuckets.length > 0
              ? [
                  h.table
                    .class(
                      "w-full border-collapse text-[0.8125rem] kb-num [&_td]:border-b [&_td]:border-outline-variant [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-outline-variant [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-[0.75rem] [&_th]:font-medium [&_th]:text-on-surface-variant",
                    )
                    .children([
                      h.thead.children([
                        h.tr.children([
                          h.th.class("text-left").children([txt(locale, "vatColRate")]),
                          h.th.class("text-right").children([txt(locale, "vatColBase")]),
                          h.th.class("text-right").children([txt(locale, "vatColVat")]),
                          h.th.class("text-right").children([txt(locale, "vatColTotal")]),
                        ]),
                      ]),
                      h.tbody.children(
                        Arr.map(displayBuckets, (b) =>
                          h.tr.children([
                            h.td.children([fmtVatRate(locale, b.ratePercent)]),
                            h.td.class("text-right").children([fmtNum(locale, b.base, 2)]),
                            h.td.class("text-right").children([fmtNum(locale, b.vat, 2)]),
                            h.td.class("text-right").children([fmtNum(locale, b.gross, 2)]),
                          ]),
                        ),
                      ),
                    ]),
                ]
              : []),
            h.div
              .class(ui.stack)
              .children([
                h.div
                  .class("flex items-baseline justify-between gap-3 py-1.5 kb-num")
                  .children([
                    h.span.class(ui.muted).children([txt(locale, "netTotal")]),
                    amount(h, fmtMoney(locale, displayTotals.net)),
                  ]),
                ...(regime === "vat_payer"
                  ? [
                      h.div
                        .class("flex items-baseline justify-between gap-3 py-1.5 kb-num")
                        .children([
                          h.span.class(ui.muted).children([txt(locale, "vatTotal")]),
                          amount(h, fmtMoney(locale, displayTotals.vat)),
                        ]),
                    ]
                  : []),
                ...(displayTotals.roundingAdjustment !== null &&
                !BigDecimal.isZero(displayTotals.roundingAdjustment.amount)
                  ? [
                      h.div
                        .class("flex items-baseline justify-between gap-3 py-1.5 kb-num")
                        .children([
                          h.span.class(ui.muted).children([txt(locale, "roundingAdj")]),
                          amount(h, fmtMoney(locale, displayTotals.roundingAdjustment)),
                        ]),
                    ]
                  : []),
                h.div
                  .class(
                    "mt-1 flex items-baseline justify-between gap-3 border-t border-outline-variant pt-2.5 pb-1.5 font-display text-[1.125rem] [font-weight:var(--kb-font-display-weight)] kb-num",
                  )
                  .children([
                    h.span.children([txt(locale, "grandTotal")]),
                    amount(h, fmtMoney(locale, displayTotals.gross)),
                  ]),
                ...(displayTotals.vatCzk !== null
                  ? [
                      h.div
                        .class(
                          cn(
                            "flex items-baseline justify-between gap-3 py-1.5 kb-num",
                            ui.small,
                            ui.muted,
                          ),
                        )
                        .children([
                          h.span.children([txt(locale, "vatCzkTotal")]),
                          amount(h, fmtMoney(locale, displayTotals.vatCzk)),
                        ]),
                    ]
                  : []),
              ]),
          ]),
      ...(serverDoc === null || serverDoc.fx === null
        ? []
        : [
            h.p
              .class(cn(ui.small, ui.muted))
              .children([
                `${txt(locale, "fxRate")} ${serverDoc.fx.quantity} ${serverDoc.totals.gross.currency} = ${fmtNum(locale, serverDoc.fx.rate, 3)} CZK`,
              ]),
          ]),
      ...Arr.map(serverDoc?.statutoryNotes ?? [], (note) =>
        h.p.class(cn(ui.small, ui.muted)).children([note.text]),
      ),
      ...(serverDoc === null || serverDoc.paymentQr === null
        ? []
        : [
            h.img
              .attr("src", svgImage(renderSVG(serverDoc.paymentQr.payload, { border: 4 })))
              .attr("alt", txt(locale, "previewQr"))
              .attr("width", "120")
              .attr("height", "120"),
          ]),
    ]),
  ]);

  return page(h, [
    pageHeader(h, {
      title: title(model, ctx),
      subtitle: txt(locale, "subtitle"),
      actions: headerActions,
    }),
    ...errorBanner,
    ...(mayEdit ? [] : [banner(h, { text: txt(locale, "readOnly"), tone: "info" })]),
    ...(model.revisionState === "review"
      ? [
          banner(h, {
            text:
              model.revisionChanges.length === 0
                ? txt(locale, "reviewRevision")
                : `${txt(locale, "reviewRevision")} ${txt(locale, "changedFields")}: ${Arr.join(model.revisionChanges, ", ")}.`,
            tone: "info",
          }),
        ]
      : []),
    ...(draftStatus === ""
      ? []
      : [h.p.class(cn(ui.small, ui.muted)).attr("role", "status").children([draftStatus])]),
    ...regimeBanner,
    h.div
      .class(
        "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.95fr)]",
      )
      .children([
        h.fieldset
          .style({ border: "0", padding: "0", margin: "0", minInlineSize: "0" })
          .disabled(!mayEdit || writeFreezesForm(model))
          .children([formColumn]),
        previewColumn,
      ]),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);

const wholeNumberText = /^\d+$/;
const editedFieldTag = /^(Changed|Cleared|Selected|Added|Moved|Removed|Updated|Toggled)/;
