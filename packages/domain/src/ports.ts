/**
 * Driven ports (core-ports section 6) and the request-scoped RequestOutcome (section 2.1).
 * Interfaces only. Port errors are internal `Schema.TaggedError`s; modules translate them to
 * `Unavailable`, so provider details never cross the seam.
 *
 * The spec names the port errors and gives the value types only as field lists in comments;
 * field types below follow those comments.
 */
import type * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { CurrencyCode, IsoDate } from "./vocabulary";

// CompanyRegistry ---------------------------------------------------------------------------

/** ARES record. Carries no VAT-payer flag: ARES dic presence does not prove payer status. */
export interface RegistryRecord {
  readonly name: string;
  readonly address: {
    readonly street: string;
    readonly city: string;
    readonly postalCode: string;
    readonly country: string;
  };
  readonly dic: string | null;
  readonly legalForm: string;
  readonly registerEntry: string | null;
  /** Dissolution date; feeds RegistryResult.terminatedOn (core-ports 4.1). */
  readonly terminatedOn: IsoDate | null;
}

export class RegistryUnavailable extends Schema.TaggedError<
  RegistryUnavailable,
  { readonly brand: unique symbol }
>()("RegistryUnavailable", {
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Czech business register. Core validates the IČO checksum and caches results. */
export class CompanyRegistry extends Context.Service<
  CompanyRegistry,
  {
    readonly lookup: (ico: string) => Effect.Effect<RegistryRecord | null, RegistryUnavailable>;
  }
>()("@kvitbit/domain/ports/CompanyRegistry") {}

// ExchangeRates -----------------------------------------------------------------------------

export interface CnbFixing {
  readonly fixingDate: IsoDate;
  readonly sequence: number;
  readonly rates: ReadonlyArray<{
    readonly code: CurrencyCode;
    readonly quantity: number; // množství
    readonly rate: BigDecimal.BigDecimal;
  }>;
}

export class RatesUnavailable extends Schema.TaggedError<
  RatesUnavailable,
  { readonly brand: unique symbol }
>()("RatesUnavailable", {
  cause: Schema.optional(Schema.Defect()),
}) {}

/** CNB daily fixing. Returns the latest fixing published on or before `date`. */
export class ExchangeRates extends Context.Service<
  ExchangeRates,
  {
    readonly fixing: (date: IsoDate) => Effect.Effect<CnbFixing, RatesUnavailable>;
  }
>()("@kvitbit/domain/ports/ExchangeRates") {}

// EmailSender -------------------------------------------------------------------------------

export interface OutboundEmail {
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string>;
  readonly replyTo: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }>;
  readonly tags: Readonly<Record<string, string>>;
}

/** Permanent (bad address, policy); never retried. */
export class EmailRejected extends Schema.TaggedError<
  EmailRejected,
  { readonly brand: unique symbol }
>()("EmailRejected", {
  cause: Schema.optional(Schema.Defect()),
}) {}
/** The provider certainly did not take the message; retrying or failing over is safe. */
export class EmailNotAccepted extends Schema.TaggedError<
  EmailNotAccepted,
  { readonly brand: unique symbol }
>()("EmailNotAccepted", {
  cause: Schema.optional(Schema.Defect()),
}) {}
/** Timeout or dropped connection after sending; retry the SAME provider with the same key only. */
export class EmailOutcomeUnknown extends Schema.TaggedError<
  EmailOutcomeUnknown,
  { readonly brand: unique symbol }
>()("EmailOutcomeUnknown", {
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Transactional email. The idempotency key is the delivery id. */
export class EmailSender extends Context.Service<
  EmailSender,
  {
    readonly send: (
      message: OutboundEmail,
      opts: { readonly idempotencyKey: string },
    ) => Effect.Effect<
      { readonly provider: string; readonly providerMessageId: string },
      EmailRejected | EmailNotAccepted | EmailOutcomeUnknown
    >;
  }
>()("@kvitbit/domain/ports/EmailSender") {}

// BlobStorage -------------------------------------------------------------------------------

/** Core-chosen, Workspace-prefixed object key. */
export const BlobKey = Schema.String.pipe(Schema.brand("BlobKey"));
export type BlobKey = typeof BlobKey.Type;

export class BlobTooLarge extends Schema.TaggedError<
  BlobTooLarge,
  { readonly brand: unique symbol }
>()("BlobTooLarge", { maxBytes: Schema.Finite }) {}
export class BlobMissing extends Schema.TaggedError<
  BlobMissing,
  { readonly brand: unique symbol }
>()("BlobMissing", {
  key: BlobKey,
}) {}
export class BlobUnavailable extends Schema.TaggedError<
  BlobUnavailable,
  { readonly brand: unique symbol }
>()("BlobUnavailable", {
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Attachments and rendered PDFs. */
export class BlobStorage extends Context.Service<
  BlobStorage,
  {
    readonly put: (
      key: BlobKey,
      body: Stream.Stream<Uint8Array>,
      meta: { readonly contentType: string; readonly maxBytes: number },
    ) => Effect.Effect<
      { readonly key: BlobKey; readonly bytes: number; readonly sha256: string },
      BlobTooLarge | BlobUnavailable
    >;
    readonly get: (
      key: BlobKey,
    ) => Effect.Effect<Stream.Stream<Uint8Array>, BlobMissing | BlobUnavailable>;
    readonly delete: (key: BlobKey) => Effect.Effect<void, BlobUnavailable>; // idempotent
  }
>()("@kvitbit/domain/ports/BlobStorage") {}

// RequestOutcome ----------------------------------------------------------------------------

/**
 * Replay signal (core-ports 2.1). Optional: core reads it with `Effect.serviceOption`, so it
 * never appears in a method's `R` channel. The Ref-backed `make` belongs to the core package.
 */
export class RequestOutcome extends Context.Service<
  RequestOutcome,
  {
    readonly markReplayed: Effect.Effect<void>;
    readonly replayed: Effect.Effect<boolean>;
  }
>()("@kvitbit/domain/ports/RequestOutcome") {}
