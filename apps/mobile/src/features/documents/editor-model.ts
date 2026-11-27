import * as Fn from "effect/Function";
/**
 * Pure document editor state, contact/price-list defaults, live VAT/FX calculation via
 * `@kvitbit/ui-port/view-models`, validation, and API payload builders.
 */

import {
  type BankAccountId,
  type ContactId,
  CurrencyCode,
  type DocumentInput,
  type DocumentKind,
  type DocumentPatch,
  type DocumentView,
  type FxRateView,
  IsoDate,
  type LineInput,
  type Locale,
  type NumberingSeriesId,
  type NumberingSeriesView,
  type PaymentMethod,
  type PriceListItemId,
  type Role,
  type TaxRegime,
  type VatTreatment,
} from "@kvitbit/domain/contract";
import { parseIsoDate } from "@kvitbit/ui-port/format";
import {
  calculate,
  type FxRate,
  type LivePreview,
  type PreviewLine,
} from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type * as Types from "effect/Types";
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

export const COMMON_CURRENCIES = Arr.map(["CZK", "EUR", "USD", "GBP", "PLN"], (currency) =>
  CurrencyCode.make(currency),
);

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
const nextLineKey = (): string => `line-${++lineSeq}`;

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

export const matchingBankAccounts: {
  (
    bankAccounts: ReadonlyArray<BankAccountOption>,
    currency: CurrencyCode,
  ): ReadonlyArray<BankAccountOption>;
  (
    currency: CurrencyCode,
  ): (bankAccounts: ReadonlyArray<BankAccountOption>) => ReadonlyArray<BankAccountOption>;
} = Fn.dual(
  2,
  (
    bankAccounts: ReadonlyArray<BankAccountOption>,
    currency: CurrencyCode,
  ): ReadonlyArray<BankAccountOption> =>
    Arr.filter(bankAccounts, (b) => Str.toUpperCase(b.currency) === Str.toUpperCase(currency)),
);

export const defaultBankAccountId: {
  (bankAccounts: ReadonlyArray<BankAccountOption>, currency: CurrencyCode): BankAccountId | null;
  (
    currency: CurrencyCode,
  ): (bankAccounts: ReadonlyArray<BankAccountOption>) => BankAccountId | null;
} = Fn.dual(
  2,
  (
    bankAccounts: ReadonlyArray<BankAccountOption>,
    currency: CurrencyCode,
  ): BankAccountId | null => {
    const matching = matchingBankAccounts(bankAccounts, currency);
    return (
      (Option.getOrUndefined(Arr.findFirst(matching, (b) => b.isDefault)) ?? matching[0])?.id ??
      null
    );
  },
);

export const matchingSeries: {
  (
    seriesList: ReadonlyArray<NumberingSeriesView>,
    kind: DocumentKind,
  ): ReadonlyArray<NumberingSeriesView>;
  (
    kind: DocumentKind,
  ): (seriesList: ReadonlyArray<NumberingSeriesView>) => ReadonlyArray<NumberingSeriesView>;
} = Fn.dual(
  2,
  (
    seriesList: ReadonlyArray<NumberingSeriesView>,
    kind: DocumentKind,
  ): ReadonlyArray<NumberingSeriesView> => Arr.filter(seriesList, (s) => s.kind === kind),
);

const defaultSeriesId = (
  seriesList: ReadonlyArray<NumberingSeriesView>,
  kind: DocumentKind,
  preferred?: NumberingSeriesId,
): NumberingSeriesId | null => {
  const list = matchingSeries(seriesList, kind);
  if (preferred !== undefined && Arr.some(list, (s) => s.id === preferred)) return preferred;
  return (Option.getOrUndefined(Arr.findFirst(list, (s) => s.isDefault)) ?? list[0])?.id ?? null;
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

export const draftFromDocument: {
  (
    doc: DocumentView,
    params: {
      readonly workspaceDefaults: WorkspaceDefaultsView;
      readonly bankAccounts: ReadonlyArray<BankAccountOption>;
      readonly seriesList: ReadonlyArray<NumberingSeriesView>;
      readonly duplicate?: boolean;
      readonly importedSeed?: TemplateSeed | null;
      readonly today?: IsoDate;
    },
  ): EditorDraft;
  (params: {
    readonly workspaceDefaults: WorkspaceDefaultsView;
    readonly bankAccounts: ReadonlyArray<BankAccountOption>;
    readonly seriesList: ReadonlyArray<NumberingSeriesView>;
    readonly duplicate?: boolean;
    readonly importedSeed?: TemplateSeed | null;
    readonly today?: IsoDate;
  }): (doc: DocumentView) => EditorDraft;
} = Fn.dual(
  2,
  (
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
    const lines = Arr.map(doc.lines, (raw) => {
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
      contactId: contact.contactId,
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
      manualFxRate: doc.fx !== null ? decimalToInputString(doc.fx.rate) : "",
      manualFxQuantity: doc.fx !== null ? String(doc.fx.quantity) : "1",
      refreshParties: false,
      overrideNumber: doc.number ?? "",
      lines:
        lines.length > 0
          ? lines
          : [createEmptyLine(defaultTreatmentForRegime(params.workspaceDefaults.taxRegime))],
    };
  },
);

export const applyContactDefaults: {
  (
    draft: EditorDraft,
    contact: ContactOption,
    workspaceDefaults: WorkspaceDefaultsView,
    bankAccounts: ReadonlyArray<BankAccountOption>,
    seriesList: ReadonlyArray<NumberingSeriesView>,
  ): EditorDraft;
  (
    contact: ContactOption,
    workspaceDefaults: WorkspaceDefaultsView,
    bankAccounts: ReadonlyArray<BankAccountOption>,
    seriesList: ReadonlyArray<NumberingSeriesView>,
  ): (draft: EditorDraft) => EditorDraft;
} = Fn.dual(
  5,
  (
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
  },
);

export const applyPriceListItem: {
  (
    draft: EditorDraft,
    lineKey: string,
    item: PriceListOption,
    taxRegime: TaxRegime,
  ): { readonly draft: EditorDraft; readonly currencyMismatch: CurrencyCode | null };
  (
    lineKey: string,
    item: PriceListOption,
    taxRegime: TaxRegime,
  ): (draft: EditorDraft) => {
    readonly draft: EditorDraft;
    readonly currencyMismatch: CurrencyCode | null;
  };
} = Fn.dual(
  4,
  (
    draft: EditorDraft,
    lineKey: string,
    item: PriceListOption,
    taxRegime: TaxRegime,
  ): { readonly draft: EditorDraft; readonly currencyMismatch: CurrencyCode | null } => {
    const mismatch =
      Str.toUpperCase(item.currency) !== Str.toUpperCase(draft.currency) ? item.currency : null;
    const treatment = item.vat !== null ? item.vat : defaultTreatmentForRegime(taxRegime);
    const nextLines = Arr.map(draft.lines, (line) =>
      line.key !== lineKey
        ? line
        : {
            ...line,
            itemId: item.id,
            description:
              (item.description ?? "") !== "" ? `${item.name} — ${item.description}` : item.name,
            unit: item.unit ?? "",
            unitPrice: decimalToInputString(item.unitPrice),
            treatment,
          },
    );
    return {
      draft: { ...draft, lines: nextLines },
      currencyMismatch: mismatch,
    };
  },
);

// --- Live preview via @kvitbit/ui-port/view-models ----------------------------------------------

const resolvePreviewFx = (draft: EditorDraft, cnbFx: FxRateView | null): FxRate | null => {
  if (Str.toUpperCase(draft.currency) === "CZK") return null;
  if (draft.fxMode === "manual") {
    const rate = parseDecimalInput(draft.manualFxRate);
    const qty = Number.parseInt(Str.trim(draft.manualFxQuantity), 10);
    if (rate === null || !Number.isInteger(qty) || qty <= 0) return null;
    return { rate, quantity: qty };
  }
  if (cnbFx === null) return null;
  return { rate: cnbFx.rate, quantity: cnbFx.quantity };
};

export const computeLivePreview: {
  (
    draft: EditorDraft,
    taxRegime: TaxRegime,
    paymentRounding: "none" | "whole_unit",
    cnbFx: FxRateView | null,
  ): LivePreview | null;
  (
    taxRegime: TaxRegime,
    paymentRounding: "none" | "whole_unit",
    cnbFx: FxRateView | null,
  ): (draft: EditorDraft) => LivePreview | null;
} = Fn.dual(
  4,
  (
    draft: EditorDraft,
    taxRegime: TaxRegime,
    paymentRounding: "none" | "whole_unit",
    cnbFx: FxRateView | null,
  ): LivePreview | null => {
    if (taxRegime === "vat_payer" && draft.pricesIncludeVat === null) return null;
    const readDate = Schema.decodeUnknownOption(IsoDate);
    const taxPoint =
      Option.getOrUndefined(readDate(draft.taxableSupplyOn)) ??
      Option.getOrUndefined(readDate(draft.issuedOn)) ??
      todayIsoPrague();
    const previewLines: PreviewLine[] = Arr.map(draft.lines, (line) => ({
      quantity: parseDecimalInput(line.quantity) ?? BigDecimal.fromBigInt(0n),
      unitPrice: parseDecimalInput(line.unitPrice) ?? BigDecimal.fromBigInt(0n),
      treatment: line.treatment,
    }));
    const result = calculate({
      lines: previewLines,
      currency: draft.currency,
      taxPoint,
      pricesIncludeVat: draft.pricesIncludeVat ?? false,
      fx: resolvePreviewFx(draft, cnbFx),
      paymentRounding,
      direction: "outgoing",
      taxRegime,
      kind: draft.kind,
    });
    return Result.isSuccess(result) ? result.success : null;
  },
);

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

export const validateEditorDraft: {
  (
    draft: EditorDraft,
    messages: {
      readonly contactRequired: string;
      readonly invalidDate: string;
      readonly dueBeforeIssue: string;
      readonly invalidLine: string;
      readonly invalidFx: string;
    },
  ): EditorValidation;
  (messages: {
    readonly contactRequired: string;
    readonly invalidDate: string;
    readonly dueBeforeIssue: string;
    readonly invalidLine: string;
    readonly invalidFx: string;
  }): (draft: EditorDraft) => EditorValidation;
} = Fn.dual(
  2,
  (
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
    if (
      Str.trim(draft.taxableSupplyOn) !== "" &&
      parseIsoDate(draft.taxableSupplyOn) === undefined
    ) {
      taxableSupplyOn = messages.invalidDate;
    }
    if (parseIsoDate(draft.dueOn) === undefined) {
      dueOn = messages.invalidDate;
    } else if (issuedOn === undefined && draft.dueOn < draft.issuedOn) {
      dueOn = messages.dueBeforeIssue;
    }
    if (Str.toUpperCase(draft.currency) !== "CZK" && draft.fxMode === "manual") {
      const rate = parseDecimalInput(draft.manualFxRate);
      const qty = Number.parseInt(Str.trim(draft.manualFxQuantity), 10);
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
        Str.trim(line.description) === "" ||
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
      EffectRecord.keys(lines).length > 0;

    const validation: Types.Mutable<EditorValidation> = { lines, hasErrors };
    if (contact !== undefined) validation.contact = contact;
    if (issuedOn !== undefined) validation.issuedOn = issuedOn;
    if (taxableSupplyOn !== undefined) validation.taxableSupplyOn = taxableSupplyOn;
    if (dueOn !== undefined) validation.dueOn = dueOn;
    if (fx !== undefined) validation.fx = fx;
    return validation;
  },
);

const toLineInputs = (lines: ReadonlyArray<EditorLineDraft>): [LineInput, ...LineInput[]] => {
  const mapped = Arr.map(lines, (line): LineInput => {
    const qty = parseDecimalInput(line.quantity) ?? BigDecimal.fromBigInt(1n);
    const price = parseDecimalInput(line.unitPrice) ?? BigDecimal.fromBigInt(0n);
    const input: Types.Mutable<LineInput> = {
      description: Str.trim(line.description),
      quantity: qty,
      unitPrice: price,
      vat: line.treatment,
    };
    if (line.itemId !== null) input.item = line.itemId;
    const unit = Str.trim(line.unit);
    if (unit !== "") input.unit = unit;
    return input;
  });
  return [Option.getOrThrow(Arr.head(mapped)), ...Arr.drop(mapped, 1)];
};

const buildFxOverride = (draft: EditorDraft) => {
  if (Str.toUpperCase(draft.currency) === "CZK") return;
  if (draft.fxMode !== "manual") return;
  const rate = parseDecimalInput(draft.manualFxRate);
  const quantity = Number.parseInt(Str.trim(draft.manualFxQuantity), 10);
  if (rate === null || !Number.isInteger(quantity) || quantity <= 0) return;
  return { manual: { rate, quantity } } as const;
};

export const buildDocumentInput = (draft: EditorDraft): DocumentInput => {
  const fx = buildFxOverride(draft);
  const input: Types.Mutable<DocumentInput> = {
    kind: draft.kind,
    contact: Option.getOrThrow(Option.fromNullOr(draft.contactId)),
    lines: toLineInputs(draft.lines),
    currency: draft.currency,
    issuedOn: IsoDate.make(draft.issuedOn),
    due: { on: IsoDate.make(draft.dueOn) },
    paymentMethod: draft.paymentMethod,
  };
  if (Str.trim(draft.taxableSupplyOn) !== "")
    input.taxableSupplyOn = IsoDate.make(draft.taxableSupplyOn);
  if (draft.language !== null) input.language = draft.language;
  if (draft.seriesId !== null) input.series = draft.seriesId;
  if (draft.bankAccountId !== null) input.bankAccount = draft.bankAccountId;
  if (draft.pricesIncludeVat !== null) input.pricesIncludeVat = draft.pricesIncludeVat;
  const variableSymbol = Str.trim(draft.variableSymbol);
  const orderNumber = Str.trim(draft.orderNumber);
  const note = Str.trim(draft.note);
  if (variableSymbol !== "") input.variableSymbol = variableSymbol;
  if (orderNumber !== "") input.orderNumber = orderNumber;
  if (note !== "") input.note = note;
  if (fx !== undefined) input.fx = fx;
  return input;
};

export const buildDocumentPatch: {
  (draft: EditorDraft, baseline: EditorDraft, original: DocumentView, role: Role): DocumentPatch;
  (
    baseline: EditorDraft,
    original: DocumentView,
    role: Role,
  ): (draft: EditorDraft) => DocumentPatch;
} = Fn.dual(
  4,
  (
    draft: EditorDraft,
    baseline: EditorDraft,
    original: DocumentView,
    role: Role,
  ): DocumentPatch => {
    const isDraft = original.status === "draft";
    const canAdmin = role === "owner" || role === "admin";
    const fx = buildFxOverride(draft);
    const trimmedNumber = Str.trim(draft.overrideNumber);
    const numberChanged =
      !isDraft && canAdmin && trimmedNumber !== "" && trimmedNumber !== (original.number ?? "");
    const changed = (field: keyof EditorDraft) => draft[field] !== baseline[field];
    const fxChanged =
      changed("currency") ||
      changed("fxMode") ||
      (draft.fxMode === "manual" && (changed("manualFxRate") || changed("manualFxQuantity")));
    const patch: Types.Mutable<DocumentPatch> = {};
    if (changed("contactId") && draft.contactId !== null) patch.contact = draft.contactId;
    if (changed("lines")) patch.lines = toLineInputs(draft.lines);
    if (changed("currency")) patch.currency = draft.currency;
    if (changed("issuedOn")) patch.issuedOn = IsoDate.make(draft.issuedOn);
    if (changed("taxableSupplyOn") && Str.trim(draft.taxableSupplyOn) !== "") {
      patch.taxableSupplyOn = IsoDate.make(draft.taxableSupplyOn);
    }
    if (changed("dueOn")) patch.due = { on: IsoDate.make(draft.dueOn) };
    if (changed("language") && draft.language !== null) patch.language = draft.language;
    if (isDraft && changed("seriesId") && draft.seriesId !== null) patch.series = draft.seriesId;
    if (changed("bankAccountId") && draft.bankAccountId !== null)
      patch.bankAccount = draft.bankAccountId;
    if (changed("pricesIncludeVat") && draft.pricesIncludeVat !== null) {
      patch.pricesIncludeVat = draft.pricesIncludeVat;
    }
    const variableSymbol = Str.trim(draft.variableSymbol);
    const orderNumber = Str.trim(draft.orderNumber);
    const note = Str.trim(draft.note);
    if (changed("variableSymbol") && variableSymbol !== "") patch.variableSymbol = variableSymbol;
    if (changed("orderNumber") && orderNumber !== "") patch.orderNumber = orderNumber;
    if (changed("note") && note !== "") patch.note = note;
    if (changed("paymentMethod")) patch.paymentMethod = draft.paymentMethod;
    if (fxChanged && Str.toUpperCase(draft.currency) !== "CZK") {
      patch.fx = draft.fxMode === "manual" ? (fx ?? null) : null;
    }
    if (numberChanged) patch.number = trimmedNumber;
    if (changed("refreshParties") && draft.refreshParties) patch.refreshParties = true;
    return patch;
  },
);
