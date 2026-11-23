/** Payments (core-ports 4.5) and PublicShareLinks (core-ports 4.6). Interfaces only. */
import type { Effect } from "effect";
import { Context, Schema } from "effect";
import type { CurrentCaller } from "../caller";
import type { Conflict, CoreError, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { DocumentId, ExpenseId, PaymentId } from "../ids";
import { ShareViewId } from "../ids";
import type { FileDownload, Unspecified } from "../shared";
import type {
  IsoDate,
  Locale,
  Money,
  Page,
  PageRequest,
  PaymentMethod,
  RequestOptions,
} from "../vocabulary";
import type { DocumentView } from "./documents";

export type PaymentView = Unspecified<"PaymentView">;

export type PaymentTarget = { readonly document: DocumentId } | { readonly expense: ExpenseId };

export interface RecordPaymentInput {
  readonly target: PaymentTarget;
  readonly amount?: Money;
  readonly paidOn?: IsoDate;
  readonly method?: PaymentMethod;
  readonly note?: string;
}

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
    ) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>;
    readonly listFor: (
      target: PaymentTarget,
    ) => Effect.Effect<ReadonlyArray<PaymentView>, NotFound | Forbidden, CurrentCaller>;
  }
>()("kvitbit/Payments") {}

export const ShareViewEvent = Schema.Struct({
  id: ShareViewId,
  kind: Schema.Literals(["view", "download"]),
  at: Schema.String, // ISO instant
  device: Schema.Literals(["desktop", "mobile", "tablet", "unknown"]), // coarse, from the user agent
});
export type ShareViewEvent = typeof ShareViewEvent.Type;

/** Narrowed recipient projection; adds `viewerIsIssuer: boolean`. Fields not yet specified. */
export type SharedDocumentView = Unspecified<"SharedDocumentView">;

/** Serves both sides of a Public Share Link: Members manage it, visitors open it. */
export class PublicShareLinks extends Context.Service<
  PublicShareLinks,
  {
    // Member caller
    /** Idempotent: returns the active link if one exists. Issued documents only. */
    readonly create: (
      id: DocumentId,
    ) => Effect.Effect<{ readonly url: string }, NotFound | Conflict | Forbidden, CurrentCaller>;
    readonly revoke: (id: DocumentId) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>;
    /** View and download events for the document's links, newest first (share.read). */
    readonly views: (
      id: DocumentId,
      page?: PageRequest,
    ) => Effect.Effect<Page<ShareViewEvent>, Invalid | NotFound | Forbidden, CurrentCaller>;
    // ShareLinkVisitor caller (token comes from the caller)
    /** Records a view (deduplicated per visitor per hour) and returns the recipient view. */
    readonly open: Effect.Effect<SharedDocumentView, NotFound, CurrentCaller>;
    /** Records a download event. */
    readonly pdf: (opts?: {
      readonly language?: Locale;
    }) => Effect.Effect<FileDownload, NotFound | Unavailable, CurrentCaller>;
    /** The issuing Workspace's logo for the page header; NotFound when it has none. */
    readonly logo: Effect.Effect<FileDownload, NotFound | Unavailable, CurrentCaller>;
  }
>()("kvitbit/PublicShareLinks") {}
