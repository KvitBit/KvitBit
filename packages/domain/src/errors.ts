/**
 * The five shared errors (core-ports section 3). Each carries its HTTP status, so HttpApi and
 * MCP encode them without per-endpoint mapping. Use `X.schema` where the status matters.
 */

import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";
import { Action, IssueCode } from "./action";
import { EntityKind } from "./vocabulary";

export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  {
    entity: EntityKind,
    id: Schema.String,
  },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("NotFound")); // 404
}

export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  {
    action: Action,
  },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("Forbidden")); // 403
}

export const Issue = Schema.Struct({
  // @effect-diagnostics-next-line schemaNumber:off Preserve the JSON codec for numeric path segments.
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  code: IssueCode, // stable i18n key; presenters localize cs/en
  params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type Issue = typeof Issue.Type;

export class Invalid extends Schema.TaggedError<Invalid, { readonly brand: unique symbol }>()(
  "Invalid",
  {
    issues: Schema.NonEmptyArray(Issue),
  },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("UnprocessableEntity")); // 422
}

export const ConflictReason = Schema.Literals([
  "revision_changed", // stale expectedRevision / If-Match
  "document_locked", // edit or cancel on a locked document
  "illegal_transition", // e.g. send a draft, discard an issued document, remove last owner
  "duplicate", // number override taken, second Final Invoice, duplicate IČO Contact
  "idempotency_mismatch", // same requestKey, different payload
]);
export type ConflictReason = typeof ConflictReason.Type;

export class Conflict extends Schema.TaggedError<Conflict, { readonly brand: unique symbol }>()(
  "Conflict",
  {
    reason: ConflictReason,
    // @effect-diagnostics-next-line schemaNumber:off Preserve decoding of legacy JSON strings such as "Infinity".
    currentRevision: Schema.optional(Schema.Number),
    detail: Schema.optional(IssueCode),
  },
) {
  static readonly schema = this.pipe(HttpApiSchema.status("Conflict")); // 409
}

export const UnavailableDependency = Schema.Literals([
  "company_registry",
  "exchange_rates",
  "blob_storage",
  "database",
]);
export type UnavailableDependency = typeof UnavailableDependency.Type;

export class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {
  dependency: UnavailableDependency,
  // @effect-diagnostics-next-line schemaNumber:off Preserve decoding of legacy JSON strings such as "NaN".
  retryAfterSeconds: Schema.optional(Schema.Number),
}) {
  static readonly schema = this.pipe(HttpApiSchema.status("ServiceUnavailable")); // 503
}

export type CoreError = NotFound | Forbidden | Invalid | Conflict | Unavailable;
export const CoreError = Schema.Union([NotFound, Forbidden, Invalid, Conflict, Unavailable]);
