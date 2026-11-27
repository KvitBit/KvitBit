/**
 * Private shared schemas, decoders, VAT/FX math helpers and Effect UI Commands for the `records`
 * page group (Expenses, Contacts, Price List, Reports). Kept private inside `src/page/records/`.
 */
import {
  ContactDefaults,
  type ContactView,
  CurrencyCode,
  type ExpenseSummary,
  type ExpenseView,
  IsoDate,
  type Locale,
  PaymentMethod,
  type PaymentView,
  type PriceListItemView,
  type ReportKind,
  type ReportView,
  type VatTreatment,
} from "@kvitbit/domain/contract";
import { Format, I18n, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Failure, failureFromUnknown } from "../../app/api";
import { browserOrigin, downloadFile, fetchBrowserOk } from "../../app/browser";
import { browserCommand, type PageCommand } from "../../app/commands";
import type { Translator } from "../../app/i18n";
import type { PageContext } from "../../app/page";
import type { BadgeTone } from "../../ui/kit";

export { apiCommand } from "../../app/commands";

export const enumLabel: {
  <E extends I18n.EnumName>(name: E, value: I18n.EnumLabels[E]): (t: Translator) => string;
  <E extends I18n.EnumName>(t: Translator, name: E, value: I18n.EnumLabels[E]): string;
} = Fn.dual(
  3,
  <E extends I18n.EnumName>(t: Translator, name: E, value: I18n.EnumLabels[E]): string =>
    t.translate(I18n.enumText(name, value)),
);

// --- Common value schemas (JSON-safe for Effect UI SSR Model codecs) -------------------------------

const MoneyRecord = Schema.Struct({
  amount: Schema.String,
  currency: Schema.String,
});
type MoneyRecord = typeof MoneyRecord.Type;

const VatBucketRecord = Schema.Struct({
  treatment: Schema.String,
  ratePercent: Schema.String,
  base: Schema.String,
  vat: Schema.String,
  gross: Schema.String,
  vatCzk: Schema.NullOr(Schema.String),
});
type VatBucketRecord = typeof VatBucketRecord.Type;

const VatBreakdownRecord = Schema.Struct({
  buckets: Schema.Array(VatBucketRecord),
  net: MoneyRecord,
  vat: MoneyRecord,
  roundingAdjustment: MoneyRecord,
  gross: MoneyRecord,
  vatCzk: Schema.NullOr(MoneyRecord),
});
type VatBreakdownRecord = typeof VatBreakdownRecord.Type;

// --- Contact schemas -----------------------------------------------------------------------------

export const ContactRoleLiteral = Schema.Literals(["customer", "supplier"]);
export type ContactRoleLiteral = typeof ContactRoleLiteral.Type;

const ContactAddressRecord = Schema.Struct({
  street: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  postalCode: Schema.NullOr(Schema.String),
  country: Schema.String,
});

const ReminderPolicyRecord = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("inherit") }),
  Schema.Struct({ mode: Schema.Literal("disabled") }),
  Schema.Struct({ mode: Schema.Literal("custom"), offsetsDays: Schema.Array(Schema.Int) }),
]);
type ReminderPolicyRecord = typeof ReminderPolicyRecord.Type;

export const ContactDefaultsRecord = Schema.Struct({
  currency: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.Literals(["cs", "en"])),
  dueDays: Schema.optionalKey(Schema.Int),
  paymentMethod: Schema.optionalKey(Schema.String),
  preferredSeriesByKind: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  defaultNote: Schema.optionalKey(Schema.String),
  reminderPolicy: Schema.optionalKey(ReminderPolicyRecord),
});
export type ContactDefaultsRecord = typeof ContactDefaultsRecord.Type;

export const ContactRecord = Schema.Struct({
  id: Schema.String,
  roles: Schema.Array(ContactRoleLiteral),
  name: Schema.String,
  ico: Schema.NullOr(Schema.String),
  dic: Schema.NullOr(Schema.String),
  legalForm: Schema.NullOr(Schema.String),
  address: ContactAddressRecord,
  billingEmails: Schema.Array(Schema.String),
  phone: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  defaults: ContactDefaultsRecord,
  registryFetchedAt: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  revision: Schema.Int,
});
export type ContactRecord = typeof ContactRecord.Type;

// --- Price List schemas --------------------------------------------------------------------------

export const PriceListItemRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  unit: Schema.NullOr(Schema.String),
  unitPrice: Schema.String,
  currency: Schema.String,
  vat: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  revision: Schema.Int,
});
export type PriceListItemRecord = typeof PriceListItemRecord.Type;

// --- Expense & Payment schemas -------------------------------------------------------------------

const ExpenseStatusLiteral = Schema.Literals(["complete", "incomplete"]);

export const ExpenseSettlementLiteral = Schema.Literals([
  "unpaid",
  "partially_paid",
  "paid",
  "overpaid",
]);
export type ExpenseSettlementLiteral = typeof ExpenseSettlementLiteral.Type;

const ExpenseSupplierRecord = Schema.Struct({
  contactId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  ico: Schema.NullOr(Schema.String),
  dic: Schema.NullOr(Schema.String),
});
type ExpenseSupplierRecord = typeof ExpenseSupplierRecord.Type;

const ExpenseVatLineRecord = Schema.Struct({
  treatment: Schema.String,
  base: Schema.String,
  vat: Schema.String,
  selfAssessed: Schema.NullOr(Schema.Literals(["standard", "reduced"])),
});

const ExpenseFxRecord = Schema.Struct({
  rate: Schema.String,
  quantity: Schema.Int,
  fixingDate: Schema.NullOr(Schema.String),
  source: Schema.Literals(["cnb", "manual"]),
});
type ExpenseFxRecord = typeof ExpenseFxRecord.Type;

export const ExpenseAttachmentRecord = Schema.Struct({
  id: Schema.String,
  expenseId: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
  bytes: Schema.Finite,
  sha256: Schema.String,
  createdAt: Schema.String,
});
export type ExpenseAttachmentRecord = typeof ExpenseAttachmentRecord.Type;

const DeductibilityRecord = Schema.Union([
  Schema.Literals(["full", "none"]),
  Schema.Struct({ partial: Schema.Int }),
]);
type DeductibilityRecord = typeof DeductibilityRecord.Type;

export const ExpenseSummaryRecord = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  status: ExpenseStatusLiteral,
  supplierName: Schema.NullOr(Schema.String),
  supplierDocumentNumber: Schema.NullOr(Schema.String),
  issuedOn: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  attachments: Schema.Int,
  settlement: ExpenseSettlementLiteral,
});
export type ExpenseSummaryRecord = typeof ExpenseSummaryRecord.Type;

export const ExpenseViewRecord = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  status: ExpenseStatusLiteral,
  supplier: Schema.NullOr(ExpenseSupplierRecord),
  supplierDocumentNumber: Schema.NullOr(Schema.String),
  issuedOn: Schema.NullOr(Schema.String),
  taxableSupplyOn: Schema.NullOr(Schema.String),
  dueOn: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.String),
  vat: ExpenseVatLineRecord.pipe(Schema.Array, Schema.NullOr),
  totals: Schema.NullOr(VatBreakdownRecord),
  selfAssessed: Schema.Array(VatBucketRecord),
  fx: Schema.NullOr(ExpenseFxRecord),
  totalCzk: Schema.NullOr(Schema.String),
  deductibility: DeductibilityRecord,
  deductibleVat: Schema.NullOr(MoneyRecord),
  deductibleVatCzk: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
  attachments: Schema.Array(ExpenseAttachmentRecord),
  payment: Schema.Struct({
    settlement: ExpenseSettlementLiteral,
    paid: Schema.NullOr(MoneyRecord),
    payments: Schema.Int,
  }),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ExpenseViewRecord = typeof ExpenseViewRecord.Type;

export const PaymentRecord = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  amount: MoneyRecord,
  paidOn: Schema.String,
  method: PaymentMethod,
  note: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type PaymentRecord = typeof PaymentRecord.Type;

// --- Reports schemas -----------------------------------------------------------------------------

const ReportPeriodRecord = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});

const ReportAmountRow = Schema.Struct({
  key: Schema.String,
  label: Schema.NullOr(Schema.String),
  count: Schema.Int,
  net: MoneyRecord,
  vat: MoneyRecord,
  gross: MoneyRecord,
  original: Schema.NullOr(MoneyRecord),
});
type ReportAmountRow = typeof ReportAmountRow.Type;

const ReportAmountTotals = Schema.Struct({
  count: Schema.Int,
  net: MoneyRecord,
  vat: MoneyRecord,
  gross: MoneyRecord,
});

export const RevenueReportRecord = Schema.Struct({
  report: Schema.Literal("revenue"),
  period: ReportPeriodRecord,
  groupBy: Schema.Literals(["month", "contact", "currency"]),
  rows: Schema.Array(ReportAmountRow),
  totals: ReportAmountTotals,
});
export type RevenueReportRecord = typeof RevenueReportRecord.Type;

export const ExpensesReportRecord = Schema.Struct({
  report: Schema.Literal("expenses"),
  period: ReportPeriodRecord,
  groupBy: Schema.Literals(["month", "contact", "currency", "category"]),
  rows: Schema.Array(ReportAmountRow),
  totals: ReportAmountTotals,
  incomplete: Schema.Int,
});
export type ExpensesReportRecord = typeof ExpensesReportRecord.Type;

export const ProfitReportRecord = Schema.Struct({
  report: Schema.Literal("profit"),
  period: ReportPeriodRecord,
  rows: Schema.Array(
    Schema.Struct({
      month: Schema.String,
      revenue: MoneyRecord,
      expenses: MoneyRecord,
      profit: MoneyRecord,
    }),
  ),
  totals: Schema.Struct({
    revenue: MoneyRecord,
    expenses: MoneyRecord,
    profit: MoneyRecord,
  }),
});
export type ProfitReportRecord = typeof ProfitReportRecord.Type;

export const CashflowReportRecord = Schema.Struct({
  report: Schema.Literal("cashflow"),
  period: ReportPeriodRecord,
  points: Schema.Array(
    Schema.Struct({
      month: Schema.String,
      in: MoneyRecord,
      out: MoneyRecord,
      net: MoneyRecord,
    }),
  ),
  totals: Schema.Struct({
    in: MoneyRecord,
    out: MoneyRecord,
    net: MoneyRecord,
  }),
});
export type CashflowReportRecord = typeof CashflowReportRecord.Type;

const ReceivableRowRecord = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  number: Schema.NullOr(Schema.String),
  contact: Schema.Struct({ id: Schema.NullOr(Schema.String), name: Schema.String }),
  currency: Schema.String,
  dueOn: Schema.NullOr(Schema.String),
  daysOverdue: Schema.Int,
  outstanding: MoneyRecord,
  outstandingCzk: MoneyRecord,
});

export const ReceivablesReportRecord = Schema.Struct({
  report: Schema.Literal("receivables"),
  period: ReportPeriodRecord,
  asOf: Schema.String,
  buckets: Schema.Array(
    Schema.Struct({
      bucket: Schema.Literals(["not_due", "1_30", "31_60", "61_90", "over_90"]),
      count: Schema.Int,
      total: MoneyRecord,
      documents: Schema.Array(ReceivableRowRecord),
    }),
  ),
  total: MoneyRecord,
  overdue: Schema.Struct({ total: MoneyRecord, count: Schema.Int }),
});
export type ReceivablesReportRecord = typeof ReceivablesReportRecord.Type;

const VatLineRecord = Schema.Struct({
  month: Schema.String,
  treatment: Schema.String,
  ratePercent: Schema.String,
  base: MoneyRecord,
  vat: MoneyRecord,
  documents: Schema.Array(
    Schema.Union([
      Schema.TaggedStruct("Document", { id: Schema.String }),
      Schema.TaggedStruct("Expense", { id: Schema.String }),
    ]),
  ),
});
type VatLineRecord = typeof VatLineRecord.Type;

export const VatSummaryReportRecord = Schema.Struct({
  report: Schema.Literal("vat_summary"),
  period: ReportPeriodRecord,
  output: Schema.Array(VatLineRecord),
  input: Schema.Array(VatLineRecord),
  totals: Schema.Struct({ output: MoneyRecord, input: MoneyRecord, payable: MoneyRecord }),
});
export type VatSummaryReportRecord = typeof VatSummaryReportRecord.Type;

export const ReportDataRecord = Schema.Union([
  RevenueReportRecord,
  ExpensesReportRecord,
  ProfitReportRecord,
  CashflowReportRecord,
  ReceivablesReportRecord,
  VatSummaryReportRecord,
]);
export type ReportDataRecord = typeof ReportDataRecord.Type;

// --- Wire normalization helpers (open/branded domain views -> JSON-safe records) -----------------

const WireField = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.ObjectKeyword,
]).pipe(Schema.UndefinedOr, Schema.NullOr);
type WireField = typeof WireField.Type;

const WireFields = Schema.Record(Schema.String, WireField);
const readFields = Schema.decodeUnknownOption(WireFields);
const emptyFields: typeof WireFields.Type = {};
const asRecord = Fn.compose(
  readFields,
  Option.getOrElse(() => emptyFields),
);
const readString = Schema.is(Schema.String);
const readPaymentMethod = Schema.is(PaymentMethod);
const readNumber = Schema.is(Schema.Finite);
const readBoolean = Schema.is(Schema.Boolean);
const str = (u: WireField, fallback = ""): string => (readString(u) ? u : fallback);
const optStr = (u: WireField): string | null => (readString(u) ? u : null);
const num = (u: WireField, fallback = 0): number => (readNumber(u) ? u : fallback);
const int = (u: WireField, fallback = 0): number => Math.trunc(num(u, fallback));
const bool = (u: WireField, fallback = false): boolean => (readBoolean(u) ? u : fallback);

export const decimalToString = (u: WireField): string => optDecimalToString(u) ?? "0";

const optDecimalToString = (u: WireField): string | null => {
  if (readString(u)) return u;
  if (readNumber(u)) return String(u);
  if (BigDecimal.isBigDecimal(u)) return u.pipe(BigDecimal.normalize, BigDecimal.format);
  return null;
};

const parseMoney = (u: WireField, fallbackCurrency = "CZK"): MoneyRecord => {
  const r = asRecord(u);
  return {
    amount: decimalToString(r.amount),
    currency: str(r.currency, fallbackCurrency),
  };
};

const parseOptMoney = (u: WireField): MoneyRecord | null =>
  u === null || u === undefined ? null : parseMoney(u);

const parseVatBucket = Fn.compose(
  asRecord,
  (r): VatBucketRecord => ({
    treatment: str(r.treatment, "standard"),
    ratePercent: decimalToString(r.ratePercent),
    base: decimalToString(r.base),
    vat: decimalToString(r.vat),
    gross: decimalToString(r.gross),
    vatCzk: optDecimalToString(r.vatCzk),
  }),
);

const parseVatBreakdown = (u: WireField): VatBreakdownRecord | null => {
  if (u === null || u === undefined) return null;
  const r = asRecord(u);
  const buckets = Arr.isArray(r.buckets) ? Arr.map(r.buckets, parseVatBucket) : [];
  return {
    buckets,
    net: parseMoney(r.net),
    vat: parseMoney(r.vat),
    roundingAdjustment: parseMoney(r.roundingAdjustment),
    gross: parseMoney(r.gross),
    vatCzk: parseOptMoney(r.vatCzk),
  };
};

export const normalizeContact = (raw: ContactView): ContactRecord => {
  const r = asRecord(raw);
  const addr = asRecord(r.address);
  const def = asRecord(r.defaults);
  const rp = asRecord(def.reminderPolicy);
  const reminderPolicy: ReminderPolicyRecord | undefined =
    rp.mode === "disabled"
      ? { mode: "disabled" }
      : rp.mode === "custom"
        ? {
            mode: "custom",
            offsetsDays: Arr.isArray(rp.offsetsDays)
              ? Arr.map(rp.offsetsDays, (x) => (readNumber(x) ? Math.trunc(x) : 0))
              : [],
          }
        : rp.mode === "inherit"
          ? { mode: "inherit" }
          : undefined;
  const seriesRaw = asRecord(def.preferredSeriesByKind);
  const seriesEntries = Arr.filter(Rec.toEntries(seriesRaw), (entry): entry is [string, string] =>
    readString(entry[1]),
  );
  const currency = readString(def.currency) ? { currency: def.currency } : undefined;
  const language =
    def.language === "cs" || def.language === "en"
      ? ({ language: def.language } as const)
      : undefined;
  const dueDays = readNumber(def.dueDays) ? { dueDays: int(def.dueDays) } : undefined;
  const method = readString(def.paymentMethod) ? { paymentMethod: def.paymentMethod } : undefined;
  const series =
    seriesEntries.length > 0
      ? { preferredSeriesByKind: Rec.fromEntries(seriesEntries) }
      : undefined;
  const note = readString(def.defaultNote) ? { defaultNote: def.defaultNote } : undefined;
  const reminders = reminderPolicy === undefined ? undefined : { reminderPolicy };
  const defaults = {
    ...currency,
    ...language,
    ...dueDays,
    ...method,
    ...series,
    ...note,
    ...reminders,
  } satisfies ContactDefaultsRecord;
  const rolesRaw = Arr.isArray(r.roles) ? r.roles : ["customer"];
  const roles = Arr.filter(
    rolesRaw,
    (x): x is ContactRoleLiteral => x === "customer" || x === "supplier",
  );
  return {
    id: str(r.id),
    roles: roles.length > 0 ? roles : ["customer"],
    name: str(r.name),
    ico: optStr(r.ico),
    dic: optStr(r.dic),
    legalForm: optStr(r.legalForm),
    address: {
      street: optStr(addr.street),
      city: optStr(addr.city),
      postalCode: optStr(addr.postalCode),
      country: str(addr.country, "CZ"),
    },
    billingEmails: Arr.isArray(r.billingEmails)
      ? Arr.filter(r.billingEmails, (e): e is string => readString(e))
      : [],
    phone: optStr(r.phone),
    note: optStr(r.note),
    defaults,
    registryFetchedAt: optStr(r.registryFetchedAt),
    archived: bool(r.archived),
    revision: int(r.revision, 1),
  };
};

export const normalizePriceListItem = (raw: PriceListItemView): PriceListItemRecord => {
  const r = asRecord(raw);
  return {
    id: str(r.id),
    name: str(r.name),
    description: optStr(r.description),
    unit: optStr(r.unit),
    unitPrice: decimalToString(r.unitPrice),
    currency: str(r.currency, "CZK"),
    vat: optStr(r.vat),
    archived: bool(r.archived),
    revision: int(r.revision, 1),
  };
};

export const normalizeExpenseSummary = (raw: ExpenseSummary): ExpenseSummaryRecord => {
  const r = asRecord(raw);
  const settlement =
    r.settlement === "paid" ||
    r.settlement === "partially_paid" ||
    r.settlement === "overpaid" ||
    r.settlement === "unpaid"
      ? r.settlement
      : "unpaid";
  return {
    id: str(r.id),
    revision: int(r.revision, 1),
    status: r.status === "incomplete" ? "incomplete" : "complete",
    supplierName: optStr(r.supplierName),
    supplierDocumentNumber: optStr(r.supplierDocumentNumber),
    issuedOn: optStr(r.issuedOn),
    total: optDecimalToString(r.total),
    currency: optStr(r.currency),
    category: optStr(r.category),
    tags: Arr.isArray(r.tags) ? Arr.filter(r.tags, (x): x is string => readString(x)) : [],
    attachments: int(r.attachments, 0),
    settlement,
  };
};

const normalizeAttachment = Fn.compose(
  asRecord,
  (r): ExpenseAttachmentRecord => ({
    id: str(r.id),
    expenseId: str(r.expenseId),
    name: str(r.name, "attachment"),
    contentType: str(r.contentType, "application/octet-stream"),
    bytes: num(r.bytes, 0),
    sha256: str(r.sha256),
    createdAt: str(r.createdAt),
  }),
);

export const normalizeExpenseView = (raw: ExpenseView): ExpenseViewRecord => {
  const r = asRecord(raw);
  const supRaw = r.supplier === null || r.supplier === undefined ? null : asRecord(r.supplier);
  const supplier: ExpenseSupplierRecord | null =
    supRaw === null
      ? null
      : {
          contactId: optStr(supRaw.contactId),
          name: optStr(supRaw.name),
          ico: optStr(supRaw.ico),
          dic: optStr(supRaw.dic),
        };
  const fxRaw = r.fx === null || r.fx === undefined ? null : asRecord(r.fx);
  const fx: ExpenseFxRecord | null =
    fxRaw === null
      ? null
      : {
          rate: decimalToString(fxRaw.rate),
          quantity: int(fxRaw.quantity, 1),
          fixingDate: optStr(fxRaw.fixingDate),
          source: fxRaw.source === "manual" ? "manual" : "cnb",
        };
  const dedRaw = r.deductibility;
  const deductibility: DeductibilityRecord =
    dedRaw === "none"
      ? "none"
      : "partial" in asRecord(dedRaw)
        ? { partial: Math.max(1, Math.min(99, int(asRecord(dedRaw).partial, 50))) }
        : "full";
  const payRaw = asRecord(r.payment);
  const settlement =
    payRaw.settlement === "paid" ||
    payRaw.settlement === "partially_paid" ||
    payRaw.settlement === "overpaid" ||
    payRaw.settlement === "unpaid"
      ? payRaw.settlement
      : "unpaid";
  return {
    id: str(r.id),
    revision: int(r.revision, 1),
    status: r.status === "incomplete" ? "incomplete" : "complete",
    supplier,
    supplierDocumentNumber: optStr(r.supplierDocumentNumber),
    issuedOn: optStr(r.issuedOn),
    taxableSupplyOn: optStr(r.taxableSupplyOn),
    dueOn: optStr(r.dueOn),
    currency: optStr(r.currency),
    total: optDecimalToString(r.total),
    vat: Arr.isArray(r.vat)
      ? Arr.map(r.vat, (line) => {
          const l = asRecord(line);
          return {
            treatment: str(l.treatment, "standard"),
            base: decimalToString(l.base),
            vat: decimalToString(l.vat),
            selfAssessed:
              l.selfAssessed === "standard" || l.selfAssessed === "reduced" ? l.selfAssessed : null,
          };
        })
      : null,
    totals: parseVatBreakdown(r.totals),
    selfAssessed: Arr.isArray(r.selfAssessed) ? Arr.map(r.selfAssessed, parseVatBucket) : [],
    fx,
    totalCzk: optDecimalToString(r.totalCzk),
    deductibility,
    deductibleVat: parseOptMoney(r.deductibleVat),
    deductibleVatCzk: optDecimalToString(r.deductibleVatCzk),
    category: optStr(r.category),
    tags: Arr.isArray(r.tags) ? Arr.filter(r.tags, (x): x is string => readString(x)) : [],
    note: optStr(r.note),
    attachments: Arr.isArray(r.attachments) ? Arr.map(r.attachments, normalizeAttachment) : [],
    payment: {
      settlement,
      paid: parseOptMoney(payRaw.paid),
      payments: int(payRaw.payments, 0),
    },
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
};

export const normalizePayment = (raw: PaymentView): PaymentRecord => {
  const r = asRecord(raw);
  return {
    id: str(r.id),
    revision: int(r.revision, 1),
    amount: parseMoney(r.amount),
    paidOn: str(r.paidOn),
    method: readPaymentMethod(r.method) ? r.method : "bank_transfer",
    note: optStr(r.note),
    createdAt: str(r.createdAt),
  };
};

const parseAmountRow = Fn.compose(
  asRecord,
  (r): ReportAmountRow => ({
    key: str(r.key),
    label: optStr(r.label),
    count: int(r.count),
    net: parseMoney(r.net),
    vat: parseMoney(r.vat),
    gross: parseMoney(r.gross),
    original: parseOptMoney(r.original),
  }),
);

const parseAmountTotals = (raw: WireField) => {
  const r = asRecord(raw);
  return {
    count: int(r.count),
    net: parseMoney(r.net),
    vat: parseMoney(r.vat),
    gross: parseMoney(r.gross),
  };
};

const parseVatLine = Fn.compose(asRecord, (r): VatLineRecord => {
  const docs = Arr.isArray(r.documents)
    ? Arr.map(r.documents, (d) => {
        const dr = asRecord(d);
        return dr._tag === "Expense"
          ? ({ _tag: "Expense", id: str(dr.id) } as const)
          : ({ _tag: "Document", id: str(dr.id) } as const);
      })
    : [];
  return {
    month: str(r.month),
    treatment: str(r.treatment, "standard"),
    ratePercent: decimalToString(r.ratePercent),
    base: parseMoney(r.base),
    vat: parseMoney(r.vat),
    documents: docs,
  };
});

export const normalizeReport: {
  (fallbackKind: ReportKind): (raw: ReportView) => ReportDataRecord;
  (raw: ReportView, fallbackKind: ReportKind): ReportDataRecord;
} = Fn.dual(2, (raw: ReportView, fallbackKind: ReportKind): ReportDataRecord => {
  const r = asRecord(raw);
  const periodRaw = asRecord(r.period);
  const period = { from: str(periodRaw.from), to: str(periodRaw.to) };
  const kind = str(r.report, fallbackKind);
  switch (kind) {
    case "expenses":
      return {
        report: "expenses",
        period,
        groupBy:
          r.groupBy === "contact" || r.groupBy === "currency" || r.groupBy === "category"
            ? r.groupBy
            : "month",
        rows: Arr.isArray(r.rows) ? Arr.map(r.rows, parseAmountRow) : [],
        totals: parseAmountTotals(r.totals),
        incomplete: int(r.incomplete),
      };
    case "profit": {
      const totalsRaw = asRecord(r.totals);
      return {
        report: "profit",
        period,
        rows: Arr.isArray(r.rows)
          ? Arr.map(r.rows, (row) => {
              const rr = asRecord(row);
              return {
                month: str(rr.month),
                revenue: parseMoney(rr.revenue),
                expenses: parseMoney(rr.expenses),
                profit: parseMoney(rr.profit),
              };
            })
          : [],
        totals: {
          revenue: parseMoney(totalsRaw.revenue),
          expenses: parseMoney(totalsRaw.expenses),
          profit: parseMoney(totalsRaw.profit),
        },
      };
    }
    case "cashflow": {
      const totalsRaw = asRecord(r.totals);
      return {
        report: "cashflow",
        period,
        points: Arr.isArray(r.points)
          ? Arr.map(r.points, (pt) => {
              const pr = asRecord(pt);
              return {
                month: str(pr.month),
                in: parseMoney(pr.in),
                out: parseMoney(pr.out),
                net: parseMoney(pr.net),
              };
            })
          : [],
        totals: {
          in: parseMoney(totalsRaw.in),
          out: parseMoney(totalsRaw.out),
          net: parseMoney(totalsRaw.net),
        },
      };
    }
    case "receivables": {
      const overdueRaw = asRecord(r.overdue);
      return {
        report: "receivables",
        period,
        asOf: str(r.asOf, period.to),
        buckets: Arr.isArray(r.buckets)
          ? Arr.map(r.buckets, (b) => {
              const br = asRecord(b);
              const bucket =
                br.bucket === "1_30" ||
                br.bucket === "31_60" ||
                br.bucket === "61_90" ||
                br.bucket === "over_90"
                  ? br.bucket
                  : "not_due";
              return {
                bucket,
                count: int(br.count),
                total: parseMoney(br.total),
                documents: Arr.isArray(br.documents)
                  ? Arr.map(br.documents, (doc) => {
                      const dr = asRecord(doc);
                      const c = asRecord(dr.contact);
                      return {
                        id: str(dr.id),
                        kind: str(dr.kind, "invoice"),
                        number: optStr(dr.number),
                        contact: { id: optStr(c.id), name: str(c.name) },
                        currency: str(dr.currency, "CZK"),
                        dueOn: optStr(dr.dueOn),
                        daysOverdue: int(dr.daysOverdue),
                        outstanding: parseMoney(dr.outstanding, str(dr.currency, "CZK")),
                        outstandingCzk: parseMoney(dr.outstandingCzk, "CZK"),
                      };
                    })
                  : [],
              };
            })
          : [],
        total: parseMoney(r.total),
        overdue: { total: parseMoney(overdueRaw.total), count: int(overdueRaw.count) },
      };
    }
    case "vat_summary": {
      const totalsRaw = asRecord(r.totals);
      return {
        report: "vat_summary",
        period,
        output: Arr.isArray(r.output) ? Arr.map(r.output, parseVatLine) : [],
        input: Arr.isArray(r.input) ? Arr.map(r.input, parseVatLine) : [],
        totals: {
          output: parseMoney(totalsRaw.output),
          input: parseMoney(totalsRaw.input),
          payable: parseMoney(totalsRaw.payable),
        },
      };
    }
    default:
      return {
        report: "revenue",
        period,
        groupBy: r.groupBy === "contact" || r.groupBy === "currency" ? r.groupBy : "month",
        rows: Arr.isArray(r.rows) ? Arr.map(r.rows, parseAmountRow) : [],
        totals: parseAmountTotals(r.totals),
      };
  }
});

// --- Formatting & domain helpers -----------------------------------------------------------------

export const canWrite = (ctx: PageContext): boolean =>
  ctx.workspace !== null && ctx.workspace.role !== "accountant" && !ctx.workspace.closed;

export const moneyText: {
  (amount: string, currency: string): (locale: Locale) => string;
  (locale: Locale, amount: string, currency: string): string;
} = Fn.dual(3, (locale: Locale, amount: string, currency: string): string =>
  Format.formatMoney(locale, { amount, currency }),
);

export const dateText: {
  (iso: string | null): (locale: Locale) => string;
  (locale: Locale, iso: string | null): string;
} = Fn.dual(2, (locale: Locale, iso: string | null): string =>
  iso === null || iso === "" ? "—" : Format.formatDate(locale, iso),
);

export const settlementTone = (settlement: ExpenseSettlementLiteral): BadgeTone => {
  switch (settlement) {
    case "paid":
      return "paid";
    case "partially_paid":
      return "proforma";
    case "overpaid":
      return "overdue";
    case "unpaid":
      return "draft";
  }
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const CURRENCIES: ReadonlyArray<CurrencyCode> = [
  CurrencyCode.make("CZK"),
  CurrencyCode.make("EUR"),
  CurrencyCode.make("USD"),
  CurrencyCode.make("GBP"),
  CurrencyCode.make("PLN"),
  CurrencyCode.make("CHF"),
];

export const VAT_TREATMENTS: ReadonlyArray<VatTreatment> = [
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

/** Default Czech VAT rate percent for a treatment (post-2024-01-01). */
export const vatRatePercent = (treatment: string): number => {
  if (treatment === "standard") return 21;
  if (treatment === "reduced") return 12;
  return 0;
};

const whitespace = /\s+/g;
const userDecimal = /^-?\d+(\.\d+)?$/;
const unsignedInteger = /^\d+$/;

/** Parse a user-typed decimal string (accepts comma or dot). */
export const parseUserDecimal = (raw: string): number | null => {
  const normalized = Str.replace(",", ".")(Str.replace(whitespace, "")(Str.trim(raw)));
  if (normalized === "" || !userDecimal.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Round half away from zero to `decimals` places (matches Czech VAT rounding rule). */
const roundHalfAway = (value: number, decimals = 2): number => {
  const factor = 10 ** decimals;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON)) / factor;
};

export const formatDecimalFixed: {
  (decimals: number): (value: number) => string;
  (value: number, decimals: number): string;
} = Fn.dual(2, (value: number, decimals: number): string =>
  roundHalfAway(value, decimals).toFixed(decimals),
);

/** Live preview math for an expense's VAT lines, deductible VAT, and CZK FX equivalent. */
export interface ExpenseMathPreview {
  readonly sumBase: number;
  readonly sumVat: number;
  readonly sumGross: number;
  readonly total: number | null;
  readonly difference: number | null;
  readonly deductiblePercent: number;
  readonly deductibleVat: number;
  readonly fxRate: number | null;
  readonly fxQuantity: number;
  readonly totalCzk: number | null;
  readonly deductibleVatCzk: number | null;
}

export const computeExpensePreview = (input: {
  readonly total: string;
  readonly currency: string;
  readonly vatLines: ReadonlyArray<{
    readonly treatment: string;
    readonly base: string;
    readonly vat: string;
    readonly selfAssessed: "standard" | "reduced" | null;
  }>;
  readonly deductibilityMode: "full" | "none" | "partial";
  readonly deductibilityPercent: string;
  readonly fxRate: string;
  readonly fxQuantity: number;
}): ExpenseMathPreview => {
  let sumBase = 0;
  let sumVat = 0;
  let selfAssessedVat = 0;
  for (const line of input.vatLines) {
    const base = parseUserDecimal(line.base) ?? 0;
    const vat = parseUserDecimal(line.vat) ?? 0;
    sumBase = roundHalfAway(sumBase + base, 2);
    sumVat = roundHalfAway(sumVat + vat, 2);
    if (line.treatment === "reverse_charge" || line.treatment === "exempt_intra_eu_goods") {
      const rate = vatRatePercent(line.selfAssessed ?? "standard");
      selfAssessedVat = roundHalfAway(selfAssessedVat + roundHalfAway((base * rate) / 100, 2), 2);
    }
  }
  const sumGross = roundHalfAway(sumBase + sumVat, 2);
  const total = parseUserDecimal(input.total);
  const difference =
    total === null || input.vatLines.length === 0 ? null : roundHalfAway(total - sumGross, 2);

  const deductiblePercent =
    input.deductibilityMode === "full"
      ? 100
      : input.deductibilityMode === "none"
        ? 0
        : Math.max(1, Math.min(99, Math.trunc(parseUserDecimal(input.deductibilityPercent) ?? 50)));
  const claimableVat = roundHalfAway(sumVat + selfAssessedVat, 2);
  const deductibleVat = roundHalfAway((claimableVat * deductiblePercent) / 100, 2);

  const fxRate = input.currency === "CZK" ? null : parseUserDecimal(input.fxRate);
  const fxQuantity = Math.max(1, input.fxQuantity || 1);
  const totalCzk =
    total === null
      ? null
      : input.currency === "CZK"
        ? roundHalfAway(total, 2)
        : fxRate !== null && fxRate > 0
          ? roundHalfAway((total * fxRate) / fxQuantity, 2)
          : null;
  const deductibleVatCzk =
    input.currency === "CZK"
      ? deductibleVat
      : fxRate !== null && fxRate > 0
        ? roundHalfAway((deductibleVat * fxRate) / fxQuantity, 2)
        : null;

  return {
    sumBase,
    sumVat,
    sumGross,
    total,
    difference,
    deductiblePercent,
    deductibleVat,
    fxRate,
    fxQuantity,
    totalCzk,
    deductibleVatCzk,
  };
};

// --- Report period helpers -----------------------------------------------------------------------

const lastDayOfMonth = (year: number, month: number): number =>
  DateTime.makeUnsafe({ year, month, day: 1 }).pipe(
    DateTime.endOf("month"),
    DateTime.getPartUtc("day"),
  );

const quarterPeriod = /^(\d{4})-Q([1-4])$/;
const monthPeriod = /^(\d{4})-(\d{2})$/;
const uuidSeparator = /-/g;

const pad2 = (n: number): string => Str.padStart(2, "0")(String(n));

/** Converts a Period (`2026`, `2026-Q4`, `2026-11`) into inclusive `{ from, to }` IsoDates. */
export const periodToRange = (period: ViewModels.Period): { from: IsoDate; to: IsoDate } => {
  const qMatch = quarterPeriod.exec(period);
  if (qMatch !== null) {
    const y = Number(qMatch[1]);
    const q = Number(qMatch[2]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      from: IsoDate.make(`${y}-${pad2(startMonth)}-01`),
      to: IsoDate.make(`${y}-${pad2(endMonth)}-${pad2(lastDayOfMonth(y, endMonth))}`),
    };
  }
  const mMatch = monthPeriod.exec(period);
  if (mMatch !== null) {
    const y = Number(mMatch[1]);
    const m = Number(mMatch[2]);
    return {
      from: IsoDate.make(`${y}-${pad2(m)}-01`),
      to: IsoDate.make(`${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`),
    };
  }
  const y = Number(Str.slice(0, 4)(period)) || 2026;
  return {
    from: IsoDate.make(`${y}-01-01`),
    to: IsoDate.make(`${y}-12-31`),
  };
};

export const periodOptions: {
  (
    locale: Locale,
  ): (
    currentPeriod: ViewModels.Period,
  ) => ReadonlyArray<{ readonly value: ViewModels.Period; readonly label: string }>;
  (
    currentPeriod: ViewModels.Period,
    locale: Locale,
  ): ReadonlyArray<{ readonly value: ViewModels.Period; readonly label: string }>;
} = Fn.dual(
  2,
  (
    currentPeriod: ViewModels.Period,
    locale: Locale,
  ): ReadonlyArray<{ readonly value: ViewModels.Period; readonly label: string }> => {
    const year = Number(Str.slice(0, 4)(currentPeriod)) || 2026;
    const prev = year - 1;
    const qLabel = (y: number, q: number) =>
      locale === "cs" ? `${q}. čtvrtletí ${y}` : `Q${q} ${y}`;
    const base: Array<{ readonly value: ViewModels.Period; readonly label: string }> = [
      { value: ViewModels.Period.make(String(year)), label: `${year}` },
      { value: ViewModels.Period.make(`${year}-Q4`), label: qLabel(year, 4) },
      { value: ViewModels.Period.make(`${year}-Q3`), label: qLabel(year, 3) },
      { value: ViewModels.Period.make(`${year}-Q2`), label: qLabel(year, 2) },
      { value: ViewModels.Period.make(`${year}-Q1`), label: qLabel(year, 1) },
      { value: ViewModels.Period.make(String(prev)), label: `${prev}` },
    ];
    if (!Arr.some(base, (o) => o.value === currentPeriod)) {
      base.unshift({ value: currentPeriod, label: currentPeriod });
    }
    return base;
  },
);

/** Generate an opaque idempotency key (alphanumeric, 8-128 chars). */
export const newIdempotencyKey = (prefix: string): string => {
  const rand = Str.replace(uuidSeparator, "")(SecureRandom.uuidV4Unsafe());
  return Str.slice(0, 64)(`${prefix}_${rand}`);
};

export const todayIso = (): IsoDate =>
  IsoDate.make(DateTime.formatIsoDateUtc(DateTime.nowUnsafe()));

/** Convert `ContactDefaultsRecord` into domain `ContactDefaults` for `OverrideForm` / `resolveBilling`. */
export const toDomainContactDefaults = (defaults: ContactDefaultsRecord): ContactDefaults =>
  Option.getOrElse(Schema.decodeUnknownOption(ContactDefaults)(defaults), () => ({}));

// --- Browser side-effect Commands (zero DOM access in update/view) -------------------------------

/** Trigger a same-origin file download (report CSV/PDF or expense attachment) inside a Command. */
export const downloadUrlCommand: {
  <M1, M2>(
    path: string,
    filename: string,
    onSuccess: () => M1,
    onFailure: (failure: Failure) => M2,
  ): (name: string) => PageCommand<M1 | M2>;
  <M1, M2>(
    name: string,
    path: string,
    filename: string,
    onSuccess: () => M1,
    onFailure: (failure: Failure) => M2,
  ): PageCommand<M1 | M2>;
} = Fn.dual(
  5,
  <M1, M2>(
    name: string,
    path: string,
    filename: string,
    onSuccess: () => M1,
    onFailure: (failure: Failure) => M2,
  ): PageCommand<M1 | M2> =>
    browserCommand<M1 | M2>(
      name,
      downloadFile({ path, filename }).pipe(
        Effect.match({ onSuccess, onFailure: (error) => onFailure(failureFromUnknown(error)) }),
      ),
    ),
);

/** Upload a multipart file attachment to an expense inside a Effect UI Command. */
export const uploadAttachmentCommand: {
  <M1, M2>(
    workspaceId: string,
    expenseId: string,
    file: File,
    onSuccess: (attachment: ExpenseAttachmentRecord) => M1,
    onFailure: (failure: Failure) => M2,
  ): (name: string) => PageCommand<M1 | M2>;
  <M1, M2>(
    name: string,
    workspaceId: string,
    expenseId: string,
    file: File,
    onSuccess: (attachment: ExpenseAttachmentRecord) => M1,
    onFailure: (failure: Failure) => M2,
  ): PageCommand<M1 | M2>;
} = Fn.dual(
  6,
  <M1, M2>(
    name: string,
    workspaceId: string,
    expenseId: string,
    file: File,
    onSuccess: (attachment: ExpenseAttachmentRecord) => M1,
    onFailure: (failure: Failure) => M2,
  ): PageCommand<M1 | M2> =>
    browserCommand<M1 | M2>(
      name,
      Effect.suspend(() => {
        const form = new FormData();
        form.append("file", file, file.name);
        const path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/expenses/${encodeURIComponent(expenseId)}/attachments`;
        const request = HttpClientRequest.post(`${browserOrigin()}${path}`).pipe(
          HttpClientRequest.bodyFormData(form),
        );
        return fetchBrowserOk(request).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map(normalizeAttachment),
          Effect.match({ onSuccess, onFailure: (error) => onFailure(failureFromUnknown(error)) }),
        );
      }),
    ),
);

/** Read an optional number from a string input for `Option.fromNullishOr`. */
export const optInt = (raw: string): Option.Option<number> => {
  const trimmed = Str.trim(raw);
  if (!unsignedInteger.test(trimmed)) return Option.none();
  return Option.some(Number(trimmed));
};
