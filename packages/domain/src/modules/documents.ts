/** Documents module (core-ports section 4.4). Interface only. */
import type * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CurrentCaller } from "../caller";
import type { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { LineId } from "../ids";
import { BankAccountId, ContactId, DeliveryId, DocumentId, NumberingSeriesId } from "../ids";
import type { FileDownload } from "../shared";
import { StatutoryNote, VatBreakdown } from "../shared";
import type { Page, PageRequest, PdfTemplate, RequestOptions } from "../vocabulary";
import {
  CurrencyCode,
  DeliveryPurpose,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  IsoDate,
  LineInput,
  Locale,
  PaymentMethod,
} from "../vocabulary";
import type { AuditEntry } from "./audit";

/** Manual exchange rate, decision Q4: `quantity` units of the document currency = `rate` CZK. */
export const FxOverride = Schema.Struct({
  manual: Schema.Struct({ rate: Schema.BigDecimal, quantity: Schema.Int }),
});
export type FxOverride = typeof FxOverride.Type;

export const DueInput = Schema.Union([
  Schema.Struct({ on: IsoDate }),
  Schema.Struct({ inDays: Schema.Int }),
]);

export const DocumentInput = Schema.Struct({
  kind: Schema.Literals(["invoice", "proforma"]), // PTDs come from Payments; Credit Notes from correct/cancel
  contact: ContactId,
  lines: Schema.NonEmptyArray(LineInput),
  currency: Schema.optional(CurrencyCode), // default: Contact → Workspace (CZK)
  issuedOn: Schema.optional(IsoDate), // default: today (Prague)
  taxableSupplyOn: Schema.optional(IsoDate), // default: issuedOn; drives VAT rate and CNB fixing
  due: Schema.optional(DueInput), // default: Contact → Workspace
  language: Schema.optional(Locale), // default: Contact → Workspace
  series: Schema.optional(NumberingSeriesId), // default: Contact preferredSeriesByKind → Workspace default
  bankAccount: Schema.optional(BankAccountId), // default: Issuing Entity default for currency
  pricesIncludeVat: Schema.optional(Schema.Boolean), // default false; selects §37(b) top-down math
  variableSymbol: Schema.optional(Schema.String), // default: digits of the number
  orderNumber: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String), // default: Contact → Workspace
  paymentMethod: Schema.optional(PaymentMethod), // default: Contact → Workspace
  fx: Schema.optional(FxOverride), // default: CNB fixing (rule D11); non-CZK only
});
export type DocumentInput = typeof DocumentInput.Type;

/** Every DocumentInput field except kind, each optional, plus two edit-only fields. */
export const DocumentPatch = Schema.Struct({
  contact: Schema.optional(ContactId),
  lines: LineInput.pipe(Schema.NonEmptyArray, Schema.optional),
  currency: Schema.optional(CurrencyCode),
  issuedOn: Schema.optional(IsoDate),
  taxableSupplyOn: Schema.optional(IsoDate),
  due: Schema.optional(DueInput),
  language: Schema.optional(Locale),
  series: Schema.optional(NumberingSeriesId), // drafts only
  bankAccount: Schema.optional(BankAccountId),
  pricesIncludeVat: Schema.optional(Schema.Boolean),
  variableSymbol: Schema.optional(Schema.String),
  orderNumber: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  paymentMethod: Schema.optional(PaymentMethod),
  fx: FxOverride.pipe(Schema.NullOr, Schema.optional), // null returns to the CNB fixing (rule D11)
  number: Schema.optional(Schema.String), // issued only; owner/admin; unique (rule D4)
  refreshParties: Schema.optional(Schema.Boolean), // re-snapshot Contact and Issuing Entity (rule D10)
});
export type DocumentPatch = typeof DocumentPatch.Type;

/** Buyer particulars as printed. Fields not yet specified. */
export const ContactSnapshot = Schema.Unknown.pipe(Schema.brand("ContactSnapshot"));
export type ContactSnapshot = typeof ContactSnapshot.Type;
/** Issuing Entity particulars, §435 register entry, bank account. Fields not yet specified. */
export const IssuerSnapshot = Schema.Unknown.pipe(Schema.brand("IssuerSnapshot"));
export type IssuerSnapshot = typeof IssuerSnapshot.Type;
/** A line with its resolved VatTreatment and rate %. Fields not yet specified. */
export const LineView = Schema.Unknown.pipe(Schema.brand("LineView"));
export type LineView = typeof LineView.Type;
/** List row: number or draft, contact, dates, total, badges (ui-port notes). Fields not yet specified. */
export const DocumentSummary = Schema.Unknown.pipe(Schema.brand("DocumentSummary"));
export type DocumentSummary = typeof DocumentSummary.Type;

/**
 * List filter: kind, status, settlement, overdue, contact, period, text (ui-port 8.9). Flat so
 * HTTP can spread `.fields` into a query string; the period is `from`/`to` (implementer choice,
 * the spec names the filter but not its encoding). Paging (cursor, limit) is added by callers.
 */
export const DocumentQuery = Schema.Struct({
  kind: Schema.optional(DocumentKind),
  status: Schema.optional(DocumentStatus),
  settlement: Schema.optional(DocumentSettlement),
  overdue: Schema.optional(Schema.Boolean),
  contact: Schema.optional(ContactId),
  from: Schema.optional(IsoDate),
  to: Schema.optional(IsoDate),
  text: Schema.optional(Schema.String),
});
export type DocumentQuery = typeof DocumentQuery.Type;

export const DeliveryStatus = Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]);
export type DeliveryStatus = typeof DeliveryStatus.Type;
export const DocumentRelation = Schema.Literals([
  "corrects",
  "corrected_by",
  "advance_of",
  "tax_document_for",
  "final_invoice_for",
  "deducts",
]);
export type DocumentRelation = typeof DocumentRelation.Type;

export const DocumentView = Schema.Struct({
  id: DocumentId,
  kind: DocumentKind,
  number: Schema.NullOr(Schema.String), // null while draft
  status: DocumentStatus,
  locked: Schema.Boolean,
  settlement: DocumentSettlement, // derived at read
  overdue: Schema.Boolean, // derived at read
  revision: Schema.Int,
  taxDocument: Schema.Boolean, // true when the document is a VAT tax document
  contact: ContactSnapshot,
  issuer: IssuerSnapshot,
  dates: Schema.Struct({
    issuedOn: IsoDate,
    taxableSupplyOn: Schema.NullOr(IsoDate),
    dueOn: IsoDate,
  }),
  paymentMethod: PaymentMethod, // resolved Document → Contact → Workspace
  lines: Schema.Array(LineView),
  totals: VatBreakdown,
  fx: Schema.NullOr(
    Schema.Struct({
      rate: Schema.BigDecimal,
      quantity: Schema.Int,
      fixingDate: Schema.NullOr(IsoDate), // null for manual
      source: Schema.Literals(["cnb", "manual"]),
    }),
  ),
  statutoryNotes: Schema.Array(StatutoryNote),
  paymentQr: Schema.NullOr(
    Schema.Struct({ format: Schema.Literals(["spayd", "epc"]), payload: Schema.String }),
  ),
  related: Schema.Array(
    Schema.Struct({
      relation: DocumentRelation,
      id: DocumentId,
      kind: DocumentKind,
      number: Schema.String,
    }),
  ),
  share: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      views: Schema.Int,
      lastViewedAt: Schema.NullOr(Schema.String),
    }),
  ),
  deliveries: Schema.Array(
    Schema.Struct({
      id: DeliveryId,
      to: Schema.Array(Schema.String),
      purpose: DeliveryPurpose,
      status: DeliveryStatus,
      at: Schema.String,
    }),
  ),
});
export type DocumentView = typeof DocumentView.Type;

export interface CorrectionInput {
  readonly reason: string;
  readonly lines:
    | "full"
    | ReadonlyArray<{
        readonly line: LineId;
        readonly quantity?: BigDecimal.BigDecimal;
        readonly unitPrice?: BigDecimal.BigDecimal;
      }>;
  readonly correctedOn?: IsoDate;
}

export interface SendOptions {
  readonly to?: ReadonlyArray<string>; // default: Contact invoicing email
  readonly language?: Locale;
  readonly reminders?: boolean; // default: effective reminder policy (rule D16); ignored for "reminder"
  readonly purpose?: DeliveryPurpose; // default "document"
}

export interface SendPreview {
  readonly purpose: DeliveryPurpose;
  readonly to: ReadonlyArray<string>;
  readonly language: Locale;
  readonly subject: string;
  readonly attachments: ReadonlyArray<{ readonly filename: string; readonly contentType: string }>;
  readonly armsReminders: boolean;
}

// @effect-diagnostics-next-line leakingRequirements:off Resolve the caller at method invocation.
export class Documents extends Context.Service<
  Documents,
  {
    /** Live totals for an editor. Same code path as issue; nothing is stored or numbered. */
    readonly preview: (
      input: DocumentInput,
    ) => Effect.Effect<DocumentView, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly createDraft: (
      input: DocumentInput,
      opts?: RequestOptions,
    ) => Effect.Effect<
      DocumentView,
      Invalid | NotFound | Conflict | Unavailable | Forbidden,
      CurrentCaller
    >;
    /** Drafts only. Hard delete. */
    readonly discardDraft: (
      id: DocumentId,
      expectedRevision: number,
    ) => Effect.Effect<void, NotFound | Conflict | Unavailable | Forbidden, CurrentCaller>;
    /** From an existing draft or straight from input. Assigns the number. */
    readonly issue: (
      from:
        | { readonly draft: DocumentId; readonly expectedRevision: number }
        | { readonly input: DocumentInput },
      opts?: RequestOptions & { readonly send?: SendOptions },
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;
    /** Drafts and unlocked issued documents. Issued edits are audited field by field. */
    readonly edit: (
      id: DocumentId,
      patch: DocumentPatch,
      expectedRevision: number,
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;
    readonly lock: (
      id: DocumentId,
    ) => Effect.Effect<DocumentView, NotFound | Conflict | Unavailable | Forbidden, CurrentCaller>;
    readonly unlock: (
      id: DocumentId,
      reason: string,
    ) => Effect.Effect<
      DocumentView,
      NotFound | Conflict | Invalid | Unavailable | Forbidden,
      CurrentCaller
    >;
    /** Void an issued document without deleting it (rule D6). */
    readonly cancel: (
      id: DocumentId,
      input: { readonly reason: string; readonly on?: IsoDate },
      opts?: RequestOptions,
    ) => Effect.Effect<
      { readonly document: DocumentView; readonly creditNote: DocumentView | null },
      CoreError,
      CurrentCaller
    >;
    /** Credit Note against an issued Invoice or Payment Tax Document. */
    readonly correct: (
      id: DocumentId,
      input: CorrectionInput,
      opts?: RequestOptions,
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;
    /** The Final Invoice for a paid Proforma, deducting the advance (§37a). Explicit; once per Proforma. */
    readonly issueFinalInvoice: (
      proforma: DocumentId,
      input?: { readonly patch?: DocumentPatch },
      opts?: RequestOptions,
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;
    /**
     * Queue email delivery. Never fails on provider outage. purpose "document" arms payment
     * reminders unless disabled; purpose "reminder" sends one manual reminder and never re-arms
     * the schedule (rule D14).
     */
    readonly send: (
      id: DocumentId,
      input?: SendOptions,
      opts?: RequestOptions,
    ) => Effect.Effect<
      { readonly deliveryId: DeliveryId; readonly status: "queued" },
      NotFound | Conflict | Invalid | Unavailable | Forbidden,
      CurrentCaller
    >;

    // Dry runs for MCP two-step confirmation (rule D15). Nothing is stored.
    /** Recipients, language, subject and attachments that send(id, input) would use now. */
    readonly previewSend: (
      id: DocumentId,
      input?: SendOptions,
    ) => Effect.Effect<
      SendPreview,
      NotFound | Conflict | Invalid | Unavailable | Forbidden,
      CurrentCaller
    >;
    /** The Final Invoice issueFinalInvoice would produce, with deductions, unnumbered. */
    readonly previewFinalInvoice: (
      proforma: DocumentId,
      input?: { readonly patch?: DocumentPatch },
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;
    /** The Credit Note correct(id, input) would produce, unnumbered. */
    readonly previewCorrection: (
      id: DocumentId,
      input: CorrectionInput,
    ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>;

    readonly pdf: (
      id: DocumentId,
      opts?: { readonly template?: PdfTemplate; readonly language?: Locale },
    ) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly get: (
      id: DocumentId,
    ) => Effect.Effect<DocumentView, NotFound | Unavailable | Forbidden, CurrentCaller>;
    /** Filter plus paging (cursor, limit 1 to 100, default 50). */
    readonly list: (
      q: DocumentQuery & PageRequest,
    ) => Effect.Effect<Page<DocumentSummary>, Invalid | Unavailable | Forbidden, CurrentCaller>;
    readonly history: (
      id: DocumentId,
    ) => Effect.Effect<
      ReadonlyArray<AuditEntry>,
      NotFound | Unavailable | Forbidden,
      CurrentCaller
    >;
  }
  // @effect-diagnostics-next-line deterministicKeys:off Preserve the service key specified in core-ports.
>()("kvitbit/Documents") {}
