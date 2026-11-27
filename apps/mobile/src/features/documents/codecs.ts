/**
 * Runtime decoders for domain views whose contract schemas are opaque (`Schema.Unknown` brands or
 * `OpenStruct`), plus Europe/Prague date and decimal parsing helpers.
 */
import {
  type BankAccountId,
  type BankAccountView,
  type ContactId,
  type ContactSnapshot,
  type ContactView,
  type CurrencyCode,
  type DocumentId,
  type DocumentKind,
  type DocumentSettlement,
  type DocumentStatus,
  type DocumentSummary,
  type IsoDate,
  type IssuerSnapshot,
  type LineId,
  type LineView,
  type Locale,
  type Money,
  MoneyMath,
  type NumberingSeriesId,
  type PaymentId,
  type PaymentMethod,
  type PaymentView,
  type PriceListItemId,
  type PriceListItemView,
  type TaxRegime,
  type VatTreatment,
  type WorkspaceView,
} from "@kvitbit/domain/contract";
import { BUSINESS_TIME_ZONE, parseIsoDate } from "@kvitbit/ui-port/format";
import { BigDecimal, Option } from "effect";

// --- Small runtime guards -----------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const toBigDecimal = (value: unknown, fallback = "0"): BigDecimal.BigDecimal => {
  if (BigDecimal.isBigDecimal(value)) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = BigDecimal.fromString(String(value).trim());
    if (Option.isSome(parsed)) return parsed.value;
  }
  return Option.getOrElse(BigDecimal.fromString(fallback), () => BigDecimal.fromBigInt(0n));
};

/** Parses user-typed decimal text (accepts `.` or `,`, ignores spaces). */
export const parseDecimalInput = (raw: string): BigDecimal.BigDecimal | null => {
  const normalized = raw.replace(/\s+/g, "").replace(",", ".");
  if (normalized === "" || normalized === "-" || normalized === "." || normalized === "-.") {
    return null;
  }
  const parsed = BigDecimal.fromString(normalized);
  return Option.isSome(parsed) ? parsed.value : null;
};

/** Formats a BigDecimal or wire decimal into a plain editable string without scientific notation. */
export const decimalToInputString = (value: BigDecimal.BigDecimal | string | number): string => {
  const bd = BigDecimal.isBigDecimal(value) ? value : toBigDecimal(value);
  return BigDecimal.format(BigDecimal.normalize(bd));
};

const parseMoney = (value: unknown, fallbackCurrency = "CZK"): Money => {
  const rec = asRecord(value);
  const currency = asString(rec.currency, fallbackCurrency).toUpperCase() as CurrencyCode;
  return MoneyMath.make(toBigDecimal(rec.amount), currency);
};

// --- Concrete view shapes -----------------------------------------------------------------------

export interface AddressView {
  readonly street: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly country: string;
}

const parseAddress = (value: unknown): AddressView => {
  const rec = asRecord(value);
  return {
    street: asNullableString(rec.street),
    city: asNullableString(rec.city),
    postalCode: asNullableString(rec.postalCode),
    country: asString(rec.country, "CZ"),
  };
};

export const formatAddress = (address: AddressView): string => {
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(" ");
  return [address.street, cityLine, address.country].filter(Boolean).join(", ");
};

export interface DocumentSummaryView {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly number: string | null;
  readonly status: DocumentStatus;
  readonly locked: boolean;
  readonly settlement: DocumentSettlement;
  readonly overdue: boolean;
  readonly revision: number;
  readonly contact: { readonly id: ContactId; readonly name: string };
  readonly issuedOn: IsoDate;
  readonly dueOn: IsoDate;
  readonly total: Money;
}

export const parseDocumentSummary = (raw: DocumentSummary): DocumentSummaryView => {
  const rec = asRecord(raw);
  const contact = asRecord(rec.contact);
  return {
    id: asString(rec.id) as DocumentId,
    kind: asString(rec.kind, "invoice") as DocumentKind,
    number: asNullableString(rec.number),
    status: asString(rec.status, "draft") as DocumentStatus,
    locked: asBoolean(rec.locked),
    settlement: asString(rec.settlement, "unpaid") as DocumentSettlement,
    overdue: asBoolean(rec.overdue),
    revision: asNumber(rec.revision),
    contact: {
      id: asString(contact.id) as ContactId,
      name: asString(contact.name),
    },
    issuedOn: asString(rec.issuedOn) as IsoDate,
    dueOn: asString(rec.dueOn) as IsoDate,
    total: parseMoney(rec.total),
  };
};

export interface ContactSnapshotView {
  readonly contactId: ContactId;
  readonly name: string;
  readonly ico: string | null;
  readonly dic: string | null;
  readonly legalForm: string | null;
  readonly address: AddressView;
  readonly billingEmails: ReadonlyArray<string>;
}

export const parseContactSnapshot = (raw: ContactSnapshot): ContactSnapshotView => {
  const rec = asRecord(raw);
  return {
    contactId: asString(rec.contactId) as ContactId,
    name: asString(rec.name),
    ico: asNullableString(rec.ico),
    dic: asNullableString(rec.dic),
    legalForm: asNullableString(rec.legalForm),
    address: parseAddress(rec.address),
    billingEmails: asStringArray(rec.billingEmails),
  };
};

export interface IssuerBankAccountView {
  readonly id: BankAccountId;
  readonly name: string | null;
  readonly currency: CurrencyCode;
  readonly accountNumber: string | null;
  readonly iban: string | null;
  readonly bic: string | null;
}

export interface IssuerSnapshotView {
  readonly name: string;
  readonly ico: string | null;
  readonly dic: string | null;
  readonly address: AddressView;
  readonly registerEntry: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly web: string | null;
  readonly regime: TaxRegime;
  readonly bankAccount: IssuerBankAccountView | null;
}

export const parseIssuerSnapshot = (raw: IssuerSnapshot): IssuerSnapshotView => {
  const rec = asRecord(raw);
  const bank =
    rec.bankAccount === null || rec.bankAccount === undefined ? null : asRecord(rec.bankAccount);
  return {
    name: asString(rec.name),
    ico: asNullableString(rec.ico),
    dic: asNullableString(rec.dic),
    address: parseAddress(rec.address),
    registerEntry: asNullableString(rec.registerEntry),
    email: asNullableString(rec.email),
    phone: asNullableString(rec.phone),
    web: asNullableString(rec.web),
    regime: asString(rec.regime, "non_vat_payer") as TaxRegime,
    bankAccount:
      bank === null
        ? null
        : {
            id: asString(bank.id) as BankAccountId,
            name: asNullableString(bank.name),
            currency: asString(bank.currency, "CZK").toUpperCase() as CurrencyCode,
            accountNumber: asNullableString(bank.accountNumber),
            iban: asNullableString(bank.iban),
            bic: asNullableString(bank.bic),
          },
  };
};

export interface LineItemView {
  readonly id: LineId;
  readonly item: PriceListItemId | null;
  readonly description: string;
  readonly quantity: BigDecimal.BigDecimal;
  readonly unit: string | null;
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly treatment: VatTreatment;
  readonly ratePercent: BigDecimal.BigDecimal;
  readonly amount: BigDecimal.BigDecimal;
  readonly deducts: DocumentId | null;
}

export const parseLineView = (raw: LineView): LineItemView => {
  const rec = asRecord(raw);
  return {
    id: asString(rec.id) as LineId,
    item: asNullableString(rec.item) as PriceListItemId | null,
    description: asString(rec.description),
    quantity: toBigDecimal(rec.quantity, "1"),
    unit: asNullableString(rec.unit),
    unitPrice: toBigDecimal(rec.unitPrice, "0"),
    treatment: asString(rec.treatment, "standard") as VatTreatment,
    ratePercent: toBigDecimal(rec.ratePercent, "0"),
    amount: toBigDecimal(rec.amount, "0"),
    deducts: asNullableString(rec.deducts) as DocumentId | null,
  };
};

export interface PaymentRecordView {
  readonly id: PaymentId;
  readonly revision: number;
  readonly amount: Money;
  readonly paidOn: IsoDate;
  readonly method: PaymentMethod;
  readonly note: string | null;
  readonly taxDocument: DocumentId | null;
  readonly createdAt: string;
}

export const parsePaymentView = (raw: PaymentView): PaymentRecordView => {
  const rec = asRecord(raw);
  return {
    id: asString(rec.id) as PaymentId,
    revision: asNumber(rec.revision),
    amount: parseMoney(rec.amount),
    paidOn: asString(rec.paidOn) as IsoDate,
    method: asString(rec.method, "bank_transfer") as PaymentMethod,
    note: asNullableString(rec.note),
    taxDocument: asNullableString(rec.taxDocument) as DocumentId | null,
    createdAt: asString(rec.createdAt),
  };
};

export interface ContactOption {
  readonly id: ContactId;
  readonly name: string;
  readonly ico: string | null;
  readonly dic: string | null;
  readonly billingEmails: ReadonlyArray<string>;
  readonly archived: boolean;
  readonly defaults: ContactView["defaults"];
}

export const parseContactOption = (raw: ContactView): ContactOption => {
  const rec = asRecord(raw);
  return {
    id: asString(rec.id) as ContactId,
    name: asString(rec.name),
    ico: asNullableString(rec.ico),
    dic: asNullableString(rec.dic),
    billingEmails: asStringArray(rec.billingEmails),
    archived: asBoolean(rec.archived),
    defaults: raw.defaults,
  };
};

export interface PriceListOption {
  readonly id: PriceListItemId;
  readonly name: string;
  readonly description: string | null;
  readonly unit: string | null;
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly currency: CurrencyCode;
  readonly vat: VatTreatment | null;
  readonly archived: boolean;
}

export const parsePriceListOption = (raw: PriceListItemView): PriceListOption => {
  const rec = asRecord(raw);
  return {
    id: asString(rec.id) as PriceListItemId,
    name: asString(rec.name),
    description: asNullableString(rec.description),
    unit: asNullableString(rec.unit),
    unitPrice: toBigDecimal(rec.unitPrice, "0"),
    currency: asString(rec.currency, "CZK").toUpperCase() as CurrencyCode,
    vat: (asNullableString(rec.vat) as VatTreatment | null) ?? null,
    archived: asBoolean(rec.archived),
  };
};

export interface BankAccountOption {
  readonly id: BankAccountId;
  readonly name: string | null;
  readonly iban: string;
  readonly bic: string | null;
  readonly currency: CurrencyCode;
  readonly isDefault: boolean;
}

export const parseBankAccountOption = (raw: BankAccountView): BankAccountOption => {
  const rec = asRecord(raw);
  return {
    id: asString(rec.id) as BankAccountId,
    name: asNullableString(rec.name),
    iban: asString(rec.iban),
    bic: asNullableString(rec.bic),
    currency: asString(rec.currency, "CZK").toUpperCase() as CurrencyCode,
    isDefault: asBoolean(rec.isDefault),
  };
};

export interface WorkspaceDefaultsView {
  readonly taxRegime: TaxRegime;
  readonly currency: CurrencyCode;
  readonly language: Locale;
  readonly dueDays: number;
  readonly paymentMethod: PaymentMethod;
  readonly paymentRounding: "none" | "whole_unit";
  readonly note: string | null;
  readonly preferredSeriesByKind: Readonly<Partial<Record<DocumentKind, NumberingSeriesId>>>;
}

export const parseWorkspaceDefaults = (
  raw: WorkspaceView | null,
  fallbackRegime: TaxRegime,
): WorkspaceDefaultsView => {
  const rec = asRecord(raw);
  const defaults = asRecord(rec.defaults);
  const preferred = asRecord(defaults.preferredSeriesByKind);
  const preferredSeriesByKind: Partial<Record<DocumentKind, NumberingSeriesId>> = {};
  for (const kind of ["invoice", "proforma", "payment_tax_document", "credit_note"] as const) {
    const id = preferred[kind];
    if (typeof id === "string" && id.length > 0) {
      preferredSeriesByKind[kind] = id as NumberingSeriesId;
    }
  }
  const rounding = defaults.paymentRounding === "whole_unit" ? "whole_unit" : "none";
  return {
    taxRegime: (asString(rec.taxRegime, fallbackRegime) as TaxRegime) || fallbackRegime,
    currency: asString(defaults.currency, "CZK").toUpperCase() as CurrencyCode,
    language: defaults.language === "en" ? "en" : "cs",
    dueDays: asNumber(defaults.dueDays, 14),
    paymentMethod: asString(defaults.paymentMethod, "bank_transfer") as PaymentMethod,
    paymentRounding: rounding,
    note: asNullableString(defaults.defaultNote) ?? asNullableString(defaults.note),
    preferredSeriesByKind,
  };
};

// --- Dates & idempotency ------------------------------------------------------------------------

/** Current calendar date in Europe/Prague (`YYYY-MM-DD`). */
export const todayIsoPrague = (now: Date = new Date()): IsoDate => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}` as IsoDate;
};

/** Adds `days` calendar days to an ISO date (`YYYY-MM-DD`). */
export const addDaysIso = (iso: string, days: number): IsoDate => {
  const parsed = parseIsoDate(iso);
  if (parsed === undefined) return todayIsoPrague();
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}` as IsoDate;
};

/** Mints one RFC 9562 UUIDv7 Idempotency-Key for a user write intent. */
