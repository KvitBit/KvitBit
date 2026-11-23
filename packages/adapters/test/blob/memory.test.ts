import { expect, test } from "bun:test";
import { BlobStorage } from "@kvitbit/domain/ports";
import { Effect, Stream } from "effect";
import { MemoryBlobStorage } from "../../src/blob/index";
import { describeBlobStorageContract, key, meta, readAll } from "./contract";

describeBlobStorageContract("MemoryBlobStorage", () => MemoryBlobStorage.layer);

test("stored bytes are isolated from the producer's and the reader's buffers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* BlobStorage;
      const chunk = new Uint8Array([1, 2, 3]);
      yield* store.put(key("ws/a"), Stream.make(chunk), meta());
      chunk[0] = 9;
      const first = yield* readAll(yield* store.get(key("ws/a")));
      first[1] = 9;
      const second = yield* readAll(yield* store.get(key("ws/a")));
      expect([...second]).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(MemoryBlobStorage.layer)),
  ));
