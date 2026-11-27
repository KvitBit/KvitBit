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
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Effect, Option, type Stream } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";

export const requestWasReplayed = Effect.flatMap(
  Effect.serviceOption(RequestOutcome),
  Option.match({ onNone: () => Effect.succeed(false), onSome: (outcome) => outcome.replayed }),
);

/**
 * Rule of section 3.2: a missing `If-Match` is 428; core's `Conflict{revision_changed}` becomes
 * 412 with the current revision. Every other Conflict stays 409.
 */
export const withRevision = <A, E, R>(
  ifMatch: EntityTag | undefined,
  run: (expectedRevision: number) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  Exclude<E, Conflict> | Conflict | PreconditionRequired | PreconditionFailed,
  R
> =>
  ifMatch === undefined
    ? Effect.fail(new PreconditionRequired({}))
    : (run(parseEntityTag(ifMatch)).pipe(
        Effect.catchIf(
          (e): e is Extract<E, Conflict> =>
            e instanceof Conflict && e.reason === "revision_changed",
          (e) =>
            Effect.fail(new PreconditionFailed({ currentRevision: e.currentRevision ?? null })),
        ),
      ) as Effect.Effect<
        A,
        Exclude<E, Conflict> | Conflict | PreconditionRequired | PreconditionFailed,
        R
      >);

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
export const contentDisposition = (disposition: Disposition, filename: string): string => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
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
export const downloadResponse = (
  file: {
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes?: number | null | undefined;
    readonly bytes: Stream.Stream<Uint8Array, unknown>;
  },
  options: DownloadOptions = {},
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.stream(file.bytes, {
    contentType: file.contentType,
    ...(file.sizeBytes === undefined || file.sizeBytes === null
      ? {}
      : { contentLength: file.sizeBytes }),
    headers: {
      "content-disposition": contentDisposition(options.disposition ?? "attachment", file.filename),
      "x-content-type-options": "nosniff",
      "cache-control": options.cacheControl ?? "private, no-store",
      ...(options.etag === undefined ? {} : { etag: options.etag }),
    },
  });

/** `downloadResponse` for a core `FileDownload`. */
export const fileDownload = (file: FileDownload, options: DownloadOptions = {}) =>
  downloadResponse(file, options);

/** Optional keys without `undefined` values (decoded query and header structs under exactOptionalPropertyTypes). */
export type Compact<T> = { readonly [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops the keys whose value is `undefined`. */
export const compact = <T extends object>(value: T): Compact<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Compact<T>;
