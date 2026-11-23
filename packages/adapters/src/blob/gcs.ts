/**
 * BlobStorage on Google Cloud Storage for the hosted deployment (ADR 0003), over the JSON API
 * with no SDK: media upload, `alt=media` download, delete.
 *
 * `put` buffers the body in memory, up to `maxBytes` and no further (the limit is enforced
 * chunk by chunk while reading), then uploads it in one request with a Content-Length. A
 * buffered body can be resent, so a 401 (token revoked or expired early), a 429, a 5xx or a
 * lost connection is retried; re-uploading the same bytes to the same name is idempotent. Port
 * limits are sized for attachments and PDFs, so the buffer stays small.
 */
import { type BlobKey, BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import { Config, Data, Duration, Effect, Layer, Schedule, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { checkKey, collectBounded } from "./common";
import { GcsAccessToken } from "./gcs-access-token";

export interface GcsBlobStorageOptions {
  readonly bucket: string;
  /** Defaults to `https://storage.googleapis.com`; set for an emulator. */
  readonly endpoint?: string | undefined;
  /** Retries after a transient failure (401, 429, 5xx, transport, timeout). Default 2. */
  readonly retries?: number | undefined;
  /** First retry delay, doubled per retry. Default 200 ms. */
  readonly retryBackoff?: Duration.Input | undefined;
  /** Deadline for response headers, per attempt. Default 30 s. */
  readonly timeout?: Duration.Input | undefined;
}

/** Why an attempt failed when another may succeed. */
class Transient extends Data.TaggedError("Transient")<{ readonly cause: unknown }> {}

/** What GCS answered, minus anything secret, for `BlobUnavailable.cause`. */
const statusCause = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map((body) => ({ operation, status: response.status, body: body.slice(0, 500) })),
  );

const isTransientStatus = (status: number) => status === 401 || status === 429 || status >= 500;

const make = (
  options: GcsBlobStorageOptions,
): Effect.Effect<BlobStorage["Service"], never, HttpClient.HttpClient | GcsAccessToken> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const tokens = yield* GcsAccessToken;
    const endpoint = (options.endpoint ?? "https://storage.googleapis.com").replace(/\/+$/, "");
    const bucket = encodeURIComponent(options.bucket);
    const objectUrl = (key: BlobKey) =>
      `${endpoint}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;
    const uploadUrl = `${endpoint}/upload/storage/v1/b/${bucket}/o`;
    const timeout = options.timeout ?? Duration.seconds(30);
    const retry = Schedule.exponential(options.retryBackoff ?? Duration.millis(200));

    /**
     * Sends `request` with a bearer token until it gets a non-transient answer or retries run
     * out. A 401 drops the token first, so the retry fetches a new one.
     */
    const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const token = yield* tokens.get.pipe(Effect.mapError((cause) => new Transient({ cause })));
        const response = yield* client.execute(HttpClientRequest.bearerToken(request, token)).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail({ operation, reason: "timeout" }),
          }),
          Effect.mapError((cause) => new Transient({ cause })),
        );
        if (isTransientStatus(response.status)) {
          if (response.status === 401) yield* tokens.invalidate(token);
          return yield* Effect.fail(
            new Transient({ cause: yield* statusCause(operation, response) }),
          );
        }
        return response;
      }).pipe(
        Effect.retry({ schedule: retry, times: options.retries ?? 2 }),
        Effect.mapError(({ cause }) => new BlobUnavailable({ cause })),
      );

    const refused = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(statusCause(operation, response), (cause) =>
        Effect.fail(new BlobUnavailable({ cause })),
      );

    return BlobStorage.of({
      put: (key, body, meta) =>
        Effect.gen(function* () {
          yield* checkKey(key);
          const { data, bytes, sha256 } = yield* collectBounded(body, meta.maxBytes);
          const response = yield* send(
            "put",
            HttpClientRequest.post(uploadUrl).pipe(
              HttpClientRequest.setUrlParams({ uploadType: "media", name: key }),
              HttpClientRequest.bodyUint8Array(data, meta.contentType),
            ),
          );
          if (response.status !== 200) return yield* refused("put", response);
          yield* Effect.ignore(response.arrayBuffer);
          return { key, bytes, sha256 };
        }),
      get: (key) =>
        Effect.gen(function* () {
          yield* checkKey(key);
          const response = yield* send(
            "get",
            HttpClientRequest.get(objectUrl(key)).pipe(
              HttpClientRequest.setUrlParams({ alt: "media" }),
            ),
          );
          if (response.status === 404) {
            yield* Effect.ignore(response.arrayBuffer);
            return yield* Effect.fail(new BlobMissing({ key }));
          }
          if (response.status !== 200) return yield* refused("get", response);
          // The port's stream has no error channel: a connection lost mid-body is a defect.
          return response.stream.pipe(Stream.orDie);
        }),
      delete: (key) =>
        Effect.gen(function* () {
          yield* checkKey(key);
          const response = yield* send("delete", HttpClientRequest.delete(objectUrl(key)));
          if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
            return yield* refused("delete", response);
          }
          yield* Effect.ignore(response.arrayBuffer);
        }),
    });
  });

export const GcsBlobStorage = {
  make,
  layer: (
    options: GcsBlobStorageOptions,
  ): Layer.Layer<BlobStorage, never, HttpClient.HttpClient | GcsAccessToken> =>
    Layer.effect(BlobStorage, make(options)),
  /** Reads the bucket from `BLOB_GCS_BUCKET`. */
  layerConfig: (
    bucket: Config.Config<string> = Config.NonEmptyString("BLOB_GCS_BUCKET"),
  ): Layer.Layer<BlobStorage, Config.ConfigError, HttpClient.HttpClient | GcsAccessToken> =>
    Layer.effect(
      BlobStorage,
      Effect.flatMap(bucket, (name) => make({ bucket: name })),
    ),
} as const;
