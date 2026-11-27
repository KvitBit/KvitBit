/**
 * Workspace API Keys: `kvb_<key id>_<secret>` (http-mcp-contracts section 2.1, rule A1).
 *
 * The wire format and parser come from `@kvitbit/api-contract`; this module issues keys and
 * checks them. Storage is the Better Auth `apiKey` plugin's `auth.apikey` table: `id` is the
 * key id, and `key` holds the same digest the plugin's `defaultKeyHasher` computes (SHA-256 of
 * the whole token, base64url without padding), so a key stays verifiable by either side.
 */
// The synchronous key API uses Node's cryptographic random bytes and constant-time comparison.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_KEY_PREFIX,
  ApiKeyId,
  type ApiKeyToken,
  apiKeyDisplayPrefix,
  formatApiKey,
  parseApiKey,
} from "@kvitbit/api-contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { generateId } from "./ids";

export type { ApiKeyId, ApiKeyParts, ApiKeyToken } from "@kvitbit/api-contract";
export { API_KEY_PREFIX, isApiKeyBearer, parseApiKey } from "@kvitbit/api-contract";

/** Random bytes in a generated secret: 256 bits, 43 base64url characters. */
export const API_KEY_SECRET_BYTES = 32;

/** A freshly issued key. Show `token` once; store only the other fields. */
export interface IssuedApiKey {
  /** `apikey.id`: a UUIDv7, also the token's key id. */
  readonly keyId: ApiKeyId;
  /** The bearer value shown to the user once. Never stored. */
  readonly token: ApiKeyToken;
  /** `apikey.key`: the stored digest. */
  readonly hash: string;
  /** `apikey.prefix`. */
  readonly prefix: typeof API_KEY_PREFIX;
  /** `apikey.start`: the non-secret `kvb_<key id>` shown in lists. */
  readonly start: string;
}

/** Digest stored in `apikey.key`; equal to Better Auth's `defaultKeyHasher(token)`. */
export const hashApiKey = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("base64url");

/** Issues a new key with a UUIDv7 key id and a 256-bit random secret. */
export const generateApiKey = (): IssuedApiKey => {
  const parts = {
    keyId: ApiKeyId.make(generateId()),
    secret: randomBytes(API_KEY_SECRET_BYTES).toString("base64url"),
  };
  const token = formatApiKey(parts);
  return {
    keyId: parts.keyId,
    token,
    hash: hashApiKey(token),
    prefix: API_KEY_PREFIX,
    start: apiKeyDisplayPrefix(parts.keyId),
  };
};

/**
 * Does `token` hash to `storedHash`? Compares the digests in constant time; a stored value of
 * another length (corrupt row) is a mismatch, not an error.
 */
export const apiKeyMatches: {
  (storedHash: string): (token: string) => boolean;
  (token: string, storedHash: string): boolean;
} = Fn.dual(2, (token: string, storedHash: string) => {
  const presented = createHash("sha256").update(token, "utf8").digest();
  const stored = Buffer.from(storedHash, "base64url");
  return stored.length === presented.length && timingSafeEqual(presented, stored);
});

/** Why a bearer value was not accepted as an API Key. */
export type ApiKeyRejection = "malformed" | "unknown_key" | "wrong_secret";

type FindHash = (keyId: ApiKeyId) => Promise<string | undefined>;
type ApiKeyVerification =
  | { readonly ok: true; readonly keyId: ApiKeyId }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

const checkApiKey = Effect.fn("checkApiKey")(function* (bearer: string, findHash: FindHash) {
  const parts = parseApiKey(bearer);
  if (Option.isNone(parts)) return { ok: false, reason: "malformed" } as const;
  const { keyId } = parts.value;
  const stored = yield* Effect.tryPromise({
    try: () => findHash(keyId),
    catch: (cause) => ({ cause }),
  }).pipe(Effect.catch(({ cause }) => Effect.die(cause)));
  if (stored === undefined) return { ok: false, reason: "unknown_key" } as const;
  return apiKeyMatches(bearer, stored)
    ? ({ ok: true, keyId } as const)
    : ({ ok: false, reason: "wrong_secret" } as const);
});

/**
 * Checks a bearer value against the stored row: parses it, looks up the key id with
 * `findHash` (the `apikey.key` of row `id`, or undefined), and compares in constant time.
 * Expiry, `enabled` and Workspace binding are the caller's checks on the same row.
 */
export const verifyApiKey: {
  (findHash: FindHash): (bearer: string) => Promise<ApiKeyVerification>;
  (bearer: string, findHash: FindHash): Promise<ApiKeyVerification>;
} = Fn.dual(2, (bearer: string, findHash: FindHash) =>
  // biome-ignore lint/plugin/no-direct-effect-runs: Preserve the public Promise API at the Effect boundary.
  Effect.runPromise(checkApiKey(bearer, findHash)),
);
