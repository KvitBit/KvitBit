/** Documents module (core-ports section 4.4). Interface only. */
import type { BigDecimal, Effect } from "effect";
import { Context, Schema } from "effect";
import type { CurrentCaller } from "../caller";
import type { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { DeliveryId, DocumentId, LineId } from "../ids";
import { BankAccountId, ContactId, NumberingSeriesId } from "../ids";
import type { FileDownload, StatutoryNote, Unspecified, VatBreakdown } from "../shared";
import type {
  DeliveryPurpose,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  Page,
  PdfTemplate,
  RequestOptions,
} from "../vocabulary";
import { CurrencyCode, IsoDate, LineInput, Locale, PaymentMethod } from "../vocabulary";
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
  lines: Schema.optional(Schema.NonEmptyArray(LineInput)),
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
  fx: Schema.optional(Schema.NullOr(FxOverride)), // null returns to the CNB fixing (rule D11)
  number: Schema.optional(Schema.String), // issued only; owner/admin; unique (rule D4)
  refreshParties: Schema.optional(Schema.Boolean), // re-snapshot Contact and Issuing Entity (rule D10)
});
export type DocumentPatch = typeof DocumentPatch.Type;

/** Buyer particulars as printed. Fields not yet specified. */
export type ContactSnapshot = Unspecified<"ContactSnapshot">;
/** Issuing Entity particulars, §435 register entry, bank account. Fields not yet specified. */
export type IssuerSnapshot = Unspecified<"IssuerSnapshot">;
/** A line with its resolved VatTreatment and rate %. Fields not yet specified. */
export type LineView = Unspecified<"LineView">;
/** kind, status, settlement, overdue, contact, period, text (ui-port notes). Fields not yet specified. */
export type DocumentQuery = Unspecified<"DocumentQuery">;
export type DocumentSummary = Unspecified<"DocumentSummary">;

export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "skipped";
export type DocumentRelation =
  | "corrects"
  | "corrected_by"
  | "advance_of"
  | "tax_document_for"
  | "final_invoice_for"
  | "deducts";

export interface DocumentView {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly number: string | null; // null while draft
  readonly status: DocumentStatus;
  readonly locked: boolean;
  readonly settlement: DocumentSettlement; // derived at read
  readonly overdue: boolean; // derived at read
  readonly revision: number;
  readonly taxDocument: boolean; // true when the document is a VAT tax document
  readonly contact: ContactSnapshot;
  readonly issuer: IssuerSnapshot;
  readonly dates: {
    readonly issuedOn: IsoDate;
    readonly taxableSupplyOn: IsoDate | null;
    readonly dueOn: IsoDate;
  };
  readonly paymentMethod: PaymentMethod; // resolved Document → Contact → Workspace
  readonly lines: ReadonlyArray<LineView>;
  readonly totals: VatBreakdown;
  readonly fx: null | {
    readonly rate: BigDecimal.BigDecimal;
    readonly quantity: number;
    readonly fixingDate: IsoDate | null; // null for manual
    readonly source: "cnb" | "manual";
  };
  readonly statutoryNotes: ReadonlyArray<StatutoryNote>;
  readonly paymentQr: null | { readonly format: "spayd" | "epc"; readonly payload: string };
  readonly related: ReadonlyArray<{
    readonly relation: DocumentRelation;
    readonly id: DocumentId;
    readonly kind: DocumentKind;
    readonly number: string;
  }>;
  readonly share: null | {
    readonly url: string;
    readonly views: number;
    readonly lastViewedAt: string | null;
  };
  readonly deliveries: ReadonlyArray<{
    readonly id: DeliveryId;
    readonly to: ReadonlyArray<string>;
    readonly purpose: DeliveryPurpose;
    readonly status: DeliveryStatus;
    readonly at: string;
  }>;
}

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

export class Documents extends Context.Service<
  Documents,
  {
    /** Live totals for an editor. Same code path as issue; nothing is stored or numbered. */
    readonly preview: (
      input: DocumentInput,
    ) => Effect.Effect<DocumentView, Invalid | Unavailable | Forbidden, CurrentCaller>;
    readonly createDraft: (
      input: DocumentInput,
      opts?: RequestOptions,
    ) => Effect.Effect<DocumentView, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>;
    /** Drafts only. Hard delete. */
    readonly discardDraft: (
      id: DocumentId,
      expectedRevision: number,
    ) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>;
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
    ) => Effect.Effect<DocumentView, NotFound | Conflict | Forbidden, CurrentCaller>;
    readonly unlock: (
      id: DocumentId,
      reason: string,
    ) => Effect.Effect<DocumentView, NotFound | Conflict | Forbidden, CurrentCaller>;
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
      NotFound | Conflict | Invalid | Forbidden,
      CurrentCaller
    >;

    // Dry runs for MCP two-step confirmation (rule D15). Nothing is stored.
    /** Recipients, language, subject and attachments that send(id, input) would use now. */
    readonly previewSend: (
      id: DocumentId,
      input?: SendOptions,
    ) => Effect.Effect<SendPreview, NotFound | Conflict | Invalid | Forbidden, CurrentCaller>;
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
    ) => Effect.Effect<DocumentView, NotFound | Forbidden, CurrentCaller>;
    readonly list: (
      q: DocumentQuery,
    ) => Effect.Effect<Page<DocumentSummary>, Invalid | Forbidden, CurrentCaller>;
    readonly history: (
      id: DocumentId,
    ) => Effect.Effect<ReadonlyArray<AuditEntry>, NotFound | Forbidden, CurrentCaller>;
  }
>()("kvitbit/Documents") {}
