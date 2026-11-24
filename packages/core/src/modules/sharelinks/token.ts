/**
 * Share tokens (core-ports section 1): "v{keyVersion}." + base64url(HMAC-SHA256(key, linkId)).
 * Re-derivable from the stored link id and key version, so `create` can return the same URL
 * again without storing the token; links are found by the token's SHA-256 hash.
 */
import type { ShareToken } from "@kvitbit/domain/contract";
import { Effect } from "effect";

/** Key versions are `share_links.key_version` values: non-negative int4. */
export const MAX_KEY_VERSION = 2_147_483_647;

const isKeyVersion = (version: number) =>
  Number.isInteger(version) && version >= 0 && version <= MAX_KEY_VERSION;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const deriveToken = (
  linkId: string,
  version: number,
  secret: Uint8Array,
): Effect.Effect<ShareToken> =>
  isKeyVersion(version)
    ? derive(linkId, version, secret)
    : // A configuration defect: such a token could never be stored or parsed back.
      Effect.die(new Error(`ShareLinkKeys: key version ${version} is not a non-negative int4`));

const derive = (linkId: string, version: number, secret: Uint8Array): Effect.Effect<ShareToken> =>
  Effect.promise(async () => {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey(
      "raw",
      secret as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await subtle.sign("HMAC", key, new TextEncoder().encode(linkId));
    return `v${version}.${base64url(new Uint8Array(mac))}` as ShareToken;
  });

/** The key version a token claims, or `null` when it is not shaped like a share token. */
export const tokenVersion = (token: string): number | null => {
  const match = /^v(0|[1-9]\d{0,9})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (match?.[1] === undefined) return null;
  const version = Number(match[1]);
  return isKeyVersion(version) ? version : null;
};
