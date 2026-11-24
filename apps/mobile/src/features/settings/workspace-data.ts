import type {
  BankAccountId,
  BankAccountView,
  CurrencyCode,
  Locale,
  PaymentMethod,
  TaxRegime,
  WorkspaceBranding,
  WorkspaceSlug,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import { SettingsSection } from "@kvitbit/ui-port/view-models";

export interface AddressData {
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

export interface TaxRegimePeriodData {
  readonly regime: TaxRegime;
  readonly effectiveFrom: string;
}

export type PaymentRounding = "none" | "whole_unit";

export interface WorkspaceDefaultsData {
  readonly currency: CurrencyCode;
  readonly language: Locale;
  readonly dueDays: number;
  readonly paymentMethod: PaymentMethod;
  readonly defaultNote: string | null;
  readonly paymentRounding: PaymentRounding;
  readonly paymentTaxDocumentAutoSend: boolean;
}

export interface ReminderPolicyData {
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

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const str = (u: unknown, fallback = ""): string => (typeof u === "string" ? u : fallback);

const optStr = (u: unknown): string | null => (typeof u === "string" && u !== "" ? u : null);

const bool = (u: unknown, fallback: boolean): boolean => (typeof u === "boolean" ? u : fallback);

const int = (u: unknown, fallback: number): number =>
  typeof u === "number" && Number.isInteger(u) ? u : fallback;

const asTaxRegime = (u: unknown): TaxRegime =>
  u === "vat_payer" || u === "identified_person" || u === "non_vat_payer" ? u : "non_vat_payer";

const asPaymentMethod = (u: unknown): PaymentMethod =>
  u === "bank_transfer" || u === "cash" || u === "card" || u === "other" ? u : "bank_transfer";

const asLocale = (u: unknown): Locale => (u === "en" ? "en" : "cs");

const asRounding = (u: unknown): PaymentRounding => (u === "whole_unit" ? "whole_unit" : "none");

const asCurrency = (u: unknown): CurrencyCode =>
  (typeof u === "string" && /^[A-Z]{3}$/.test(u) ? u : "CZK") as CurrencyCode;

/** Safely extracts the concrete core fields from an open `WorkspaceView`. */
export const parseWorkspaceView = (raw: WorkspaceView): ParsedWorkspace => {
  const r = raw as Record<string, unknown>;
  const entity = isRecord(r.issuingEntity) ? r.issuingEntity : {};
  const addr = isRecord(entity.address) ? entity.address : {};
  const defaults = isRecord(r.defaults) ? r.defaults : {};
  const reminder = isRecord(r.reminderPolicy) ? r.reminderPolicy : {};
  const rawHistory = Array.isArray(r.taxRegimeHistory) ? r.taxRegimeHistory : [];
  const taxRegimeHistory: TaxRegimePeriodData[] = [];
  for (const item of rawHistory) {
    if (isRecord(item) && typeof item.effectiveFrom === "string") {
      taxRegimeHistory.push({
        regime: asTaxRegime(item.regime),
        effectiveFrom: item.effectiveFrom,
      });
    }
  }
  const rawOffsets = Array.isArray(reminder.offsetsDays) ? reminder.offsetsDays : [3, 10, 30];
  const offsetsDays = rawOffsets.filter((n): n is number => typeof n === "number" && n > 0);

  return {
    slug: raw.slug,
    name: str(r.name, raw.slug),
    closed: bool(r.closed, false),
    revision: raw.revision,
    issuingEntity: {
      name: str(entity.name),
      ico: optStr(entity.ico),
      dic: optStr(entity.dic),
      address: {
        street: str(addr.street),
        city: str(addr.city),
        postalCode: str(addr.postalCode),
        country: str(addr.country, "CZ"),
      },
      legalForm: optStr(entity.legalForm),
      registerEntry: optStr(entity.registerEntry),
      email: optStr(entity.email),
      phone: optStr(entity.phone),
      web: optStr(entity.web),
    },
    taxRegime: asTaxRegime(r.taxRegime),
    taxRegimeHistory,
    defaults: {
      currency: asCurrency(defaults.currency),
      language: asLocale(defaults.language),
      dueDays: int(defaults.dueDays, 14),
      paymentMethod: asPaymentMethod(defaults.paymentMethod),
      defaultNote: optStr(defaults.defaultNote),
      paymentRounding: asRounding(defaults.paymentRounding),
      paymentTaxDocumentAutoSend: bool(defaults.paymentTaxDocumentAutoSend, true),
    },
    reminderPolicy: {
      enabled: bool(reminder.enabled, true),
      proformas: bool(reminder.proformas, false),
      offsetsDays,
    },
    branding: raw.branding,
  };
};

/** Safely extracts the concrete fields from an opaque `BankAccountView`. */
export const parseBankAccountView = (raw: BankAccountView): BankAccountData => {
  const r: Record<string, unknown> = isRecord(raw) ? raw : {};
  return {
    id: str(r.id) as BankAccountId,
    name: optStr(r.name),
    iban: str(r.iban),
    bic: optStr(r.bic),
    currency: asCurrency(r.currency),
    isDefault: bool(r.isDefault, false),
    revision: int(r.revision, 1),
  };
};

const toKebab = (value: string): string =>
  value.replace(/_/g, "-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

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
export const todayIsoDate = (now: Date = new Date()): string => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};
