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
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const Address = Schema.Struct({
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
});

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

const PaymentRounding = Schema.Literals(["none", "whole_unit"]);

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

const BrandingData = Schema.Struct({
  pdfTemplate: PdfTemplate,
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String),
  theme: Schema.NullOr(ThemeSource),
  logo: Schema.NullOr(ImageRef),
  stamp: Schema.NullOr(ImageRef),
});

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

const ibanWhitespace = /\s+/g;
const czechIban = /^CZ\d{22}$/;
const leadingZeros = /^0+/;

/** Derives a Czech domestic account number (`prefix-number/bank`) from a CZ IBAN, else null. */
export const czechAccountFromIban = (iban: string): string | null => {
  const clean = Str.toUpperCase(Str.replace(ibanWhitespace, "")(iban));
  if (!czechIban.test(clean)) return null;
  const bank = Str.slice(4, 8)(clean);
  const prefix = Str.replace(leadingZeros, "")(Str.slice(8, 14)(clean));
  const account = Str.replace(leadingZeros, "")(Str.slice(14, 24)(clean)) || "0";
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
const alphaRuns = /([A-Za-z]+)/;
const numberingRun = /^[YMN]+$/;
const numberingTokens = /(YYYY|YY|MM|N+)/;
const counterToken = /N+/;

export const previewNumberingPattern: {
  (nextCounter: number, refYear?: number, refMonth?: number): (pattern: string) => NumberingPreview;
  (pattern: string, nextCounter: number, refYear?: number, refMonth?: number): NumberingPreview;
} = Fn.dual(
  (args) => Schema.is(Schema.String)(args[0]),
  (pattern: string, nextCounter: number, refYear = 2026, refMonth = 11): NumberingPreview => {
    const trimmed = Str.trim(pattern);
    if (trimmed === "" || !counterToken.test(trimmed)) {
      return { samples: [], valid: false, tooLong: false };
    }
    const yy = Str.slice(-2)(String(refYear));
    const yyyy = String(refYear);
    const mm = Str.padStart(2, "0")(String(refMonth));
    const start = Math.max(1, Math.floor(nextCounter));

    const formatOne = (counter: number): string =>
      Arr.join(
        Arr.map(Str.split(trimmed, alphaRuns), (word, index) => {
          if (index % 2 === 0 || !numberingRun.test(word)) return word;
          return Arr.join(
            Arr.map(Str.split(word, numberingTokens), (token, tokenIndex) => {
              if (tokenIndex % 2 === 0) return token;
              if (token === "YYYY") return yyyy;
              if (token === "YY") return yy;
              return token === "MM" ? mm : Str.padStart(token.length, "0")(String(counter));
            }),
            "",
          );
        }),
        "",
      );

    const samples = [formatOne(start), formatOne(start + 1), formatOne(start + 2)];
    const tooLong = Arr.some(samples, (s) => s.length > 20);
    return { samples, valid: !tooLong, tooLong };
  },
);
