/**
 * Share tokens (core-ports section 1): "v{keyVersion}." + base64url(HMAC-SHA256(key, linkId)).
 * Re-derivable from the stored link id and key version, so `create` can return the same URL
 * again without storing the token; links are found by the token's SHA-256 hash.
 */

import { ShareToken } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";

/** Key versions are `share_links.key_version` values: non-negative int4. */
const TOKEN_FORMAT = /^v(0|[1-9]\d{0,9})\.[A-Za-z0-9_-]{43}$/;
const BASE64_PADDING = /[=]+$/;
const MAX_KEY_VERSION = 2_147_483_647;

const isKeyVersion = (version: number) =>
  Number.isInteger(version) && version >= 0 && version <= MAX_KEY_VERSION;

const base64url = (bytes: Uint8Array): string =>
  EffectString.replace(
    BASE64_PADDING,
    "",
  )(
    EffectString.replaceAll(
      "/",
      "_",
    )(EffectString.replaceAll("+", "-")(btoa(String.fromCharCode(...bytes)))),
  );

export const deriveToken: {
  (version: number, secret: Uint8Array): (linkId: string) => Effect.Effect<ShareToken>;
  (linkId: string, version: number, secret: Uint8Array): Effect.Effect<ShareToken>;
} = Fn.dual(
  3,
  (linkId: string, version: number, secret: Uint8Array): Effect.Effect<ShareToken> =>
    isKeyVersion(version)
      ? derive(linkId, version, secret)
      : // A configuration defect: such a token could never be stored or parsed back.
        Effect.die(new Error(`ShareLinkKeys: key version ${version} is not a non-negative int4`)),
);

class TokenDerivationFailed extends Schema.TaggedError<
  TokenDerivationFailed,
  { readonly brand: unique symbol }
>()("TokenDerivationFailed", { cause: Schema.Unknown }) {}

const derive = Effect.fn("deriveToken")(function* (
  linkId: string,
  version: number,
  secret: Uint8Array,
) {
  const subtle = globalThis.crypto.subtle;
  const key = yield* Effect.tryPromise({
    try: () =>
      subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]),
    catch: (cause) => TokenDerivationFailed.make({ cause }),
  }).pipe(Effect.catchTag("TokenDerivationFailed", (error) => Effect.die(error.cause)));
  const message = new TextEncoder().encode(linkId);
  const mac = yield* Effect.tryPromise({
    try: () => subtle.sign("HMAC", key, message),
    catch: (cause) => TokenDerivationFailed.make({ cause }),
  }).pipe(Effect.catchTag("TokenDerivationFailed", (error) => Effect.die(error.cause)));
  return ShareToken.make(`v${version}.${base64url(new Uint8Array(mac))}`);
});

/** The key version a token claims, or `null` when it is not shaped like a share token. */
export const tokenVersion = (token: string): number | null => {
  const match = TOKEN_FORMAT.exec(token);
  if (match?.[1] === undefined) return null;
  const version = Number(match[1]);
  return isKeyVersion(version) ? version : null;
};
