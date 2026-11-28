/**
 * Shared by the BlobStorage adapters: key validation and size-bounded, hashing consumption of
 * the `put` body.
 */

import { type BlobKey, BlobTooLarge } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

/**
 * A key no adapter accepts. Keys are core-chosen, so this is a programming error and adapters
 * raise it as a defect rather than a typed failure.
 */
export class InvalidBlobKey extends Schema.TaggedError<
  InvalidBlobKey,
  { readonly brand: unique symbol }
>()(
  // biome-ignore lint/security/noSecrets: The public Effect error discriminant is a fixed literal.
  "InvalidBlobKey",
  { key: Schema.String, reason: Schema.String },
) {}

/** Directory under a LocalDisk root that holds in-progress writes; no key may start with it. */
export const partialDir = ".partial";

/**
 * Why `key` is unacceptable, or `undefined`. Accepts `/`-separated relative keys whose segments are non-empty, not `.` or `..`, and free of
 * backslashes and control characters. Every adapter applies the same rule, so a key that works
 * in tests works in production.
 */
export const keyProblem = (key: string): string | undefined => {
  if (key.length === 0) return "empty";
  if (new TextEncoder().encode(key).byteLength > 1024) return "longer than 1024 UTF-8 bytes";
  if (Str.startsWith("/")(key)) return "absolute";
  for (const character of key) {
    if (character < " " || character === "\u007f" || character === "\\") {
      return "control character or backslash";
    }
  }
  const segments = Str.split(key, "/");
  if (Arr.some(segments, (segment) => segment === "")) return "empty segment";
  if (Arr.some(segments, (segment) => segment === "." || segment === "..")) return "dot segment";
  if (segments[0] === partialDir) return "reserved prefix";
  return undefined;
};

/** `keyProblem` as an effect: the key's segments, or a defect. */
export const checkKey = (key: BlobKey): Effect.Effect<ReadonlyArray<string>> => {
  const reason = keyProblem(key);
  return reason === undefined
    ? Effect.succeed(Str.split(key, "/"))
    : Effect.die(InvalidBlobKey.make({ key, reason }));
};

/**
 * An owned copy of `chunk`: a producer may reuse its buffer after emitting it, and
 * `Buffer#slice` would alias rather than copy.
 */
const copyOf = (chunk: Uint8Array): Uint8Array => new Uint8Array(chunk);

export interface Consumed {
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Runs `body`, handing each chunk to `onChunk` after counting it. Fails with `BlobTooLarge` on
 * the first chunk that takes the total over `maxBytes`, which stops the upstream there, so an
 * oversized body is never read to the end. The hash covers exactly the bytes passed on.
 */
export const consumeBounded = Effect.fn("consumeBounded")(function* <E, R>(
  body: Stream.Stream<Uint8Array>,
  maxBytes: number,
  onChunk: (chunk: Uint8Array) => Effect.Effect<void, E, R>,
): Effect.fn.Return<Consumed, BlobTooLarge | E, R> {
  const hash = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  yield* Stream.runForEach(body, (chunk): Effect.Effect<void, BlobTooLarge | E, R> => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) return Effect.fail(BlobTooLarge.make({ maxBytes }));
    hash.update(chunk);
    return onChunk(chunk);
  });
  return { bytes, sha256: hash.digest("hex") };
});

/** Buffers `body` into one array, failing with `BlobTooLarge` as soon as it passes `maxBytes`. */
export const collectBounded = Effect.fn("collectBounded")(function* (
  body: Stream.Stream<Uint8Array>,
  maxBytes: number,
): Effect.fn.Return<Consumed & { readonly data: Uint8Array }, BlobTooLarge> {
  const chunks: Array<Uint8Array> = [];
  const consumed = yield* consumeBounded(body, maxBytes, (chunk) =>
    Effect.sync(() => {
      chunks.push(copyOf(chunk));
    }),
  );
  const data = new Uint8Array(consumed.bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ...consumed, data };
});
