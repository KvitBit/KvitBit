/**
 * BlobStorage on Google Cloud Storage for the hosted deployment (ADR 0003), over the JSON API
 * with no SDK.
 *
 * `put` never holds more than `chunkSize` bytes of the body (default 8 MiB). A body that ends
 * within one chunk goes up as a single media upload; a longer one opens a resumable session and
 * sends each full chunk as it fills, so memory per upload is bounded whatever `maxBytes` is.
 * Both paths can resend what they hold: the media upload is retried whole, a resumable chunk
 * is resumed from the offset GCS reports as persisted. `maxBytes` and the sha256 are checked
 * chunk by chunk while reading; a body over the limit cancels its session, so no object is
 * created. `get` streams the download, `delete` treats 404 as done.
 */
import { type BlobKey, BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import { Config, Data, Duration, Effect, Layer, Schedule, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { checkKey, consumeBounded, copyOf } from "./common";
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
  /** Bytes held per upload; a positive multiple of 256 KiB, as GCS requires. Default 8 MiB. */
  readonly chunkSize?: number | undefined;
}

const chunkGranularity = 256 * 1024;

/** Why an attempt failed when another may succeed. */
class Transient extends Data.TaggedError("Transient")<{ readonly cause: unknown }> {}

const isTransientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** `bytes=0-N` from a 308: the persisted byte count, N + 1; none persisted without a header. */
const persistedBytes = (response: HttpClientResponse.HttpClientResponse) => {
  const match = /^bytes=0-(\d+)$/.exec(response.headers.range ?? "");
  return match?.[1] === undefined ? 0 : Number(match[1]) + 1;
};

type ChunkAnswer =
  | { readonly _tag: "Persisted"; readonly bytes: number }
  | { readonly _tag: "Done" };

const concat = (chunks: ReadonlyArray<Uint8Array>, bytes: number) => {
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
};

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
    const statusCause = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      Effect.map(bodyText(response), (body) => ({
        operation,
        status: response.status,
        body: body.slice(0, 500),
      }));
    const refused = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(statusCause(operation, response), (cause) =>
        Effect.fail(new BlobUnavailable({ cause })),
      );

    const getToken = tokens.get.pipe(Effect.mapError((cause) => new BlobUnavailable({ cause })));
    const execute = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      token: string,
    ) =>
      client.execute(HttpClientRequest.bearerToken(request, token)).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail({ operation, reason: "timeout" }),
        }),
        Effect.mapError((cause) => new Transient({ cause })),
      );

    /**
     * One request. A 401 drops the token and resends once, at once, if a refresh yields a
     * different one. A transient status or a lost connection fails with `Transient`; a token
     * failure is final (the token layer retries on its own).
     */
    const attempt = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
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
          return yield* Effect.fail(
            new Transient({ cause: yield* statusCause(operation, response) }),
          );
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

    const startSession = (key: BlobKey, contentType: string) =>
      Effect.gen(function* () {
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
      Effect.ignore(attempt("put", HttpClientRequest.delete(session)));

    const answerOf = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<ChunkAnswer, BlobUnavailable> =>
      response.status === 308
        ? Effect.as(drain(response), { _tag: "Persisted", bytes: persistedBytes(response) })
        : response.status === 200 || response.status === 201
          ? Effect.as(drain(response), { _tag: "Done" })
          : refused("put", response);

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
        const settle = (answer: ChunkAnswer, nextFailures: number) => {
          if (answer._tag === "Done") {
            return total === undefined
              ? Effect.fail(new BlobUnavailable({ cause: "GCS finalized the upload early" }))
              : Effect.void;
          }
          if (answer.bytes === end && total === undefined) return Effect.void;
          if (answer.bytes < start || answer.bytes > end) {
            return Effect.fail(
              new BlobUnavailable({ cause: { reason: "persisted offset out of range", answer } }),
            );
          }
          // Partly persisted: resend the rest, counting a failure only when nothing advanced.
          return loop(answer.bytes, answer.bytes > from ? nextFailures : nextFailures + 1);
        };
        const rest = data.subarray(from - start);
        const range =
          rest.byteLength === 0 ? `bytes */${size}` : `bytes ${from}-${end - 1}/${size}`;
        return attempt(
          "put",
          HttpClientRequest.put(session).pipe(
            HttpClientRequest.setHeader("Content-Range", range),
            HttpClientRequest.bodyUint8Array(rest),
          ),
        ).pipe(
          Effect.flatMap(answerOf),
          Effect.flatMap((answer) => settle(answer, failures)),
          Effect.catchTag("Transient", (error) =>
            failures + 1 > retries
              ? Effect.fail(new BlobUnavailable({ cause: error.cause }))
              : Effect.sleep(delayFor(failures + 1)).pipe(
                  Effect.andThen(send("put", status)),
                  Effect.flatMap(answerOf),
                  Effect.flatMap((answer) => settle(answer, failures + 1)),
                ),
          ),
        );
      };
      return loop(start, 0);
    };

    const mediaUpload = (key: BlobKey, data: Uint8Array, contentType: string) =>
      Effect.gen(function* () {
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
      put: (key, body, meta) =>
        Effect.gen(function* () {
          yield* checkKey(key);
          const state: {
            pending: Array<Uint8Array>;
            pendingBytes: number;
            sent: number;
            session: string | undefined;
          } = { pending: [], pendingBytes: 0, sent: 0, session: undefined };
          /** Sends the full pending chunk, opening the session first if needed. */
          const flush = Effect.gen(function* () {
            const session = state.session ?? (yield* startSession(key, meta.contentType));
            state.session = session;
            const data = concat(state.pending, state.pendingBytes);
            state.pending = [];
            state.pendingBytes = 0;
            yield* sendChunk(session, data, state.sent, undefined);
            state.sent += data.byteLength;
          });
          // A full chunk is sent only once more bytes arrive, so a body of at most one chunk
          // always takes the single-request path.
          const onChunk = (chunk: Uint8Array) =>
            Effect.gen(function* () {
              let rest = chunk;
              while (rest.byteLength > 0) {
                if (state.pendingBytes === chunkSize) yield* flush;
                const take = Math.min(chunkSize - state.pendingBytes, rest.byteLength);
                state.pending.push(copyOf(rest.subarray(0, take)));
                state.pendingBytes += take;
                rest = rest.subarray(take);
              }
            });
          const upload = Effect.gen(function* () {
            const consumed = yield* consumeBounded(body, meta.maxBytes, onChunk);
            const last = concat(state.pending, state.pendingBytes);
            if (state.session === undefined) {
              yield* mediaUpload(key, last, meta.contentType);
            } else {
              yield* sendChunk(state.session, last, state.sent, consumed.bytes);
            }
            return consumed;
          });
          const { bytes, sha256 } = yield* upload.pipe(
            Effect.onExit((exit) =>
              exit._tag === "Failure" && state.session !== undefined
                ? cancelSession(state.session)
                : Effect.void,
            ),
          );
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
            yield* drain(response);
            return yield* Effect.fail(new BlobMissing({ key }));
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
      delete: (key) =>
        Effect.gen(function* () {
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
