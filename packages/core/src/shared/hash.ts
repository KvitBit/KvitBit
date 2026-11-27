/** SHA-256 over the platform Web Crypto global (Bun, Node, browsers). */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const toHex = (buffer: ArrayBuffer): string =>
  Arr.join(
    Array.from(new Uint8Array(buffer), (byte) => Str.padStart(2, "0")(byte.toString(16))),
    "",
  );

class DigestFailed extends Schema.TaggedError<DigestFailed, { readonly brand: unique symbol }>()(
  "DigestFailed",
  { cause: Schema.Unknown },
) {}

export const sha256Hex = Effect.fn("sha256Hex")(function* (data: string | Uint8Array) {
  const bytes = Predicate.isString(data) ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest("SHA-256", bytes),
    catch: (cause) => DigestFailed.make({ cause }),
  }).pipe(Effect.catchTag("DigestFailed", (error) => Effect.die(error.cause)));
  return toHex(digest);
});
