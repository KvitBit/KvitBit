export { apiCommand as cmd } from "../../app/commands";

/**
 * Concrete Schema models and pure helpers private to the Settings & Account page group.
 * Matches packages/core/src/modules/workspaces/model.ts wire shapes and api-contract views.
 */
import {
  BankAccountId,
  CurrencyCode,
  type DocumentKind,
  Hex,
  ImageRef,
  IsoDate,
  Locale,
  PaymentMethod,
  PdfTemplate,
  TaxRegime,
  ThemeSource,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain";
import { Option, Schema } from "effect";

export const Address = Schema.Struct({
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
});
export type Address = typeof Address.Type;

export const IssuingEntity = Schema.Struct({
  name: Schema.String,
  ico: Schema.NullOr(Schema.String),
  dic: Schema.NullOr(Schema.String),
  address: Address,
  legalForm: Schema.NullOr(Schema.String),
  registerEntry: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  web: Schema.NullOr(Schema.String),
});
export type IssuingEntity = typeof IssuingEntity.Type;

export const TaxRegimePeriod = Schema.Struct({
  regime: TaxRegime,
  effectiveFrom: IsoDate,
});
export type TaxRegimePeriod = typeof TaxRegimePeriod.Type;

export const PaymentRounding = Schema.Literals(["none", "whole_unit"]);
export type PaymentRounding = typeof PaymentRounding.Type;

export const WorkspaceDefaults = Schema.Struct({
  currency: CurrencyCode,
  language: Locale,
  dueDays: Schema.Int,
  paymentMethod: PaymentMethod,
  defaultNote: Schema.NullOr(Schema.String),
  paymentRounding: PaymentRounding,
  paymentTaxDocumentAutoSend: Schema.Boolean,
});
export type WorkspaceDefaults = typeof WorkspaceDefaults.Type;

export const ReminderSchedule = Schema.Struct({
  enabled: Schema.Boolean,
  proformas: Schema.Boolean,
  offsetsDays: Schema.Array(Schema.Int),
});
export type ReminderSchedule = typeof ReminderSchedule.Type;

export const BankAccount = Schema.Struct({
  id: BankAccountId,
  name: Schema.NullOr(Schema.String),
  iban: Schema.String,
  bic: Schema.NullOr(Schema.String),
  currency: CurrencyCode,
  isDefault: Schema.Boolean,
  revision: Schema.Int,
});
export type BankAccount = typeof BankAccount.Type;

export const BrandingData = Schema.Struct({
  pdfTemplate: PdfTemplate,
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String),
  theme: Schema.NullOr(ThemeSource),
  logo: Schema.NullOr(ImageRef),
  stamp: Schema.NullOr(ImageRef),
});
export type BrandingData = typeof BrandingData.Type;

export const WorkspaceDetail = Schema.Struct({
  id: WorkspaceId,
  slug: WorkspaceSlug,
  name: Schema.String,
  closed: Schema.Boolean,
  revision: Schema.Int,
  issuingEntity: IssuingEntity,
  taxRegime: TaxRegime,
  taxRegimeHistory: Schema.Array(TaxRegimePeriod),
  defaults: WorkspaceDefaults,
  reminderPolicy: ReminderSchedule,
  bankAccounts: Schema.Array(BankAccount),
  branding: BrandingData,
});
export type WorkspaceDetail = typeof WorkspaceDetail.Type;

export const PasskeyItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  deviceType: Schema.NullOr(Schema.String),
});
export type PasskeyItem = typeof PasskeyItem.Type;

export const SessionItem = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  userAgent: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  current: Schema.Boolean,
});
export type SessionItem = typeof SessionItem.Type;

const decodeDetail = Schema.decodeUnknownOption(WorkspaceDetail);
const decodeBank = Schema.decodeUnknownOption(BankAccount);
const decodeBankList = Schema.decodeUnknownOption(Schema.Array(BankAccount));

export const parseWorkspaceDetail = (raw: unknown): Option.Option<WorkspaceDetail> =>
  decodeDetail(raw);

export const parseBankAccount = (raw: unknown): Option.Option<BankAccount> => decodeBank(raw);

export const parseBankAccounts = (raw: unknown): ReadonlyArray<BankAccount> =>
  Option.getOrElse(decodeBankList(raw), () => []);

export const CURRENCY_OPTIONS: ReadonlyArray<CurrencyCode> = [
  CurrencyCode.make("CZK"),
  CurrencyCode.make("EUR"),
  CurrencyCode.make("USD"),
  CurrencyCode.make("GBP"),
  CurrencyCode.make("PLN"),
];
export const DOCUMENT_KINDS: ReadonlyArray<DocumentKind> = [
  "invoice",
  "proforma",
  "payment_tax_document",
  "credit_note",
];
export const TAX_REGIMES: ReadonlyArray<TaxRegime> = [
  "vat_payer",
  "non_vat_payer",
  "identified_person",
];
export const PAYMENT_METHODS: ReadonlyArray<PaymentMethod> = [
  "bank_transfer",
  "cash",
  "card",
  "other",
];

/** Derives a Czech domestic account number (`prefix-number/bank`) from a CZ IBAN, else null. */
export const czechAccountFromIban = (iban: string): string | null => {
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^CZ\d{22}$/.test(clean)) return null;
  const bank = clean.slice(4, 8);
  const prefix = clean.slice(8, 14).replace(/^0+/, "");
  const account = clean.slice(14, 24).replace(/^0+/, "") || "0";
  return prefix === "" ? `${account}/${bank}` : `${prefix}-${account}/${bank}`;
};

export interface NumberingPreview {
  readonly samples: ReadonlyArray<string>;
  readonly valid: boolean;
  readonly tooLong: boolean;
}

/**
 * Pure live preview of a document numbering pattern (`YYYY`, `YY`, `MM`, `N…`), matching
 * @kvitbit/core's numbering grammar (word of only Y/M/N is tokens; other words are literals).
 */
export const previewNumberingPattern = (
  pattern: string,
  nextCounter: number,
  refYear = 2026,
  refMonth = 11,
): NumberingPreview => {
  const trimmed = pattern.trim();
  if (trimmed === "" || !/N+/.test(trimmed)) {
    return { samples: [], valid: false, tooLong: false };
  }
  const yy = String(refYear).slice(-2);
  const yyyy = String(refYear);
  const mm = String(refMonth).padStart(2, "0");
  const start = Math.max(1, Math.floor(nextCounter));

  const formatOne = (counter: number): string =>
    trimmed.replace(/[A-Za-z]+/g, (word) => {
      if (!/^[YMN]+$/.test(word)) return word;
      return word.replace(/YYYY|YY|MM|N+/g, (tok) => {
        if (tok === "YYYY") return yyyy;
        if (tok === "YY") return yy;
        if (tok === "MM") return mm;
        return String(counter).padStart(tok.length, "0");
      });
    });

  const samples = [formatOne(start), formatOne(start + 1), formatOne(start + 2)];
  const tooLong = samples.some((s) => s.length > 20);
  return { samples, valid: !tooLong, tooLong };
};
