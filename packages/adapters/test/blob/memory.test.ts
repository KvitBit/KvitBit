import { expect, test } from "bun:test";
import { BlobStorage } from "@kvitbit/domain/ports";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { MemoryBlobStorage } from "../../src/blob/index";
import { describeBlobStorageContract, key, meta, readAll } from "./contract";

describeBlobStorageContract({ name: "MemoryBlobStorage", layer: () => MemoryBlobStorage.layer });

test("stored bytes are isolated from the producer's and the reader's buffers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* BlobStorage;
      const chunk = new Uint8Array([1, 2, 3]);
      yield* store.put(key("ws/a"), Stream.make(chunk), meta());
      chunk[0] = 9;
      const value = yield* store.get(key("ws/a"));
      const first = yield* readAll(value);
      first[1] = 9;
      const value_1 = yield* store.get(key("ws/a"));
      const second = yield* readAll(value_1);
      expect([...second]).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(MemoryBlobStorage.layer)),
  ));

test("rejects a key that would be both an object and a prefix, as LocalDisk does", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* BlobStorage;
      yield* store.put(key("ws/a"), Stream.make(new Uint8Array([1])), meta());
      const under = yield* Effect.flip(
        store.put(key("ws/a/b"), Stream.make(new Uint8Array([2])), meta()),
      );
      yield* store.put(key("ws/c/d"), Stream.make(new Uint8Array([3])), meta());
      const over = yield* Effect.flip(
        store.put(key("ws/c"), Stream.make(new Uint8Array([4])), meta()),
      );
      expect([under._tag, over._tag]).toEqual(["BlobUnavailable", "BlobUnavailable"]);
      const value_2 = yield* Effect.flip(store.get(key("ws/a/b")));
      expect(value_2).toMatchObject({ _tag: "BlobMissing" });
    }).pipe(Effect.provide(MemoryBlobStorage.layer)),
  ));
