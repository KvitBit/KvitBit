/**
 * The stored Document aggregate (`documents` table): one row per Invoice, Proforma, Payment Tax
 * Document or Credit Note, drafts included. The row keeps both what the caller gave (`given`,
 * re-resolved on every recompute) and what was resolved from it (top-level fields), so the
 * Document → Contact → Workspace chain can be re-run on edit without losing explicit values.
 *
 * Top-level scalars are the queryable columns (kind, status, number, contactId, issuedOn,
 * dueOn, settlement, ...); nested values are JSON columns in the SQL implementation.
 */
import type { DocumentKind as DocumentKindType } from "@kvitbit/domain/contract";
import {
  BankAccountId,
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  DocumentRelation,
  DocumentSettlement,
  DocumentStatus,
  DueInput,
  FxOverride,
  IsoDate,
  LineId,
  Locale,
  NumberingSeriesId,
  PaymentMethod,
  PriceListItemId,
  ScheduleId,
  TaxRegime,
  VatBreakdown,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import { defineCollection } from "../../store/tables";

const Text = Schema.NullOr(Schema.String);

/** Postal address as printed (contacts' and the Issuing Entity's shape). */
export const AddressRecord = Schema.Struct({
  street: Text,
  city: Text,
  postalCode: Text,
  /** ISO 3166-1 alpha-2. */
  country: Schema.String,
});
export type AddressRecord = typeof AddressRecord.Type;

/** Buyer particulars as printed (`DocumentView.contact`). Frozen at issue (rule D10). */
export const ContactSnapshotRecord = Schema.Struct({
  contactId: ContactId,
  name: Schema.String,
  ico: Text,
  dic: Text,
  legalForm: Text,
  address: AddressRecord,
  billingEmails: Schema.Array(Schema.String),
});
export type ContactSnapshotRecord = typeof ContactSnapshotRecord.Type;

export const BankAccountRecord = Schema.Struct({
  id: BankAccountId,
  name: Text,
  currency: CurrencyCode,
  accountNumber: Text,
  iban: Text,
  bic: Text,
});
export type BankAccountRecord = typeof BankAccountRecord.Type;

/** Issuing Entity particulars as printed (`DocumentView.issuer`). Frozen at issue (rule D10). */
export const IssuerSnapshotRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  name: Schema.String,
  ico: Text,
  dic: Text,
  address: AddressRecord,
  /** §435 commercial register line, verbatim. */
  registerEntry: Text,
  email: Text,
  phone: Text,
  web: Text,
  /** Tax Regime in force on the tax point. */
  regime: TaxRegime,
  /** The account payments go to; null when the Workspace has none in the document currency. */
  bankAccount: Schema.NullOr(BankAccountRecord),
});
export type IssuerSnapshotRecord = typeof IssuerSnapshotRecord.Type;

/** One stored line, with its resolved treatment and rate (`DocumentView.lines`). */
export const LineRecord = Schema.Struct({
  id: LineId,
  item: Schema.NullOr(PriceListItemId),
  description: Schema.String,
  quantity: Schema.BigDecimal,
  unit: Text,
  /** Document currency; excl. VAT unless the document's `pricesIncludeVat`. */
  unitPrice: Schema.BigDecimal,
  /** The Price List Item's net price and currency when the price was copied from it. */
  itemPrice: Schema.NullOr(Schema.Struct({ currency: CurrencyCode, net: Schema.BigDecimal })),
  /** The treatment the caller set (kept on recompute); null = from the defaults (rule D9). */
  vat: Schema.NullOr(VatTreatment),
  /** The Price List Item's treatment copied with the line (a vat_payer default). */
  itemVat: Schema.NullOr(VatTreatment),
  /** Resolved: `vat`, else (vat_payer) `itemVat`, else the regime default. */
  treatment: VatTreatment,
  ratePercent: Schema.BigDecimal,
  /** Full-precision quantity x unitPrice. */
  amount: Schema.BigDecimal,
  /** Deduction lines of a Final Invoice (rule D8, P3): the deducted Payment Tax Document. */
  deducts: Schema.NullOr(DocumentId),
});
export type LineRecord = typeof LineRecord.Type;

/** The document's own values as given by the caller; absent = resolve from Contact/Workspace. */
export const GivenFields = Schema.Struct({
  currency: Schema.optional(CurrencyCode),
  issuedOn: Schema.optional(IsoDate),
  taxableSupplyOn: Schema.optional(IsoDate),
  due: Schema.optional(DueInput),
  language: Schema.optional(Locale),
  series: Schema.optional(NumberingSeriesId),
  bankAccount: Schema.optional(BankAccountId),
  /** null: pinned "no note" (issued documents keep a resolved null note). */
  note: Schema.optional(Schema.NullOr(Schema.String)),
  paymentMethod: Schema.optional(PaymentMethod),
  variableSymbol: Schema.optional(Schema.String),
});
export type GivenFields = typeof GivenFields.Type;

/** The rate the document uses (`DocumentView.fx`). */
export const FxRecord = Schema.Struct({
  rate: Schema.BigDecimal,
  quantity: Schema.Int,
  fixingDate: Schema.NullOr(IsoDate),
  source: Schema.Literals(["cnb", "manual"]),
});
export type FxRecord = typeof FxRecord.Type;
export type PaymentRounding = "none" | "whole_unit";

/** A link to another document (`DocumentView.related`); written by P3 (corrections, advances). */
export const LinkRecord = Schema.Struct({ relation: DocumentRelation, id: DocumentId });
export type LinkRecord = typeof LinkRecord.Type;

export const DocumentRecord = Schema.Struct({
  id: DocumentId,
  workspaceId: WorkspaceId,
  revision: Schema.Number,

  kind: DocumentKind,
  status: DocumentStatus,
  /** Document Lock (rule D5); a cancelled document is always locked. */
  locked: Schema.Boolean,
  lockedAt: Text,
  /** null while draft. */
  number: Text,
  /** The series the document numbers (or numbered) from (rule D1). */
  seriesId: Schema.NullOr(NumberingSeriesId),

  contactId: ContactId,
  contact: ContactSnapshotRecord,
  issuer: IssuerSnapshotRecord,

  given: GivenFields,
  // Resolved fields (Document → Contact → Workspace, rule D9/D11 and core-ports 4.2).
  currency: CurrencyCode,
  language: Locale,
  paymentMethod: PaymentMethod,
  note: Text,
  issuedOn: IsoDate,
  /** Default issuedOn (DocumentInput); nullable for later kinds that carry none. */
  taxableSupplyOn: Schema.NullOr(IsoDate),
  dueOn: IsoDate,
  pricesIncludeVat: Schema.Boolean,
  variableSymbol: Text,
  orderNumber: Text,

  lines: Schema.Array(LineRecord),
  totals: VatBreakdown,
  fx: Schema.NullOr(FxRecord),
  /** The manual rate as given (decision Q4); survives tax point changes (D11). */
  fxOverride: Schema.NullOr(FxOverride),
  taxDocument: Schema.Boolean,
  /** The Workspace's whole-unit payment rounding when composed; kept after issue (D10). */
  paymentRounding: Schema.Literals(["none", "whole_unit"]),

  /** What a `send` stored (rule D16), as given; computing schedules is stage 2's. */
  remindersChoice: Schema.Literals(["on", "off", "inherit"]),
  /** Outcome of the last arm (rule D16); written by stage 2. */
  remindersOn: Schema.Boolean,

  links: Schema.Array(LinkRecord),
  /** Sum of the document's live payments, document currency (Payments seam, P3). */
  paidAmount: Schema.BigDecimal,
  payments: Schema.Int,
  /** Stored settlement, kept current by every write that changes payments or credits. */
  settlement: DocumentSettlement,

  /** Recurring issuance link (board #450, `RecurringDocumentLink`); null otherwise. */
  scheduleId: Schema.NullOr(ScheduleId),
  occurrence: Schema.NullOr(IsoDate),

  cancelledOn: Schema.NullOr(IsoDate),
  /** A Credit Note's corrected document number as it was at correction time (rule D7). */
  correctedNumber: Text,
  /** Why: a Credit Note's correction reason (rule D7), a cancelled document's cancel reason (D6). */
  reason: Text,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  issuedAt: Text,
});
export type DocumentRecord = typeof DocumentRecord.Type;

/** Unique index: a number is taken once per (workspace, kind) among stored documents. */
export const NUMBER_PER_KIND = "documents_number_per_kind";

/** Unique index: one document per (schedule, occurrence) (board #450). */
export const SCHEDULE_OCCURRENCE = "documents_schedule_occurrence_unique";

export const DocumentsTable = defineCollection<DocumentRecord>({
  name: "documents",
  entity: "Document",
  schema: DocumentRecord as unknown as Schema.Codec<DocumentRecord, unknown>,
  unique: [
    {
      name: NUMBER_PER_KIND,
      scope: "workspace",
      key: (row) => (row.number === null ? null : [row.kind, row.number]),
    },
    {
      name: SCHEDULE_OCCURRENCE,
      scope: "workspace",
      key: (row) =>
        row.scheduleId === null || row.occurrence === null
          ? null
          : [row.scheduleId, row.occurrence],
    },
  ],
});

/** Kinds `DocumentInput` can create (PTDs come from Payments, Credit Notes from correct/cancel). */
export type DraftableKind = Extract<DocumentKindType, "invoice" | "proforma">;

/**
 * Issued, not settled and past due (`DocumentView.overdue`, list filter). Only Invoices and
 * Proformas are ever overdue: a Payment Tax Document confirms a payment already received and a
 * Credit Note is owed by the issuer, so neither is chased.
 */
export const isOverdue = (
  row: Pick<DocumentRecord, "kind" | "status" | "settlement" | "dueOn">,
  today: string,
): boolean =>
  (row.kind === "invoice" || row.kind === "proforma") &&
  row.status === "issued" &&
  (row.settlement === "unpaid" || row.settlement === "partially_paid") &&
  row.dueOn < today;
