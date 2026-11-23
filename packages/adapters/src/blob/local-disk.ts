/**
 * BlobStorage on the local filesystem for self-hosted installs (ADR 0003, core-ports section
 * 10). Each key maps to a file under `root`; writes go to `root/.partial/` and are renamed into
 * place, so a reader sees either the old or the new complete object, never a partial one.
 *
 * Keys must be prefix-free: `a` and `a/b` cannot both exist, as `a` would be both a file and a
 * directory. Core keys end in a file name, so they never collide; MemoryBlobStorage enforces
 * the same rule so tests catch a violation.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BlobKey, BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import { Config, Effect, Layer, Stream } from "effect";
import { checkKey, consumeBounded, InvalidBlobKey, partialDir } from "./common";

export interface LocalDiskBlobStorageOptions {
  /** Directory holding the objects; created if missing. */
  readonly root: string;
}

const unavailable = (cause: unknown) => new BlobUnavailable({ cause });

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: unavailable });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** Missing file, or a key whose parent is a file rather than a directory. */
const isAbsent = (error: unknown) => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const writeAll = (handle: FileHandle, chunk: Uint8Array) =>
  attempt(async () => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
      offset += bytesWritten;
    }
  });

const make = (
  options: LocalDiskBlobStorageOptions,
): Effect.Effect<BlobStorage["Service"], BlobUnavailable> =>
  Effect.gen(function* () {
    const root = resolve(options.root);
    const partial = join(root, partialDir);
    yield* attempt(() => mkdir(partial, { recursive: true }));

    /** The key's path, checked again after resolution so no key can leave `root`. */
    const pathOf = (key: BlobKey) =>
      checkKey(key).pipe(
        Effect.flatMap((segments) => {
          const path = resolve(root, ...segments);
          const rel = relative(root, path);
          return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
            ? Effect.die(new InvalidBlobKey({ key, reason: "escapes root" }))
            : Effect.succeed(path);
        }),
      );

    return BlobStorage.of({
      put: (key, body, meta) =>
        Effect.gen(function* () {
          const target = yield* pathOf(key);
          const temp = join(partial, randomUUID());
          const written = yield* Effect.acquireUseRelease(
            attempt(() => open(temp, "wx")),
            (handle) =>
              consumeBounded(body, meta.maxBytes, (chunk) => writeAll(handle, chunk)).pipe(
                Effect.tap(() => attempt(() => handle.sync())),
              ),
            (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
          ).pipe(
            Effect.tap(() =>
              attempt(async () => {
                await mkdir(dirname(target), { recursive: true });
                await rename(temp, target);
              }),
            ),
            // Any failure or interruption before the rename leaves no partial file behind.
            Effect.onExit((exit) =>
              exit._tag === "Success"
                ? Effect.void
                : Effect.promise(() => unlink(temp).catch(() => undefined)),
            ),
          );
          return { key, bytes: written.bytes, sha256: written.sha256 };
        }),
      get: (key) =>
        pathOf(key).pipe(
          Effect.flatMap((path) =>
            Effect.tryPromise({
              try: () => stat(path),
              catch: (error) => (isAbsent(error) ? new BlobMissing({ key }) : unavailable(error)),
            }).pipe(
              Effect.flatMap((stats) =>
                stats.isFile()
                  ? Effect.succeed(
                      // Opened only when consumed. Rename-based writes mean the file is always
                      // complete; a read error mid-stream is a defect, as the port's stream
                      // carries no error channel.
                      Stream.suspend(() =>
                        Stream.fromAsyncIterable(
                          createReadStream(path) as AsyncIterable<Uint8Array>,
                          unavailable,
                        ),
                      ).pipe(Stream.orDie),
                    )
                  : Effect.fail(new BlobMissing({ key })),
              ),
            ),
          ),
        ),
      delete: (key) =>
        pathOf(key).pipe(
          Effect.flatMap((path) =>
            attempt(async () => {
              try {
                await unlink(path);
              } catch (error) {
                if (isAbsent(error)) return;
                // A directory holds other keys under this prefix, never an object of its own.
                const isDirectory = await stat(path).then(
                  (stats) => stats.isDirectory(),
                  () => false,
                );
                if (!isDirectory) throw error;
              }
            }),
          ),
        ),
    });
  });

export const LocalDiskBlobStorage = {
  make,
  layer: (options: LocalDiskBlobStorageOptions): Layer.Layer<BlobStorage, BlobUnavailable> =>
    Layer.effect(BlobStorage, make(options)),
  /** Reads the root from `BLOB_LOCAL_ROOT`. */
  layerConfig: (
    root: Config.Config<string> = Config.NonEmptyString("BLOB_LOCAL_ROOT"),
  ): Layer.Layer<BlobStorage, BlobUnavailable | Config.ConfigError> =>
    Layer.effect(
      BlobStorage,
      Effect.flatMap(root, (dir) => make({ root: dir })),
    ),
} as const;
