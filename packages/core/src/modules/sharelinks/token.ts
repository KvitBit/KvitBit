/**
 * Share tokens (core-ports section 1): "v{keyVersion}." + base64url(HMAC-SHA256(key, linkId)).
 * Re-derivable from the stored link id and key version, so `create` can return the same URL
 * again without storing the token; links are found by the token's SHA-256 hash.
 */
import type { ShareToken } from "@kvitbit/domain/contract";
import { Effect } from "effect";

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
  const match = /^v(\d{1,9})\.[A-Za-z0-9_-]{43}$/.exec(token);
  return match?.[1] === undefined ? null : Number(match[1]);
};
