/** In-process BlobStorage for tests (core-ports section 10, `TestCore`). */

import { BlobMissing, BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { checkKey, collectBounded } from "./common";

interface StoredBlob {
  readonly data: Uint8Array;
  readonly contentType: string;
}

const make: Effect.Effect<BlobStorage["Service"]> = Effect.gen(function* () {
  const blobs = yield* Ref.make(new Map<string, StoredBlob>());
  return BlobStorage.of({
    put: Effect.fn("BlobStorage.put")((key, body, meta) =>
      checkKey(key).pipe(
        Effect.andThen(collectBounded(body, meta.maxBytes)),
        Effect.tap(({ data }) =>
          Ref.modify(blobs, (map): readonly [Option.Option<string>, Map<string, StoredBlob>] => {
            const clash = Arr.findFirst(
              map.keys(),
              (other) => Str.startsWith(`${key}/`)(other) || Str.startsWith(`${other}/`)(key),
            );
            return Option.isNone(clash)
              ? [clash, new Map(map).set(key, { data, contentType: meta.contentType })]
              : [clash, map];
          }).pipe(
            Effect.flatMap((clash) =>
              Option.isNone(clash)
                ? Effect.void
                : // LocalDisk cannot hold both `a` and `a/b`; fail here as it would.
                  Effect.fail(
                    new BlobUnavailable({
                      cause: { reason: "key prefix clash", clash: clash.value },
                    }),
                  ),
            ),
          ),
        ),
        Effect.map(({ bytes, sha256 }) => ({ key, bytes, sha256 })),
      ),
    ),
    get: Effect.fn("BlobStorage.get")((key) =>
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
    ),
    delete: Effect.fn("BlobStorage.delete")((key) =>
      checkKey(key).pipe(
        Effect.andThen(
          Ref.update(blobs, (map) => {
            const next = new Map(map);
            next.delete(key);
            return next;
          }),
        ),
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
