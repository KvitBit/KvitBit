/**
 * Workspaces module data model (core-ports 4.1): stored rows, the concrete shapes of the inputs
 * the domain leaves open (`NewWorkspace`, `IssuingEntityPatch`, `WorkspaceSettingsPatch`,
 * `BankAccountInput`), and the views built from them.
 */
import {
  BankAccountId,
  CurrencyCode,
  DocumentKind,
  Hex,
  ImageRef,
  InvitationId,
  IsoDate,
  Locale,
  NumberingSeriesId,
  PaymentMethod,
  PdfTemplate,
  Role,
  TaxRegime,
  ThemeSource,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";

// Values ------------------------------------------------------------------------------------

export const Address = Schema.Struct({
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
});
export type Address = typeof Address.Type;

/** The legal identity printed on every document (W1: exactly one per Workspace). */
export const IssuingEntity = Schema.Struct({
  name: Schema.String,
  ico: Schema.NullOr(Schema.String),
  dic: Schema.NullOr(Schema.String),
  address: Address,
  legalForm: Schema.NullOr(Schema.String),
  /** §435 commercial register line. */
  registerEntry: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  web: Schema.NullOr(Schema.String),
});
export type IssuingEntity = typeof IssuingEntity.Type;

/** One Tax Regime period (W2): applies to tax points on or after `effectiveFrom`. */
export const TaxRegimePeriod = Schema.Struct({ regime: TaxRegime, effectiveFrom: IsoDate });
export type TaxRegimePeriod = typeof TaxRegimePeriod.Type;

export const PaymentRounding = Schema.Literals(["none", "whole_unit"]);
export type PaymentRounding = typeof PaymentRounding.Type;

/** Workspace billing defaults (the Workspace level of the override chain, core-ports 4.2). */
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

/** The Workspace reminder schedule (rule D16, `WorkspaceReminderPolicy`). */
export const ReminderSchedule = Schema.Struct({
  enabled: Schema.Boolean,
  proformas: Schema.Boolean,
  offsetsDays: Schema.Array(Schema.Int),
});
export type ReminderSchedule = typeof ReminderSchedule.Type;

export const Branding = Schema.Struct({
  pdfTemplate: PdfTemplate,
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String),
  theme: Schema.NullOr(ThemeSource),
  logo: Schema.NullOr(ImageRef),
  stamp: Schema.NullOr(ImageRef),
});
export type Branding = typeof Branding.Type;

export const DEFAULT_BRANDING: Branding = {
  pdfTemplate: "classic",
  accentColor: "#1F5FAF",
  footerText: null,
  theme: null,
  logo: null,
  stamp: null,
};

export const DEFAULT_REMINDERS: ReminderSchedule = {
  enabled: true,
  proformas: false,
  offsetsDays: [3, 10, 30],
};

// Rows --------------------------------------------------------------------------------------

export const WorkspaceRow = Schema.Struct({
  id: WorkspaceId,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  slug: WorkspaceSlug,
  name: Schema.String,
  closed: Schema.Boolean,
  closedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  issuingEntity: IssuingEntity,
  /** Sorted by `effectiveFrom`, never empty. */
  taxRegimes: Schema.Array(TaxRegimePeriod),
  defaults: WorkspaceDefaults,
  /** Default bank account per currency code. */
  bankAccountByCurrency: Schema.Record(Schema.String, BankAccountId),
  reminders: ReminderSchedule,
  branding: Branding,
});
export type WorkspaceRow = typeof WorkspaceRow.Type;

/** A former slug that keeps redirecting for 90 days (W6). */
export const SlugAliasRow = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  slug: Schema.String,
  expiresAt: Schema.String,
});
export type SlugAliasRow = typeof SlugAliasRow.Type;

export const MembershipRow = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  userId: UserId,
  role: Role,
  joinedAt: Schema.String,
});
export type MembershipRow = typeof MembershipRow.Type;

export const InvitationRole = Schema.Literals(["admin", "member", "accountant"]);
export type InvitationRole = typeof InvitationRole.Type;

export const InvitationRow = Schema.Struct({
  id: InvitationId,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  email: Schema.String,
  emailLower: Schema.String,
  role: InvitationRole,
  /** `expired` is derived from `expiresAt` at read time. */
  status: Schema.Literals(["pending", "revoked", "accepted"]),
  /** SHA-256 hex of the current token; the token itself is never stored. */
  tokenHash: Schema.String,
  /** Bumped by every resend; each epoch has its own token and email. */
  sendEpoch: Schema.Int,
  invitedBy: UserId,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  acceptedBy: Schema.NullOr(UserId),
});
export type InvitationRow = typeof InvitationRow.Type;

export const BankAccountRow = Schema.Struct({
  id: BankAccountId,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  name: Schema.NullOr(Schema.String),
  iban: Schema.String,
  bic: Schema.NullOr(Schema.String),
  currency: CurrencyCode,
  archived: Schema.Boolean,
  createdAt: Schema.String,
});
export type BankAccountRow = typeof BankAccountRow.Type;

// Inputs ------------------------------------------------------------------------------------

/** Concrete `NewWorkspace` (open in the domain). */
export const NewWorkspaceFields = Schema.Struct({
  /** Required unless `ico` prefills it from the registry. */
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  ico: Schema.optional(Schema.String),
  taxRegime: Schema.optional(TaxRegime),
  defaults: Schema.optional(
    Schema.Struct({
      currency: Schema.optional(CurrencyCode),
      language: Schema.optional(Locale),
    }),
  ),
});
export type NewWorkspaceFields = typeof NewWorkspaceFields.Type;

/** Concrete `IssuingEntityPatch` (opaque in the domain). Address replaces as a whole. */
export const IssuingEntityPatchFields = Schema.Struct({
  name: Schema.optional(Schema.String),
  ico: Schema.optional(Schema.NullOr(Schema.String)),
  dic: Schema.optional(Schema.NullOr(Schema.String)),
  address: Schema.optional(Address),
  legalForm: Schema.optional(Schema.NullOr(Schema.String)),
  registerEntry: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  phone: Schema.optional(Schema.NullOr(Schema.String)),
  web: Schema.optional(Schema.NullOr(Schema.String)),
  /** A Tax Regime change; documents with an earlier tax point keep the old regime (W2). */
  taxRegime: Schema.optional(TaxRegimePeriod),
});
export type IssuingEntityPatchFields = typeof IssuingEntityPatchFields.Type;

export const SeriesByKind = Schema.Record(DocumentKind, Schema.optionalKey(NumberingSeriesId));
export type SeriesByKind = typeof SeriesByKind.Type;

/** Concrete extra fields of `WorkspaceSettingsPatch` (open in the domain). */
export const SettingsPatchFields = Schema.Struct({
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  branding: Schema.optional(
    Schema.Struct({
      pdfTemplate: Schema.optional(PdfTemplate),
      accentColor: Schema.optional(Schema.String),
      footerText: Schema.optional(Schema.NullOr(Schema.String)),
      theme: Schema.optional(Schema.NullOr(ThemeSource)),
    }),
  ),
  defaults: Schema.optional(
    Schema.Struct({
      currency: Schema.optional(CurrencyCode),
      language: Schema.optional(Locale),
      dueDays: Schema.optional(Schema.Int),
      paymentMethod: Schema.optional(PaymentMethod),
      defaultNote: Schema.optional(Schema.NullOr(Schema.String)),
      paymentRounding: Schema.optional(PaymentRounding),
      paymentTaxDocumentAutoSend: Schema.optional(Schema.Boolean),
      /** Makes each named series the default of its kind (W3). */
      preferredSeriesByKind: Schema.optional(SeriesByKind),
    }),
  ),
  reminderPolicy: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      proformas: Schema.optional(Schema.Boolean),
      offsetsDays: Schema.optional(Schema.Array(Schema.Int)),
    }),
  ),
});
export type SettingsPatchFields = typeof SettingsPatchFields.Type;

/** Concrete `BankAccountInput` (opaque in the domain). */
export const BankAccountFields = Schema.Struct({
  id: Schema.optional(BankAccountId),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  iban: Schema.String,
  bic: Schema.optional(Schema.NullOr(Schema.String)),
  currency: CurrencyCode,
  /** Makes it the default account for its currency; the first account of a currency is. */
  isDefault: Schema.optional(Schema.Boolean),
});
export type BankAccountFields = typeof BankAccountFields.Type;

// Views -------------------------------------------------------------------------------------

/** Concrete `BankAccountView` (opaque in the domain). */
export const BankAccountViewFields = Schema.Struct({
  id: BankAccountId,
  name: Schema.NullOr(Schema.String),
  iban: Schema.String,
  bic: Schema.NullOr(Schema.String),
  currency: CurrencyCode,
  isDefault: Schema.Boolean,
  revision: Schema.Int,
});
export type BankAccountViewFields = typeof BankAccountViewFields.Type;

/** Concrete `WorkspaceView`: the domain's open struct plus these fields. */
export const WorkspaceViewFields = Schema.Struct({
  id: WorkspaceId,
  slug: WorkspaceSlug,
  name: Schema.String,
  closed: Schema.Boolean,
  revision: Schema.Int,
  issuingEntity: IssuingEntity,
  /** The regime in force today (Prague). */
  taxRegime: TaxRegime,
  taxRegimeHistory: Schema.Array(TaxRegimePeriod),
  defaults: Schema.Struct({
    ...WorkspaceDefaults.fields,
    /** The default Numbering Series of each kind (W3). */
    preferredSeriesByKind: SeriesByKind,
  }),
  reminderPolicy: ReminderSchedule,
  bankAccounts: Schema.Array(BankAccountViewFields),
  branding: Branding,
});
export type WorkspaceViewFields = typeof WorkspaceViewFields.Type;
