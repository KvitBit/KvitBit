import { afterAll, describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BlobStorage } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { LocalDiskBlobStorage } from "../../src/blob/index";
import { makeLocalDiskBlobStorage } from "../../src/blob/local-disk";
import { chunked, describeBlobStorageContract, endless, key, meta } from "./contract";

const fixtureFs = await FileSystem.FileSystem.pipe(
  Effect.provide(BunFileSystem.layer),
  Effect.runPromise,
);
const { join } = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
const hasProcFd = await Effect.runPromise(fixtureFs.exists("/proc/self/fd"));
const base = await Effect.runPromise(fixtureFs.makeTempDirectory({ prefix: "kvitbit-blob-" }));
afterAll(() => Effect.runPromise(fixtureFs.remove(base, { recursive: true, force: true })));
let roots = 0;
const freshRoot = () => join(base, `root-${roots++}`);

describeBlobStorageContract({
  name: "Local disk",
  layer: () => LocalDiskBlobStorage.layer({ root: freshRoot() }),
});

describe("LocalDiskBlobStorage on disk", () => {
  const withStore = <A, E>(
    root: string,
    f: (store: BlobStorage["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const BlobStorage_1 = yield* BlobStorage;
        return yield* f(BlobStorage_1);
      }).pipe(Effect.provide(LocalDiskBlobStorage.layer({ root }))),
    );

  test("writes the object at root/key and creates parent directories", async () => {
    const root = freshRoot();
    await withStore(root, (store) =>
      store.put(key("pdf/ws/doc/1/cs.pdf"), chunked("%PDF"), meta()),
    );
    expect(
      await Effect.runPromise(fixtureFs.readFileString(join(root, "pdf/ws/doc/1/cs.pdf"))),
    ).toBe("%PDF");
    expect(await Effect.runPromise(fixtureFs.readDirectory(join(root, ".partial")))).toEqual([]);
  });

  test("an oversized or failed put leaves no temp file and no target", async () => {
    const root = freshRoot();
    await withStore(root, (store) => Effect.flip(store.put(key("ws/big"), endless, meta(100))));
    await withStore(root, (store) =>
      Effect.exit(
        store.put(key("ws/broken"), Stream.concat(chunked("abc"), Stream.die("boom")), meta()),
      ),
    );
    expect(await Effect.runPromise(fixtureFs.exists(join(root, "ws/big")))).toBe(false);
    expect(await Effect.runPromise(fixtureFs.exists(join(root, "ws/broken")))).toBe(false);
    expect(await Effect.runPromise(fixtureFs.readDirectory(join(root, ".partial")))).toEqual([]);
  });

  test("interrupting an overwrite preserves the existing object and clears staging", async () => {
    const root = freshRoot();
    const target = key("ws/object");
    await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(target, chunked("old"), meta());
        const reading = yield* Deferred.make<void>();
        const pause = Stream.fromEffectDrain(
          Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const upload = yield* store
          .put(target, Stream.concat(chunked("new"), pause), meta())
          .pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(upload);
      }),
    );
    expect(await Effect.runPromise(fixtureFs.readFileString(join(root, target)))).toBe("old");
    expect(await Effect.runPromise(fixtureFs.readDirectory(join(root, ".partial")))).toEqual([]);
  });

  test("get of a directory or of a path under a file is BlobMissing", async () => {
    const root = freshRoot();
    const errors = await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/dir/file"), chunked("x"), meta());
        return [
          yield* Effect.flip(store.get(key("ws/dir"))),
          yield* Effect.flip(store.get(key("ws/dir/file/child"))),
        ];
      }),
    );
    expect(Arr.map(errors, (error) => error._tag)).toEqual(["BlobMissing", "BlobMissing"]);
  });

  test("delete of a prefix that is only a directory is a no-op", async () => {
    const root = freshRoot();
    await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/dir/file"), chunked("x"), meta());
        yield* store.delete(key("ws/dir"));
      }),
    );
    expect(await Effect.runPromise(fixtureFs.readFileString(join(root, "ws/dir/file")))).toBe("x");
  });

  test("delete of a path under a file is a no-op", async () => {
    const root = freshRoot();
    await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/file"), chunked("x"), meta());
        yield* store.delete(key("ws/file/child"));
      }),
    );
    expect(await Effect.runPromise(fixtureFs.readFileString(join(root, "ws/file")))).toBe("x");
  });

  test("a put whose parent is a file fails with BlobUnavailable", async () => {
    const root = freshRoot();
    const error = await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/file"), chunked("x"), meta());
        return yield* Effect.flip(store.put(key("ws/file/child"), chunked("y"), meta()));
      }),
    );
    expect(error._tag).toBe("BlobUnavailable");
    expect(await Effect.runPromise(fixtureFs.readDirectory(join(root, ".partial")))).toEqual([]);
  });

  test("reads files placed by another writer, e.g. a restored backup", async () => {
    const root = freshRoot();
    await withStore(root, () => Effect.void);
    const restored = Str.repeat(30_000)("from backup");
    await Effect.runPromise(fixtureFs.writeFileString(join(root, "restored"), restored));
    const text = await withStore(root, (store) =>
      Effect.flatMap(store.get(key("restored")), (stream) =>
        Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks).toString())),
      ),
    );
    expect(text).toBe(restored);
  });

  test("a root that cannot be created fails the layer with BlobUnavailable", async () => {
    const file = join(base, "not-a-dir");
    await Effect.runPromise(fixtureFs.writeFileString(file, ""));
    const error = await BlobStorage.pipe(
      Effect.asVoid,
      Effect.provide(LocalDiskBlobStorage.layer({ root: file })),
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("BlobUnavailable");
  });

  describe("symlinks below root are never followed", () => {
    const setup = async () => {
      const root = freshRoot();
      const outside = join(base, `outside-${roots}`);
      await Effect.runPromise(fixtureFs.makeDirectory(outside, { recursive: true }));
      await Effect.runPromise(fixtureFs.makeDirectory(root, { recursive: true }));
      await Effect.runPromise(fixtureFs.writeFileString(join(outside, "secret"), "outside"));
      await Effect.runPromise(fixtureFs.symlink(outside, join(root, "ws")));
      await Effect.runPromise(fixtureFs.symlink(join(outside, "secret"), join(root, "link")));
      return { root, outside };
    };

    test("put, get and delete through a symlinked directory fail and touch nothing outside", async () => {
      const { root, outside } = await setup();
      const errors = await withStore(root, (store) =>
        Effect.gen(function* () {
          return [
            yield* Effect.flip(store.put(key("ws/new"), chunked("x"), meta())),
            yield* Effect.flip(store.get(key("ws/secret"))),
            yield* Effect.flip(store.delete(key("ws/secret"))),
            yield* Effect.flip(store.put(key("ws/deeper/new"), chunked("x"), meta())),
          ];
        }),
      );
      expect(Arr.map(errors, (error) => error._tag)).toEqual([
        "BlobUnavailable",
        "BlobUnavailable",
        "BlobUnavailable",
        "BlobUnavailable",
      ]);
      expect((await Effect.runPromise(fixtureFs.readDirectory(outside))).sort()).toEqual([
        "secret",
      ]);
      expect(await Effect.runPromise(fixtureFs.readFileString(join(outside, "secret")))).toBe(
        "outside",
      );
      expect(await Effect.runPromise(fixtureFs.readDirectory(join(root, ".partial")))).toEqual([]);
    });

    test("a symlinked object is refused on get; delete removes only the link", async () => {
      const { root, outside } = await setup();
      const error = await withStore(root, (store) => Effect.flip(store.get(key("link"))));
      expect(error._tag).toBe("BlobUnavailable");
      await withStore(root, (store) => store.delete(key("link")));
      expect(await Effect.runPromise(fixtureFs.exists(join(root, "link")))).toBe(false);
      expect(await Effect.runPromise(fixtureFs.readFileString(join(outside, "secret")))).toBe(
        "outside",
      );
    });

    test("delete removes a dangling or directory symlink by name", async () => {
      const { root, outside } = await setup();
      await withStore(root, (store) => store.delete(key("ws")));
      expect(await Effect.runPromise(fixtureFs.exists(join(root, "ws")))).toBe(false);
      expect(await Effect.runPromise(fixtureFs.readFileString(join(outside, "secret")))).toBe(
        "outside",
      );

      const dangling = join(root, "dangling");
      await Effect.runPromise(fixtureFs.symlink(join(outside, "absent"), dangling));
      await withStore(root, (store) => store.delete(key("dangling")));
      expect(await Effect.runPromise(fixtureFs.readDirectory(root))).not.toContain("dangling");
    });

    test("a put over a symlinked object replaces the link, not its target", async () => {
      const { root, outside } = await setup();
      await withStore(root, (store) => store.put(key("link"), chunked("mine"), meta()));
      expect(await Effect.runPromise(fixtureFs.readFileString(join(root, "link")))).toBe("mine");
      expect(await Effect.runPromise(fixtureFs.readFileString(join(outside, "secret")))).toBe(
        "outside",
      );
    });

    test("a symlinked staging directory fails the layer", async () => {
      const root = freshRoot();
      const outside = join(base, `staging-${roots}`);
      await Effect.runPromise(fixtureFs.makeDirectory(outside, { recursive: true }));
      await Effect.runPromise(fixtureFs.makeDirectory(root, { recursive: true }));
      await Effect.runPromise(fixtureFs.symlink(outside, join(root, ".partial")));
      const exit = await BlobStorage.pipe(
        Effect.asVoid,
        Effect.provide(LocalDiskBlobStorage.layer({ root })),
        Effect.runPromiseExit,
      );
      expect(exit._tag).toBe("Failure");
    });

    test("a root that is itself a symlink works", async () => {
      const real = freshRoot();
      await Effect.runPromise(fixtureFs.makeDirectory(real, { recursive: true }));
      const alias = join(base, `alias-${roots}`);
      await Effect.runPromise(fixtureFs.symlink(real, alias));
      await withStore(alias, (store) => store.put(key("ws/a"), chunked("via alias"), meta()));
      expect(await Effect.runPromise(fixtureFs.readFileString(join(real, "ws/a")))).toBe(
        "via alias",
      );
    });
  });

  test("a prefix of a live key cannot be stored and the descendant survives", async () => {
    const root = freshRoot();
    const error = await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/a/b"), chunked("child"), meta());
        return yield* Effect.flip(store.put(key("ws/a"), chunked("parent"), meta()));
      }),
    );
    expect(error._tag).toBe("BlobUnavailable");
    expect(await Effect.runPromise(fixtureFs.readFileString(join(root, "ws/a/b")))).toBe("child");
    expect(await Effect.runPromise(fixtureFs.readDirectory(join(root, ".partial")))).toEqual([]);
  });

  test("download interruption waits for a pending read before releasing the file", async () => {
    const root = freshRoot();
    await Effect.runPromise(fixtureFs.makeDirectory(root));
    await Effect.runPromise(fixtureFs.writeFileString(join(root, "object"), "body"));

    const result = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const started = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const readSettled = yield* Deferred.make<void>();
      const releasing = yield* Deferred.make<void>();
      const gatedFileSystem = {
        ...fs,
        open: (path, options) =>
          Effect.gen(function* () {
            const file = yield* fs.open(path, options);
            // The finalizer runs just before the file descriptor is closed.
            yield* Effect.addFinalizer(() => Deferred.succeed(releasing, undefined));
            const readAlloc = file.readAlloc.bind(file);
            return Object.assign(file, {
              readAlloc: (size: number, readOptions?: FileSystem.File.ReadOptions) =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                  Effect.andThen(readAlloc(size, readOptions)),
                  Effect.tap(() => Deferred.succeed(readSettled, undefined)),
                ),
            });
          }),
      } satisfies FileSystem.FileSystem;

      const store = yield* makeLocalDiskBlobStorage({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, gatedFileSystem),
      );
      const stream = yield* store.get(key("object"));
      const reader = yield* stream.pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(started);
      const interrupt = yield* reader.pipe(Fiber.interrupt, Effect.forkChild);
      const releasedWhileReading = yield* releasing.pipe(
        Deferred.await,
        Effect.timeoutOption("50 millis"),
      );
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(interrupt);
      const settled = yield* Deferred.isDone(readSettled);
      const released = yield* Deferred.isDone(releasing);
      return { releasedEarly: Option.isSome(releasedWhileReading), settled, released };
    }).pipe(Effect.provide([BunFileSystem.layer, Path.layer]), Effect.runPromise);

    expect(result).toEqual({ releasedEarly: false, settled: true, released: true });
  });

  // Counts descriptors through procfs; hosts without it (macOS) skip this check.
  describe.skipIf(hasProcFd !== true)("open descriptors", () => {
    test("a download cancelled before or while reading leaves no descriptor open", async () => {
      const root = freshRoot();
      const openFds = async () =>
        (await Effect.runPromise(fixtureFs.readDirectory("/proc/self/fd"))).length;
      await withStore(root, (store) =>
        store.put(key("ws/f"), chunked(Str.repeat(100_000)("a")), meta(10 ** 6)),
      );
      const before = await openFds();
      await withStore(root, (store) =>
        Effect.gen(function* () {
          for (let i = 0; i < 20; i++) {
            const stream = yield* store.get(key("ws/f"));
            yield* Stream.runCollect(Stream.take(stream, 1));
            const fiber = yield* stream.pipe(Stream.runDrain, Effect.forkChild);
            yield* Fiber.interrupt(fiber);
          }
        }),
      );
      expect(await openFds()).toBeLessThanOrEqual(before);
    });
  });
});
