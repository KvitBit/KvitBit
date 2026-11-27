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

// @effect-diagnostics-next-line nodeBuiltinImport:off
import { rmdir } from "node:fs/promises"; // FileSystem.remove cannot remove only an empty directory.
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { type BlobKey, BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { checkKey, consumeBounded, partialDir } from "./common";

export interface LocalDiskBlobStorageOptions {
  /** Directory holding the objects; created if missing. */
  readonly root: string;
}

class UnsafePath extends Schema.TaggedError<UnsafePath, { readonly brand: unique symbol }>()(
  "UnsafePath",
  {
    path: Schema.String,
    reason: Schema.Literals(["symlink", "not a directory", "not empty"]),
  },
) {}

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));
const errorCode = (error: PlatformError.PlatformError) =>
  Option.getOrUndefined(decodeErrno(error.reason.cause))?.code;

/** Missing file, or a key whose parent is a file rather than a directory. */
const isAbsent = (error: PlatformError.PlatformError) => {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const unavailable = (cause: PlatformError.PlatformError | UnsafePath) =>
  new BlobUnavailable({ cause });

export const makeLocalDiskBlobStorage = Effect.fn("LocalDiskBlobStorage.make")(function* (
  options: LocalDiskBlobStorageOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(options.root, { recursive: true }).pipe(Effect.mapError(unavailable));
  const root = yield* fs.realPath(options.root).pipe(Effect.mapError(unavailable));
  const partial = path.join(root, partialDir);
  yield* fs.makeDirectory(partial, { recursive: true }).pipe(Effect.mapError(unavailable));
  const staging = yield* fs.lstat(partial).pipe(Effect.mapError(unavailable));
  if (staging.type !== "Directory") {
    return yield* unavailable(UnsafePath.make({ path: partial, reason: "not a directory" }));
  }

  /** The directories from root to the key's parent, and the key's own path. */
  const pathsOf = (key: BlobKey) =>
    checkKey(key).pipe(
      Effect.map((segments) => {
        const dirs: Array<string> = [];
        let current = root;
        for (const segment of segments.slice(0, -1)) {
          current = path.join(current, segment);
          dirs.push(current);
        }
        return { dirs, target: path.join(current, segments.at(-1) ?? "") };
      }),
    );

  const statIfPresent = (target: string) =>
    fs.lstat(target).pipe(
      Effect.asSome,
      Effect.catchIf(isAbsent, () => Effect.succeedNone),
    );

  /** Checks the existing parent directories without following a symlink. */
  const ancestorsExist = Effect.fn("LocalDiskBlobStorage.ancestorsExist")(function* (
    dirs: ReadonlyArray<string>,
  ) {
    for (const dir of dirs) {
      const stats = yield* statIfPresent(dir);
      if (Option.isNone(stats)) return false;
      if (stats.value.type === "SymbolicLink") {
        return yield* UnsafePath.make({ path: dir, reason: "symlink" });
      }
      if (stats.value.type !== "Directory") return false;
    }
    return true;
  });

  /** Creates the directories one level at a time, refusing symlinks and files. */
  const ensureAncestors = Effect.fn("LocalDiskBlobStorage.ensureAncestors")(function* (
    dirs: ReadonlyArray<string>,
  ) {
    for (const dir of dirs) {
      yield* fs.makeDirectory(dir).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (error) => errorCode(error) === "EEXIST",
          () => Effect.void,
        ),
      );
      const stats = yield* fs.lstat(dir);
      if (stats.type === "SymbolicLink")
        return yield* UnsafePath.make({ path: dir, reason: "symlink" });
      if (stats.type !== "Directory")
        return yield* UnsafePath.make({ path: dir, reason: "not a directory" });
    }
  });

  /** Removes only empty directories, even if another writer adds an object under the prefix. */
  const removeEmptyTree: (dir: string) => Effect.Effect<void, BlobUnavailable> = Effect.fn(
    "LocalDiskBlobStorage.removeEmptyTree",
  )(function* (dir: string) {
    const entries = yield* fs.readDirectory(dir).pipe(Effect.mapError(unavailable));
    for (const entry of entries) {
      const child = path.join(dir, entry);
      const stats = yield* fs.lstat(child).pipe(Effect.mapError(unavailable));
      if (stats.type !== "Directory") {
        return yield* unavailable(UnsafePath.make({ path: dir, reason: "not empty" }));
      }
      yield* removeEmptyTree(child);
    }
    yield* Effect.tryPromise({
      try: () => rmdir(dir),
      catch: (cause) => new BlobUnavailable({ cause }),
    });
  });

  /** Moves the finished temp file into place, replacing an empty former prefix. */
  const commit = Effect.fn("LocalDiskBlobStorage.commit")(function* (
    temp: string,
    dirs: ReadonlyArray<string>,
    target: string,
  ) {
    yield* ensureAncestors(dirs).pipe(Effect.mapError(unavailable));
    yield* fs.rename(temp, target).pipe(
      Effect.catchIf(
        (error) => {
          const code = errorCode(error);
          return code === "EISDIR" || code === "ENOTEMPTY" || code === "EEXIST";
        },
        Effect.fnUntraced(function* (error) {
          const stats = yield* fs.lstat(target).pipe(Effect.mapError(unavailable));
          if (stats.type !== "Directory") return yield* unavailable(error);
          yield* removeEmptyTree(target);
          yield* fs.rename(temp, target).pipe(Effect.mapError(unavailable));
        }),
      ),
      Effect.mapError((error) => (error._tag === "BlobUnavailable" ? error : unavailable(error))),
    );
  });

  return BlobStorage.of({
    put: Effect.fn("LocalDiskBlobStorage.put")(function* (key, body, meta) {
      const { dirs, target } = yield* pathsOf(key);
      const temporaryDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: partial }).pipe(Effect.mapError(unavailable)),
        (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const temp = path.join(temporaryDir, "object");
      const written = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temp, { flag: "wx" }).pipe(Effect.mapError(unavailable));
          // The platform callbacks cannot be cancelled. Wait for each I/O before closing the descriptor.
          const bytes = yield* consumeBounded(body, meta.maxBytes, (chunk) =>
            file.writeAll(chunk).pipe(Effect.uninterruptible, Effect.mapError(unavailable)),
          );
          yield* file.sync.pipe(Effect.uninterruptible, Effect.mapError(unavailable));
          return bytes;
        }),
      );
      // Wait for the rename before releasing the temporary directory on interruption.
      yield* Effect.uninterruptible(commit(temp, dirs, target));
      return { key, bytes: written.bytes, sha256: written.sha256 };
    }, Effect.scoped),
    get: Effect.fn("LocalDiskBlobStorage.get")(function* (key) {
      const { dirs, target } = yield* pathsOf(key);
      const parentsPresent = yield* ancestorsExist(dirs).pipe(Effect.mapError(unavailable));
      if (!parentsPresent) return yield* new BlobMissing({ key });
      const stats = yield* statIfPresent(target).pipe(Effect.mapError(unavailable));
      if (Option.isNone(stats)) return yield* new BlobMissing({ key });
      if (stats.value.type === "SymbolicLink") {
        return yield* unavailable(UnsafePath.make({ path: target, reason: "symlink" }));
      }
      if (stats.value.type !== "File") return yield* new BlobMissing({ key });

      // Recheck the parents at consumption and open the file without following its last component.
      const handle = Effect.gen(function* () {
        if (!(yield* ancestorsExist(dirs))) return yield* new BlobMissing({ key });
        return yield* fs.open(target, { noFollow: true });
      });
      return Stream.unwrap(
        handle.pipe(
          Effect.map((file) =>
            Stream.fromEffectRepeat(
              file.readAlloc(64 * 1024).pipe(
                Effect.uninterruptible,
                Effect.flatMap((chunk) =>
                  Option.isSome(chunk) ? Effect.succeed(chunk.value) : Cause.done(),
                ),
              ),
            ),
          ),
        ),
      ).pipe(Stream.orDie);
    }),
    delete: Effect.fn("LocalDiskBlobStorage.delete")(function* (key) {
      const { dirs, target } = yield* pathsOf(key);
      const parentsPresent = yield* ancestorsExist(dirs).pipe(Effect.mapError(unavailable));
      if (!parentsPresent) return;
      // A symlink is removed by name. A directory belongs to other keys and is left alone.
      yield* fs.remove(target).pipe(
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isAbsent(error)) return;
            const stats = yield* fs.lstat(target).pipe(Effect.option);
            if (Option.isNone(stats) || stats.value.type !== "Directory") return yield* error;
          }),
        ),
        Effect.mapError(unavailable),
      );
    }),
  });
});

const make = (options: LocalDiskBlobStorageOptions) =>
  makeLocalDiskBlobStorage(options).pipe(Effect.provide([BunFileSystem.layer, BunPath.layer]));

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
