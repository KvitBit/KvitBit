import {
  BankAccountId,
  type BankAccountView,
  CurrencyCode,
  Locale,
  PaymentMethod,
  TaxRegime,
  type WorkspaceBranding,
  type WorkspaceSlug,
  type WorkspaceView,
} from "@kvitbit/domain/contract";
import { SettingsSection } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

interface AddressData {
  readonly street: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface IssuingEntityData {
  readonly name: string;
  readonly ico: string | null;
  readonly dic: string | null;
  readonly address: AddressData;
  readonly legalForm: string | null;
  readonly registerEntry: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly web: string | null;
}

interface TaxRegimePeriodData {
  readonly regime: TaxRegime;
  readonly effectiveFrom: string;
}

export type PaymentRounding = "none" | "whole_unit";

interface WorkspaceDefaultsData {
  readonly currency: CurrencyCode;
  readonly language: Locale;
  readonly dueDays: number;
  readonly paymentMethod: PaymentMethod;
  readonly defaultNote: string | null;
  readonly paymentRounding: PaymentRounding;
  readonly paymentTaxDocumentAutoSend: boolean;
}

interface ReminderPolicyData {
  readonly enabled: boolean;
  readonly proformas: boolean;
  readonly offsetsDays: ReadonlyArray<number>;
}

export interface BankAccountData {
  readonly id: BankAccountId;
  readonly name: string | null;
  readonly iban: string;
  readonly bic: string | null;
  readonly currency: CurrencyCode;
  readonly isDefault: boolean;
  readonly revision: number;
}

export interface ParsedWorkspace {
  readonly slug: WorkspaceSlug;
  readonly name: string;
  readonly closed: boolean;
  readonly revision: number;
  readonly issuingEntity: IssuingEntityData;
  readonly taxRegime: TaxRegime;
  readonly taxRegimeHistory: ReadonlyArray<TaxRegimePeriodData>;
  readonly defaults: WorkspaceDefaultsData;
  readonly reminderPolicy: ReminderPolicyData;
  readonly branding: WorkspaceBranding;
}

const Fields = Schema.Record(Schema.String, Schema.Unknown);
const emptyFields = Fields.make({});
const toRecord = Fn.flow(
  Schema.decodeUnknownOption(Fields),
  Option.getOrElse(() => emptyFields),
);
const toList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const text = Schema.decodeUnknownOption(Schema.String);
const optText = Fn.flow(
  text,
  Option.filter((value) => value !== ""),
  Option.getOrNull,
);
const boolean = Schema.decodeUnknownOption(Schema.Boolean);
const integer = Schema.decodeUnknownOption(Schema.Int);
const regime = Schema.decodeUnknownOption(TaxRegime);
const method = Schema.decodeUnknownOption(PaymentMethod);
const locale = Schema.decodeUnknownOption(Locale);
const rounding = Schema.decodeUnknownOption(Schema.Literals(["none", "whole_unit"]));
const currency = Schema.decodeUnknownOption(CurrencyCode);
const czk = CurrencyCode.make("CZK");
const bankAccountId = Schema.decodeUnknownResult(BankAccountId);
const isPositive = Schema.is(Schema.Finite.check(Schema.isGreaterThan(0)));

/** Safely extracts the concrete core fields from an open `WorkspaceView`. */
export const parseWorkspaceView = (raw: WorkspaceView): ParsedWorkspace => {
  const entity = toRecord(raw["issuingEntity"]);
  const addr = toRecord(entity["address"]);
  const defaults = toRecord(raw["defaults"]);
  const reminder = toRecord(raw["reminderPolicy"]);
  const rawHistory = Option.getOrElse(toList(raw["taxRegimeHistory"]), () => []);
  const taxRegimeHistory = Arr.filterMap(rawHistory, (item) => {
    const period = toRecord(item);
    return Schema.decodeUnknownResult(Schema.String)(period["effectiveFrom"]).pipe(
      Result.map(
        (effectiveFrom): TaxRegimePeriodData => ({
          regime: Option.getOrElse(regime(period["regime"]), () => "non_vat_payer"),
          effectiveFrom,
        }),
      ),
    );
  });
  const rawOffsets = Option.getOrElse(toList(reminder["offsetsDays"]), () => [3, 10, 30]);
  const offsetsDays = Arr.filter(rawOffsets, isPositive);

  return {
    slug: raw.slug,
    name: Option.getOrElse(text(raw["name"]), () => raw.slug),
    closed: Option.getOrElse(boolean(raw["closed"]), () => false),
    revision: raw.revision,
    issuingEntity: {
      name: Option.getOrElse(text(entity["name"]), () => ""),
      ico: optText(entity["ico"]),
      dic: optText(entity["dic"]),
      address: {
        street: Option.getOrElse(text(addr["street"]), () => ""),
        city: Option.getOrElse(text(addr["city"]), () => ""),
        postalCode: Option.getOrElse(text(addr["postalCode"]), () => ""),
        country: Option.getOrElse(text(addr["country"]), () => "CZ"),
      },
      legalForm: optText(entity["legalForm"]),
      registerEntry: optText(entity["registerEntry"]),
      email: optText(entity["email"]),
      phone: optText(entity["phone"]),
      web: optText(entity["web"]),
    },
    taxRegime: Option.getOrElse(regime(raw["taxRegime"]), () => "non_vat_payer"),
    taxRegimeHistory,
    defaults: {
      currency: Option.getOrElse(currency(defaults["currency"]), () => czk),
      language: Option.getOrElse(locale(defaults["language"]), () => "cs"),
      dueDays: Option.getOrElse(integer(defaults["dueDays"]), () => 14),
      paymentMethod: Option.getOrElse(method(defaults["paymentMethod"]), () => "bank_transfer"),
      defaultNote: optText(defaults["defaultNote"]),
      paymentRounding: Option.getOrElse(rounding(defaults["paymentRounding"]), () => "none"),
      paymentTaxDocumentAutoSend: Option.getOrElse(
        boolean(defaults["paymentTaxDocumentAutoSend"]),
        () => true,
      ),
    },
    reminderPolicy: {
      enabled: Option.getOrElse(boolean(reminder["enabled"]), () => true),
      proformas: Option.getOrElse(boolean(reminder["proformas"]), () => false),
      offsetsDays,
    },
    branding: raw.branding,
  };
};

/** Safely extracts the concrete fields from an opaque `BankAccountView`. */
export const parseBankAccountView = (raw: BankAccountView) => {
  const r = toRecord(raw);
  return bankAccountId(r["id"]).pipe(
    Result.map(
      (id): BankAccountData => ({
        id,
        name: optText(r["name"]),
        iban: Option.getOrElse(text(r["iban"]), () => ""),
        bic: optText(r["bic"]),
        currency: Option.getOrElse(currency(r["currency"]), () => czk),
        isDefault: Option.getOrElse(boolean(r["isDefault"]), () => false),
        revision: Option.getOrElse(integer(r["revision"]), () => 1),
      }),
    ),
  );
};

const UPPERCASE_INITIAL = /[A-Z]/;
const toKebab = (value: string): string =>
  Arr.join(
    Arr.map(Str.split("")(value), (char) => {
      if (char === "_") return "-";
      return UPPERCASE_INITIAL.test(char) ? `-${Str.toLowerCase(char)}` : char;
    }),
    "",
  );

/** Resolves a route param (kebab-case or camelCase) to a valid `SettingsSection`, or null. */
export const parseSettingsSection = (segment: string | undefined): SettingsSection | null => {
  if (segment === undefined || segment === "") return null;
  for (const literal of SettingsSection.literals) {
    if (literal === segment || toKebab(literal) === segment) return literal;
  }
  return null;
};

export const sectionTitleKey = (section: SettingsSection): `settings.nav.${SettingsSection}` =>
  `settings.nav.${section}`;

/** Today's calendar date in YYYY-MM-DD (local). */
export const todayIsoDate = (now: Date = DateTime.toDateUtc(DateTime.nowUnsafe())): string => {
  const y = now.getFullYear();
  const m = Str.padStart(2, "0")(String(now.getMonth() + 1));
  const d = Str.padStart(2, "0")(String(now.getDate()));
  return `${y}-${m}-${d}`;
};
