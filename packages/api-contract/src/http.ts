/**
 * Shared HTTP conventions (http-mcp-contracts section 3.2): entity tags, retry keys, paging
 * query fields, status helpers and the binary body schemas of section 3.4.
 */
import { Context, Schema } from "effect";
import { Multipart } from "effect/http";
import { HttpApiSchema } from "effect/http-api";

/** Strong entity tag holding a revision: `"7"`. Weak tags (W/) and `*` are rejected. */
export const EntityTag = Schema.String.pipe(Schema.check(Schema.isPattern(/^"(0|[1-9]\d{0,9})"$/)));
export type EntityTag = typeof EntityTag.Type;
export const parseEntityTag = (tag: EntityTag): number => Number(tag.slice(1, -1));
export const entityTag = (revision: number): EntityTag => `"${revision}"`;

/** Client-chosen retry key. UUIDv7 recommended. Maps to RequestOptions.requestKey. */
export const IdempotencyKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/)),
);
export type IdempotencyKey = typeof IdempotencyKey.Type;

export const IfMatchHeaders = Schema.Struct({ "if-match": Schema.optional(EntityTag) });
export const IdempotencyHeaders = Schema.Struct({
  "idempotency-key": Schema.optional(IdempotencyKey),
});
export const WriteHeaders = Schema.Struct({
  ...IfMatchHeaders.fields,
  ...IdempotencyHeaders.fields,
});

/** Paging defaults and bounds (AG-UI-1). */
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;

/**
 * Query fields every paged list accepts, merged with the list's own filter fields. HttpApi
 * wraps query schemas in a string-tree codec, so `limit` is declared as an integer and travels
 * as its decimal string.
 */
export const PageQueryFields = {
  cursor: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))),
  limit: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: PAGE_LIMIT_MAX }))),
  ),
};

/** Endpoint annotation: the success value has a `revision`, so the server sets `ETag` from it. */
export const Revisioned = Context.Reference<boolean>("kvitbit/http/Revisioned", {
  defaultValue: () => false,
});

export const Created = <S extends Schema.Top>(schema: S): S["Rebuild"] =>
  schema.pipe(HttpApiSchema.status(201));
export const Accepted = <S extends Schema.Top>(schema: S): S["Rebuild"] =>
  schema.pipe(HttpApiSchema.status(202));
export const NoContent = HttpApiSchema.NoContent; // 204
export const AcceptedEmpty = HttpApiSchema.Empty(202);

/** `?disposition=inline` for in-app viewers; downloads default to `attachment`. */
export const Disposition = Schema.Literals(["attachment", "inline"]);
export type Disposition = typeof Disposition.Type;

/** Upload limits and accepted types (section 3.4), also reported by `GET /api/v1/config`. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
] as const;
export const BRANDING_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BRANDING_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;
export const THEME_JSON_MAX_BYTES = 64 * 1024;

/**
 * Streamed binary success bodies: PDFs, attachments, exports (never buffered whole).
 *
 * These schemas declare the content types for OpenAPI and typed clients. A handler whose MIME
 * type varies per response (an attachment, a branding image, a CSV-or-PDF export) or that sets
 * download headers (`Content-Disposition`, `Content-Length`) returns a raw
 * `HttpServerResponse` from `effect/http` instead of a bare stream.
 */
export const PdfBytes = HttpApiSchema.StreamUint8Array({ contentType: "application/pdf" });
export const ImageBytes = HttpApiSchema.StreamUint8Array({
  contentType: [...BRANDING_IMAGE_TYPES],
});
export const AttachmentBytes = HttpApiSchema.StreamUint8Array({
  contentType: [...ATTACHMENT_TYPES],
});
export const ReportExportBytes = HttpApiSchema.StreamUint8Array({
  contentType: ["text/csv; charset=utf-8", "application/pdf"],
});
export const ZipBytes = HttpApiSchema.StreamUint8Array({ contentType: "application/zip" });

/** One multipart part named `file` (filename and content type), streamed to core. */
export const UploadedFile = Multipart.SingleFileSchema;
export const AttachPayload = Schema.Struct({ file: UploadedFile }).pipe(
  HttpApiSchema.asMultipartStream({ maxParts: 1, maxFileSize: ATTACHMENT_MAX_BYTES }),
);
export const BrandingImagePayload = Schema.Struct({ file: UploadedFile }).pipe(
  HttpApiSchema.asMultipartStream({ maxParts: 1, maxFileSize: BRANDING_IMAGE_MAX_BYTES }),
);
