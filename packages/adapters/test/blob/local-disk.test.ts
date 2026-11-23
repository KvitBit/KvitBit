import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStorage } from "@kvitbit/domain/ports";
import { Effect, Stream } from "effect";
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
});
