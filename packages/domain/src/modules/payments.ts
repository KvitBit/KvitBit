/** Payments (core-ports 4.5) and PublicShareLinks (core-ports 4.6). Interfaces only. */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CurrentCaller } from "../caller";
import type { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { DocumentId, ExpenseId, PaymentId } from "../ids";
import { ShareViewId } from "../ids";
import type { FileDownload } from "../shared";
import { StatutoryNote, VatBreakdown } from "../shared";
import type { IsoDate, Page, PageRequest, PaymentMethod, RequestOptions } from "../vocabulary";
import { DocumentKind, DocumentSettlement, DocumentStatus, Locale, Money } from "../vocabulary";
import { ContactSnapshot, DocumentView, IssuerSnapshot, LineView } from "./documents";
import { WorkspaceBranding } from "./workspaces";

export const PaymentView = Schema.Unknown.pipe(Schema.brand("PaymentView"));
export type PaymentView = typeof PaymentView.Type;

export type PaymentTarget = { readonly document: DocumentId } | { readonly expense: ExpenseId };

export interface RecordPaymentInput {
  readonly target: PaymentTarget;
  readonly amount?: Money;
  readonly paidOn?: IsoDate;
  readonly method?: PaymentMethod;
  readonly note?: string;
}

// @effect-diagnostics-next-line leakingRequirements:off Resolve the caller at method invocation.
export class Payments extends Context.Service<
  Payments,
  {
    /** Default amount = outstanding; default date = today. Applies statutory follow-ups. */
    readonly record: (
      input: RecordPaymentInput,
      opts?: RequestOptions,
    ) => Effect.Effect<
      {
        readonly payment: PaymentView;
        readonly settlement: "partially_paid" | "paid" | "overpaid";
        readonly issued: ReadonlyArray<DocumentView>; // the auto-issued Payment Tax Document, if any
      },
      CoreError,
      CurrentCaller
    >;
    readonly remove: (
      id: PaymentId,
      reason: string,
    ) => Effect.Effect<
      void,
      NotFound | Conflict | Invalid | Unavailable | Forbidden,
      CurrentCaller
    >;
    readonly listFor: (
      target: PaymentTarget,
    ) => Effect.Effect<
      ReadonlyArray<PaymentView>,
      NotFound | Unavailable | Forbidden,
      CurrentCaller
    >;
  }
  // @effect-diagnostics-next-line deterministicKeys:off Preserve the service key specified in core-ports.
>()("kvitbit/Payments") {}

export const ShareViewEvent = Schema.Struct({
  id: ShareViewId,
  kind: Schema.Literals(["view", "download"]),
  at: Schema.String, // ISO instant
  device: Schema.Literals(["desktop", "mobile", "tablet", "unknown"]), // coarse, from the user agent
});
export type ShareViewEvent = typeof ShareViewEvent.Type;

/**
 * Narrowed recipient projection (core-ports 4.6): issuer branding, parties, lines, totals,
 * statutory notes, payment QR, settlement and PDF link, plus `viewerIsIssuer`, and the
 * header and notes user-flows 8.2 shows (language, amount due, corrected number, note, update). Closed on
 * purpose: encoding drops everything else (audit history, internal notes, deliveries).
 * Field names follow DocumentView; `branding` and `pdfUrl` are this package's names for
 * "issuer branding" and "PDF link".
 */
export const SharedDocumentView = Schema.Struct({
  kind: DocumentKind,
  number: Schema.String,
  status: DocumentStatus, // a cancelled or credited document stays viewable and shows its state
  settlement: DocumentSettlement,
  taxDocument: Schema.Boolean,
  dates: DocumentView.fields.dates,
  issuer: IssuerSnapshot,
  branding: WorkspaceBranding,
  contact: ContactSnapshot,
  lines: Schema.Array(LineView),
  totals: VatBreakdown,
  statutoryNotes: Schema.Array(StatutoryNote),
  paymentQr: DocumentView.fields.paymentQr,
  language: Locale, // the page opens in the document's language (user-flows 8.2)
  amountDue: Money, // outstanding amount shown in the header; zero when settled
  correctsNumber: Schema.NullOr(Schema.String), // a Credit Note shows the original Invoice number
  note: Schema.NullOr(Schema.String), // printed note, as on the PDF
  updatedAt: Schema.NullOr(Schema.String), // ISO instant of the last edit after issue ("Updated on D")
  pdfUrl: Schema.String,
  viewerIsIssuer: Schema.Boolean, // signedInUser is a Member of the issuing Workspace
});
export type SharedDocumentView = typeof SharedDocumentView.Type;

/** Serves both sides of a Public Share Link: Members manage it, visitors open it. */
// @effect-diagnostics-next-line leakingRequirements:off Resolve the caller at method invocation.
export class PublicShareLinks extends Context.Service<
  PublicShareLinks,
  {
    // Member caller
    /** Idempotent: returns the active link if one exists. Issued documents only. */
    readonly create: (
      id: DocumentId,
    ) => Effect.Effect<
      { readonly url: string },
      NotFound | Conflict | Unavailable | Forbidden,
      CurrentCaller
    >;
    readonly revoke: (
      id: DocumentId,
    ) => Effect.Effect<void, NotFound | Unavailable | Forbidden, CurrentCaller>;
    /** View and download events for the document's links, newest first (share.read). */
    readonly views: (
      id: DocumentId,
      page?: PageRequest,
    ) => Effect.Effect<
      Page<ShareViewEvent>,
      Invalid | NotFound | Unavailable | Forbidden,
      CurrentCaller
    >;
    // ShareLinkVisitor caller (token comes from the caller)
    /** Records a view (deduplicated per visitor per hour) and returns the recipient view. */
    readonly open: Effect.Effect<
      SharedDocumentView,
      NotFound | Unavailable | Forbidden,
      CurrentCaller
    >;
    /** Records a download event. */
    readonly pdf: (opts?: {
      readonly language?: Locale;
    }) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>;
    /** The issuing Workspace's logo for the page header; NotFound when it has none. */
    readonly logo: Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off Preserve the service key specified in core-ports.
>()("kvitbit/PublicShareLinks") {}
