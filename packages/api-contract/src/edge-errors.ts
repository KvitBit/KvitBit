/**
 * The seven edge errors (http-mcp-contracts section 3.3). Core's five errors come from
 * `@kvitbit/domain/contract` and carry their own status; these exist only at the HTTP edge.
 */

import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";

export const UnauthorizedReason = Schema.Literals([
  "missing",
  "invalid",
  "expired",
  "credential_not_allowed",
  "reauthentication_required",
]);
export type UnauthorizedReason = typeof UnauthorizedReason.Type;

// Keep the nominal brand outside the public error fields.
declare const edgeErrorBrand: unique symbol;
interface EdgeErrorBrand {
  readonly [edgeErrorBrand]: true;
}

export class Unauthorized extends Schema.TaggedError<Unauthorized, EdgeErrorBrand>()(
  "Unauthorized",
  {
    reason: UnauthorizedReason,
  },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("Unauthorized")); // 401
}

/** ALTCHA payload missing, for the wrong scope, expired or replayed (section 2.6, rule B3). */
export class InvalidBotProof extends Schema.TaggedError<InvalidBotProof, EdgeErrorBrand>()(
  "InvalidBotProof",
  {},
) {
  static readonly schema = this.pipe(HttpApiSchema.status("BadRequest")); // 400
}

export class OriginRejected extends Schema.TaggedError<OriginRejected, EdgeErrorBrand>()(
  "OriginRejected",
  {},
) {
  static readonly schema = this.pipe(HttpApiSchema.status("Forbidden")); // 403
}

export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed, EdgeErrorBrand>()(
  "PreconditionFailed",
  { currentRevision: Schema.NullOr(Schema.Int) },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("PreconditionFailed")); // 412
}

export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge, EdgeErrorBrand>()(
  "PayloadTooLarge",
  {
    limitBytes: Schema.Int,
  },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("PayloadTooLarge")); // 413
}

export class PreconditionRequired extends Schema.TaggedError<
  PreconditionRequired,
  EdgeErrorBrand
>()("PreconditionRequired", {}) {
  static readonly schema = this.pipe(HttpApiSchema.status(428));
}

export class RateLimited extends Schema.TaggedError<RateLimited, EdgeErrorBrand>()("RateLimited", {
  retryAfterSeconds: Schema.Int,
}) {
  static readonly schema = this.pipe(HttpApiSchema.status("TooManyRequests")); // 429
}

export type EdgeError =
  | Unauthorized
  | InvalidBotProof
  | OriginRejected
  | PreconditionFailed
  | PayloadTooLarge
  | PreconditionRequired
  | RateLimited;
export const EdgeError = Schema.Union([
  Unauthorized,
  InvalidBotProof,
  OriginRejected,
  PreconditionFailed,
  PayloadTooLarge,
  PreconditionRequired,
  RateLimited,
]);

/** Errors of every endpoint that requires `If-Match`. */
export const RevisionedEdgeErrors = [
  PreconditionFailed.schema,
  PreconditionRequired.schema,
] as const;
