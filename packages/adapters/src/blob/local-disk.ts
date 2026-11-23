/**
 * BlobStorage on the local filesystem for self-hosted installs (ADR 0003, core-ports section
 * 10). Each key maps to a file under `root`; writes go to `root/.partial/` and are renamed into
 * place, so a reader sees either the old or the new complete object, never a partial one.
 *
 * Containment: keys cannot name a path outside `root` (see `keyProblem`), and no operation
 * follows a symlink below `root`. Directories on a key's path are checked with `lstat` and
 * created one at a time, and files open with `O_NOFOLLOW`, so a symlink in a restored tree
 * fails the operation with `BlobUnavailable` instead of reaching outside. `root` itself may be
 * a symlink; it is resolved once at startup. The checks do not defend against a process that
 * swaps directories for symlinks concurrently: only this adapter may write under `root`.
 *
 * Keys must be prefix-free: `a` and `a/b` cannot both exist, as `a` would be both a file and a
 * directory. Core keys end in a file name, so they never collide; MemoryBlobStorage enforces
 * the same rule so tests catch a violation. A directory left empty by deletes is replaced when
 * its path is stored as a key.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { type BlobKey, BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import { Config, Effect, Layer, Stream } from "effect";
import { checkKey, consumeBounded, partialDir } from "./common";

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

/** A failure that names the path below root and why; never follows it. */
class UnsafePath extends Error {
  constructor(
    readonly path: string,
    readonly reason: "symlink" | "not a directory",
  ) {
    super(`${reason} at ${path}`);
  }
}

const writeAll = (handle: FileHandle, chunk: Uint8Array) =>
  attempt(async () => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
      offset += bytesWritten;
    }
  });

/** Removes `dir` if it holds only empty directories; fails if it holds anything else. */
const removeEmptyTree = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`not empty: ${dir}`);
    await removeEmptyTree(join(dir, entry.name));
  }
  await rmdir(dir);
};

const make = (
  options: LocalDiskBlobStorageOptions,
): Effect.Effect<BlobStorage["Service"], BlobUnavailable> =>
  Effect.gen(function* () {
    const root = yield* attempt(async () => {
      await mkdir(options.root, { recursive: true });
      return realpath(options.root);
    });
    const partial = join(root, partialDir);
    yield* attempt(async () => {
      await mkdir(partial, { recursive: true });
      const stats = await lstat(partial);
      if (!stats.isDirectory()) throw new UnsafePath(partial, "not a directory");
    });

    /** The directories from root to the key's parent, and the key's own path. */
    const pathsOf = (key: BlobKey) =>
      Effect.map(checkKey(key), (segments) => {
        const dirs: Array<string> = [];
        let current = root;
        for (const segment of segments.slice(0, -1)) {
          current = join(current, segment);
          dirs.push(current);
        }
        return { dirs, target: join(current, segments.at(-1) ?? "") };
      });

    /**
     * Checks each existing directory on the path without following it. `false` when one is
     * missing or a file, i.e. the key cannot exist; throws on a symlink.
     */
    const ancestorsExist = async (dirs: ReadonlyArray<string>) => {
      for (const dir of dirs) {
        const stats = await lstat(dir).catch((error: unknown) => {
          if (isAbsent(error)) return undefined;
          throw error;
        });
        if (stats === undefined) return false;
        if (stats.isSymbolicLink()) throw new UnsafePath(dir, "symlink");
        if (!stats.isDirectory()) return false;
      }
      return true;
    };

    /** Creates the directories one level at a time, refusing symlinks and files. */
    const ensureAncestors = async (dirs: ReadonlyArray<string>) => {
      for (const dir of dirs) {
        await mkdir(dir).catch((error: unknown) => {
          if (errorCode(error) !== "EEXIST") throw error;
        });
        const stats = await lstat(dir);
        if (stats.isSymbolicLink()) throw new UnsafePath(dir, "symlink");
        if (!stats.isDirectory()) throw new UnsafePath(dir, "not a directory");
      }
    };

    /** Moves the finished temp file into place, replacing an empty former prefix. */
    const commit = async (temp: string, dirs: ReadonlyArray<string>, target: string) => {
      await ensureAncestors(dirs);
      try {
        await rename(temp, target);
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EISDIR" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        const stats = await lstat(target);
        if (!stats.isDirectory()) throw error;
        await removeEmptyTree(target);
        await rename(temp, target);
      }
    };

    return BlobStorage.of({
      put: (key, body, meta) =>
        Effect.gen(function* () {
          const { dirs, target } = yield* pathsOf(key);
          const temp = join(partial, randomUUID());
          const written = yield* Effect.acquireUseRelease(
            attempt(() => open(temp, "wx")),
            (handle) =>
              consumeBounded(body, meta.maxBytes, (chunk) => writeAll(handle, chunk)).pipe(
                Effect.tap(() => attempt(() => handle.sync())),
              ),
            (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
          ).pipe(
            Effect.tap(() => attempt(() => commit(temp, dirs, target))),
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
        Effect.gen(function* () {
          const { dirs, target } = yield* pathsOf(key);
          const found = yield* Effect.tryPromise({
            try: async () => {
              if (!(await ancestorsExist(dirs))) return false;
              const stats = await lstat(target);
              if (stats.isSymbolicLink()) throw new UnsafePath(target, "symlink");
              return stats.isFile();
            },
            catch: (error) => (isAbsent(error) ? new BlobMissing({ key }) : unavailable(error)),
          });
          if (!found) return yield* Effect.fail(new BlobMissing({ key }));
          // Opened only when consumed, re-checking the path and refusing a symlinked file.
          // Rename-based writes mean the file is always complete; a read error mid-stream is a
          // defect, as the port's stream carries no error channel.
          const open = attempt(async () => {
            if (!(await ancestorsExist(dirs))) throw new Error(`gone: ${target}`);
            const handle = await openNoFollow(target);
            return handle.createReadStream({ autoClose: true });
          });
          return Stream.unwrap(
            Effect.map(open, (file) =>
              Stream.fromAsyncIterable(file as AsyncIterable<Uint8Array>, unavailable),
            ),
          ).pipe(Stream.orDie);
        }),
      delete: (key) =>
        Effect.gen(function* () {
          const { dirs, target } = yield* pathsOf(key);
          yield* attempt(async () => {
            if (!(await ancestorsExist(dirs))) return;
            try {
              // Unlinking a symlink removes the link itself, never its target.
              await unlink(target);
            } catch (error) {
              if (isAbsent(error)) return;
              // A directory holds other keys under this prefix, never an object of its own.
              const isDirectory = await lstat(target).then(
                (stats) => stats.isDirectory(),
                () => false,
              );
              if (!isDirectory) throw error;
            }
          });
        }),
    });
  });

const openNoFollow = (path: string) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

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
