/**
 * BlobStorage on Google Cloud Storage for the hosted deployment (ADR 0003), over the JSON API
 * with no SDK.
 *
 * `put` holds one buffer per upload, reused per chunk: 256 KiB at first, grown once to
 * `chunkSize` (default 8 MiB), so a small body never pays for a full chunk. Adapter-owned payload
 * peaks at `chunkSize` + 256 KiB, during that one growth copy. A body that ends
 * within one chunk goes up as a single media upload; a longer one opens a resumable session and
 * sends each full chunk as it fills, so memory per upload is bounded whatever `maxBytes` is.
 * Both paths can resend what they hold: the media upload is retried whole, a resumable chunk
 * is resumed from the offset GCS reports as persisted. `maxBytes` and the sha256 are checked
 * chunk by chunk while reading; a body over the limit cancels its session, so no object is
 * created. `get` streams the download, `delete` treats 404 as done.
 */

import { type BlobKey, BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { checkKey, consumeBounded } from "./common";
import { GcsAccessToken } from "./gcs-access-token";

export interface GcsBlobStorageOptions {
  readonly bucket: string;
  /** Defaults to `https://storage.googleapis.com`; set for an emulator. */
  readonly endpoint?: string | undefined;
  /** Retries after a transient failure (408, 429, 5xx, transport, timeout). Default 2. */
  readonly retries?: number | undefined;
  /** First retry delay, doubled per retry. Default 200 ms. */
  readonly retryBackoff?: Duration.Input | undefined;
  /** Deadline for response headers, per attempt, and for reading a small response body. */
  readonly timeout?: Duration.Input | undefined;
  /** Longest wait for the next chunk of a download. Default 60 s. */
  readonly idleTimeout?: Duration.Input | undefined;
  /**
   * Size of each resumable chunk and of the upload buffer once grown (peak `chunkSize` + 256 KiB
   * during the single growth copy); a positive multiple of 256 KiB, as GCS requires. Default 8 MiB.
   */
  readonly chunkSize?: number | undefined;
}

const trailingSlashes = /\/+$/;
const persistedRange = /^bytes=0-(\d+)$/;
const chunkGranularity = 256 * 1024;

/** Why an attempt failed when another may succeed. */
class Transient extends Schema.TaggedError<Transient, { readonly brand: unique symbol }>()(
  "Transient",
  { cause: Schema.Defect() },
) {}

const isTransientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** `bytes=0-N` from a 308: the persisted byte count, N + 1; none persisted without a header. */
const persistedBytes = (response: HttpClientResponse.HttpClientResponse) => {
  const match = persistedRange.exec(response.headers.range ?? "");
  return match?.[1] === undefined ? 0 : Number(match[1]) + 1;
};

type ChunkAnswer =
  | { readonly _tag: "Persisted"; readonly bytes: number }
  | { readonly _tag: "Done" };

const make = (
  options: GcsBlobStorageOptions,
): Effect.Effect<BlobStorage["Service"], never, HttpClient.HttpClient | GcsAccessToken> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const tokens = yield* GcsAccessToken;
    const endpoint = Str.replace(
      trailingSlashes,
      "",
    )(options.endpoint ?? "https://storage.googleapis.com");
    const bucket = encodeURIComponent(options.bucket);
    const objectUrl = (key: BlobKey) =>
      `${endpoint}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;
    const uploadUrl = `${endpoint}/upload/storage/v1/b/${bucket}/o`;
    const timeout = options.timeout ?? Duration.seconds(30);
    const idleTimeout = options.idleTimeout ?? Duration.seconds(60);
    const retries = options.retries ?? 2;
    const backoff = Duration.toMillis(
      Duration.fromInputUnsafe(options.retryBackoff ?? "200 millis"),
    );
    const chunkSize = options.chunkSize ?? 32 * chunkGranularity;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize % chunkGranularity !== 0) {
      return yield* Effect.die(
        new RangeError(`chunkSize must be a positive multiple of 256 KiB: ${chunkSize}`),
      );
    }

    /** Reads a small body under the deadline; "" when it cannot. */
    const bodyText = (response: HttpClientResponse.HttpClientResponse) =>
      response.text.pipe(
        Effect.timeout(timeout),
        Effect.orElseSucceed(() => ""),
      );
    const drain = (response: HttpClientResponse.HttpClientResponse) =>
      Effect.ignore(Effect.timeout(response.arrayBuffer, timeout));
    /** What GCS answered, minus anything secret, for `BlobUnavailable.cause`. */
    /**
     * What GCS answered, for `BlobUnavailable.cause`: never a token, and for a resumable
     * session no body at all, since GCS may echo the session URI (an upload credential) in any
     * form.
     */
    const statusCause = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      operation === "session"
        ? Effect.as(drain(response), { operation, status: response.status })
        : Effect.map(bodyText(response), (body) => ({
            operation,
            status: response.status,
            body: Str.slice(0, 500)(body),
          }));
    const refused = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(statusCause(operation, response), (cause) =>
        Effect.fail(new BlobUnavailable({ cause })),
      );

    const getToken = tokens.get.pipe(Effect.mapError((cause) => new BlobUnavailable({ cause })));
    const execute = Effect.fn("GcsBlob.execute")(function* (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      token: string,
    ) {
      // A resumable session URI is an upload credential. Keep the id and Location out of telemetry.
      const urlNames = yield* UrlParams.CurrentRedactedNames;
      const headerNames = yield* Headers.CurrentRedactedNames;
      return yield* client.execute(HttpClientRequest.bearerToken(request, token)).pipe(
        Effect.provideService(UrlParams.CurrentRedactedNames, [...urlNames, "upload_id"]),
        Effect.provideService(Headers.CurrentRedactedNames, [...headerNames, "location"]),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail({ operation, reason: "timeout" }),
        }),
        Effect.mapError((cause) => Transient.make({ cause })),
      );
    });

    /**
     * One request. A 401 drops the token and resends once, at once, if a refresh yields a
     * different one. A transient status or a lost connection fails with `Transient`; a token
     * failure is final (the token layer retries on its own).
     */
    const attempt = Effect.fn("attempt")(function* (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const token = yield* getToken;
      let response = yield* execute(operation, request, token);
      if (response.status === 401) {
        yield* tokens.invalidate(token);
        const fresh = yield* getToken;
        if (fresh === token) return yield* refused(operation, response);
        yield* drain(response);
        response = yield* execute(operation, request, fresh);
        if (response.status === 401) return yield* refused(operation, response);
      }
      if (isTransientStatus(response.status)) {
        return yield* Transient.make({ cause: yield* statusCause(operation, response) });
      }
      return response;
    });

    const delayFor = (failures: number) => Duration.millis(backoff * 2 ** (failures - 1));

    /** `attempt`, retried with backoff; for requests that can be resent as they are. */
    const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      attempt(operation, request).pipe(
        Effect.retry({
          schedule: Schedule.exponential(Duration.millis(backoff)),
          times: retries,
          while: (error) => error._tag === "Transient",
        }),
        Effect.catchTag("Transient", ({ cause }) => Effect.fail(new BlobUnavailable({ cause }))),
      );

    // Resumable uploads -------------------------------------------------------------------

    const startSession = Effect.fn("startSession")(function* (key: BlobKey, contentType: string) {
      const response = yield* send(
        "put",
        HttpClientRequest.post(uploadUrl).pipe(
          HttpClientRequest.setUrlParams({ uploadType: "resumable", name: key }),
          HttpClientRequest.setHeader("X-Upload-Content-Type", contentType),
        ),
      );
      const location = response.headers.location;
      if (response.status !== 200 || location === undefined) {
        return yield* refused("put", response);
      }
      yield* drain(response);
      return location;
    });

    /** Frees an unfinished session; nothing was committed, so failures are ignored. */
    const cancelSession = (session: string) =>
      Effect.ignore(attempt("session", HttpClientRequest.delete(session)));

    const answerOf = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<ChunkAnswer, BlobUnavailable> =>
      response.status === 308
        ? Effect.as(drain(response), { _tag: "Persisted", bytes: persistedBytes(response) })
        : response.status === 200 || response.status === 201
          ? Effect.as(drain(response), { _tag: "Done" })
          : refused("session", response);

    /**
     * Sends `data`, the bytes at `start`, to the session; `total` is set for the last chunk.
     * After a transient failure, asks GCS what it persisted and resends only the rest.
     */
    const sendChunk = (
      session: string,
      data: Uint8Array,
      start: number,
      total: number | undefined,
    ): Effect.Effect<void, BlobUnavailable> => {
      const end = start + data.byteLength;
      const size = total === undefined ? "*" : String(total);
      const status = HttpClientRequest.put(session).pipe(
        HttpClientRequest.setHeader("Content-Range", `bytes */${size}`),
      );
      const loop = (from: number, failures: number): Effect.Effect<void, BlobUnavailable> => {
        if (failures > retries) {
          return Effect.fail(new BlobUnavailable({ cause: "resumable upload made no progress" }));
        }
        const settle = (answer: ChunkAnswer, nextFailures: number, afterTransient: boolean) => {
          if (answer._tag === "Done") {
            if (total === undefined) {
              return Effect.fail(new BlobUnavailable({ cause: "GCS finalized the upload early" }));
            }
            return Effect.void;
          }
          if (answer.bytes === end && total === undefined) return Effect.void;
          if (answer.bytes < start || answer.bytes > end) {
            return Effect.fail(
              new BlobUnavailable({ cause: { reason: "persisted offset out of range", answer } }),
            );
          }
          // Resend the rest. A transient failure was already counted; a 308 that persisted
          // nothing counts as one.
          const progressed = afterTransient || answer.bytes > from;
          return loop(answer.bytes, progressed ? nextFailures : nextFailures + 1);
        };
        const rest = data.subarray(from - start);
        const range =
          rest.byteLength === 0 ? `bytes */${size}` : `bytes ${from}-${end - 1}/${size}`;
        return attempt(
          "session",
          HttpClientRequest.put(session).pipe(
            HttpClientRequest.setHeader("Content-Range", range),
            HttpClientRequest.bodyUint8Array(rest),
          ),
        ).pipe(
          Effect.flatMap(answerOf),
          Effect.flatMap((answer) => settle(answer, failures, false)),
          Effect.catchTag("Transient", (error) =>
            failures + 1 > retries
              ? Effect.fail(new BlobUnavailable({ cause: error.cause }))
              : Effect.sleep(delayFor(failures + 1)).pipe(
                  Effect.andThen(send("session", status)),
                  Effect.flatMap(answerOf),
                  Effect.flatMap((answer) => settle(answer, failures + 1, true)),
                ),
          ),
        );
      };
      return loop(start, 0);
    };

    const mediaUpload = Effect.fn("mediaUpload")(function* (
      key: BlobKey,
      data: Uint8Array,
      contentType: string,
    ) {
      const response = yield* send(
        "put",
        HttpClientRequest.post(uploadUrl).pipe(
          HttpClientRequest.setUrlParams({ uploadType: "media", name: key }),
          HttpClientRequest.bodyUint8Array(data, contentType),
        ),
      );
      if (response.status !== 200) return yield* refused("put", response);
      yield* drain(response);
    });

    return BlobStorage.of({
      put: Effect.fn("BlobStorage.put")(function* (key, body, meta) {
        yield* checkKey(key);
        // One buffer per upload, reused for every chunk: it starts small so short bodies
        // stay cheap and grows once, to `chunkSize`.
        const state = {
          buffer: new Uint8Array(Math.min(chunkSize, chunkGranularity)),
          filled: 0,
          sent: 0,
          session: Option.none<string>(),
        };
        /** Sends the full buffer, opening the session first if needed, then reuses it. */
        const flush = Effect.gen(function* () {
          const session = Option.isSome(state.session)
            ? state.session.value
            : yield* startSession(key, meta.contentType);
          state.session = Option.some(session);
          yield* sendChunk(session, state.buffer.subarray(0, state.filled), state.sent, undefined);
          state.sent += state.filled;
          state.filled = 0;
        });
        // A full chunk is sent only once more bytes arrive, so a body of at most one chunk
        // always takes the single-request path.
        const onChunk = Effect.fn("onChunk")(function* (chunk: Uint8Array) {
          let rest = chunk;
          while (rest.byteLength > 0) {
            if (state.filled === chunkSize) yield* flush;
            if (state.filled === state.buffer.byteLength) {
              const grown = new Uint8Array(chunkSize);
              grown.set(state.buffer.subarray(0, state.filled));
              state.buffer = grown;
            }
            const take = Math.min(state.buffer.byteLength - state.filled, rest.byteLength);
            // Copies, so a producer reusing its buffer cannot change what is sent.
            state.buffer.set(rest.subarray(0, take), state.filled);
            state.filled += take;
            rest = rest.subarray(take);
          }
        });
        const upload = Effect.gen(function* () {
          const consumed = yield* consumeBounded(body, meta.maxBytes, onChunk);
          const last = state.buffer.subarray(0, state.filled);
          if (Option.isNone(state.session)) {
            yield* mediaUpload(key, last, meta.contentType);
          } else {
            yield* sendChunk(state.session.value, last, state.sent, consumed.bytes);
          }
          return consumed;
        });
        const { bytes, sha256 } = yield* upload.pipe(
          Effect.onError(() => {
            if (Option.isSome(state.session)) return cancelSession(state.session.value);
            return Effect.void;
          }),
        );
        return { key, bytes, sha256 };
      }),
      get: Effect.fn("BlobStorage.get")(function* (key) {
        yield* checkKey(key);
        const response = yield* send(
          "get",
          HttpClientRequest.get(objectUrl(key)).pipe(
            HttpClientRequest.setUrlParams({ alt: "media" }),
          ),
        );
        if (response.status === 404) {
          yield* drain(response);
          return yield* new BlobMissing({ key });
        }
        if (response.status !== 200) return yield* refused("get", response);
        // An empty object may come with no body at all, which `response.stream` rejects.
        if (response.headers["content-length"] === "0") {
          yield* drain(response);
          return Stream.empty;
        }
        // The port's stream has no error channel: a connection lost or stalled mid-body is a
        // defect.
        return response.stream.pipe(
          Stream.timeoutOrElse({
            duration: idleTimeout,
            orElse: () =>
              Stream.die(
                new BlobUnavailable({ cause: { operation: "get", reason: "idle timeout" } }),
              ),
          }),
          Stream.orDie,
        );
      }),
      delete: Effect.fn("BlobStorage.delete")(function* (key) {
        yield* checkKey(key);
        const response = yield* send("delete", HttpClientRequest.delete(objectUrl(key)));
        if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
          return yield* refused("delete", response);
        }
        yield* drain(response);
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
