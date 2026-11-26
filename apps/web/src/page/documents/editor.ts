import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 10 — Document Editor (Draft & Issued-edit): split-screen editor with VAT/FX preview
 * via @kvitbit/ui-port ViewModels.calculate, Tax Regime variants, ARES quick-add contact,
 * Quick Template start, line items add/remove/reorder, Document->Contact->Workspace->Default
 * override badges, and save draft / issue / save issued edit flows.
 */
import {
  type BankAccountId,
  type ContactId,
  type CurrencyCode,
  type DocumentId,
  type DocumentInput,
  type DocumentPatch,
  DocumentView,
  FxRateView,
  type IsoDate,
  type LineInput,
  type NumberingSeriesId,
  NumberingSeriesView,
  type PriceListItemId,
  type TaxRegime,
  type VatTreatment,
  type WorkspaceId,
} from "@kvitbit/domain";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Effect, Result, Schema } from "effect";
import { Failure } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
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
  linkButton,
  mono,
  page,
  pageHeader,
  select,
  selectField,
  skeleton,
  textArea,
  textField,
} from "../../ui/kit";
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

export type Route = RouteOf<"DocumentNew" | "DocumentEdit">;

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
  | "savedDraftToast"
  | "issuedToast"
  | "savedEditToast"
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
    savedDraftToast: "Koncept uložen.",
    issuedToast: "Doklad byl vystaven.",
    savedEditToast: "Změny dokladu uloženy.",
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
    savedDraftToast: "Draft saved.",
    issuedToast: "Document issued.",
    savedEditToast: "Document changes saved.",
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

export const Model = Schema.Struct({
  route: ViewModels.Route,
  lookups: Remote.remoteSchema(LookupsData),
  fxLookup: Remote.remoteSchema(FxRateView),
  kind: Schema.Literals(["invoice", "proforma"]),
  editingId: Schema.NullOr(Schema.String),
  editingStatus: Schema.NullOr(Schema.Literals(["draft", "issued", "cancelled"])),
  editingRevision: Schema.NullOr(Schema.Int),
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
  autosaveSeq: Remote.Seq,
  autosaveStatus: Schema.Literals(["clean", "dirty", "saving", "saved", "failed"]),
  autosaveError: Schema.NullOr(Schema.String),
  pendingWriteKey: Schema.NullOr(Schema.String),
  pendingWriteIntent: Schema.NullOr(WriteIntent),
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
  AutosaveSucceeded: { seq: Remote.Seq, doc: DocumentView },
  AutosaveFailed: { seq: Remote.Seq, failure: Failure },
  GotRequestKey: { intent: WriteIntent, key: Schema.String },
  DraftPersistedForIssue: { doc: DocumentView, key: Schema.String },
  ClickedSaveDraft: {},
  ClickedIssue: {},
  ClickedSaveIssued: {},
  SavedDocument: { doc: DocumentView, action: Schema.Literals(["draft", "issue", "edit"]) },
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
    "LoadEditorLookups",
    (c) =>
      Effect.all({
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
      }),
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
    "LoadFxRate",
    (c) => c.reports.fxRate({ params: { workspaceId, currency }, query: { on } }),
    (data): Message => Message.LoadedFx({ seq, data }),
    (failure): Message => Message.FailedFx({ seq, failure }),
  );

const applyTemplateToModel = (model: Model, tpl: TemplateViewData): Model => {
  const lines: Array<EditorLine> = tpl.input.lines.map((line, i) => ({
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
  const lines: Array<EditorLine> = rawLines.map((l, idx) => ({
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
    editingId: isEdit ? doc.id : null,
    editingStatus: isEdit ? doc.status : null,
    editingRevision: isEdit ? doc.revision : null,
    contactId: contact?.contactId ?? "",
    issuedOn: isEdit ? doc.dates.issuedOn : model.issuedOn,
    taxableSupplyOn: isEdit
      ? (doc.dates.taxableSupplyOn ?? doc.dates.issuedOn)
      : model.taxableSupplyOn,
    currencyOverride: doc.totals.gross.currency,
    paymentMethodOverride: doc.paymentMethod,
    numberOverride: isEdit ? (doc.number ?? "") : "",
    manualFx: doc.fx?.source === "manual",
    fxRateInput: doc.fx !== null ? decimalToInput(doc.fx.rate) : "",
    fxQuantityInput: doc.fx !== null ? String(doc.fx.quantity) : "1",
    lines: lines.length > 0 ? lines : model.lines,
    nextLineKey: lines.length + 1,
  };
};

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const today = todayPrague();
  const regime: TaxRegime = ctx.workspace?.taxRegime ?? "vat_payer";
  const base: Model = {
    route,
    lookups: Remote.idle,
    fxLookup: Remote.idle,
    kind: route._tag === "DocumentNew" ? route.kind : "invoice",
    editingId: route._tag === "DocumentEdit" ? route.id : null,
    editingStatus: null,
    editingRevision: null,
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
    autosaveSeq: 0,
    autosaveStatus: "clean",
    autosaveError: null,
    pendingWriteKey: null,
    pendingWriteIntent: null,
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

const resolveEffective = (model: Model): ViewModels.EffectiveBilling => {
  const data = Remote.dataOf(model.lookups);
  const contact = data?.contacts.find((c) => c.id === model.contactId);
  const wsDefaults = data?.workspace?.defaults;
  const seriesByKind: Partial<Record<"invoice" | "proforma", NumberingSeriesId>> = {};
  for (const s of data?.series ?? []) {
    if (s.isDefault && (s.kind === "invoice" || s.kind === "proforma")) {
      seriesByKind[s.kind] = s.id;
    }
  }
  const parsedDue =
    model.dueDaysOverride !== null && /^\d+$/.test(model.dueDaysOverride)
      ? Number(model.dueDaysOverride)
      : undefined;

  const docValues: ViewModels.DocumentBillingValues = {
    ...(model.currencyOverride === null
      ? {}
      : { currency: model.currencyOverride as CurrencyCode }),
    ...(model.languageOverride === null ? {} : { language: model.languageOverride }),
    ...(parsedDue === undefined ? {} : { dueDays: parsedDue }),
    ...(model.paymentMethodOverride === null ? {} : { paymentMethod: model.paymentMethodOverride }),
    ...(model.seriesOverride === null ? {} : { series: model.seriesOverride as NumberingSeriesId }),
    ...(model.noteOverride === null ? {} : { note: model.noteOverride }),
  };
  const wsValues: ViewModels.WorkspaceBillingDefaults = {
    ...(wsDefaults?.currency === undefined ? {} : { currency: wsDefaults.currency }),
    ...(wsDefaults?.language === undefined ? {} : { language: wsDefaults.language }),
    ...(wsDefaults?.dueDays === undefined ? {} : { dueDays: wsDefaults.dueDays }),
    ...(wsDefaults?.paymentMethod === undefined ? {} : { paymentMethod: wsDefaults.paymentMethod }),
    seriesByKind,
    ...(wsDefaults?.defaultNote === null || wsDefaults?.defaultNote === undefined
      ? {}
      : { defaultNote: wsDefaults.defaultNote }),
  };

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
    if (line.description.trim() === "") continue;
    const qty = parseDecimalText(line.quantity);
    const price = parseDecimalText(line.unitPrice);
    if (qty === undefined || price === undefined) continue;
    validLines.push({
      ...(line.itemId === null ? {} : { item: line.itemId as PriceListItemId }),
      description: line.description.trim(),
      quantity: qty,
      ...(line.unit.trim() === "" ? {} : { unit: line.unit.trim() }),
      unitPrice: price,
      vat: line.vat,
    });
  }
  if (validLines.length === 0) return { ok: false, error: txt(locale, "needLines") };

  const effective = resolveEffective(model);
  const issuedOn = isIsoDateString(model.issuedOn) ? model.issuedOn : todayPrague();
  const taxableSupplyOn = isIsoDateString(model.taxableSupplyOn) ? model.taxableSupplyOn : issuedOn;

  const fxRate = model.manualFx ? parseDecimalText(model.fxRateInput) : undefined;
  const fxQty = Number.parseInt(model.fxQuantityInput, 10);

  const input: DocumentInput = {
    kind: model.kind,
    contact: model.contactId as ContactId,
    lines: validLines as [LineInput, ...Array<LineInput>],
    currency: effective.currency.value,
    issuedOn,
    taxableSupplyOn,
    due: { inDays: effective.dueDays.value },
    language: effective.language.value,
    ...(effective.series.value === null ? {} : { series: effective.series.value }),
    ...(model.bankAccountId === "" ? {} : { bankAccount: model.bankAccountId as BankAccountId }),
    pricesIncludeVat: model.pricesIncludeVat,
    ...(model.variableSymbol.trim() === "" ? {} : { variableSymbol: model.variableSymbol.trim() }),
    ...(model.orderNumber.trim() === "" ? {} : { orderNumber: model.orderNumber.trim() }),
    ...(effective.note.value === "" ? {} : { note: effective.note.value }),
    paymentMethod: effective.paymentMethod.value,
    ...(model.manualFx && fxRate !== undefined && Number.isInteger(fxQty) && fxQty >= 1
      ? { fx: { manual: { rate: fxRate, quantity: fxQty } } }
      : {}),
  };
  return { ok: true, input };
};

const PREVIEW_DEBOUNCE_MS = 400;
const AUTOSAVE_DEBOUNCE_MS = 3000;

const buildDraftPatch = (input: DocumentInput): DocumentPatch => ({
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
  orderNumber: input.orderNumber,
  note: input.note,
  paymentMethod: input.paymentMethod,
  fx: input.fx ?? null,
});

const scheduleAfterEdit = (
  model: Model,
  workspaceId: WorkspaceId | undefined,
  extraCommands: ReadonlyArray<PageCommand<Message>> = [],
): PageReturn<Model, Message> => {
  const previewSeq = model.previewSeq + 1;
  const shouldAutosave = workspaceId !== undefined && model.editingStatus !== "issued";
  const autosaveSeq = shouldAutosave ? model.autosaveSeq + 1 : model.autosaveSeq;
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
        Message.AutosaveDue({ seq: autosaveSeq }),
      ),
    );
  }
  return {
    model: {
      ...model,
      dirty: true,
      previewSeq,
      autosaveSeq,
      autosaveStatus: shouldAutosave ? "dirty" : model.autosaveStatus,
      autosaveError: null,
      pendingWriteKey: null,
      pendingWriteIntent: null,
    },
    commands,
  };
};

const runSaveDraftWithKey = (
  model: Model,
  workspaceId: WorkspaceId,
  input: DocumentInput,
  key: string,
): PageReturn<Model, Message> => {
  const isExistingDraft = model.editingId !== null && model.editingRevision !== null;
  const editId = model.editingId as DocumentId;
  const editRev = model.editingRevision ?? 1;
  return {
    model: {
      ...model,
      submitting: true,
      submitError: null,
      pendingWriteKey: key,
      pendingWriteIntent: "save_draft",
    },
    commands: [
      apiCommand(
        "SaveDraft",
        (c) =>
          isExistingDraft
            ? c.documents.edit({
                params: { workspaceId, documentId: editId },
                headers: ifMatch(editRev),
                payload: buildDraftPatch(input),
              })
            : c.documents.createDraft({
                params: { workspaceId },
                headers: idempotencyHeaders(key),
                payload: input,
              }),
        (doc): Message => Message.SavedDocument({ doc, action: "draft" }),
        (failure): Message => Message.FailedSubmit({ failure }),
      ),
    ],
  };
};

const runIssueWithKey = (
  model: Model,
  workspaceId: WorkspaceId,
  input: DocumentInput,
  key: string,
): PageReturn<Model, Message> => {
  const isExistingDraft =
    model.editingId !== null && model.editingStatus === "draft" && model.editingRevision !== null;
  const editId = model.editingId as DocumentId;
  const editRev = model.editingRevision ?? 1;
  if (isExistingDraft && model.dirty) {
    // Persist unsaved edits with If-Match first, then issue the resulting revision.
    return {
      model: {
        ...model,
        submitting: true,
        submitError: null,
        pendingWriteKey: key,
        pendingWriteIntent: "issue",
      },
      commands: [
        apiCommand(
          "PersistDraftBeforeIssue",
          (c) =>
            c.documents.edit({
              params: { workspaceId, documentId: editId },
              headers: ifMatch(editRev),
              payload: buildDraftPatch(input),
            }),
          (doc): Message => Message.DraftPersistedForIssue({ doc, key }),
          (failure): Message => Message.FailedSubmit({ failure }),
        ),
      ],
    };
  }
  return {
    model: {
      ...model,
      submitting: true,
      submitError: null,
      pendingWriteKey: key,
      pendingWriteIntent: "issue",
    },
    commands: [
      apiCommand(
        "IssueDocument",
        (c) =>
          isExistingDraft
            ? c.documents.issueDraft({
                params: { workspaceId, documentId: editId },
                headers: { ...idempotencyHeaders(key), ...ifMatch(editRev) },
                payload: {},
              })
            : c.documents.issueFromInput({
                params: { workspaceId },
                headers: idempotencyHeaders(key),
                payload: { input },
              }),
        (doc): Message => Message.SavedDocument({ doc, action: "issue" }),
        (failure): Message => Message.FailedSubmit({ failure }),
      ),
    ],
  };
};

const runAutosaveWithKey = (
  model: Model,
  workspaceId: WorkspaceId,
  input: DocumentInput,
  seq: Remote.Seq,
  key: string,
): PageReturn<Model, Message> => {
  const isExistingDraft = model.editingId !== null && model.editingRevision !== null;
  const editId = model.editingId as DocumentId;
  const editRev = model.editingRevision ?? 1;
  return {
    model: {
      ...model,
      autosaveStatus: "saving",
      autosaveError: null,
      pendingWriteKey: isExistingDraft ? model.pendingWriteKey : key,
      pendingWriteIntent: isExistingDraft ? model.pendingWriteIntent : "autosave",
    },
    commands: [
      apiCommand(
        "AutosaveDraft",
        (c) =>
          isExistingDraft
            ? c.documents.edit({
                params: { workspaceId, documentId: editId },
                headers: ifMatch(editRev),
                payload: buildDraftPatch(input),
              })
            : c.documents.createDraft({
                params: { workspaceId },
                headers: idempotencyHeaders(key),
                payload: input,
              }),
        (doc): Message => Message.AutosaveSucceeded({ seq, doc }),
        (failure): Message => Message.AutosaveFailed({ seq, failure }),
      ),
    ],
  };
};

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

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  const route = model.route as Route;
  const regime: TaxRegime = ws?.taxRegime ?? "vat_payer";

  return Message.match(message, {
    LoadedLookups: ({ seq, data }) => {
      const lookups = Remote.succeed(model.lookups, seq, data);
      let next: Model = { ...model, lookups };
      if (route._tag === "DocumentEdit" && data.existingDoc !== null) {
        next = hydrateFromDocument(next, data.existingDoc, true);
      } else if (
        route._tag === "DocumentNew" &&
        route.from?._tag === "Duplicate" &&
        data.existingDoc !== null
      ) {
        next = hydrateFromDocument(next, data.existingDoc, false);
      } else if (route._tag === "DocumentNew" && route.from?._tag === "Template") {
        const tpl = data.templates.find((t) => t.id === route.from?.id);
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
      const tpl = data?.templates.find((t) => t.id === templateId);
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
      if (ws === null || model.aresBusy) return { model };
      const ico = model.aresIco.trim();
      return {
        model: { ...model, aresBusy: true, aresError: null },
        commands: [
          apiCommand(
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
                  ...data.contacts.filter((existing) => existing.id !== contact.id),
                ],
              },
            };
      return {
        model: {
          ...model,
          lookups: nextLookups,
          contactId: contact.id,
          aresOpen: false,
          aresIco: "",
          aresBusy: false,
          aresError: null,
        },
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
      scheduleAfterEdit({ ...model, numberOverride: value }, ws?.id),
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
      const item = data?.priceList.find((p) => p.id === itemId);
      if (item === undefined) return { model };
      const line: EditorLine = {
        key: `l${model.nextLineKey}`,
        itemId: item.id,
        description: item.description ? `${item.name} — ${item.description}` : item.name,
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
          lines: model.lines.map((l) => (l.key === key ? { ...l, [field]: value } : l)),
        },
        ws?.id,
      ),
    MovedLine: ({ key, direction }) => {
      const idx = model.lines.findIndex((l) => l.key === key);
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
              : model.lines.filter((l) => l.key !== key),
          nextLineKey: model.lines.length <= 1 ? model.nextLineKey + 1 : model.nextLineKey,
        },
        ws?.id,
      ),
    DebouncedPreview: ({ seq }) => {
      if (ws === null || seq !== model.previewSeq) return { model };
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model };
      const serverPreview = Remote.load(model.serverPreview);
      return {
        model: { ...model, serverPreview },
        commands: [
          apiCommand(
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
      if (seq !== model.previewSeq) return { model };
      const local = computePreview(model, regime);
      const calcDrift =
        local !== null && !BigDecimal.equals(local.breakdown.gross.amount, doc.totals.gross.amount);
      return {
        model: {
          ...model,
          serverPreview: { _tag: "Loaded", seq: Remote.seqOf(model.serverPreview), data: doc },
          calcDrift,
        },
      };
    },
    FailedPreview: ({ seq, failure }) => {
      if (seq !== model.previewSeq) return { model };
      return {
        model: {
          ...model,
          serverPreview: { _tag: "Failed", seq: Remote.seqOf(model.serverPreview), failure },
        },
      };
    },
    AutosaveDue: ({ seq }) => {
      if (
        ws === null ||
        seq !== model.autosaveSeq ||
        !model.dirty ||
        model.submitting ||
        model.editingStatus === "issued" ||
        !canRole(ws.role, "document.draft")
      ) {
        return { model };
      }
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model };
      const isExistingDraft = model.editingId !== null && model.editingRevision !== null;
      if (isExistingDraft) {
        return runAutosaveWithKey(model, ws.id, built.input, seq, model.pendingWriteKey ?? "");
      }
      if (model.pendingWriteKey !== null && model.pendingWriteIntent === "autosave") {
        return runAutosaveWithKey(model, ws.id, built.input, seq, model.pendingWriteKey);
      }
      return {
        model: { ...model, autosaveStatus: "saving", autosaveError: null },
        commands: [
          mintRequestKeyCommand("MintAutosaveKey", (key) =>
            Message.GotRequestKey({ intent: "autosave", key }),
          ),
        ],
      };
    },
    AutosaveSucceeded: ({ seq, doc }) => ({
      model: {
        ...model,
        editingId: doc.id,
        editingStatus: doc.status,
        editingRevision: doc.revision,
        dirty: seq === model.autosaveSeq ? false : model.dirty,
        autosaveStatus: seq === model.autosaveSeq ? "saved" : model.autosaveStatus,
        autosaveError: null,
        pendingWriteKey: model.pendingWriteIntent === "autosave" ? null : model.pendingWriteKey,
        pendingWriteIntent:
          model.pendingWriteIntent === "autosave" ? null : model.pendingWriteIntent,
      },
    }),
    AutosaveFailed: ({ seq, failure }) => ({
      model: {
        ...model,
        autosaveStatus: seq === model.autosaveSeq ? "failed" : model.autosaveStatus,
        autosaveError: textOf(translator(ctx.locale), failure.text),
        pendingWriteKey: failure.retryable ? model.pendingWriteKey : null,
        pendingWriteIntent: failure.retryable ? model.pendingWriteIntent : null,
      },
    }),
    GotRequestKey: ({ intent, key }) => {
      if (ws === null) return { model };
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) {
        return { model: { ...model, submitting: false, submitError: built.error } };
      }
      if (intent === "save_draft") return runSaveDraftWithKey(model, ws.id, built.input, key);
      if (intent === "issue") return runIssueWithKey(model, ws.id, built.input, key);
      return runAutosaveWithKey(model, ws.id, built.input, model.autosaveSeq, key);
    },
    DraftPersistedForIssue: ({ doc, key }) => {
      if (ws === null) return { model };
      return {
        model: {
          ...model,
          editingId: doc.id,
          editingStatus: doc.status,
          editingRevision: doc.revision,
          dirty: false,
          submitting: true,
          pendingWriteKey: key,
          pendingWriteIntent: "issue",
        },
        commands: [
          apiCommand(
            "IssuePersistedDraft",
            (c) =>
              c.documents.issueDraft({
                params: { workspaceId: ws.id, documentId: doc.id },
                headers: { ...idempotencyHeaders(key), ...ifMatch(doc.revision) },
                payload: {},
              }),
            (issued): Message => Message.SavedDocument({ doc: issued, action: "issue" }),
            (failure): Message => Message.FailedSubmit({ failure }),
          ),
        ],
      };
    },
    ClickedSaveDraft: () => {
      if (ws === null || model.submitting || !canRole(ws.role, "document.draft")) return { model };
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      const isExistingDraft = model.editingId !== null && model.editingRevision !== null;
      if (isExistingDraft) {
        return runSaveDraftWithKey(model, ws.id, built.input, model.pendingWriteKey ?? "");
      }
      if (model.pendingWriteKey !== null && model.pendingWriteIntent === "save_draft") {
        return runSaveDraftWithKey(model, ws.id, built.input, model.pendingWriteKey);
      }
      return {
        model: { ...model, submitting: true, submitError: null },
        commands: [
          mintRequestKeyCommand("MintDraftKey", (key) =>
            Message.GotRequestKey({ intent: "save_draft", key }),
          ),
        ],
      };
    },
    ClickedIssue: () => {
      if (ws === null || model.submitting || !canRole(ws.role, "document.issue")) return { model };
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      if (model.pendingWriteKey !== null && model.pendingWriteIntent === "issue") {
        return runIssueWithKey(model, ws.id, built.input, model.pendingWriteKey);
      }
      return {
        model: { ...model, submitting: true, submitError: null },
        commands: [
          mintRequestKeyCommand("MintIssueKey", (key) =>
            Message.GotRequestKey({ intent: "issue", key }),
          ),
        ],
      };
    },
    ClickedSaveIssued: () => {
      if (
        ws === null ||
        model.submitting ||
        model.editingId === null ||
        model.editingRevision === null ||
        !canRole(ws.role, "document.edit")
      ) {
        return { model };
      }
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      const allowNumberOverride = canRole(ws.role, "document.overrideNumber");
      const patch: DocumentPatch = {
        ...buildDraftPatch(built.input),
        ...(allowNumberOverride && model.numberOverride.trim() !== ""
          ? { number: model.numberOverride.trim() }
          : {}),
        ...(model.refreshParties ? { refreshParties: true } : {}),
      };
      const editId = model.editingId as DocumentId;
      const editRev = model.editingRevision;
      return {
        model: { ...model, submitting: true, submitError: null },
        commands: [
          apiCommand(
            "SaveIssuedEdit",
            (c) =>
              c.documents.edit({
                params: { workspaceId: ws.id, documentId: editId },
                headers: ifMatch(editRev),
                payload: patch,
              }),
            (doc): Message => Message.SavedDocument({ doc, action: "edit" }),
            (failure): Message => Message.FailedSubmit({ failure }),
          ),
        ],
      };
    },
    SavedDocument: ({ doc, action }) => ({
      model: {
        ...model,
        editingId: doc.id,
        editingStatus: doc.status,
        editingRevision: doc.revision,
        dirty: false,
        pendingWriteKey: null,
        pendingWriteIntent: null,
        submitting: false,
        submitError: null,
      },
      outMessage: Intent_.navigate(
        href({ _tag: "Document", ws: route.ws, id: doc.id, tab: "preview" }),
      ),
      commands: [...(action === "draft" || action === "issue" || action === "edit" ? [] : [])],
    }),
    FailedSubmit: ({ failure }) => ({
      model: {
        ...model,
        submitting: false,
        submitError: textOf(translator(ctx.locale), failure.text),
        pendingWriteKey: failure.retryable ? model.pendingWriteKey : null,
        pendingWriteIntent: failure.retryable ? model.pendingWriteIntent : null,
      },
    }),
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

export const title = (model: Model, ctx: PageContext): string => {
  if (model.editingStatus === "issued") return txt(ctx.locale, "editIssuedTitle");
  if (model.editingId !== null) return txt(ctx.locale, "editDraftTitle");
  return model.kind === "proforma"
    ? txt(ctx.locale, "newProformaTitle")
    : txt(ctx.locale, "newInvoiceTitle");
};

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

  const previewLines: Array<ViewModels.PreviewLine> = model.lines.map((l) => ({
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

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const { locale } = ctx;
  const t = translator(locale);
  const ws = ctx.workspace;
  const route = model.route as Route;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const regime = ws.taxRegime;
  const data = Remote.dataOf(model.lookups);
  const effective = resolveEffective(model);
  const preview = computePreview(model, regime);
  const serverDoc = Remote.dataOf(model.serverPreview);
  const displayTotals =
    serverDoc !== undefined
      ? {
          net: serverDoc.totals.net,
          vat: serverDoc.totals.vat,
          gross: serverDoc.totals.gross,
          vatCzk: serverDoc.totals.vatCzk,
          roundingAdjustment: preview?.breakdown.roundingAdjustment ?? null,
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
  const isIssuedEdit = model.editingStatus === "issued";
  const selectedContact = data?.contacts.find((c) => c.id === model.contactId);
  const cnbFx = Remote.dataOf(model.fxLookup);

  const issuedIso = isIsoDateString(model.issuedOn) ? model.issuedOn : todayPrague();
  const computedDue = addDaysIso(issuedIso, effective.dueDays.value);

  const headerActions = isIssuedEdit
    ? [
        linkButton(h, {
          label: txt(locale, "backToList"),
          href: href({
            _tag: "Document",
            ws: ws.slug,
            id: model.editingId as DocumentId,
            tab: "preview",
          }),
          variant: "ghost",
        }),
        button(h, {
          label: txt(locale, "saveChanges"),
          onClick: Message.ClickedSaveIssued(),
          variant: "primary",
          busy: model.submitting,
        }),
      ]
    : [
        linkButton(h, {
          label: txt(locale, "backToList"),
          href: href({ _tag: "Documents", ws: ws.slug, query: {} }),
          variant: "ghost",
        }),
        button(h, {
          label: txt(locale, "saveDraft"),
          onClick: Message.ClickedSaveDraft(),
          busy: model.submitting,
        }),
        button(h, {
          label: txt(locale, "issue"),
          onClick: Message.ClickedIssue(),
          variant: "primary",
          busy: model.submitting,
        }),
      ];

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
      : model.submitError !== null
        ? [banner(h, { text: model.submitError, tone: "error" })]
        : [];

  const regimeBanner =
    regime === "non_vat_payer"
      ? [banner(h, { text: txt(locale, "regimeNonVat"), tone: "info" })]
      : regime === "identified_person"
        ? [banner(h, { text: txt(locale, "regimeIdentified"), tone: "info" })]
        : [];

  const vatOptions: ReadonlyArray<{ readonly value: VatTreatment; readonly label: string }> =
    regime === "vat_payer"
      ? [
          { value: "standard", label: textOf(t, I18n.enumText("vatTreatment", "standard")) },
          { value: "reduced", label: textOf(t, I18n.enumText("vatTreatment", "reduced")) },
          {
            value: "reverse_charge",
            label: textOf(t, I18n.enumText("vatTreatment", "reverse_charge")),
          },
          {
            value: "exempt_intra_eu_goods",
            label: textOf(t, I18n.enumText("vatTreatment", "exempt_intra_eu_goods")),
          },
          {
            value: "outside_scope",
            label: textOf(t, I18n.enumText("vatTreatment", "outside_scope")),
          },
        ]
      : [
          {
            value: "outside_scope",
            label: textOf(t, I18n.enumText("vatTreatment", "outside_scope")),
          },
          ...(regime === "identified_person"
            ? [
                {
                  value: "reverse_charge" as const,
                  label: textOf(t, I18n.enumText("vatTreatment", "reverse_charge")),
                },
              ]
            : []),
        ];

  const formColumn =
    data === undefined
      ? card(h, [
          h.div
            .class("kb-stack")
            .attr("aria-busy", String(true))
            .children([
              skeleton(h, "40%", "1.2rem"),
              skeleton(h, "100%", "2.5rem"),
              skeleton(h, "100%", "6rem"),
            ]),
        ])
      : h.div.class("kb-stack").children([
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
                        ...data.templates.map((tpl) => ({ value: tpl.id, label: tpl.name })),
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
              onChange: (contactId) => Message.SelectedContact({ contactId }),
              options: [
                { value: "", label: txt(locale, "customerPlaceholder") },
                ...data.contacts.map((c) => ({
                  value: c.id,
                  label: c.ico !== null ? `${c.name} (${c.ico})` : c.name,
                })),
              ],
            }),
            ...(model.aresOpen
              ? [
                  h.div.class("kb-ares-box").children([
                    h.div.class("kb-row").children([
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
            h.div.class("kb-editor-form-grid kb-editor-form-grid--3").children([
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
              h.div.class("kb-stack").children([
                h.div.class("kb-editor-field-head").children([
                  h.label
                    .class("kb-field__label")
                    .attr("for", "editor-due-days")
                    .children([txt(locale, "dueDays")]),
                  sourceBadge(h, locale, effective.dueDays.source),
                ]),
                h.input
                  .class("kb-input kb-num")
                  .id("editor-due-days")
                  .attr("type", "number")
                  .value(model.dueDaysOverride ?? String(effective.dueDays.value))
                  .on("input", ({ value }) => Message.ChangedDueDays({ value })),
                h.span
                  .class("kb-field__hint kb-num")
                  .children([txt(locale, "dueDateHint", { date: fmtDate(locale, computedDue) })]),
              ]),
            ]),
          ]),
          // Billing details with override source badges
          card(h, [
            cardTitle(h, txt(locale, "sectionBilling")),
            h.div.class("kb-editor-form-grid").children([
              // Currency
              h.div.class("kb-field").children([
                h.div.class("kb-editor-field-head").children([
                  h.label
                    .class("kb-field__label")
                    .attr("for", "editor-currency")
                    .children([txt(locale, "currency")]),
                  h.div.class("kb-row").children([
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
              h.div.class("kb-field").children([
                h.div.class("kb-editor-field-head").children([
                  h.label
                    .class("kb-field__label")
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
                    { value: "cs", label: textOf(t, I18n.enumText("locale", "cs")) },
                    { value: "en", label: textOf(t, I18n.enumText("locale", "en")) },
                  ],
                }),
              ]),
              // Payment method
              h.div.class("kb-field").children([
                h.div.class("kb-editor-field-head").children([
                  h.label
                    .class("kb-field__label")
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
                      label: textOf(t, I18n.enumText("paymentMethod", "bank_transfer")),
                    },
                    {
                      value: "cash",
                      label: textOf(t, I18n.enumText("paymentMethod", "cash")),
                    },
                    {
                      value: "card",
                      label: textOf(t, I18n.enumText("paymentMethod", "card")),
                    },
                    {
                      value: "other",
                      label: textOf(t, I18n.enumText("paymentMethod", "other")),
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
                    }),
                  ]
                : [
                    h.div.class("kb-field").children([
                      h.div.class("kb-editor-field-head").children([
                        h.label
                          .class("kb-field__label")
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
                          ...data.series
                            .filter((s) => s.kind === model.kind)
                            .map((s) => ({
                              value: s.id,
                              label: `${s.name} (${s.nextNumber})`,
                            })),
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
                  ...data.bankAccounts.map((b) => ({
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
            h.div.class("kb-row").children([
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
                  h.hr.class("kb-divider"),
                  h.div.class("kb-stack").children([
                    h.div.class("kb-spread").children([
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
                          h.div.class("kb-editor-form-grid").children([
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
                            h.p.class("kb-small kb-muted kb-num").children([
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
                      onChange: (itemId) => Message.AddedPriceListItem({ itemId }),
                      options: [
                        { value: "", label: txt(locale, "addFromPriceList") },
                        ...data.priceList.map((p) => ({
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
            ...model.lines.map((line, index) =>
              h.div
                .key(line.key)
                .class("kb-line-row")
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
                  h.div.class("kb-line-actions").children([
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
            h.div.class("kb-editor-field-head").children([
              h.label
                .class("kb-field__label")
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

  const previewColumn = h.aside
    .class("kb-editor-preview-sticky")
    .children([
      card(h, [
        cardTitle(h, txt(locale, "previewTitle"), [
          badge(
            h,
            textOf(t, I18n.enumText("documentKind", model.kind)),
            model.kind === "proforma" ? "proforma" : "outline",
          ),
        ]),
        h.div
          .class("kb-spread")
          .children([
            mono(h, model.numberOverride || txt(locale, "draftPreviewNumber")),
            h.span.class("kb-small kb-muted kb-num").children([fmtDate(locale, issuedIso)]),
          ]),
        h.hr.class("kb-divider"),
        h.div
          .class("kb-stack")
          .children([
            h.strong.children([selectedContact?.name ?? txt(locale, "customerPlaceholder")]),
            ...(selectedContact?.ico !== null && selectedContact?.ico !== undefined
              ? [h.span.class("kb-small kb-muted kb-mono").children([`IČO ${selectedContact.ico}`])]
              : []),
            ...(selectedContact?.dic !== null && selectedContact?.dic !== undefined
              ? [h.span.class("kb-small kb-muted kb-mono").children([`DIČ ${selectedContact.dic}`])]
              : []),
          ]),
        h.hr.class("kb-divider"),
        h.h3.children([txt(locale, "vatSummaryTitle")]),
        ...(displayTotals === null
          ? []
          : [
              ...(regime === "vat_payer" && preview !== null && preview.breakdown.buckets.length > 0
                ? [
                    h.table
                      .class("kb-vat-table")
                      .children([
                        h.thead.children([
                          h.tr.children([
                            h.th.children([txt(locale, "vatColRate")]),
                            h.th.class("kb-end").children([txt(locale, "vatColBase")]),
                            h.th.class("kb-end").children([txt(locale, "vatColVat")]),
                            h.th.class("kb-end").children([txt(locale, "vatColTotal")]),
                          ]),
                        ]),
                        h.tbody.children(
                          preview.breakdown.buckets.map((b) =>
                            h.tr.children([
                              h.td.children([fmtVatRate(locale, b.ratePercent)]),
                              h.td.class("kb-end").children([fmtNum(locale, b.base, 2)]),
                              h.td.class("kb-end").children([fmtNum(locale, b.vat, 2)]),
                              h.td.class("kb-end").children([fmtNum(locale, b.gross, 2)]),
                            ]),
                          ),
                        ),
                      ]),
                  ]
                : []),
              h.div
                .class("kb-stack")
                .children([
                  h.div
                    .class("kb-vat-total-row")
                    .children([
                      h.span.class("kb-muted").children([txt(locale, "netTotal")]),
                      amount(h, fmtMoney(locale, displayTotals.net)),
                    ]),
                  ...(regime === "vat_payer"
                    ? [
                        h.div
                          .class("kb-vat-total-row")
                          .children([
                            h.span.class("kb-muted").children([txt(locale, "vatTotal")]),
                            amount(h, fmtMoney(locale, displayTotals.vat)),
                          ]),
                      ]
                    : []),
                  ...(displayTotals.roundingAdjustment !== null &&
                  !BigDecimal.isZero(displayTotals.roundingAdjustment.amount)
                    ? [
                        h.div
                          .class("kb-vat-total-row")
                          .children([
                            h.span.class("kb-muted").children([txt(locale, "roundingAdj")]),
                            amount(h, fmtMoney(locale, displayTotals.roundingAdjustment)),
                          ]),
                      ]
                    : []),
                  h.div
                    .class("kb-vat-total-row kb-vat-total-row--grand")
                    .children([
                      h.span.children([txt(locale, "grandTotal")]),
                      amount(h, fmtMoney(locale, displayTotals.gross)),
                    ]),
                  ...(displayTotals.vatCzk !== null
                    ? [
                        h.div
                          .class("kb-vat-total-row kb-small kb-muted")
                          .children([
                            h.span.children([txt(locale, "vatCzkTotal")]),
                            amount(h, fmtMoney(locale, displayTotals.vatCzk)),
                          ]),
                      ]
                    : []),
                ]),
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
    ...regimeBanner,
    h.div.class("kb-editor-grid").children([formColumn, previewColumn]),
  ]);
};
