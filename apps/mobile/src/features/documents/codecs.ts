/**
 * Runtime decoders for domain views whose contract schemas are opaque (`Schema.Unknown` brands or
 * `OpenStruct`), plus Europe/Prague date and decimal parsing helpers.
 */

import {
  BankAccountId,
  type BankAccountView,
  ContactId,
  type ContactSnapshot,
  type ContactView,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  type DocumentSummary,
  IsoDate,
  type IssuerSnapshot,
  LineId,
  type LineView,
  type Locale,
  type Money,
  MoneyMath,
  NumberingSeriesId,
  PaymentId,
  PaymentMethod,
  type PaymentView,
  PriceListItemId,
  type PriceListItemView,
  TaxRegime,
  VatTreatment,
  type WorkspaceView,
} from "@kvitbit/domain/contract";
import { BUSINESS_TIME_ZONE } from "@kvitbit/ui-port/format";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

// --- Small runtime guards -----------------------------------------------------------------------

const WireRecord = Schema.Record(Schema.String, Schema.Unknown);
const emptyRecord = (): typeof WireRecord.Type => ({});
const asRecord = Fn.flow(Schema.decodeUnknownOption(WireRecord), Option.getOrElse(emptyRecord));
const asNullableString = Fn.flow(Schema.decodeUnknownOption(Schema.String), Option.getOrNull);
const readString = Schema.decodeUnknownOption(Schema.String);
const readBoolean = Schema.decodeUnknownOption(Schema.Boolean);
const readNumber = Schema.decodeUnknownOption(Schema.Finite);
const readStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const readDecimal = Schema.decodeUnknownOption(
  Schema.Union([Schema.BigDecimal, Schema.String, Schema.Finite]),
);
const readCurrency = Schema.decodeUnknownOption(CurrencyCode);
const readSeriesId = Schema.decodeUnknownOption(NumberingSeriesId);
const readVatTreatment = Schema.decodeUnknownOption(VatTreatment);

const toBigDecimal = (value: ReturnType<typeof asRecord>[string], fallback = "0") =>
  readDecimal(value).pipe(
    Option.flatMap((input) =>
      BigDecimal.isBigDecimal(input)
        ? Option.some(input)
        : BigDecimal.fromString(Str.trim(String(input))),
    ),
    Option.getOrElse(() =>
      Option.getOrElse(BigDecimal.fromString(fallback), () => BigDecimal.fromBigInt(0n)),
    ),
  );

/** Parses user-typed decimal text (accepts `.` or `,`, ignores spaces). */
export const parseDecimalInput = (raw: string): BigDecimal.BigDecimal | null => {
  const normalized = Str.replace(",", ".")(Str.replace(/\s+/g, "")(raw));
  if (normalized === "" || normalized === "-" || normalized === "." || normalized === "-.") {
    return null;
  }
  const parsed = BigDecimal.fromString(normalized);
  return Option.isSome(parsed) ? parsed.value : null;
};

/** Formats a BigDecimal or wire decimal into a plain editable string without scientific notation. */
export const decimalToInputString = (value: BigDecimal.BigDecimal | string | number): string => {
  const bd = BigDecimal.isBigDecimal(value) ? value : toBigDecimal(value);
  return bd.pipe(BigDecimal.normalize, BigDecimal.format);
};

const currencyOrCzk = Fn.flow(
  asNullableString,
  (currency) => readCurrency(Str.toUpperCase(currency ?? "")),
  Option.getOrElse(() => CurrencyCode.make("CZK")),
);

const parseMoney = Fn.flow(
  asRecord,
  (rec): Money => MoneyMath.make(toBigDecimal(rec.amount), currencyOrCzk(rec.currency)),
);

// --- Concrete view shapes -----------------------------------------------------------------------

export interface AddressView {
  readonly street: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly country: string;
}

const parseAddress = Fn.flow(
  asRecord,
  (rec): AddressView => ({
    street: asNullableString(rec.street),
    city: asNullableString(rec.city),
    postalCode: asNullableString(rec.postalCode),
    country: Option.getOrElse(readString(rec.country), () => "CZ"),
  }),
);

export const formatAddress = (address: AddressView): string => {
  const cityLine = Arr.join(
    Arr.filter(
      [address.postalCode, address.city],
      (part): part is string => part !== null && part !== "",
    ),
    " ",
  );
  return Arr.join(
    Arr.filter(
      [address.street, cityLine, address.country],
      (part): part is string => part !== null && part !== "",
    ),
    ", ",
  );
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
    id: DocumentId.make(asNullableString(rec.id) ?? ""),
    kind: Option.getOrElse(Schema.decodeUnknownOption(DocumentKind)(rec.kind), () => "invoice"),
    number: asNullableString(rec.number),
    status: Option.getOrElse(Schema.decodeUnknownOption(DocumentStatus)(rec.status), () => "draft"),
    locked: Option.getOrElse(readBoolean(rec.locked), () => false),
    settlement: Option.getOrElse(
      Schema.decodeUnknownOption(DocumentSettlement)(rec.settlement),
      () => "unpaid",
    ),
    overdue: Option.getOrElse(readBoolean(rec.overdue), () => false),
    revision: Option.getOrElse(readNumber(rec.revision), () => 0),
    contact: {
      id: ContactId.make(asNullableString(contact.id) ?? ""),
      name: asNullableString(contact.name) ?? "",
    },
    issuedOn: IsoDate.make(asNullableString(rec.issuedOn) ?? ""),
    dueOn: IsoDate.make(asNullableString(rec.dueOn) ?? ""),
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
    contactId: ContactId.make(asNullableString(rec.contactId) ?? ""),
    name: asNullableString(rec.name) ?? "",
    ico: asNullableString(rec.ico),
    dic: asNullableString(rec.dic),
    legalForm: asNullableString(rec.legalForm),
    address: parseAddress(rec.address),
    billingEmails: Option.getOrElse(readStrings(rec.billingEmails), () => []),
  };
};

interface IssuerBankAccountView {
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
    name: asNullableString(rec.name) ?? "",
    ico: asNullableString(rec.ico),
    dic: asNullableString(rec.dic),
    address: parseAddress(rec.address),
    registerEntry: asNullableString(rec.registerEntry),
    email: asNullableString(rec.email),
    phone: asNullableString(rec.phone),
    web: asNullableString(rec.web),
    regime: Option.getOrElse(
      Schema.decodeUnknownOption(TaxRegime)(rec.regime),
      () => "non_vat_payer",
    ),
    bankAccount:
      bank === null
        ? null
        : {
            id: BankAccountId.make(asNullableString(bank.id) ?? ""),
            name: asNullableString(bank.name),
            currency: currencyOrCzk(bank.currency),
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
    id: LineId.make(asNullableString(rec.id) ?? ""),
    item: Option.getOrNull(Schema.decodeUnknownOption(PriceListItemId)(rec.item)),
    description: asNullableString(rec.description) ?? "",
    quantity: toBigDecimal(rec.quantity, "1"),
    unit: asNullableString(rec.unit),
    unitPrice: toBigDecimal(rec.unitPrice, "0"),
    treatment: Option.getOrElse(
      Schema.decodeUnknownOption(VatTreatment)(rec.treatment),
      () => "standard",
    ),
    ratePercent: toBigDecimal(rec.ratePercent, "0"),
    amount: toBigDecimal(rec.amount, "0"),
    deducts: Option.getOrNull(Schema.decodeUnknownOption(DocumentId)(rec.deducts)),
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
    id: PaymentId.make(asNullableString(rec.id) ?? ""),
    revision: Option.getOrElse(readNumber(rec.revision), () => 0),
    amount: parseMoney(rec.amount),
    paidOn: IsoDate.make(asNullableString(rec.paidOn) ?? ""),
    method: Option.getOrElse(
      Schema.decodeUnknownOption(PaymentMethod)(rec.method),
      () => "bank_transfer",
    ),
    note: asNullableString(rec.note),
    taxDocument: Option.getOrNull(Schema.decodeUnknownOption(DocumentId)(rec.taxDocument)),
    createdAt: asNullableString(rec.createdAt) ?? "",
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
    id: ContactId.make(asNullableString(rec.id) ?? ""),
    name: asNullableString(rec.name) ?? "",
    ico: asNullableString(rec.ico),
    dic: asNullableString(rec.dic),
    billingEmails: Option.getOrElse(readStrings(rec.billingEmails), () => []),
    archived: Option.getOrElse(readBoolean(rec.archived), () => false),
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
    id: PriceListItemId.make(asNullableString(rec.id) ?? ""),
    name: asNullableString(rec.name) ?? "",
    description: asNullableString(rec.description),
    unit: asNullableString(rec.unit),
    unitPrice: toBigDecimal(rec.unitPrice, "0"),
    currency: currencyOrCzk(rec.currency),
    vat: Option.getOrNull(readVatTreatment(rec.vat)),
    archived: Option.getOrElse(readBoolean(rec.archived), () => false),
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
    id: BankAccountId.make(asNullableString(rec.id) ?? ""),
    name: asNullableString(rec.name),
    iban: asNullableString(rec.iban) ?? "",
    bic: asNullableString(rec.bic),
    currency: currencyOrCzk(rec.currency),
    isDefault: Option.getOrElse(readBoolean(rec.isDefault), () => false),
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

export const parseWorkspaceDefaults: {
  (raw: WorkspaceView | null, fallbackRegime: TaxRegime): WorkspaceDefaultsView;
  (fallbackRegime: TaxRegime): (raw: WorkspaceView | null) => WorkspaceDefaultsView;
} = Fn.dual(2, (raw: WorkspaceView | null, fallbackRegime: TaxRegime): WorkspaceDefaultsView => {
  const rec = asRecord(raw);
  const defaults = asRecord(rec.defaults);
  const preferred = asRecord(defaults.preferredSeriesByKind);
  const preferredSeriesByKind: Partial<Record<DocumentKind, NumberingSeriesId>> = {};
  for (const kind of ["invoice", "proforma", "payment_tax_document", "credit_note"] as const) {
    const id = readSeriesId(preferred[kind]);
    if (Option.isSome(id)) preferredSeriesByKind[kind] = id.value;
  }
  const rounding = defaults.paymentRounding === "whole_unit" ? "whole_unit" : "none";
  return {
    taxRegime: Option.getOrElse(
      Schema.decodeUnknownOption(TaxRegime)(rec.taxRegime),
      () => fallbackRegime,
    ),
    currency: currencyOrCzk(defaults.currency),
    language: defaults.language === "en" ? "en" : "cs",
    dueDays: Option.getOrElse(readNumber(defaults.dueDays), () => 14),
    paymentMethod: Option.getOrElse(
      Schema.decodeUnknownOption(PaymentMethod)(defaults.paymentMethod),
      () => "bank_transfer",
    ),
    paymentRounding: rounding,
    note: asNullableString(defaults.defaultNote) ?? asNullableString(defaults.note),
    preferredSeriesByKind,
  };
});

/** Current calendar date in Europe/Prague (`YYYY-MM-DD`). */
export const todayIsoPrague = (now?: Date): IsoDate =>
  (now === undefined ? DateTime.nowUnsafe() : DateTime.makeUnsafe(now)).pipe(
    DateTime.setZoneNamedUnsafe(BUSINESS_TIME_ZONE),
    DateTime.formatIsoDate,
    IsoDate.make,
  );

/** Adds `days` calendar days to an ISO date (`YYYY-MM-DD`). */
export const addDaysIso: {
  (iso: string, days: number): IsoDate;
  (days: number): (iso: string) => IsoDate;
} = Fn.dual(2, (iso: string, days: number): IsoDate => {
  const parsed = Schema.decodeOption(IsoDate)(iso);
  if (Option.isNone(parsed)) return todayIsoPrague();
  return DateTime.makeUnsafe(`${parsed.value}T00:00:00Z`).pipe(
    DateTime.add({ days }),
    DateTime.formatIsoDateUtc,
    IsoDate.make,
  );
});
