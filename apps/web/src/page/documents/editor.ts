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
import { type Command, Submodel } from "foldkit";
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
  decimalToInput,
  fmtDate,
  fmtMoney,
  fmtNum,
  fmtVatRate,
  ifMatch,
  isIsoDateString,
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
  withIdempotencyKey,
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
  submitting: Schema.Boolean,
  submitError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
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
): Command.Command<Message, never, WebServices> =>
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
): Command.Command<Message, never, WebServices> =>
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

const maybeLoadFx = (
  model: Model,
  workspaceId: WorkspaceId | undefined,
): {
  readonly model: Model;
  readonly commands: ReadonlyArray<Command.Command<Message, never, WebServices>>;
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

  return Message.match<PageReturn<Model, Message>>(message, {
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
      return maybeLoadFx(applyTemplateToModel(model, tpl), ws?.id);
    },
    SelectedContact: ({ contactId }) =>
      maybeLoadFx({ ...model, contactId, submitError: null }, ws?.id),
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
    ChangedIssuedOn: ({ value }) => ({ ...maybeLoadFx({ ...model, issuedOn: value }, ws?.id) }),
    ChangedTaxableSupplyOn: ({ value }) =>
      maybeLoadFx({ ...model, taxableSupplyOn: value }, ws?.id),
    ChangedDueDays: ({ value }) => ({
      model: { ...model, dueDaysOverride: value === "" ? null : value },
    }),
    ClearedDueDays: () => ({ model: { ...model, dueDaysOverride: null } }),
    ChangedCurrency: ({ value }) =>
      maybeLoadFx({ ...model, currencyOverride: value === "" ? null : value }, ws?.id),
    ClearedCurrency: () => maybeLoadFx({ ...model, currencyOverride: null }, ws?.id),
    ChangedLanguage: ({ value }) => ({
      model: {
        ...model,
        languageOverride: value === "cs" || value === "en" ? value : null,
      },
    }),
    ClearedLanguage: () => ({ model: { ...model, languageOverride: null } }),
    ChangedPaymentMethod: ({ value }) => ({
      model: {
        ...model,
        paymentMethodOverride:
          value === "bank_transfer" || value === "cash" || value === "card" || value === "other"
            ? value
            : null,
      },
    }),
    ClearedPaymentMethod: () => ({ model: { ...model, paymentMethodOverride: null } }),
    ChangedSeries: ({ value }) => ({
      model: { ...model, seriesOverride: value === "" ? null : value },
    }),
    ClearedSeries: () => ({ model: { ...model, seriesOverride: null } }),
    ChangedBankAccount: ({ value }) => ({ model: { ...model, bankAccountId: value } }),
    ChangedVariableSymbol: ({ value }) => ({ model: { ...model, variableSymbol: value } }),
    ChangedOrderNumber: ({ value }) => ({ model: { ...model, orderNumber: value } }),
    ChangedNote: ({ value }) => ({
      model: { ...model, noteOverride: value === "" ? null : value },
    }),
    ClearedNote: () => ({ model: { ...model, noteOverride: null } }),
    ChangedNumberOverride: ({ value }) => ({ model: { ...model, numberOverride: value } }),
    ToggledRefreshParties: ({ checked }) => ({ model: { ...model, refreshParties: checked } }),
    ToggledPricesIncludeVat: ({ checked }) => ({ model: { ...model, pricesIncludeVat: checked } }),
    ToggledManualFx: ({ checked }) => maybeLoadFx({ ...model, manualFx: checked }, ws?.id),
    ChangedFxRate: ({ value }) => ({ model: { ...model, fxRateInput: value } }),
    ChangedFxQuantity: ({ value }) => ({ model: { ...model, fxQuantityInput: value } }),
    AddedLine: () => ({
      model: {
        ...model,
        lines: [...model.lines, emptyLine(model.nextLineKey, regime)],
        nextLineKey: model.nextLineKey + 1,
      },
    }),
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
      return {
        model: {
          ...model,
          lines: [...model.lines, line],
          nextLineKey: model.nextLineKey + 1,
        },
      };
    },
    UpdatedLineField: ({ key, field, value }) => ({
      model: {
        ...model,
        lines: model.lines.map((l) => (l.key === key ? { ...l, [field]: value } : l)),
      },
    }),
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
      return { model: { ...model, lines: copyLines } };
    },
    RemovedLine: ({ key }) => ({
      model: {
        ...model,
        lines:
          model.lines.length <= 1
            ? [emptyLine(model.nextLineKey, regime)]
            : model.lines.filter((l) => l.key !== key),
        nextLineKey: model.lines.length <= 1 ? model.nextLineKey + 1 : model.nextLineKey,
      },
    }),
    ClickedSaveDraft: () => {
      if (ws === null || model.submitting) return { model };
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      const isExistingDraft = model.editingId !== null && model.editingRevision !== null;
      const editId = model.editingId as DocumentId;
      const editRev = model.editingRevision ?? 1;
      return {
        model: { ...model, submitting: true, submitError: null },
        commands: [
          apiCommand(
            "SaveDraft",
            (c) =>
              isExistingDraft
                ? c.documents.edit({
                    params: { workspaceId: ws.id, documentId: editId },
                    headers: ifMatch(editRev),
                    payload: {
                      contact: built.input.contact,
                      lines: built.input.lines,
                      currency: built.input.currency,
                      issuedOn: built.input.issuedOn,
                      taxableSupplyOn: built.input.taxableSupplyOn,
                      due: built.input.due,
                      language: built.input.language,
                      series: built.input.series,
                      bankAccount: built.input.bankAccount,
                      pricesIncludeVat: built.input.pricesIncludeVat,
                      variableSymbol: built.input.variableSymbol,
                      orderNumber: built.input.orderNumber,
                      note: built.input.note,
                      paymentMethod: built.input.paymentMethod,
                      fx: built.input.fx ?? null,
                    },
                  })
                : withIdempotencyKey((headers) =>
                    c.documents.createDraft({
                      params: { workspaceId: ws.id },
                      headers,
                      payload: built.input,
                    }),
                  ),
            (doc): Message => Message.SavedDocument({ doc, action: "draft" }),
            (failure): Message => Message.FailedSubmit({ failure }),
          ),
        ],
      };
    },
    ClickedIssue: () => {
      if (ws === null || model.submitting) return { model };
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      const isExistingDraft =
        model.editingId !== null &&
        model.editingStatus === "draft" &&
        model.editingRevision !== null;
      const editId = model.editingId as DocumentId;
      const editRev = model.editingRevision ?? 1;
      return {
        model: { ...model, submitting: true, submitError: null },
        commands: [
          apiCommand(
            "IssueDocument",
            (c) =>
              withIdempotencyKey((idemp) =>
                isExistingDraft
                  ? c.documents.issueDraft({
                      params: { workspaceId: ws.id, documentId: editId },
                      headers: { ...idemp, ...ifMatch(editRev) },
                      payload: {},
                    })
                  : c.documents.issueFromInput({
                      params: { workspaceId: ws.id },
                      headers: idemp,
                      payload: { input: built.input },
                    }),
              ),
            (doc): Message => Message.SavedDocument({ doc, action: "issue" }),
            (failure): Message => Message.FailedSubmit({ failure }),
          ),
        ],
      };
    },
    ClickedSaveIssued: () => {
      if (
        ws === null ||
        model.submitting ||
        model.editingId === null ||
        model.editingRevision === null
      ) {
        return { model };
      }
      const built = buildDocumentInput(model, ctx.locale);
      if (!built.ok) return { model: { ...model, submitError: built.error } };
      const patch: DocumentPatch = {
        contact: built.input.contact,
        lines: built.input.lines,
        currency: built.input.currency,
        issuedOn: built.input.issuedOn,
        taxableSupplyOn: built.input.taxableSupplyOn,
        due: built.input.due,
        language: built.input.language,
        bankAccount: built.input.bankAccount,
        pricesIncludeVat: built.input.pricesIncludeVat,
        variableSymbol: built.input.variableSymbol,
        orderNumber: built.input.orderNumber,
        note: built.input.note,
        paymentMethod: built.input.paymentMethod,
        fx: built.input.fx ?? null,
        ...(model.numberOverride.trim() === "" ? {} : { number: model.numberOverride.trim() }),
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
      model: { ...model, submitting: false, submitError: null },
      outMessage: Intent_.navigate(
        href({ _tag: "Document", ws: route.ws, id: doc.id, tab: "preview" }),
      ),
      commands: [
        // Navigate first; toast is shown by detail or caller if desired.
        ...(action === "draft" || action === "issue" || action === "edit" ? [] : []),
      ],
    }),
    FailedSubmit: ({ failure }) => ({
      model: {
        ...model,
        submitting: false,
        submitError: textOf(translator(ctx.locale), failure.text),
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
  });
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

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
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
          h.div(
            [h.Class("kb-stack"), h.AriaBusy(true)],
            [
              skeleton(h, "40%", "1.2rem"),
              skeleton(h, "100%", "2.5rem"),
              skeleton(h, "100%", "6rem"),
            ],
          ),
        ])
      : h.div(
          [h.Class("kb-stack")],
          [
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
                    h.div(
                      [h.Class("kb-ares-box")],
                      [
                        h.div(
                          [h.Class("kb-row")],
                          [
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
                          ],
                        ),
                      ],
                    ),
                  ]
                : []),
            ]),
            // Dates
            card(h, [
              cardTitle(h, txt(locale, "sectionDates")),
              h.div(
                [h.Class("kb-editor-form-grid kb-editor-form-grid--3")],
                [
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
                  h.div(
                    [h.Class("kb-stack")],
                    [
                      h.div(
                        [h.Class("kb-editor-field-head")],
                        [
                          h.label(
                            [h.Class("kb-field__label"), h.For("editor-due-days")],
                            [txt(locale, "dueDays")],
                          ),
                          sourceBadge(h, locale, effective.dueDays.source),
                        ],
                      ),
                      h.input([
                        h.Class("kb-input kb-num"),
                        h.Id("editor-due-days"),
                        h.Type("number"),
                        h.Value(model.dueDaysOverride ?? String(effective.dueDays.value)),
                        h.OnInput((value) => Message.ChangedDueDays({ value })),
                      ]),
                      h.span(
                        [h.Class("kb-field__hint kb-num")],
                        [txt(locale, "dueDateHint", { date: fmtDate(locale, computedDue) })],
                      ),
                    ],
                  ),
                ],
              ),
            ]),
            // Billing details with override source badges
            card(h, [
              cardTitle(h, txt(locale, "sectionBilling")),
              h.div(
                [h.Class("kb-editor-form-grid")],
                [
                  // Currency
                  h.div(
                    [h.Class("kb-field")],
                    [
                      h.div(
                        [h.Class("kb-editor-field-head")],
                        [
                          h.label(
                            [h.Class("kb-field__label"), h.For("editor-currency")],
                            [txt(locale, "currency")],
                          ),
                          h.div(
                            [h.Class("kb-row")],
                            [
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
                            ],
                          ),
                        ],
                      ),
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
                    ],
                  ),
                  // Language
                  h.div(
                    [h.Class("kb-field")],
                    [
                      h.div(
                        [h.Class("kb-editor-field-head")],
                        [
                          h.label(
                            [h.Class("kb-field__label"), h.For("editor-language")],
                            [txt(locale, "language")],
                          ),
                          sourceBadge(h, locale, effective.language.source),
                        ],
                      ),
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
                    ],
                  ),
                  // Payment method
                  h.div(
                    [h.Class("kb-field")],
                    [
                      h.div(
                        [h.Class("kb-editor-field-head")],
                        [
                          h.label(
                            [h.Class("kb-field__label"), h.For("editor-pm")],
                            [txt(locale, "paymentMethod")],
                          ),
                          sourceBadge(h, locale, effective.paymentMethod.source),
                        ],
                      ),
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
                    ],
                  ),
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
                        h.div(
                          [h.Class("kb-field")],
                          [
                            h.div(
                              [h.Class("kb-editor-field-head")],
                              [
                                h.label(
                                  [h.Class("kb-field__label"), h.For("editor-series")],
                                  [txt(locale, "series")],
                                ),
                                sourceBadge(h, locale, effective.series.source),
                              ],
                            ),
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
                          ],
                        ),
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
                ],
              ),
              h.div(
                [h.Class("kb-row")],
                [
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
                ],
              ),
              // FX section for non-CZK
              ...(effective.currency.value !== "CZK"
                ? [
                    h.hr([h.Class("kb-divider")]),
                    h.div(
                      [h.Class("kb-stack")],
                      [
                        h.div(
                          [h.Class("kb-spread")],
                          [
                            h.strong([], [txt(locale, "fxSection")]),
                            checkbox(h, {
                              id: "editor-manual-fx",
                              label: txt(locale, "fxManualToggle"),
                              checked: model.manualFx,
                              onToggle: (checked) => Message.ToggledManualFx({ checked }),
                            }),
                          ],
                        ),
                        ...(model.manualFx
                          ? [
                              h.div(
                                [h.Class("kb-editor-form-grid")],
                                [
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
                                ],
                              ),
                            ]
                          : cnbFx !== undefined
                            ? [
                                h.p(
                                  [h.Class("kb-small kb-muted kb-num")],
                                  [
                                    txt(locale, "fxCnbNote", {
                                      date: fmtDate(locale, cnbFx.fixingDate),
                                      qty: cnbFx.quantity,
                                      cur: cnbFx.currency,
                                      rate: fmtNum(locale, cnbFx.rate, 3),
                                    }),
                                  ],
                                ),
                              ]
                            : []),
                      ],
                    ),
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
                h.keyed("div")(
                  line.key,
                  [h.Class("kb-line-row")],
                  [
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
                    h.div(
                      [h.Class("kb-line-actions")],
                      [
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
                      ],
                    ),
                  ],
                ),
              ),
            ]),
            // Printed note
            card(h, [
              h.div(
                [h.Class("kb-editor-field-head")],
                [
                  h.label(
                    [h.Class("kb-field__label"), h.For("editor-note")],
                    [txt(locale, "noteLabel")],
                  ),
                  sourceBadge(h, locale, effective.note.source),
                ],
              ),
              textArea(h, {
                id: "editor-note",
                label: "",
                value: model.noteOverride ?? effective.note.value,
                onInput: (value) => Message.ChangedNote({ value }),
              }),
            ]),
          ],
        );

  const previewColumn = h.aside(
    [h.Class("kb-editor-preview-sticky")],
    [
      card(h, [
        cardTitle(h, txt(locale, "previewTitle"), [
          badge(
            h,
            textOf(t, I18n.enumText("documentKind", model.kind)),
            model.kind === "proforma" ? "proforma" : "outline",
          ),
        ]),
        h.div(
          [h.Class("kb-spread")],
          [
            mono(h, model.numberOverride || txt(locale, "draftPreviewNumber")),
            h.span([h.Class("kb-small kb-muted kb-num")], [fmtDate(locale, issuedIso)]),
          ],
        ),
        h.hr([h.Class("kb-divider")]),
        h.div(
          [h.Class("kb-stack")],
          [
            h.strong([], [selectedContact?.name ?? txt(locale, "customerPlaceholder")]),
            ...(selectedContact?.ico !== null && selectedContact?.ico !== undefined
              ? [h.span([h.Class("kb-small kb-muted kb-mono")], [`IČO ${selectedContact.ico}`])]
              : []),
            ...(selectedContact?.dic !== null && selectedContact?.dic !== undefined
              ? [h.span([h.Class("kb-small kb-muted kb-mono")], [`DIČ ${selectedContact.dic}`])]
              : []),
          ],
        ),
        h.hr([h.Class("kb-divider")]),
        h.h3([], [txt(locale, "vatSummaryTitle")]),
        ...(preview === null
          ? []
          : [
              ...(regime === "vat_payer" && preview.breakdown.buckets.length > 0
                ? [
                    h.table(
                      [h.Class("kb-vat-table")],
                      [
                        h.thead(
                          [],
                          [
                            h.tr(
                              [],
                              [
                                h.th([], [txt(locale, "vatColRate")]),
                                h.th([h.Class("kb-end")], [txt(locale, "vatColBase")]),
                                h.th([h.Class("kb-end")], [txt(locale, "vatColVat")]),
                                h.th([h.Class("kb-end")], [txt(locale, "vatColTotal")]),
                              ],
                            ),
                          ],
                        ),
                        h.tbody(
                          [],
                          preview.breakdown.buckets.map((b) =>
                            h.tr(
                              [],
                              [
                                h.td([], [fmtVatRate(locale, b.ratePercent)]),
                                h.td([h.Class("kb-end")], [fmtNum(locale, b.base, 2)]),
                                h.td([h.Class("kb-end")], [fmtNum(locale, b.vat, 2)]),
                                h.td([h.Class("kb-end")], [fmtNum(locale, b.gross, 2)]),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ]
                : []),
              h.div(
                [h.Class("kb-stack")],
                [
                  h.div(
                    [h.Class("kb-vat-total-row")],
                    [
                      h.span([h.Class("kb-muted")], [txt(locale, "netTotal")]),
                      amount(h, fmtMoney(locale, preview.breakdown.net)),
                    ],
                  ),
                  ...(regime === "vat_payer"
                    ? [
                        h.div(
                          [h.Class("kb-vat-total-row")],
                          [
                            h.span([h.Class("kb-muted")], [txt(locale, "vatTotal")]),
                            amount(h, fmtMoney(locale, preview.breakdown.vat)),
                          ],
                        ),
                      ]
                    : []),
                  ...(!BigDecimal.isZero(preview.breakdown.roundingAdjustment.amount)
                    ? [
                        h.div(
                          [h.Class("kb-vat-total-row")],
                          [
                            h.span([h.Class("kb-muted")], [txt(locale, "roundingAdj")]),
                            amount(h, fmtMoney(locale, preview.breakdown.roundingAdjustment)),
                          ],
                        ),
                      ]
                    : []),
                  h.div(
                    [h.Class("kb-vat-total-row kb-vat-total-row--grand")],
                    [
                      h.span([], [txt(locale, "grandTotal")]),
                      amount(h, fmtMoney(locale, preview.breakdown.gross)),
                    ],
                  ),
                  ...(preview.breakdown.vatCzk !== null
                    ? [
                        h.div(
                          [h.Class("kb-vat-total-row kb-small kb-muted")],
                          [
                            h.span([], [txt(locale, "vatCzkTotal")]),
                            amount(h, fmtMoney(locale, preview.breakdown.vatCzk)),
                          ],
                        ),
                      ]
                    : []),
                ],
              ),
            ]),
      ]),
    ],
  );

  return page(h, [
    pageHeader(h, {
      title: title(model, ctx),
      subtitle: txt(locale, "subtitle"),
      actions: headerActions,
    }),
    ...errorBanner,
    ...regimeBanner,
    h.div([h.Class("kb-editor-grid")], [formColumn, previewColumn]),
  ]);
});
