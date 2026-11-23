import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStorage } from "@kvitbit/domain/ports";
import { Effect, Fiber, Stream } from "effect";
import { LocalDiskBlobStorage } from "../../src/blob/index";
import { chunked, describeBlobStorageContract, endless, key, meta } from "./contract";

const base = mkdtempSync(join(tmpdir(), "kvitbit-blob-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let roots = 0;
const freshRoot = () => join(base, `root-${roots++}`);

describeBlobStorageContract("LocalDiskBlobStorage", () =>
  LocalDiskBlobStorage.layer({ root: freshRoot() }),
);

describe("LocalDiskBlobStorage on disk", () => {
  const withStore = <A, E>(
    root: string,
    f: (store: BlobStorage["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* BlobStorage);
      }).pipe(Effect.provide(LocalDiskBlobStorage.layer({ root }))),
    );

  test("writes the object at root/key and creates parent directories", async () => {
    const root = freshRoot();
    await withStore(root, (store) =>
      store.put(key("pdf/ws/doc/1/cs.pdf"), chunked("%PDF"), meta()),
    );
    expect(readFileSync(join(root, "pdf/ws/doc/1/cs.pdf"), "utf8")).toBe("%PDF");
    expect(readdirSync(join(root, ".partial"))).toEqual([]);
  });

  test("an oversized or failed put leaves no temp file and no target", async () => {
    const root = freshRoot();
    await withStore(root, (store) => Effect.flip(store.put(key("ws/big"), endless(), meta(100))));
    await withStore(root, (store) =>
      Effect.exit(
        store.put(key("ws/broken"), Stream.concat(chunked("abc"), Stream.die("boom")), meta()),
      ),
    );
    expect(existsSync(join(root, "ws/big"))).toBe(false);
    expect(existsSync(join(root, "ws/broken"))).toBe(false);
    expect(readdirSync(join(root, ".partial"))).toEqual([]);
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
    expect(errors.map((error) => error._tag)).toEqual(["BlobMissing", "BlobMissing"]);
  });

  test("delete of a prefix that is only a directory is a no-op", async () => {
    const root = freshRoot();
    await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/dir/file"), chunked("x"), meta());
        yield* store.delete(key("ws/dir"));
      }),
    );
    expect(readFileSync(join(root, "ws/dir/file"), "utf8")).toBe("x");
  });

  test("delete of a path under a file is a no-op", async () => {
    const root = freshRoot();
    await withStore(root, (store) =>
      Effect.gen(function* () {
        yield* store.put(key("ws/file"), chunked("x"), meta());
        yield* store.delete(key("ws/file/child"));
      }),
    );
    expect(readFileSync(join(root, "ws/file"), "utf8")).toBe("x");
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
    expect(readdirSync(join(root, ".partial"))).toEqual([]);
  });

  test("reads files placed by another writer, e.g. a restored backup", async () => {
    const root = freshRoot();
    await withStore(root, () => Effect.void);
    writeFileSync(join(root, "restored"), "from backup");
    const text = await withStore(root, (store) =>
      Effect.flatMap(store.get(key("restored")), (stream) =>
        Stream.runCollect(stream).pipe(Effect.map((chunks) => Buffer.concat(chunks).toString())),
      ),
    );
    expect(text).toBe("from backup");
  });

  test("a root that cannot be created fails the layer with BlobUnavailable", async () => {
    const file = join(base, "not-a-dir");
    writeFileSync(file, "");
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(Effect.asVoid(BlobStorage), LocalDiskBlobStorage.layer({ root: file })),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("BlobUnavailable");
  });

  describe("symlinks below root are never followed", () => {
    const setup = () => {
      const root = freshRoot();
      const outside = join(base, `outside-${roots}`);
      mkdirSync(outside, { recursive: true });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(outside, "secret"), "outside");
      symlinkSync(outside, join(root, "ws"));
      symlinkSync(join(outside, "secret"), join(root, "link"));
      return { root, outside };
    };

    test("put, get and delete through a symlinked directory fail and touch nothing outside", async () => {
      const { root, outside } = setup();
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
      expect(errors.map((error) => error._tag)).toEqual([
        "BlobUnavailable",
        "BlobUnavailable",
        "BlobUnavailable",
        "BlobUnavailable",
      ]);
      expect(readdirSync(outside).sort()).toEqual(["secret"]);
      expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside");
      expect(readdirSync(join(root, ".partial"))).toEqual([]);
    });

    test("a symlinked object is refused on get; delete removes only the link", async () => {
      const { root, outside } = setup();
      const error = await withStore(root, (store) => Effect.flip(store.get(key("link"))));
      expect(error._tag).toBe("BlobUnavailable");
      await withStore(root, (store) => store.delete(key("link")));
      expect(existsSync(join(root, "link"))).toBe(false);
      expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside");
    });

    test("a put over a symlinked object replaces the link, not its target", async () => {
      const { root, outside } = setup();
      await withStore(root, (store) => store.put(key("link"), chunked("mine"), meta()));
      expect(readFileSync(join(root, "link"), "utf8")).toBe("mine");
      expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside");
    });

    test("a symlinked staging directory fails the layer", async () => {
      const root = freshRoot();
      const outside = join(base, `staging-${roots}`);
      mkdirSync(outside, { recursive: true });
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, ".partial"));
      const exit = await Effect.runPromise(
        Effect.exit(
          Effect.provide(Effect.asVoid(BlobStorage), LocalDiskBlobStorage.layer({ root })),
        ),
      );
      expect(exit._tag).toBe("Failure");
    });

    test("a root that is itself a symlink works", async () => {
      const real = freshRoot();
      mkdirSync(real, { recursive: true });
      const alias = join(base, `alias-${roots}`);
      symlinkSync(real, alias);
      await withStore(alias, (store) => store.put(key("ws/a"), chunked("via alias"), meta()));
      expect(readFileSync(join(real, "ws/a"), "utf8")).toBe("via alias");
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
    expect(readFileSync(join(root, "ws/a/b"), "utf8")).toBe("child");
    expect(readdirSync(join(root, ".partial"))).toEqual([]);
  });

  test("a download cancelled before or while reading leaves no descriptor open", async () => {
    const root = freshRoot();
    const openFds = () => readdirSync("/proc/self/fd").length;
    await withStore(root, (store) =>
      store.put(key("ws/f"), chunked("a".repeat(100_000)), meta(10 ** 6)),
    );
    const before = openFds();
    await withStore(root, (store) =>
      Effect.gen(function* () {
        for (let i = 0; i < 20; i++) {
          const stream = yield* store.get(key("ws/f"));
          yield* Stream.runCollect(Stream.take(stream, 1));
          const fiber = yield* Effect.forkChild(Stream.runDrain(stream));
          yield* Fiber.interrupt(fiber);
        }
      }),
    );
    expect(openFds()).toBeLessThanOrEqual(before);
  });
});
