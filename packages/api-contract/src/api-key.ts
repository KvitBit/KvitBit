/**
 * API Key wire format (http-mcp-contracts section 2.1, rule A1):
 * `Authorization: Bearer kvb_<key id>_<secret>`. The `kvb_` prefix alone decides the lookup;
 * a bearer value without it is tried as a Better Auth session token.
 *
 * The spec fixes only the prefix and the two parts. This contract fixes the rest so parsing is
 * unambiguous: the key id is 8 to 64 ASCII letters, digits and hyphens (so UUIDs fit), never `_`,
 * which stays the delimiter; the secret is 32 to 128 base64url characters (at least 192 bits
 * when generated as 32 random bytes) and may itself contain `_`, since only the first `_` after
 * the key id splits.
 *
 * The length bounds are this contract's choice, not the spec's: they await confirmation against
 * the key issuer (the Better Auth `apiKey` plugin storage, section 2.1) and may change then.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export const API_KEY_PREFIX = "kvb_";

export const ApiKeyId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/)),
  Schema.brand("ApiKeyId"),
);
export type ApiKeyId = typeof ApiKeyId.Type;

const API_KEY_PATTERN = /^kvb_([A-Za-z0-9-]{8,64})_([A-Za-z0-9_-]{32,128})$/;

/** The full bearer value shown once at creation. */
export const ApiKeyToken = Schema.String.pipe(
  Schema.check(Schema.isPattern(API_KEY_PATTERN)),
  Schema.brand("ApiKeyToken"),
);
export type ApiKeyToken = typeof ApiKeyToken.Type;

/** Rule A1: does this bearer value go to the API Key lookup? */
export const isApiKeyBearer = Str.startsWith(API_KEY_PREFIX);

export interface ApiKeyParts {
  readonly keyId: ApiKeyId;
  readonly secret: string;
}

/** Splits a bearer value into key id and secret; None when it is not a well-formed key. */
export const parseApiKey = (bearer: string): Option.Option<ApiKeyParts> => {
  const match = API_KEY_PATTERN.exec(bearer);
  const keyId = match?.[1];
  const secret = match?.[2];
  return keyId === undefined || secret === undefined
    ? Option.none()
    : Option.some({ keyId: ApiKeyId.make(keyId), secret });
};

export const formatApiKey = (parts: ApiKeyParts): ApiKeyToken =>
  ApiKeyToken.make(`${API_KEY_PREFIX}${parts.keyId}_${parts.secret}`);

/** The non-secret prefix shown in lists so users can tell keys apart (`ApiKeyView.prefix`). */
export const apiKeyDisplayPrefix = (keyId: ApiKeyId): string => `${API_KEY_PREFIX}${keyId}`;
