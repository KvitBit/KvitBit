import {
  AttachmentId,
  ContactId,
  CurrencyCode,
  ExpenseId,
  type ExpenseInput,
  type ExpenseStatus,
  type ExpenseSummary,
  type ExpenseView,
  IsoDate,
  PaymentId,
  type PaymentMethod,
  type VatTreatment,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export type ExpenseSettlement = "unpaid" | "partially_paid" | "paid" | "overpaid";

interface ExpenseSupplierData {
  readonly contactId: ContactId | null;
  readonly name: string | null;
  readonly ico: string | null;
  readonly dic: string | null;
}

interface ExpenseVatLineData {
  readonly treatment: VatTreatment;
  readonly base: string;
  readonly vat: string;
  readonly selfAssessed: "standard" | "reduced" | null;
}

export type ExpenseDeductibility = "full" | "none" | { readonly partial: number };

export interface ExpenseAttachmentData {
  readonly id: AttachmentId;
  readonly expenseId: ExpenseId;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

interface ExpenseMoneyData {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

interface ExpenseVatBucketData {
  readonly treatment: VatTreatment;
  readonly ratePercent: string;
  readonly base: string;
  readonly vat: string;
  readonly gross: string;
  readonly vatCzk: string | null;
}

interface ExpenseFxData {
  readonly rate: string;
  readonly quantity: number;
  readonly fixingDate: IsoDate | null;
  readonly source: "cnb" | "manual";
}

export interface ExpenseSummaryData {
  readonly id: ExpenseId;
  readonly revision: number;
  readonly status: ExpenseStatus;
  readonly supplierName: string | null;
  readonly supplierDocumentNumber: string | null;
  readonly issuedOn: IsoDate | null;
  readonly total: string | null;
  readonly currency: CurrencyCode | null;
  readonly category: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly attachments: number;
  readonly settlement: ExpenseSettlement;
}

export interface ExpenseDetailData {
  readonly id: ExpenseId;
  readonly revision: number;
  readonly status: ExpenseStatus;
  readonly supplier: ExpenseSupplierData | null;
  readonly supplierDocumentNumber: string | null;
  readonly issuedOn: IsoDate | null;
  readonly taxableSupplyOn: IsoDate | null;
  readonly dueOn: IsoDate | null;
  readonly currency: CurrencyCode | null;
  readonly total: string | null;
  readonly vat: ReadonlyArray<ExpenseVatLineData> | null;
  readonly buckets: ReadonlyArray<ExpenseVatBucketData>;
  readonly fx: ExpenseFxData | null;
  readonly totalCzk: string | null;
  readonly deductibility: ExpenseDeductibility;
  readonly deductibleVat: ExpenseMoneyData | null;
  readonly deductibleVatCzk: string | null;
  readonly category: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly note: string | null;
  readonly attachments: ReadonlyArray<ExpenseAttachmentData>;
  readonly payment: {
    readonly settlement: ExpenseSettlement;
    readonly paid: ExpenseMoneyData | null;
    readonly payments: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExpensePaymentData {
  readonly id: PaymentId;
  readonly amount: ExpenseMoneyData;
  readonly paidOn: IsoDate;
  readonly method: PaymentMethod;
  readonly note: string | null;
  readonly createdAt: string;
}

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES: ReadonlyArray<string> = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
];

export const COMMON_CURRENCIES: ReadonlyArray<CurrencyCode> = [
  CurrencyCode.make("CZK"),
  CurrencyCode.make("EUR"),
  CurrencyCode.make("USD"),
  CurrencyCode.make("GBP"),
];

export const EXPENSE_VAT_TREATMENTS: ReadonlyArray<VatTreatment> = [
  "standard",
  "reduced",
  "reverse_charge",
  "exempt_intra_eu_goods",
  "outside_scope",
];

export const PAYMENT_METHODS: ReadonlyArray<PaymentMethod> = [
  "bank_transfer",
  "card",
  "cash",
  "other",
];

// --- Safe decoders from wire OpenStruct / Unknown -------------------------------------------------

const WireRecord = Schema.Record(Schema.String, Schema.Unknown);
const emptyRecord = (): typeof WireRecord.Type => ({});
const asRecord = Fn.flow(Schema.decodeUnknownOption(WireRecord), Option.getOrElse(emptyRecord));
const asString = Fn.flow(Schema.decodeUnknownOption(Schema.String), Option.getOrNull);
const asNumber = Fn.flow(Schema.decodeUnknownOption(Schema.Finite), Option.getOrNull);
const asDate = Fn.flow(Schema.decodeUnknownOption(IsoDate), Option.getOrNull);
const asCurrency = Fn.flow(Schema.decodeUnknownOption(CurrencyCode), Option.getOrNull);
const asExpenseId = Fn.flow(Schema.decodeUnknownOption(ExpenseId), Option.getOrNull);
const asContactId = Fn.flow(Schema.decodeUnknownOption(ContactId), Option.getOrNull);
const asAttachmentId = Fn.flow(Schema.decodeUnknownOption(AttachmentId), Option.getOrNull);
const asPaymentId = Fn.flow(Schema.decodeUnknownOption(PaymentId), Option.getOrNull);
const asList = Fn.flow(Schema.decodeUnknownOption(Schema.Array(Schema.Unknown)), Option.getOrNull);
const asTags = Fn.flow(asList, (list) =>
  Arr.filterMap(list ?? [], (item) => Schema.decodeUnknownResult(Schema.String)(item)),
);
const asDecimalParts = Fn.flow(
  Schema.decodeUnknownOption(Schema.Struct({ value: Schema.BigInt, scale: Schema.Int })),
  Option.getOrNull,
);
const trailingZeros = /0+$/;

const asDecimalString = Fn.flow(
  Schema.decodeUnknownOption(Schema.Unknown),
  Option.flatMap((value) => {
    const text = asString(value);
    if (text !== null && Str.trim(text) !== "") return Option.some(Str.trim(text));
    const number = asNumber(value);
    if (number !== null) return Option.some(String(number));
    const decimal = asDecimalParts(value);
    if (decimal === null) return Option.none();
    const neg = decimal.value < 0n;
    const sign = neg ? "-" : "";
    const digits = (neg ? -decimal.value : decimal.value).toString();
    if (decimal.scale <= 0)
      return Option.some(`${sign}${digits}${Str.repeat(-decimal.scale)("0")}`);
    const padded = Str.padStart(decimal.scale + 1, "0")(digits);
    const split = padded.length - decimal.scale;
    const intPart = Str.slice(0, split)(padded);
    const fracPart = Str.replace(trailingZeros, "")(Str.slice(split)(padded));
    return Option.some(`${sign}${intPart}${fracPart === "" ? "" : `.${fracPart}`}`);
  }),
  Option.getOrNull,
);

const asSettlement = Fn.flow(
  Schema.decodeUnknownOption(Schema.Literals(["partially_paid", "paid", "overpaid"])),
  Option.getOrElse((): ExpenseSettlement => "unpaid"),
);

const asPaymentMethod = Fn.flow(
  Schema.decodeUnknownOption(Schema.Literals(["cash", "card", "other"])),
  Option.getOrElse((): PaymentMethod => "bank_transfer"),
);

const asVatTreatment = Fn.flow(
  Schema.decodeUnknownOption(
    Schema.Literals(["reduced", "exempt_intra_eu_goods", "reverse_charge", "outside_scope"]),
  ),
  Option.getOrElse((): VatTreatment => "standard"),
);

const decodeMoney = (r: ReturnType<typeof asRecord>): ExpenseMoneyData | null => {
  const amount = asDecimalString(r.amount);
  const currency = asCurrency(r.currency);
  if (amount === null || currency === null) return null;
  return { amount, currency };
};

const decodeDeductibility = (u: ReturnType<typeof asString>): ExpenseDeductibility =>
  u === "none" ? "none" : "full";

export const deductibilityPercent = (d: ExpenseDeductibility): number =>
  d === "full" ? 100 : d === "none" ? 0 : d.partial;

const decodeAttachment = (r: ReturnType<typeof asRecord>): ExpenseAttachmentData | null => {
  const id = asAttachmentId(r.id);
  const expenseId = asExpenseId(r.expenseId);
  const name = asString(r.name);
  if (id === null || expenseId === null || name === null) return null;
  return {
    id,
    expenseId,
    name,
    contentType: asString(r.contentType) ?? "application/octet-stream",
    bytes: asNumber(r.bytes) ?? 0,
    sha256: asString(r.sha256) ?? "",
    createdAt: asString(r.createdAt) ?? "",
  };
};

export const decodeExpenseSummary = (r: ExpenseSummary): ExpenseSummaryData | null => {
  const id = asExpenseId(r.id);
  if (id === null) return null;
  return {
    id,
    revision: asNumber(r.revision) ?? 1,
    status: r.status,
    supplierName: asString(r.supplierName),
    supplierDocumentNumber: asString(r.supplierDocumentNumber),
    issuedOn: asDate(r.issuedOn),
    total: asDecimalString(r.total),
    currency: asCurrency(r.currency),
    category: asString(r.category),
    tags: asTags(r.tags),
    attachments: asNumber(r.attachments) ?? 0,
    settlement: asSettlement(r.settlement),
  };
};

export const decodeExpenseDetail = (r: ExpenseView): ExpenseDetailData | null => {
  const id = asExpenseId(r.id);
  if (id === null) return null;
  const supplierRec = Option.getOrNull(Schema.decodeUnknownOption(WireRecord)(r.supplier));
  const paymentRec = asRecord(r.payment);
  const totalsRec = asRecord(r.totals);
  const fxRec = Option.getOrNull(Schema.decodeUnknownOption(WireRecord)(r.fx));
  const rawVat = asList(r.vat);
  const rawBuckets = asList(totalsRec.buckets) ?? [];
  const rawAttachments = asList(r.attachments) ?? [];
  return {
    id,
    revision: asNumber(r.revision) ?? 1,
    status: r.status,
    supplier:
      supplierRec === null
        ? null
        : {
            contactId: asContactId(supplierRec.contactId),
            name: asString(supplierRec.name),
            ico: asString(supplierRec.ico),
            dic: asString(supplierRec.dic),
          },
    supplierDocumentNumber: asString(r.supplierDocumentNumber),
    issuedOn: asDate(r.issuedOn),
    taxableSupplyOn: asDate(r.taxableSupplyOn),
    dueOn: asDate(r.dueOn),
    currency: asCurrency(r.currency),
    total: asDecimalString(r.total),
    vat:
      rawVat === null
        ? null
        : Arr.map(rawVat, (entry) => {
            const line = asRecord(entry);
            return {
              treatment: asVatTreatment(line.treatment),
              base: asDecimalString(line.base) ?? "0",
              vat: asDecimalString(line.vat) ?? "0",
              selfAssessed:
                line.selfAssessed === "standard" || line.selfAssessed === "reduced"
                  ? line.selfAssessed
                  : null,
            };
          }),
    buckets: Arr.map(rawBuckets, (entry) => {
      const b = asRecord(entry);
      return {
        treatment: asVatTreatment(b.treatment),
        ratePercent: asDecimalString(b.ratePercent) ?? "0",
        base: asDecimalString(b.base) ?? "0",
        vat: asDecimalString(b.vat) ?? "0",
        gross: asDecimalString(b.gross) ?? "0",
        vatCzk: asDecimalString(b.vatCzk),
      };
    }),
    fx:
      fxRec === null
        ? null
        : {
            rate: asDecimalString(fxRec.rate) ?? "1",
            quantity: asNumber(fxRec.quantity) ?? 1,
            fixingDate: asDate(fxRec.fixingDate),
            source: fxRec.source === "manual" ? "manual" : "cnb",
          },
    totalCzk: asDecimalString(r.totalCzk),
    deductibility: (() => {
      const partial = asNumber(asRecord(r.deductibility).partial);
      return partial !== null && partial >= 1 && partial <= 99
        ? { partial: Math.round(partial) }
        : decodeDeductibility(asString(r.deductibility));
    })(),
    deductibleVat: decodeMoney(asRecord(r.deductibleVat)),
    deductibleVatCzk: asDecimalString(r.deductibleVatCzk),
    category: asString(r.category),
    tags: asTags(r.tags),
    note: asString(r.note),
    attachments: Arr.filter(
      Arr.map(rawAttachments, (raw) => decodeAttachment(asRecord(raw))),
      (a): a is ExpenseAttachmentData => a !== null,
    ),
    payment: {
      settlement: asSettlement(paymentRec.settlement),
      paid: decodeMoney(asRecord(paymentRec.paid)),
      payments: asNumber(paymentRec.payments) ?? 0,
    },
    createdAt: asString(r.createdAt) ?? "",
    updatedAt: asString(r.updatedAt) ?? "",
  };
};

export const decodePayment = Fn.flow(asRecord, (r): ExpensePaymentData | null => {
  const id = asPaymentId(r.id);
  const amount = decodeMoney(asRecord(r.amount));
  const paidOn = asDate(r.paidOn);
  if (id === null || amount === null || paidOn === null) return null;
  return {
    id,
    amount,
    paidOn,
    method: asPaymentMethod(r.method),
    note: asString(r.note),
    createdAt: asString(r.createdAt) ?? "",
  };
});

// --- List filtering -------------------------------------------------------------------------------

export type ExpenseStatusFilter = "all" | "complete" | "incomplete";

export interface ExpenseFilterState {
  readonly status: ExpenseStatusFilter;
  readonly category: string | null;
  readonly search: string;
}

export const filterExpenses: {
  (
    items: ReadonlyArray<ExpenseSummaryData>,
    filter: ExpenseFilterState,
  ): ReadonlyArray<ExpenseSummaryData>;
  (
    filter: ExpenseFilterState,
  ): (items: ReadonlyArray<ExpenseSummaryData>) => ReadonlyArray<ExpenseSummaryData>;
} = Fn.dual(
  2,
  (
    items: ReadonlyArray<ExpenseSummaryData>,
    filter: ExpenseFilterState,
  ): ReadonlyArray<ExpenseSummaryData> => {
    const needle = Str.toLowerCase(Str.trim(filter.search));
    return Arr.filter(items, (item) => {
      if (filter.status !== "all" && item.status !== filter.status) return false;
      if (filter.category !== null && (item.category ?? "") !== filter.category) return false;
      if (needle === "") return true;
      const haystack = Str.toLowerCase(
        Arr.join(
          [
            item.supplierName ?? "",
            item.supplierDocumentNumber ?? "",
            item.category ?? "",
            ...item.tags,
          ],
          " ",
        ),
      );
      return Str.includes(needle)(haystack);
    });
  },
);

export const extractCategories = (
  items: ReadonlyArray<ExpenseSummaryData>,
): ReadonlyArray<string> => {
  const set = new Set<string>();
  for (const item of items) {
    if (item.category !== null && Str.trim(item.category) !== "") set.add(Str.trim(item.category));
  }
  return [...set].sort((a, b) => Str.localeCompare(b)(a));
};

// --- Form state & payload construction ------------------------------------------------------------

export interface VatRowDraft {
  readonly id: string;
  readonly treatment: VatTreatment;
  readonly base: string;
  readonly vat: string;
}

export type DeductibilityMode = "full" | "none" | "partial";

export interface ExpenseFormState {
  readonly status: ExpenseStatus;
  readonly supplierName: string;
  readonly supplierIco: string;
  readonly supplierDic: string;
  readonly supplierDocumentNumber: string;
  readonly issuedOn: string;
  readonly taxableSupplyOn: string;
  readonly dueOn: string;
  readonly currency: string;
  readonly total: string;
  readonly vatRows: ReadonlyArray<VatRowDraft>;
  readonly deductibilityMode: DeductibilityMode;
  readonly deductiblePercent: string;
  readonly category: string;
  readonly tags: string;
  readonly note: string;
}

export const todayIsoDate = (now?: Date): IsoDate =>
  IsoDate.make(
    DateTime.formatIsoDateUtc(now === undefined ? DateTime.nowUnsafe() : DateTime.makeUnsafe(now)),
  );

export const emptyExpenseForm = (now?: Date): ExpenseFormState => ({
  status: "complete",
  supplierName: "",
  supplierIco: "",
  supplierDic: "",
  supplierDocumentNumber: "",
  issuedOn: todayIsoDate(now),
  taxableSupplyOn: "",
  dueOn: "",
  currency: "CZK",
  total: "",
  vatRows: [],
  deductibilityMode: "full",
  deductiblePercent: "100",
  category: "",
  tags: "",
  note: "",
});

export const expenseFormFromDetail = (detail: ExpenseDetailData): ExpenseFormState => {
  const deductMode: DeductibilityMode =
    detail.deductibility === "full" ? "full" : detail.deductibility === "none" ? "none" : "partial";
  return {
    status: detail.status,
    supplierName: detail.supplier?.name ?? "",
    supplierIco: detail.supplier?.ico ?? "",
    supplierDic: detail.supplier?.dic ?? "",
    supplierDocumentNumber: detail.supplierDocumentNumber ?? "",
    issuedOn: detail.issuedOn ?? "",
    taxableSupplyOn: detail.taxableSupplyOn ?? "",
    dueOn: detail.dueOn ?? "",
    currency: detail.currency ?? "CZK",
    total: detail.total ?? "",
    vatRows: Arr.map(detail.vat ?? [], (line, i) => ({
      id: `vat-${i}`,
      treatment: line.treatment,
      base: line.base,
      vat: line.vat,
    })),
    deductibilityMode: deductMode,
    deductiblePercent: String(deductibilityPercent(detail.deductibility)),
    category: detail.category ?? "",
    tags: Arr.join(detail.tags, ", "),
    note: detail.note ?? "",
  };
};

const decimalPattern = /^-?\d+(?:\.\d+)?$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const whitespace = /\s+/g;

const normalizeDecimal = (raw: string): string | null => {
  const cleaned = Str.replace(",", ".")(Str.replace(whitespace, "")(Str.trim(raw)));
  if (cleaned === "" || !decimalPattern.test(cleaned)) return null;
  return cleaned;
};

/** Difference between total and sum of VAT rows (base + vat). Null if total or rows are empty/invalid. */
export const vatBreakdownDifference: {
  (totalRaw: string, rows: ReadonlyArray<VatRowDraft>): number | null;
  (rows: ReadonlyArray<VatRowDraft>): (totalRaw: string) => number | null;
} = Fn.dual(2, (totalRaw: string, rows: ReadonlyArray<VatRowDraft>): number | null => {
  if (rows.length === 0) return null;
  const totalStr = normalizeDecimal(totalRaw);
  if (totalStr === null) return null;
  let sum = 0;
  for (const row of rows) {
    const base = normalizeDecimal(row.base);
    const vat = Str.trim(row.vat) === "" ? "0" : normalizeDecimal(row.vat);
    if (base === null || vat === null) return null;
    sum += Number(base) + Number(vat);
  }
  const diff = Math.round((Number(totalStr) - sum) * 100) / 100;
  return diff;
});

/** Remaining unpaid amount in the expense's currency, or null when unknown. */
export const remainingAmount = (detail: ExpenseDetailData): string | null => {
  if (detail.total === null) return null;
  const totalNum = Number(detail.total);
  const paidNum = detail.payment.paid === null ? 0 : Number(detail.payment.paid.amount);
  if (!(Number.isFinite(totalNum) && Number.isFinite(paidNum))) return null;
  const diff = Math.max(0, Math.round((totalNum - paidNum) * 100) / 100);
  return diff.toFixed(2);
};

interface ExpenseDraftPayload extends ExpenseInput {
  status: ExpenseStatus;
  supplier?:
    | { manual: { name: string; ico: string | null; dic: string | null } }
    | { ico: string }
    | null;
  supplierDocumentNumber?: string | null;
  issuedOn?: string | null;
  taxableSupplyOn?: string | null;
  dueOn?: string | null;
  currency?: string | null;
  total?: string | null;
  vat?: Array<{ treatment: VatTreatment; base: string; vat: string }> | null;
  deductibility?: ExpenseDeductibility;
  category?: string | null;
  tags?: ReadonlyArray<string>;
  note?: string | null;
}

export interface BuiltExpensePayload {
  readonly payload: ExpenseDraftPayload;
  readonly errors: Readonly<Record<string, string>>;
}

/** Builds a strict ExpenseFields wire payload and returns client-side validation errors if any. */
export const buildExpensePayload = (form: ExpenseFormState): BuiltExpensePayload => {
  const errors: Record<string, string> = {};
  const isComplete = form.status === "complete";
  const payload: ExpenseDraftPayload = { status: form.status };

  const name = Str.trim(form.supplierName);
  const ico = Str.trim(form.supplierIco);
  const dic = Str.trim(form.supplierDic);
  if (name !== "") {
    payload.supplier = {
      manual: {
        name,
        ico: ico === "" ? null : ico,
        dic: dic === "" ? null : dic,
      },
    };
  } else if (ico !== "") {
    payload.supplier = { ico };
  } else {
    payload.supplier = null;
  }

  payload.supplierDocumentNumber =
    Str.trim(form.supplierDocumentNumber) === "" ? null : Str.trim(form.supplierDocumentNumber);

  const issuedOn = Str.trim(form.issuedOn);
  if (issuedOn === "") {
    if (isComplete) errors.issuedOn = "required";
    payload.issuedOn = null;
  } else if (!datePattern.test(issuedOn)) {
    errors.issuedOn = "invalid_date";
  } else {
    payload.issuedOn = issuedOn;
  }

  const taxableSupplyOn = Str.trim(form.taxableSupplyOn);
  if (taxableSupplyOn === "") payload.taxableSupplyOn = null;
  else if (!datePattern.test(taxableSupplyOn)) errors.taxableSupplyOn = "invalid_date";
  else payload.taxableSupplyOn = taxableSupplyOn;

  const dueOn = Str.trim(form.dueOn);
  if (dueOn === "") payload.dueOn = null;
  else if (!datePattern.test(dueOn)) errors.dueOn = "invalid_date";
  else payload.dueOn = dueOn;

  const currency = Str.toUpperCase(Str.trim(form.currency));
  if (currency === "") {
    if (isComplete) errors.currency = "required";
    payload.currency = null;
  } else {
    payload.currency = currency;
  }

  const totalRaw = Str.trim(form.total);
  if (totalRaw === "") {
    if (isComplete) errors.total = "required";
    payload.total = null;
  } else {
    const normalized = normalizeDecimal(totalRaw);
    if (normalized === null || Number(normalized) < 0) errors.total = "invalid_number";
    else payload.total = normalized;
  }

  if (form.vatRows.length === 0) {
    payload.vat = null;
  } else {
    const vatLines: NonNullable<ExpenseDraftPayload["vat"]> = [];
    for (let i = 0; i < form.vatRows.length; i++) {
      const row = form.vatRows[i];
      if (row === undefined) continue;
      const base = normalizeDecimal(row.base);
      const vat = Str.trim(row.vat) === "" ? "0" : normalizeDecimal(row.vat);
      if (base === null) errors[`vat.${i}.base`] = "invalid_number";
      if (vat === null) errors[`vat.${i}.vat`] = "invalid_number";
      if (base !== null && vat !== null) {
        vatLines.push({ treatment: row.treatment, base, vat });
      }
    }
    payload.vat = vatLines;
  }

  if (form.deductibilityMode === "full") {
    payload.deductibility = "full";
  } else if (form.deductibilityMode === "none") {
    payload.deductibility = "none";
  } else {
    const pct = Number.parseInt(Str.trim(form.deductiblePercent), 10);
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
      errors.deductiblePercent = "invalid_percent";
    } else {
      payload.deductibility = { partial: pct };
    }
  }

  payload.category = Str.trim(form.category) === "" ? null : Str.trim(form.category);
  payload.tags = Arr.filter(
    Arr.map(Str.split(",")(form.tags), (tag) => Str.trim(tag)),
    (tag) => tag !== "",
  );
  payload.note = Str.trim(form.note) === "" ? null : Str.trim(form.note);

  return { payload, errors };
};

export const validateAttachmentFile = (file: {
  readonly contentType: string;
  readonly size: number;
}): "too_large" | "unsupported_type" | null => {
  const mime = Str.trim(Str.split(";")(Str.toLowerCase(file.contentType))[0] ?? "");
  if (!ALLOWED_ATTACHMENT_TYPES.includes(mime)) return "unsupported_type";
  if (file.size > ATTACHMENT_MAX_BYTES) return "too_large";
  return null;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
