/** In-process BlobStorage for tests (core-ports section 10, `TestCore`). */
import { BlobMissing, BlobStorage } from "@kvitbit/domain/ports";
import { Effect, Layer, Ref, Stream } from "effect";
import { checkKey, collectBounded } from "./common";

interface StoredBlob {
  readonly data: Uint8Array;
  readonly contentType: string;
}

const make: Effect.Effect<BlobStorage["Service"]> = Effect.gen(function* () {
  const blobs = yield* Ref.make(new Map<string, StoredBlob>());
  return BlobStorage.of({
    put: (key, body, meta) =>
      checkKey(key).pipe(
        Effect.andThen(collectBounded(body, meta.maxBytes)),
        Effect.tap(({ data }) =>
          Ref.update(blobs, (map) =>
            new Map(map).set(key, { data, contentType: meta.contentType }),
          ),
        ),
        Effect.map(({ bytes, sha256 }) => ({ key, bytes, sha256 })),
      ),
    get: (key) =>
      checkKey(key).pipe(
        Effect.andThen(Ref.get(blobs)),
        Effect.flatMap((map) => {
          const blob = map.get(key);
          return blob === undefined
            ? Effect.fail(new BlobMissing({ key }))
            : // A copy per read, so a consumer that mutates its chunk cannot change the store.
              Effect.succeed(Stream.make(blob.data.slice()));
        }),
      ),
    delete: (key) =>
      checkKey(key).pipe(
        Effect.andThen(
          Ref.update(blobs, (map) => {
            const next = new Map(map);
            next.delete(key);
            return next;
          }),
        ),
      ),
  });
});

export const MemoryBlobStorage = {
  /** A fresh, empty store. */
  make,
  /** A fresh, empty store per layer build. */
  layer: Layer.effect(BlobStorage, make),
} as const;
