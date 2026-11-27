/**
 * Read-only storage port for mobile updates, assets, and Android releases
 * (http-mcp-contracts section 5, board contract #929).
 *
 * Supports local disk (self-hosted) and Google Cloud Storage JSON API (hosted).
 */
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GcsAccessToken, GcsAccessTokens } from "@kvitbit/adapters/blob";
import { Context, Data, Duration, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, UrlParams } from "effect/http";
import { MobileConfig } from "./config";

export class MobileStorageNotFound extends Data.TaggedError("MobileStorageNotFound")<{
  readonly key: string;
}> {}

export class MobileStorageUnavailable extends Data.TaggedError("MobileStorageUnavailable")<{
  readonly cause?: unknown;
}> {}

export interface MobileStorageStream {
  readonly stream: Stream.Stream<Uint8Array, MobileStorageUnavailable>;
  readonly size?: number | undefined;
  readonly contentType?: string | undefined;
}

export interface MobileStorageShape {
  /** Lists all relative object keys starting with `prefix`. Missing prefix returns `[]`. */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, MobileStorageUnavailable>;
  /** Reads an object as UTF-8 text. */
  readonly getText: (
    key: string,
  ) => Effect.Effect<string, MobileStorageNotFound | MobileStorageUnavailable>;
  /** Opens a byte stream for an object; fails eagerly with `MobileStorageNotFound` if absent. */
  readonly getStream: (
    key: string,
  ) => Effect.Effect<MobileStorageStream, MobileStorageNotFound | MobileStorageUnavailable>;
}

export class MobileStorage extends Context.Service<MobileStorage, MobileStorageShape>()(
  "kvitbit/server/http/MobileStorage",
) {}

const unavailable = (cause: unknown) => new MobileStorageUnavailable({ cause });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const isAbsent = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const validateKeySegments = (key: string): ReadonlyArray<string> | undefined => {
  if (key.length === 0 || key.startsWith("/") || key.endsWith("/")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return undefined;
  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return segments;
};

const validatePrefixSegments = (prefix: string): ReadonlyArray<string> | undefined => {
  if (prefix.startsWith("/")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is intentional
  if (/[\u0000-\u001f\u007f\\]/.test(prefix)) return undefined;
  if (prefix === "") return [];
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return segments;
};

const STREAM_CHUNK_BYTES = 64 * 1024;

async function* readFileChunks(target: string): AsyncGenerator<Uint8Array, void, void> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let position = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, STREAM_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      yield new Uint8Array(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

const streamFilePath = (target: string): Stream.Stream<Uint8Array, MobileStorageUnavailable> =>
  Stream.fromAsyncIterable(readFileChunks(target), unavailable);

/** Builds a local-disk `MobileStorage` rooted at `rootDir` with strict symlink/traversal checks. */
export const makeLocalMobileStorage = (rootDir: string): MobileStorageShape => {
  const resolveRoot = async (): Promise<string | undefined> => {
    try {
      return await realpath(rootDir);
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
  };

  const checkAncestors = async (root: string, dirs: ReadonlyArray<string>): Promise<boolean> => {
    let current = root;
    for (const dir of dirs) {
      current = join(current, dir);
      const stats = await lstat(current).catch((error: unknown) => {
        if (isAbsent(error)) return undefined;
        throw error;
      });
      if (stats === undefined) return false;
      if (stats.isSymbolicLink()) throw new Error(`Symlink rejected at ${current}`);
      if (!stats.isDirectory()) return false;
    }
    return true;
  };

  const openRegularFile = async (
    key: string,
  ): Promise<
    { readonly handle: FileHandle; readonly size: number; readonly target: string } | undefined
  > => {
    const segments = validateKeySegments(key);
    if (segments === undefined) return undefined;
    const root = await resolveRoot();
    if (root === undefined) return undefined;
    const ok = await checkAncestors(root, segments.slice(0, -1));
    if (!ok) return undefined;
    const target = join(root, ...segments);
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        return undefined;
      }
      return { handle, size: stats.size, target };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  };

  const walk = async (
    dir: string,
    relPrefix: string,
    matchPrefix: string,
    out: Array<string>,
  ): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (isAbsent(error)) return undefined;
      throw error;
    });
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink rejected at ${join(dir, entry.name)}`);
      }
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel, matchPrefix, out);
      } else if (entry.isFile() && rel.startsWith(matchPrefix)) {
        out.push(rel);
      }
    }
  };

  return {
    list: (prefix) =>
      Effect.tryPromise({
        try: async () => {
          const segments = validatePrefixSegments(prefix);
          if (segments === undefined) return [];
          const root = await resolveRoot();
          if (root === undefined) return [];
          const dirSegments = prefix.endsWith("/") ? segments : segments.slice(0, -1);
          const ok = await checkAncestors(root, dirSegments);
          if (!ok) return [];
          const startDir = dirSegments.length === 0 ? root : join(root, ...dirSegments);
          const relPrefix = dirSegments.join("/");
          const keys: Array<string> = [];
          await walk(startDir, relPrefix, prefix, keys);
          keys.sort();
          return keys;
        },
        catch: unavailable,
      }),

    getText: (key) =>
      Effect.tryPromise({
        try: async () => {
          const opened = await openRegularFile(key);
          if (opened === undefined) return undefined;
          try {
            return await opened.handle.readFile({ encoding: "utf8" });
          } finally {
            await opened.handle.close().catch(() => {});
          }
        },
        catch: unavailable,
      }).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.fail(new MobileStorageNotFound({ key }))
            : Effect.succeed(text),
        ),
      ),

    getStream: (key) =>
      Effect.tryPromise({
        try: async () => {
          const opened = await openRegularFile(key);
          if (opened === undefined) return undefined;
          await opened.handle.close();
          return { target: opened.target, size: opened.size };
        },
        catch: unavailable,
      }).pipe(
        Effect.flatMap((opened) =>
          opened === undefined
            ? Effect.fail(new MobileStorageNotFound({ key }))
            : Effect.succeed({
                stream: streamFilePath(opened.target),
                size: opened.size,
              } satisfies MobileStorageStream),
        ),
      ),
  };
};

/** Local-disk `MobileStorage` layer for self-hosted deployments and tests. */
export const MobileStorageLocal = (rootDir: string): Layer.Layer<MobileStorage> =>
  Layer.succeed(MobileStorage, makeLocalMobileStorage(resolve(rootDir)));

export interface MobileStorageGcsOptions {
  readonly bucket: string;
  readonly endpoint?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
}

const GcsListResponse = Schema.Struct({
  items: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  nextPageToken: Schema.optional(Schema.String),
});

const parseContentLength = (header: string | undefined): number | undefined => {
  if (header === undefined) return undefined;
  const parsed = Number(header);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const makeGcsMobileStorage = (
  options: MobileStorageGcsOptions,
  client: HttpClient.HttpClient,
  tokens: GcsAccessToken["Service"],
): MobileStorageShape => {
  const endpoint = (options.endpoint ?? "https://storage.googleapis.com").replace(/\/+$/, "");
  const bucket = encodeURIComponent(options.bucket);
  const timeout = options.timeout ?? Duration.seconds(30);
  const listUrl = `${endpoint}/storage/v1/b/${bucket}/o`;
  const objectUrl = (key: string) =>
    `${endpoint}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;

  const withAuth = <A, E>(
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: import("effect/http").HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | MobileStorageUnavailable> =>
    Effect.gen(function* () {
      const executeWithToken = (token: string) =>
        client
          .execute(HttpClientRequest.bearerToken(request, token))
          .pipe(Effect.timeout(timeout), Effect.mapError(unavailable));

      const token = yield* tokens.get.pipe(Effect.mapError(unavailable));
      let response = yield* executeWithToken(token);
      if (response.status === 401) {
        yield* Effect.ignore(response.arrayBuffer);
        yield* tokens.invalidate(token);
        const freshToken = yield* tokens.get.pipe(Effect.mapError(unavailable));
        response = yield* executeWithToken(freshToken);
      }
      return yield* handle(response);
    });

  return {
    list: (prefix) =>
      Effect.gen(function* () {
        if (validatePrefixSegments(prefix) === undefined) return [];
        const keys: Array<string> = [];
        const seenTokens = new Set<string>();
        let pageToken: string | undefined;
        do {
          const params: Array<readonly [string, string]> = [
            ["prefix", prefix],
            ["fields", "items/name,nextPageToken"],
          ];
          if (pageToken !== undefined) params.push(["pageToken", pageToken]);
          const request = HttpClientRequest.get(listUrl).pipe(
            HttpClientRequest.setUrlParams(UrlParams.fromInput(params)),
          );
          const page = yield* withAuth(request, (response) =>
            Effect.gen(function* () {
              if (response.status < 200 || response.status >= 300) {
                yield* Effect.ignore(response.arrayBuffer);
                return yield* Effect.fail(
                  new MobileStorageUnavailable({
                    cause: { operation: "list", status: response.status },
                  }),
                );
              }
              const json = yield* response.json.pipe(Effect.mapError(unavailable));
              return yield* Schema.decodeUnknownEffect(GcsListResponse)(json).pipe(
                Effect.mapError(unavailable),
              );
            }),
          );
          for (const item of page.items ?? []) {
            keys.push(item.name);
          }
          const next = page.nextPageToken;
          if (next !== undefined && next.length > 0 && seenTokens.has(next)) {
            return yield* Effect.fail(
              new MobileStorageUnavailable({ cause: "GCS list returned duplicate nextPageToken" }),
            );
          }
          if (next !== undefined && next.length > 0) seenTokens.add(next);
          pageToken = next;
        } while (pageToken !== undefined && pageToken.length > 0);
        keys.sort();
        return keys;
      }),

    getText: (key) => {
      if (validateKeySegments(key) === undefined) {
        return Effect.fail(new MobileStorageNotFound({ key }));
      }
      const request = HttpClientRequest.get(objectUrl(key)).pipe(
        HttpClientRequest.setUrlParams(UrlParams.fromInput([["alt", "media"]])),
      );
      return withAuth<string, MobileStorageNotFound | MobileStorageUnavailable>(
        request,
        (response) => {
          if (response.status === 404) {
            return Effect.ignore(response.arrayBuffer).pipe(
              Effect.andThen(Effect.fail(new MobileStorageNotFound({ key }))),
            );
          }
          if (response.status < 200 || response.status >= 300) {
            return Effect.ignore(response.arrayBuffer).pipe(
              Effect.andThen(
                Effect.fail(
                  new MobileStorageUnavailable({
                    cause: { operation: "getText", status: response.status },
                  }),
                ),
              ),
            );
          }
          return response.text.pipe(Effect.timeout(timeout), Effect.mapError(unavailable));
        },
      );
    },

    getStream: (key) => {
      if (validateKeySegments(key) === undefined) {
        return Effect.fail(new MobileStorageNotFound({ key }));
      }
      const request = HttpClientRequest.get(objectUrl(key)).pipe(
        HttpClientRequest.setUrlParams(UrlParams.fromInput([["alt", "media"]])),
      );
      return withAuth<MobileStorageStream, MobileStorageNotFound | MobileStorageUnavailable>(
        request,
        (response) => {
          if (response.status === 404) {
            return Effect.ignore(response.arrayBuffer).pipe(
              Effect.andThen(Effect.fail(new MobileStorageNotFound({ key }))),
            );
          }
          if (response.status < 200 || response.status >= 300) {
            return Effect.ignore(response.arrayBuffer).pipe(
              Effect.andThen(
                Effect.fail(
                  new MobileStorageUnavailable({
                    cause: { operation: "getStream", status: response.status },
                  }),
                ),
              ),
            );
          }
          return Effect.succeed({
            stream: response.stream.pipe(Stream.mapError(unavailable)),
            size: parseContentLength(response.headers["content-length"]),
            contentType: response.headers["content-type"],
          } satisfies MobileStorageStream);
        },
      );
    },
  };
};

/** GCS-backed `MobileStorage` layer using `HttpClient` and `GcsAccessToken`. */
export const MobileStorageGcs = (
  options: MobileStorageGcsOptions,
): Layer.Layer<MobileStorage, never, HttpClient.HttpClient | GcsAccessToken> =>
  Layer.effect(
    MobileStorage,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const tokens = yield* GcsAccessToken;
      return makeGcsMobileStorage(options, client, tokens);
    }),
  );

/**
 * Selects local disk or GCS `MobileStorage` from `MobileConfig`.
 * Uses `FetchHttpClient` and `GcsAccessTokens.metadataServer` when GCS is active.
 */
export const MobileStorageLive: Layer.Layer<MobileStorage, never, MobileConfig> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MobileConfig;
    if (config.storage._tag === "local") {
      return MobileStorageLocal(config.storage.dir);
    }
    const gcsLayer = MobileStorageGcs({
      bucket: config.storage.bucket,
      endpoint: config.storage.endpoint,
    }).pipe(Layer.provide(GcsAccessTokens.metadataServer), Layer.provide(FetchHttpClient.layer));
    return gcsLayer;
  }),
);
