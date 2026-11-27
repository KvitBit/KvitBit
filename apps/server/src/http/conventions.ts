/**
 * Handler helpers for the conventions of http-mcp-contracts section 3.2 and 3.4. The response
 * rules that need no handler code (ETag on `Revisioned` endpoints, `Idempotent-Replayed`, error
 * headers) live in `./edge/response.ts`.
 */

import {
  type Disposition,
  type EntityTag,
  type IdempotencyKey,
  PreconditionFailed,
  PreconditionRequired,
  parseEntityTag,
} from "@kvitbit/api-contract";
import {
  Conflict,
  type FileDownload,
  RequestKey,
  type RequestOptions,
} from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as Str from "effect/String";

/**
 * Rule of section 3.2: a missing `If-Match` is 428; core's `Conflict{revision_changed}` becomes
 * 412 with the current revision. Every other Conflict stays 409.
 */
export const withRevision = Effect.fnUntraced(function* <A, E, R>(
  ifMatch: EntityTag | undefined,
  run: (expectedRevision: number) => Effect.Effect<A, E, R>,
) {
  if (ifMatch === undefined) return yield* PreconditionRequired.make({});
  const isConflict = Schema.is(Conflict);
  return yield* run(parseEntityTag(ifMatch)).pipe(
    Effect.catchFilter(
      (error) =>
        isConflict(error) && error.reason === "revision_changed"
          ? Result.succeed(error)
          : Result.fail(error),
      (error) =>
        Effect.fail(PreconditionFailed.make({ currentRevision: error.currentRevision ?? null })),
    ),
  );
});

/** `Idempotency-Key` -> `RequestOptions.requestKey` (section 3.2). */
export const requestOptions = (headers: {
  readonly "idempotency-key"?: IdempotencyKey | undefined;
}): RequestOptions => {
  const key = headers["idempotency-key"];
  return key === undefined ? {} : { requestKey: RequestKey.make(key) };
};

/** Sets `Location` on the response (201 creates, section 3.2). `path` is absolute, e.g. `/api/v1/...`. */
export const setLocation = (path: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "location", path)),
  );

/** RFC 6266 `Content-Disposition` with an ASCII fallback and the UTF-8 `filename*`. */
const contentDisposition = (disposition: Disposition, filename: string): string => {
  const ascii = Str.replace(/["\\]/g, "_")(Str.replace(/[^\x20-\x7e]/g, "_")(filename));
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

export interface DownloadOptions {
  readonly disposition?: Disposition | undefined;
  /** Branding images: strong ETag of the content hash and a short private cache. */
  readonly etag?: string | undefined;
  readonly cacheControl?: string | undefined;
}

/**
 * A streamed download (section 3.4): Content-Type, Content-Disposition (attachment unless
 * `inline` was asked), Content-Length when known, `nosniff`, `private, no-store`.
 */
export const downloadResponse =
  (options: DownloadOptions) =>
  (file: {
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes?: number | null | undefined;
    readonly bytes: Stream.Stream<Uint8Array, unknown>;
  }): HttpServerResponse.HttpServerResponse => {
    const headers = {
      "content-disposition": contentDisposition(options.disposition ?? "attachment", file.filename),
      "x-content-type-options": "nosniff",
      "cache-control": options.cacheControl ?? "private, no-store",
    };
    return HttpServerResponse.stream(file.bytes, {
      contentType: file.contentType,
      contentLength: file.sizeBytes ?? undefined,
      headers: options.etag === undefined ? headers : { ...headers, etag: options.etag },
    });
  };

/** `downloadResponse` for a core `FileDownload`. */
export const fileDownload = (file: FileDownload) => downloadResponse({})(file);

/** Optional keys without `undefined` values (decoded query and header structs under exactOptionalPropertyTypes). */
export type Compact<T> = { readonly [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops the keys whose value is `undefined`. */
export const compact = <T extends object>(value: T): Compact<T> => {
  const result: Compact<T> = {};
  for (const [key, field] of Record.toEntries(value)) {
    if (field !== undefined) {
      Object.defineProperty(result, key, {
        value: field,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
};
