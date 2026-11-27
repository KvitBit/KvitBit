/**
 * Pure document editor state, contact/price-list defaults, live VAT/FX calculation via
 * `@kvitbit/ui-port/view-models`, validation, and API payload builders.
 */
import type {
  BankAccountId,
  ContactId,
  CurrencyCode,
  DocumentInput,
  DocumentKind,
  DocumentPatch,
  DocumentView,
  FxRateView,
  IsoDate,
  LineInput,
  Locale,
  NumberingSeriesId,
  NumberingSeriesView,
  PaymentMethod,
  PriceListItemId,
  Role,
  TaxRegime,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { parseIsoDate } from "@kvitbit/ui-port/format";
import {
  calculate,
  type FxRate,
  type LivePreview,
  type PreviewLine,
} from "@kvitbit/ui-port/view-models";
import { BigDecimal, Result } from "effect";
import {
  addDaysIso,
  type BankAccountOption,
  type ContactOption,
  decimalToInputString,
  type PriceListOption,
  parseContactSnapshot,
  parseDecimalInput,
  parseIssuerSnapshot,
  parseLineView,
  todayIsoPrague,
  type WorkspaceDefaultsView,
} from "./codecs";
import type { TemplateSeed } from "./template-import";

export type EditableDocumentKind = "invoice" | "proforma";

export interface EditorLineDraft {
  readonly key: string;
  readonly itemId: PriceListItemId | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly treatment: VatTreatment;
}

export interface EditorDraft {
  readonly kind: EditableDocumentKind;
  readonly contactId: ContactId | null;
  readonly currency: CurrencyCode;
  readonly issuedOn: string;
  readonly taxableSupplyOn: string;
  readonly dueOn: string;
  readonly language: Locale | null;
  readonly seriesId: NumberingSeriesId | null;
  readonly bankAccountId: BankAccountId | null;
  readonly paymentMethod: PaymentMethod;
  readonly pricesIncludeVat: boolean | null;
  readonly variableSymbol: string;
  readonly orderNumber: string;
  readonly note: string;
  readonly fxMode: "cnb" | "manual";
  readonly manualFxRate: string;
  readonly manualFxQuantity: string;
  readonly refreshParties: boolean;
  readonly overrideNumber: string;
  readonly lines: ReadonlyArray<EditorLineDraft>;
}

export const COMMON_CURRENCIES: ReadonlyArray<CurrencyCode> = [
  "CZK",
  "EUR",
  "USD",
  "GBP",
  "PLN",
] as CurrencyCode[];

export const PAYMENT_METHODS: ReadonlyArray<PaymentMethod> = [
  "bank_transfer",
  "cash",
  "card",
  "other",
];

export const VAT_TREATMENTS: ReadonlyArray<VatTreatment> = [
  "standard",
  "reduced",
  "exempt_intra_eu_goods",
  "reverse_charge",
  "outside_scope",
];

let lineSeq = 0;
export const nextLineKey = (): string => `line-${++lineSeq}`;

export const defaultTreatmentForRegime = (regime: TaxRegime): VatTreatment =>
  regime === "vat_payer" ? "standard" : "outside_scope";

export const createEmptyLine = (treatment: VatTreatment = "standard"): EditorLineDraft => ({
  key: nextLineKey(),
  itemId: null,
  description: "",
  quantity: "1",
  unit: "",
  unitPrice: "",
  treatment,
});

export const matchingBankAccounts = (
  bankAccounts: ReadonlyArray<BankAccountOption>,
  currency: CurrencyCode,
): ReadonlyArray<BankAccountOption> =>
  bankAccounts.filter((b) => b.currency.toUpperCase() === currency.toUpperCase());

export const defaultBankAccountId = (
  bankAccounts: ReadonlyArray<BankAccountOption>,
  currency: CurrencyCode,
): BankAccountId | null => {
  const matching = matchingBankAccounts(bankAccounts, currency);
  return (matching.find((b) => b.isDefault) ?? matching[0])?.id ?? null;
};

export const matchingSeries = (
  seriesList: ReadonlyArray<NumberingSeriesView>,
  kind: DocumentKind,
): ReadonlyArray<NumberingSeriesView> => seriesList.filter((s) => s.kind === kind);

export const defaultSeriesId = (
  seriesList: ReadonlyArray<NumberingSeriesView>,
  kind: DocumentKind,
  preferred?: NumberingSeriesId,
): NumberingSeriesId | null => {
  const list = matchingSeries(seriesList, kind);
  if (preferred !== undefined && list.some((s) => s.id === preferred)) return preferred;
  return (list.find((s) => s.isDefault) ?? list[0])?.id ?? null;
};

export const draftForNew = (params: {
  readonly kind: EditableDocumentKind;
  readonly workspaceDefaults: WorkspaceDefaultsView;
  readonly contact?: ContactOption | null;
  readonly bankAccounts: ReadonlyArray<BankAccountOption>;
  readonly seriesList: ReadonlyArray<NumberingSeriesView>;
  readonly today?: IsoDate;
}): EditorDraft => {
  const today = params.today ?? todayIsoPrague();
  const ws = params.workspaceDefaults;
  const cd = params.contact?.defaults;
  const currency = cd?.currency ?? ws.currency;
  const dueDays = cd?.dueDays ?? ws.dueDays;
  const preferredSeries =
    cd?.preferredSeriesByKind?.[params.kind] ?? ws.preferredSeriesByKind[params.kind];
  return {
    kind: params.kind,
    contactId: params.contact?.id ?? null,
    currency,
    issuedOn: today,
    taxableSupplyOn: today,
    dueOn: addDaysIso(today, dueDays),
    language: cd?.language ?? ws.language,
    seriesId: defaultSeriesId(params.seriesList, params.kind, preferredSeries),
    bankAccountId: defaultBankAccountId(params.bankAccounts, currency),
    paymentMethod: cd?.paymentMethod ?? ws.paymentMethod,
    pricesIncludeVat: false,
    variableSymbol: "",
    orderNumber: "",
    note: cd?.defaultNote ?? ws.note ?? "",
    fxMode: "cnb",
    manualFxRate: "",
    manualFxQuantity: "1",
    refreshParties: false,
    overrideNumber: "",
    lines: [createEmptyLine(defaultTreatmentForRegime(ws.taxRegime))],
  };
};

export const draftFromDocument = (
  doc: DocumentView,
  params: {
    readonly workspaceDefaults: WorkspaceDefaultsView;
    readonly bankAccounts: ReadonlyArray<BankAccountOption>;
    readonly seriesList: ReadonlyArray<NumberingSeriesView>;
    readonly duplicate?: boolean;
    readonly importedSeed?: TemplateSeed | null;
    readonly today?: IsoDate;
  },
): EditorDraft => {
  const contact = parseContactSnapshot(doc.contact);
  const issuer = parseIssuerSnapshot(doc.issuer);
  const lines = doc.lines.map((raw) => {
    const line = parseLineView(raw);
    return {
      key: nextLineKey(),
      itemId: line.item,
      description: line.description,
      quantity: decimalToInputString(line.quantity),
      unit: line.unit ?? "",
      unitPrice: decimalToInputString(line.unitPrice),
      treatment: line.treatment,
    };
  });
  const kind: EditableDocumentKind = doc.kind === "proforma" ? "proforma" : "invoice";
  const currency = doc.totals.gross.currency;
  const today = params.today ?? todayIsoPrague();
  const isDuplicate = params.duplicate === true;
  // DocumentView omits these persisted terms. Defaults are suitable only for a new copy.
  const stored = params.importedSeed ?? undefined;
  return {
    kind,
    contactId: contact.contactId || null,
    currency,
    issuedOn: isDuplicate ? today : doc.dates.issuedOn,
    taxableSupplyOn: isDuplicate ? today : (doc.dates.taxableSupplyOn ?? doc.dates.issuedOn),
    dueOn: isDuplicate ? addDaysIso(today, params.workspaceDefaults.dueDays) : doc.dates.dueOn,
    language: stored?.language ?? (isDuplicate ? params.workspaceDefaults.language : null),
    seriesId:
      stored?.series ??
      (isDuplicate && stored === undefined
        ? defaultSeriesId(
            params.seriesList,
            kind,
            params.workspaceDefaults.preferredSeriesByKind[kind],
          )
        : null),
    bankAccountId:
      issuer.bankAccount?.id ??
      stored?.bankAccount ??
      (isDuplicate ? defaultBankAccountId(params.bankAccounts, currency) : null),
    paymentMethod: doc.paymentMethod,
    pricesIncludeVat: stored?.pricesIncludeVat ?? (isDuplicate ? false : null),
    variableSymbol: stored?.variableSymbol ?? "",
    orderNumber: stored?.orderNumber ?? "",
    note: stored?.note ?? "",
    fxMode: doc.fx?.source === "manual" ? "manual" : "cnb",
    manualFxRate: doc.fx ? decimalToInputString(doc.fx.rate) : "",
    manualFxQuantity: doc.fx ? String(doc.fx.quantity) : "1",
    refreshParties: false,
    overrideNumber: doc.number ?? "",
    lines:
      lines.length > 0
        ? lines
        : [createEmptyLine(defaultTreatmentForRegime(params.workspaceDefaults.taxRegime))],
  };
};

export const applyContactDefaults = (
  draft: EditorDraft,
  contact: ContactOption,
  workspaceDefaults: WorkspaceDefaultsView,
  bankAccounts: ReadonlyArray<BankAccountOption>,
  seriesList: ReadonlyArray<NumberingSeriesView>,
): EditorDraft => {
  const cd = contact.defaults;
  const currency = cd.currency ?? workspaceDefaults.currency;
  const dueDays = cd.dueDays ?? workspaceDefaults.dueDays;
  const preferredSeries =
    cd.preferredSeriesByKind?.[draft.kind] ?? workspaceDefaults.preferredSeriesByKind[draft.kind];
  return {
    ...draft,
    contactId: contact.id,
    currency,
    language: cd.language ?? draft.language,
    paymentMethod: cd.paymentMethod ?? draft.paymentMethod,
    dueOn:
      parseIsoDate(draft.issuedOn) !== undefined
        ? addDaysIso(draft.issuedOn, dueDays)
        : draft.dueOn,
    bankAccountId: defaultBankAccountId(bankAccounts, currency),
    seriesId: defaultSeriesId(seriesList, draft.kind, preferredSeries) ?? draft.seriesId,
    note: draft.note === "" && cd.defaultNote !== undefined ? cd.defaultNote : draft.note,
  };
};

export const applyPriceListItem = (
  draft: EditorDraft,
  lineKey: string,
  item: PriceListOption,
  taxRegime: TaxRegime,
): { readonly draft: EditorDraft; readonly currencyMismatch: CurrencyCode | null } => {
  const mismatch =
    item.currency.toUpperCase() !== draft.currency.toUpperCase() ? item.currency : null;
  const treatment = item.vat !== null ? item.vat : defaultTreatmentForRegime(taxRegime);
  const nextLines = draft.lines.map((line) =>
    line.key !== lineKey
      ? line
      : {
          ...line,
          itemId: item.id,
          description: item.description ? `${item.name} — ${item.description}` : item.name,
          unit: item.unit ?? "",
          unitPrice: decimalToInputString(item.unitPrice),
          treatment,
        },
  );
  return {
    draft: { ...draft, lines: nextLines },
    currencyMismatch: mismatch,
  };
};

// --- Live preview via @kvitbit/ui-port/view-models ----------------------------------------------

export const resolvePreviewFx = (draft: EditorDraft, cnbFx: FxRateView | null): FxRate | null => {
  if (draft.currency.toUpperCase() === "CZK") return null;
  if (draft.fxMode === "manual") {
    const rate = parseDecimalInput(draft.manualFxRate);
    const qty = Number.parseInt(draft.manualFxQuantity.trim(), 10);
    if (rate === null || !Number.isInteger(qty) || qty <= 0) return null;
    return { rate, quantity: qty };
  }
  if (cnbFx === null) return null;
  return { rate: cnbFx.rate, quantity: cnbFx.quantity };
};

export const computeLivePreview = (
  draft: EditorDraft,
  taxRegime: TaxRegime,
  paymentRounding: "none" | "whole_unit",
  cnbFx: FxRateView | null,
): LivePreview | null => {
  if (taxRegime === "vat_payer" && draft.pricesIncludeVat === null) return null;
  const taxPointRaw =
    parseIsoDate(draft.taxableSupplyOn) !== undefined
      ? draft.taxableSupplyOn
      : parseIsoDate(draft.issuedOn) !== undefined
        ? draft.issuedOn
        : todayIsoPrague();
  const previewLines: PreviewLine[] = draft.lines.map((line) => ({
    quantity: parseDecimalInput(line.quantity) ?? BigDecimal.fromBigInt(0n),
    unitPrice: parseDecimalInput(line.unitPrice) ?? BigDecimal.fromBigInt(0n),
    treatment: line.treatment,
  }));
  const result = calculate({
    lines: previewLines,
    currency: draft.currency,
    taxPoint: taxPointRaw as IsoDate,
    pricesIncludeVat: draft.pricesIncludeVat ?? false,
    fx: resolvePreviewFx(draft, cnbFx),
    paymentRounding,
    direction: "outgoing",
    taxRegime,
    kind: draft.kind,
  });
  return Result.isSuccess(result) ? result.success : null;
};

// --- Validation & payload builders --------------------------------------------------------------

export interface EditorValidation {
  readonly contact?: string;
  readonly issuedOn?: string;
  readonly taxableSupplyOn?: string;
  readonly dueOn?: string;
  readonly fx?: string;
  readonly lines: Readonly<Record<string, string>>;
  readonly hasErrors: boolean;
}

export const validateEditorDraft = (
  draft: EditorDraft,
  messages: {
    readonly contactRequired: string;
    readonly invalidDate: string;
    readonly dueBeforeIssue: string;
    readonly invalidLine: string;
    readonly invalidFx: string;
  },
): EditorValidation => {
  let contact: string | undefined;
  let issuedOn: string | undefined;
  let taxableSupplyOn: string | undefined;
  let dueOn: string | undefined;
  let fx: string | undefined;
  const lines: Record<string, string> = {};

  if (draft.contactId === null) contact = messages.contactRequired;
  if (parseIsoDate(draft.issuedOn) === undefined) issuedOn = messages.invalidDate;
  if (draft.taxableSupplyOn.trim() !== "" && parseIsoDate(draft.taxableSupplyOn) === undefined) {
    taxableSupplyOn = messages.invalidDate;
  }
  if (parseIsoDate(draft.dueOn) === undefined) {
    dueOn = messages.invalidDate;
  } else if (issuedOn === undefined && draft.dueOn < draft.issuedOn) {
    dueOn = messages.dueBeforeIssue;
  }
  if (draft.currency.toUpperCase() !== "CZK" && draft.fxMode === "manual") {
    const rate = parseDecimalInput(draft.manualFxRate);
    const qty = Number.parseInt(draft.manualFxQuantity.trim(), 10);
    if (
      rate === null ||
      BigDecimal.isLessThanOrEqualTo(rate, BigDecimal.fromBigInt(0n)) ||
      !Number.isInteger(qty) ||
      qty <= 0
    ) {
      fx = messages.invalidFx;
    }
  }
  for (const line of draft.lines) {
    const qty = parseDecimalInput(line.quantity);
    const price = parseDecimalInput(line.unitPrice);
    if (
      line.description.trim() === "" ||
      qty === null ||
      BigDecimal.isLessThanOrEqualTo(qty, BigDecimal.fromBigInt(0n)) ||
      price === null
    ) {
      lines[line.key] = messages.invalidLine;
    }
  }

  const hasErrors =
    contact !== undefined ||
    issuedOn !== undefined ||
    taxableSupplyOn !== undefined ||
    dueOn !== undefined ||
    fx !== undefined ||
    draft.lines.length === 0 ||
    Object.keys(lines).length > 0;

  return {
    ...(contact !== undefined ? { contact } : {}),
    ...(issuedOn !== undefined ? { issuedOn } : {}),
    ...(taxableSupplyOn !== undefined ? { taxableSupplyOn } : {}),
    ...(dueOn !== undefined ? { dueOn } : {}),
    ...(fx !== undefined ? { fx } : {}),
    lines,
    hasErrors,
  };
};

const toLineInputs = (lines: ReadonlyArray<EditorLineDraft>): [LineInput, ...LineInput[]] => {
  const mapped = lines.map((line): LineInput => {
    const qty = parseDecimalInput(line.quantity) ?? BigDecimal.fromBigInt(1n);
    const price = parseDecimalInput(line.unitPrice) ?? BigDecimal.fromBigInt(0n);
    return {
      ...(line.itemId !== null ? { item: line.itemId } : {}),
      description: line.description.trim(),
      quantity: qty,
      ...(line.unit.trim() !== "" ? { unit: line.unit.trim() } : {}),
      unitPrice: price,
      vat: line.treatment,
    };
  });
  return mapped as [LineInput, ...LineInput[]];
};

const buildFxOverride = (draft: EditorDraft) => {
  if (draft.currency.toUpperCase() === "CZK") return undefined;
  if (draft.fxMode !== "manual") return undefined;
  const rate = parseDecimalInput(draft.manualFxRate);
  const quantity = Number.parseInt(draft.manualFxQuantity.trim(), 10);
  if (rate === null || !Number.isInteger(quantity) || quantity <= 0) return undefined;
  return { manual: { rate, quantity } } as const;
};

export const buildDocumentInput = (draft: EditorDraft): DocumentInput => {
  if (draft.contactId === null) {
    throw new Error("buildDocumentInput requires a selected contact");
  }
  const fx = buildFxOverride(draft);
  return {
    kind: draft.kind,
    contact: draft.contactId,
    lines: toLineInputs(draft.lines),
    currency: draft.currency,
    issuedOn: draft.issuedOn as IsoDate,
    ...(draft.taxableSupplyOn.trim() !== ""
      ? { taxableSupplyOn: draft.taxableSupplyOn as IsoDate }
      : {}),
    due: { on: draft.dueOn as IsoDate },
    ...(draft.language === null ? {} : { language: draft.language }),
    ...(draft.seriesId !== null ? { series: draft.seriesId } : {}),
    ...(draft.bankAccountId !== null ? { bankAccount: draft.bankAccountId } : {}),
    ...(draft.pricesIncludeVat === null ? {} : { pricesIncludeVat: draft.pricesIncludeVat }),
    ...(draft.variableSymbol.trim() !== "" ? { variableSymbol: draft.variableSymbol.trim() } : {}),
    ...(draft.orderNumber.trim() !== "" ? { orderNumber: draft.orderNumber.trim() } : {}),
    ...(draft.note.trim() !== "" ? { note: draft.note.trim() } : {}),
    paymentMethod: draft.paymentMethod,
    ...(fx !== undefined ? { fx } : {}),
  };
};

export const buildDocumentPatch = (
  draft: EditorDraft,
  baseline: EditorDraft,
  original: DocumentView,
  role: Role,
): DocumentPatch => {
  const isDraft = original.status === "draft";
  const canAdmin = role === "owner" || role === "admin";
  const fx = buildFxOverride(draft);
  const trimmedNumber = draft.overrideNumber.trim();
  const numberChanged =
    !isDraft && canAdmin && trimmedNumber !== "" && trimmedNumber !== (original.number ?? "");
  const changed = (field: keyof EditorDraft) => draft[field] !== baseline[field];
  const fxChanged =
    changed("currency") ||
    changed("fxMode") ||
    (draft.fxMode === "manual" && (changed("manualFxRate") || changed("manualFxQuantity")));
  return {
    ...(changed("contactId") && draft.contactId !== null ? { contact: draft.contactId } : {}),
    ...(changed("lines") ? { lines: toLineInputs(draft.lines) } : {}),
    ...(changed("currency") ? { currency: draft.currency } : {}),
    ...(changed("issuedOn") ? { issuedOn: draft.issuedOn as IsoDate } : {}),
    ...(changed("taxableSupplyOn") && draft.taxableSupplyOn.trim() !== ""
      ? { taxableSupplyOn: draft.taxableSupplyOn as IsoDate }
      : {}),
    ...(changed("dueOn") ? { due: { on: draft.dueOn as IsoDate } } : {}),
    ...(changed("language") && draft.language !== null ? { language: draft.language } : {}),
    ...(isDraft && changed("seriesId") && draft.seriesId !== null
      ? { series: draft.seriesId }
      : {}),
    ...(changed("bankAccountId") && draft.bankAccountId !== null
      ? { bankAccount: draft.bankAccountId }
      : {}),
    ...(changed("pricesIncludeVat") && draft.pricesIncludeVat !== null
      ? { pricesIncludeVat: draft.pricesIncludeVat }
      : {}),
    ...(changed("variableSymbol") && draft.variableSymbol.trim() !== ""
      ? { variableSymbol: draft.variableSymbol.trim() }
      : {}),
    ...(changed("orderNumber") && draft.orderNumber.trim() !== ""
      ? { orderNumber: draft.orderNumber.trim() }
      : {}),
    ...(changed("note") && draft.note.trim() !== "" ? { note: draft.note.trim() } : {}),
    ...(changed("paymentMethod") ? { paymentMethod: draft.paymentMethod } : {}),
    ...(fxChanged && draft.currency.toUpperCase() !== "CZK"
      ? { fx: draft.fxMode === "manual" ? (fx ?? null) : null }
      : {}),
    ...(numberChanged ? { number: trimmedNumber } : {}),
    ...(changed("refreshParties") && draft.refreshParties ? { refreshParties: true } : {}),
  };
};
