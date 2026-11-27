/**
 * Read-only storage port for mobile updates, assets, and Android releases
 * (http-mcp-contracts section 5, board contract #929).
 *
 * Supports local disk (self-hosted) and Google Cloud Storage JSON API (hosted).
 */
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { GcsAccessToken, GcsAccessTokens } from "@kvitbit/adapters/blob";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { MobileConfig } from "./config";

class MobileStorageNotFound extends Schema.TaggedError<
  MobileStorageNotFound,
  { readonly brand: unique symbol }
>()("MobileStorageNotFound", { key: Schema.String }) {}

export class MobileStorageUnavailable extends Schema.TaggedError<
  MobileStorageUnavailable,
  { readonly brand: unique symbol }
>()("MobileStorageUnavailable", { cause: Schema.optionalKey(Schema.Unknown) }) {}

interface MobileStorageStream {
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
  "@kvitbit/server/http/mobile/storage/MobileStorage",
) {}

const unavailable = (cause: unknown) => MobileStorageUnavailable.make({ cause });

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

const isAbsent = (error: PlatformError.PlatformError): boolean => {
  const code = Option.getOrUndefined(decodeErrno(error.reason.cause))?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const allowMissing = <A, R>(operation: Effect.Effect<A, PlatformError.PlatformError, R>) =>
  operation.pipe(
    Effect.catchIf(isAbsent, () => Effect.undefined),
    Effect.mapError(unavailable),
  );

const hasInvalidKeyCharacters = (key: string): boolean =>
  Arr.some(Arr.fromIterable(key), (char) => char < " " || char === "\u007f" || char === "\\");

const validateKeySegments = (key: string): ReadonlyArray<string> | undefined => {
  if (key.length === 0 || Str.startsWith("/")(key) || Str.endsWith("/")(key)) return;
  if (hasInvalidKeyCharacters(key)) return;
  const segments = Str.split(key, "/");
  if (Arr.some(segments, (s) => s === "" || s === "." || s === "..")) return;
  return segments;
};

const validatePrefixSegments = (prefix: string): ReadonlyArray<string> | undefined => {
  if (Str.startsWith("/")(prefix) || hasInvalidKeyCharacters(prefix)) return;
  if (prefix === "") return [];
  const trimmed = Str.endsWith("/")(prefix) ? Str.slice(0, -1)(prefix) : prefix;
  const segments = Str.split(trimmed, "/");
  if (Arr.some(segments, (s) => s === "" || s === "." || s === "..")) return;
  return segments;
};

const STREAM_CHUNK_BYTES = 64 * 1024;

// Bun's file finalizer reports close errors as defects. This scope owns only that descriptor.
const closeFileScope = (scope: Scope.Closeable, exit: Exit.Exit<unknown, unknown>) =>
  Scope.close(scope, exit).pipe(
    Effect.catchDefect((cause) =>
      PlatformError.isPlatformError(cause)
        ? cause.pipe(unavailable, Effect.fail)
        : Effect.die(cause),
    ),
  );

const readFileChunks = (file: FileSystem.File) =>
  Stream.fromEffectRepeat(
    file.readAlloc(STREAM_CHUNK_BYTES).pipe(
      // Wait for the native read before releasing the descriptor on interruption.
      Effect.uninterruptible,
      Effect.mapError(unavailable),
      Effect.flatMap(Option.match({ onNone: () => Cause.done(), onSome: Effect.succeed })),
    ),
  );

interface LocalFileLocation {
  readonly root: string;
  readonly dirs: ReadonlyArray<string>;
  readonly target: string;
}

/** Builds a local-disk `MobileStorage` rooted at `rootDir` with strict symlink/traversal checks. */
export const makeLocalMobileStorage = Effect.fnUntraced(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveRoot = allowMissing(fs.realPath(path.resolve(rootDir)));

  const checkAncestors = Effect.fn("MobileStorage.checkAncestors")(function* (
    root: string,
    dirs: ReadonlyArray<string>,
  ) {
    let current = root;
    for (const dir of dirs) {
      const target = path.join(current, dir);
      current = target;
      const stats = yield* allowMissing(fs.lstat(target));
      if (stats === undefined) return false;
      if (stats.type === "SymbolicLink")
        return yield* unavailable(new Error(`Symlink rejected at ${target}`));
      if (stats.type !== "Directory") return false;
    }
    return true;
  });

  const withRegularFile = Effect.fn("MobileStorage.withRegularFile")(function* <A>(
    key: string,
    use: (
      file: FileSystem.File,
      location: LocalFileLocation,
      size: number,
    ) => Effect.Effect<A, MobileStorageUnavailable>,
    reportCloseFailure: boolean,
  ) {
    const notFound = () => MobileStorageNotFound.make({ key });
    const segments = validateKeySegments(key);
    if (segments === undefined) return yield* notFound();
    const root = yield* resolveRoot;
    if (root === undefined) return yield* notFound();
    const dirs = Arr.dropRight(segments, 1);
    if (!(yield* checkAncestors(root, dirs))) return yield* notFound();
    const target = path.join(root, ...segments);
    return yield* Effect.acquireUseRelease(
      Scope.make(),
      Effect.fnUntraced(function* (scope) {
        const file = yield* fs.open(target, { noFollow: true }).pipe(
          Scope.provide(scope),
          allowMissing,
          Effect.filterOrFail((opened) => opened !== undefined, notFound),
        );
        const stats = yield* file.stat.pipe(Effect.uninterruptible, Effect.mapError(unavailable));
        if (stats.type !== "File") return;
        return yield* use(file, { root, dirs, target }, Number(stats.size));
      }),
      (scope, exit) => {
        const close = closeFileScope(scope, exit);
        return Exit.isSuccess(exit) && (reportCloseFailure || exit.value === undefined)
          ? close
          : Effect.ignore(close);
      },
    ).pipe(Effect.filterOrFail((result) => result !== undefined, notFound));
  });

  const streamFilePath = ({ root, dirs, target }: LocalFileLocation) =>
    Effect.map(Ref.make(false), (started) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Each getStream result represents one read of the file.
          const alreadyStarted = yield* Ref.getAndSet(started, true);
          if (alreadyStarted) return Stream.empty;
          if (!(yield* checkAncestors(root, dirs)))
            return yield* unavailable(new Error(`Missing parent directory for ${target}`));
          const scope = yield* Effect.acquireRelease(Scope.make(), (fileScope, exit) =>
            Effect.ignore(closeFileScope(fileScope, exit)),
          );
          const file = yield* fs
            .open(target, { noFollow: true })
            .pipe(Scope.provide(scope), Effect.mapError(unavailable));
          return readFileChunks(file);
        }),
      ),
    );

  const walk: (
    dir: string,
    relPrefix: string,
    matchPrefix: string,
    out: Array<string>,
  ) => Effect.Effect<void, MobileStorageUnavailable> = Effect.fn("MobileStorage.walk")(
    function* (dir, relPrefix, matchPrefix, out) {
      const entries = yield* allowMissing(fs.readDirectoryEntries(dir));
      if (entries === undefined) return;
      for (const entry of entries) {
        const target = path.join(dir, entry.name);
        if (entry.type === "SymbolicLink")
          return yield* unavailable(new Error(`Symlink rejected at ${target}`));
        const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
        if (entry.type === "Directory") {
          yield* walk(target, rel, matchPrefix, out);
        } else if (entry.type === "File" && Str.startsWith(matchPrefix)(rel)) {
          out.push(rel);
        }
      }
    },
  );

  return {
    list: Effect.fn("MobileStorageLocal.list")(function* (prefix) {
      const segments = validatePrefixSegments(prefix);
      if (segments === undefined) return [];
      const root = yield* resolveRoot;
      if (root === undefined) return [];
      const dirSegments = Str.endsWith("/")(prefix) ? segments : Arr.dropRight(segments, 1);
      if (!(yield* checkAncestors(root, dirSegments))) return [];
      const startDir = path.join(root, ...dirSegments);
      const keys: Array<string> = [];
      yield* walk(startDir, Arr.join(dirSegments, "/"), prefix, keys);
      return Arr.sort(keys, Str.Order);
    }),

    getText: (key) =>
      withRegularFile(
        key,
        Effect.fnUntraced(function* (file) {
          // Preserve the BOM the same way a UTF-8 file read does.
          const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
          const text = yield* readFileChunks(file).pipe(
            Stream.runFold(
              () => "",
              (decoded, chunk) => decoded + decoder.decode(chunk, { stream: true }),
            ),
          );
          return text + decoder.decode();
        }),
        false,
      ),

    getStream: (key) =>
      withRegularFile(
        key,
        (_file, location, size) =>
          Effect.map(streamFilePath(location), (stream) => ({ stream, size })),
        true,
      ),
  } satisfies MobileStorageShape;
});

/** Local-disk `MobileStorage` layer for self-hosted deployments and tests. */
export const MobileStorageLocal = (rootDir: string): Layer.Layer<MobileStorage> =>
  Layer.effect(MobileStorage, makeLocalMobileStorage(rootDir)).pipe(
    Layer.provide([BunFileSystem.layer, BunPath.layer]),
  );

export interface MobileStorageGcsOptions {
  readonly bucket: string;
  readonly endpoint?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
}

const GcsListResponse = Schema.Struct({
  items: Schema.Struct({ name: Schema.String }).pipe(Schema.Array, Schema.optional),
  nextPageToken: Schema.optional(Schema.String),
});

const trailingSlashes = /\/+$/;

const parseContentLength = (header: string | undefined): number | undefined => {
  if (header === undefined) return undefined;
  const parsed = Number(header);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

function makeGcsMobileStorage(
  options: MobileStorageGcsOptions,
  client: HttpClient.HttpClient,
  tokens: GcsAccessToken["Service"],
): MobileStorageShape {
  const endpoint = Str.replace(
    trailingSlashes,
    "",
  )(options.endpoint ?? "https://storage.googleapis.com");
  const bucket = encodeURIComponent(options.bucket);
  const timeout = options.timeout ?? Duration.seconds(30);
  const listUrl = `${endpoint}/storage/v1/b/${bucket}/o`;
  const objectUrl = (key: string) =>
    `${endpoint}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;

  const withAuth = <A, E>(
    request: HttpClientRequest.HttpClientRequest,
    handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | MobileStorageUnavailable> =>
    Effect.gen(function* () {
      const executeWithToken = (accessToken: string) =>
        client
          .execute(HttpClientRequest.bearerToken(request, accessToken))
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
    list: Effect.fn("MobileStorageGcs.list")(function* (prefix) {
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
        const page = yield* withAuth(
          request,
          Effect.fnUntraced(function* (response) {
            if (response.status < 200 || response.status >= 300) {
              yield* Effect.ignore(response.arrayBuffer);
              return yield* MobileStorageUnavailable.make({
                cause: { operation: "list", status: response.status },
              });
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
          return yield* MobileStorageUnavailable.make({
            cause: "GCS list returned duplicate nextPageToken",
          });
        }
        if (next !== undefined && next.length > 0) seenTokens.add(next);
        pageToken = next;
      } while (pageToken !== undefined && pageToken.length > 0);
      return Arr.sort(keys, Str.Order);
    }),

    getText: Effect.fn("MobileStorageGcs.getText")(function* (key) {
      if (validateKeySegments(key) === undefined) return yield* MobileStorageNotFound.make({ key });
      const request = HttpClientRequest.get(objectUrl(key)).pipe(
        HttpClientRequest.setUrlParams(UrlParams.fromInput([["alt", "media"]])),
      );
      return yield* withAuth(
        request,
        Effect.fnUntraced(function* (response) {
          if (response.status === 404) {
            yield* Effect.ignore(response.arrayBuffer);
            return yield* MobileStorageNotFound.make({ key });
          }
          if (response.status < 200 || response.status >= 300) {
            yield* Effect.ignore(response.arrayBuffer);
            return yield* MobileStorageUnavailable.make({
              cause: { operation: "getText", status: response.status },
            });
          }
          return yield* response.text.pipe(Effect.timeout(timeout), Effect.mapError(unavailable));
        }),
      );
    }),

    getStream: Effect.fn("MobileStorageGcs.getStream")(function* (key) {
      if (validateKeySegments(key) === undefined) return yield* MobileStorageNotFound.make({ key });
      const request = HttpClientRequest.get(objectUrl(key)).pipe(
        HttpClientRequest.setUrlParams(UrlParams.fromInput([["alt", "media"]])),
      );
      return yield* withAuth(
        request,
        Effect.fnUntraced(function* (response) {
          if (response.status === 404) {
            yield* Effect.ignore(response.arrayBuffer);
            return yield* MobileStorageNotFound.make({ key });
          }
          if (response.status < 200 || response.status >= 300) {
            yield* Effect.ignore(response.arrayBuffer);
            return yield* MobileStorageUnavailable.make({
              cause: { operation: "getStream", status: response.status },
            });
          }
          return {
            stream: response.stream.pipe(Stream.mapError(unavailable)),
            size: parseContentLength(response.headers["content-length"]),
            contentType: response.headers["content-type"],
          } satisfies MobileStorageStream;
        }),
      );
    }),
  };
}

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
