import type {
  AttachmentId,
  ContactId,
  CurrencyCode,
  ExpenseId,
  ExpenseStatus,
  IsoDate,
  PaymentId,
  PaymentMethod,
  VatTreatment,
} from "@kvitbit/domain/contract";

export type ExpenseSettlement = "unpaid" | "partially_paid" | "paid" | "overpaid";

export interface ExpenseSupplierData {
  readonly contactId: ContactId | null;
  readonly name: string | null;
  readonly ico: string | null;
  readonly dic: string | null;
}

export interface ExpenseVatLineData {
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

export interface ExpenseMoneyData {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export interface ExpenseVatBucketData {
  readonly treatment: VatTreatment;
  readonly ratePercent: string;
  readonly base: string;
  readonly vat: string;
  readonly gross: string;
  readonly vatCzk: string | null;
}

export interface ExpenseFxData {
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
  "CZK" as CurrencyCode,
  "EUR" as CurrencyCode,
  "USD" as CurrencyCode,
  "GBP" as CurrencyCode,
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

const asRecord = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : {};

const asString = (u: unknown): string | null => (typeof u === "string" ? u : null);

const asNumber = (u: unknown): number | null =>
  typeof u === "number" && Number.isFinite(u) ? u : null;

const asDecimalString = (u: unknown): string | null => {
  if (typeof u === "string" && u.trim() !== "") return u.trim();
  if (typeof u === "number" && Number.isFinite(u)) return String(u);
  if (typeof u === "object" && u !== null && "value" in u && "scale" in u) {
    const rec = u as { value?: unknown; scale?: unknown };
    if (typeof rec.value === "bigint" && typeof rec.scale === "number") {
      const neg = rec.value < 0n;
      const digits = (neg ? -rec.value : rec.value).toString();
      if (rec.scale <= 0) return `${neg ? "-" : ""}${digits}${"0".repeat(-rec.scale)}`;
      const padded = digits.padStart(rec.scale + 1, "0");
      const intPart = padded.slice(0, padded.length - rec.scale);
      const fracPart = padded.slice(padded.length - rec.scale).replace(/0+$/, "");
      return `${neg ? "-" : ""}${intPart}${fracPart === "" ? "" : `.${fracPart}`}`;
    }
  }
  return null;
};

const asSettlement = (u: unknown): ExpenseSettlement =>
  u === "partially_paid" || u === "paid" || u === "overpaid" ? u : "unpaid";

const asStatus = (u: unknown): ExpenseStatus => (u === "incomplete" ? "incomplete" : "complete");

const asPaymentMethod = (u: unknown): PaymentMethod =>
  u === "cash" || u === "card" || u === "other" ? u : "bank_transfer";

const asVatTreatment = (u: unknown): VatTreatment =>
  u === "reduced" ||
  u === "exempt_intra_eu_goods" ||
  u === "reverse_charge" ||
  u === "outside_scope"
    ? u
    : "standard";

const decodeMoney = (u: unknown): ExpenseMoneyData | null => {
  const r = asRecord(u);
  const amount = asDecimalString(r.amount);
  const currency = asString(r.currency) as CurrencyCode | null;
  if (amount === null || currency === null) return null;
  return { amount, currency };
};

const decodeDeductibility = (u: unknown): ExpenseDeductibility => {
  if (u === "full" || u === "none") return u;
  const r = asRecord(u);
  const partial = asNumber(r.partial);
  if (partial !== null && partial >= 1 && partial <= 99) return { partial: Math.round(partial) };
  return "full";
};

export const deductibilityPercent = (d: ExpenseDeductibility): number =>
  d === "full" ? 100 : d === "none" ? 0 : d.partial;

export const decodeAttachment = (u: unknown): ExpenseAttachmentData | null => {
  const r = asRecord(u);
  const id = asString(r.id) as AttachmentId | null;
  const expenseId = asString(r.expenseId) as ExpenseId | null;
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

export const decodeExpenseSummary = (u: unknown): ExpenseSummaryData => {
  const r = asRecord(u);
  return {
    id: (asString(r.id) ?? "") as ExpenseId,
    revision: asNumber(r.revision) ?? 1,
    status: asStatus(r.status),
    supplierName: asString(r.supplierName),
    supplierDocumentNumber: asString(r.supplierDocumentNumber),
    issuedOn: asString(r.issuedOn) as IsoDate | null,
    total: asDecimalString(r.total),
    currency: asString(r.currency) as CurrencyCode | null,
    category: asString(r.category),
    tags: Array.isArray(r.tags) ? r.tags.filter((x): x is string => typeof x === "string") : [],
    attachments: asNumber(r.attachments) ?? 0,
    settlement: asSettlement(r.settlement),
  };
};

export const decodeExpenseDetail = (u: unknown): ExpenseDetailData => {
  const r = asRecord(u);
  const supplierRec = r.supplier !== null && r.supplier !== undefined ? asRecord(r.supplier) : null;
  const paymentRec = asRecord(r.payment);
  const totalsRec = asRecord(r.totals);
  const fxRec = r.fx !== null && r.fx !== undefined ? asRecord(r.fx) : null;
  const rawVat = Array.isArray(r.vat) ? r.vat : null;
  const rawBuckets = Array.isArray(totalsRec.buckets) ? totalsRec.buckets : [];
  const rawAttachments = Array.isArray(r.attachments) ? r.attachments : [];
  return {
    id: (asString(r.id) ?? "") as ExpenseId,
    revision: asNumber(r.revision) ?? 1,
    status: asStatus(r.status),
    supplier:
      supplierRec === null
        ? null
        : {
            contactId: asString(supplierRec.contactId) as ContactId | null,
            name: asString(supplierRec.name),
            ico: asString(supplierRec.ico),
            dic: asString(supplierRec.dic),
          },
    supplierDocumentNumber: asString(r.supplierDocumentNumber),
    issuedOn: asString(r.issuedOn) as IsoDate | null,
    taxableSupplyOn: asString(r.taxableSupplyOn) as IsoDate | null,
    dueOn: asString(r.dueOn) as IsoDate | null,
    currency: asString(r.currency) as CurrencyCode | null,
    total: asDecimalString(r.total),
    vat:
      rawVat === null
        ? null
        : rawVat.map((entry) => {
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
    buckets: rawBuckets.map((entry) => {
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
            fixingDate: asString(fxRec.fixingDate) as IsoDate | null,
            source: fxRec.source === "manual" ? "manual" : "cnb",
          },
    totalCzk: asDecimalString(r.totalCzk),
    deductibility: decodeDeductibility(r.deductibility),
    deductibleVat: decodeMoney(r.deductibleVat),
    deductibleVatCzk: asDecimalString(r.deductibleVatCzk),
    category: asString(r.category),
    tags: Array.isArray(r.tags) ? r.tags.filter((x): x is string => typeof x === "string") : [],
    note: asString(r.note),
    attachments: rawAttachments
      .map(decodeAttachment)
      .filter((a): a is ExpenseAttachmentData => a !== null),
    payment: {
      settlement: asSettlement(paymentRec.settlement),
      paid: decodeMoney(paymentRec.paid),
      payments: asNumber(paymentRec.payments) ?? 0,
    },
    createdAt: asString(r.createdAt) ?? "",
    updatedAt: asString(r.updatedAt) ?? "",
  };
};

export const decodePayment = (u: unknown): ExpensePaymentData | null => {
  const r = asRecord(u);
  const id = asString(r.id) as PaymentId | null;
  const amount = decodeMoney(r.amount);
  const paidOn = asString(r.paidOn) as IsoDate | null;
  if (id === null || amount === null || paidOn === null) return null;
  return {
    id,
    amount,
    paidOn,
    method: asPaymentMethod(r.method),
    note: asString(r.note),
    createdAt: asString(r.createdAt) ?? "",
  };
};

// --- List filtering -------------------------------------------------------------------------------

export type ExpenseStatusFilter = "all" | "complete" | "incomplete";

export interface ExpenseFilterState {
  readonly status: ExpenseStatusFilter;
  readonly category: string | null;
  readonly search: string;
}

export const filterExpenses = (
  items: ReadonlyArray<ExpenseSummaryData>,
  filter: ExpenseFilterState,
): ReadonlyArray<ExpenseSummaryData> => {
  const needle = filter.search.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.status !== "all" && item.status !== filter.status) return false;
    if (filter.category !== null && (item.category ?? "") !== filter.category) return false;
    if (needle === "") return true;
    const haystack = [
      item.supplierName ?? "",
      item.supplierDocumentNumber ?? "",
      item.category ?? "",
      ...item.tags,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
};

export const extractCategories = (
  items: ReadonlyArray<ExpenseSummaryData>,
): ReadonlyArray<string> => {
  const set = new Set<string>();
  for (const item of items) {
    if (item.category !== null && item.category.trim() !== "") set.add(item.category.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
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

export const todayIsoDate = (now: Date = new Date()): IsoDate =>
  now.toISOString().slice(0, 10) as IsoDate;

export const emptyExpenseForm = (now: Date = new Date()): ExpenseFormState => ({
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
    vatRows: (detail.vat ?? []).map((line, i) => ({
      id: `vat-${i}`,
      treatment: line.treatment,
      base: line.base,
      vat: line.vat,
    })),
    deductibilityMode: deductMode,
    deductiblePercent: String(deductibilityPercent(detail.deductibility)),
    category: detail.category ?? "",
    tags: detail.tags.join(", "),
    note: detail.note ?? "",
  };
};

const normalizeDecimal = (raw: string): string | null => {
  const cleaned = raw.trim().replace(/\s+/g, "").replace(",", ".");
  if (cleaned === "" || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
};

/** Difference between total and sum of VAT rows (base + vat). Null if total or rows are empty/invalid. */
export const vatBreakdownDifference = (
  totalRaw: string,
  rows: ReadonlyArray<VatRowDraft>,
): number | null => {
  if (rows.length === 0) return null;
  const totalStr = normalizeDecimal(totalRaw);
  if (totalStr === null) return null;
  let sum = 0;
  for (const row of rows) {
    const base = normalizeDecimal(row.base);
    const vat = row.vat.trim() === "" ? "0" : normalizeDecimal(row.vat);
    if (base === null || vat === null) return null;
    sum += Number(base) + Number(vat);
  }
  const diff = Math.round((Number(totalStr) - sum) * 100) / 100;
  return diff;
};

/** Remaining unpaid amount in the expense's currency, or null when unknown. */
export const remainingAmount = (detail: ExpenseDetailData): string | null => {
  if (detail.total === null) return null;
  const totalNum = Number(detail.total);
  const paidNum = detail.payment.paid === null ? 0 : Number(detail.payment.paid.amount);
  if (!Number.isFinite(totalNum) || !Number.isFinite(paidNum)) return null;
  const diff = Math.max(0, Math.round((totalNum - paidNum) * 100) / 100);
  return diff.toFixed(2);
};

export interface BuiltExpensePayload {
  readonly payload: Record<string, unknown>;
  readonly errors: Readonly<Record<string, string>>;
}

/** Builds a strict ExpenseFields wire payload and returns client-side validation errors if any. */
export const buildExpensePayload = (form: ExpenseFormState): BuiltExpensePayload => {
  const errors: Record<string, string> = {};
  const isComplete = form.status === "complete";
  const payload: Record<string, unknown> = { status: form.status };

  const name = form.supplierName.trim();
  const ico = form.supplierIco.trim();
  const dic = form.supplierDic.trim();
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
    form.supplierDocumentNumber.trim() === "" ? null : form.supplierDocumentNumber.trim();

  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const issuedOn = form.issuedOn.trim();
  if (issuedOn === "") {
    if (isComplete) errors.issuedOn = "required";
    payload.issuedOn = null;
  } else if (!isoRe.test(issuedOn)) {
    errors.issuedOn = "invalid_date";
  } else {
    payload.issuedOn = issuedOn;
  }

  const taxableSupplyOn = form.taxableSupplyOn.trim();
  if (taxableSupplyOn === "") payload.taxableSupplyOn = null;
  else if (!isoRe.test(taxableSupplyOn)) errors.taxableSupplyOn = "invalid_date";
  else payload.taxableSupplyOn = taxableSupplyOn;

  const dueOn = form.dueOn.trim();
  if (dueOn === "") payload.dueOn = null;
  else if (!isoRe.test(dueOn)) errors.dueOn = "invalid_date";
  else payload.dueOn = dueOn;

  const currency = form.currency.trim().toUpperCase();
  if (currency === "") {
    if (isComplete) errors.currency = "required";
    payload.currency = null;
  } else {
    payload.currency = currency;
  }

  const totalRaw = form.total.trim();
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
    const vatLines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < form.vatRows.length; i++) {
      const row = form.vatRows[i];
      if (row === undefined) continue;
      const base = normalizeDecimal(row.base);
      const vat = row.vat.trim() === "" ? "0" : normalizeDecimal(row.vat);
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
    const pct = Number.parseInt(form.deductiblePercent.trim(), 10);
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
      errors.deductiblePercent = "invalid_percent";
    } else {
      payload.deductibility = { partial: pct };
    }
  }

  payload.category = form.category.trim() === "" ? null : form.category.trim();
  payload.tags = form.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  payload.note = form.note.trim() === "" ? null : form.note.trim();

  return { payload, errors };
};

export const validateAttachmentFile = (file: {
  readonly contentType: string;
  readonly size: number;
}): "too_large" | "unsupported_type" | null => {
  const mime = file.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!ALLOWED_ATTACHMENT_TYPES.includes(mime)) return "unsupported_type";
  if (file.size > ATTACHMENT_MAX_BYTES) return "too_large";
  return null;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
