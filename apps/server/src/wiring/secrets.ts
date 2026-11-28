/**
 * HKDF-derived keys for `ShareLinkKeys` and `InvitationTokens` from `BETTER_AUTH_SECRET`,
 * `KVITBIT_SHARE_KEY_VERSION`, and `APP_ORIGIN` (settled board contract #871/#899).
 */

import { InvitationTokens, ShareLinkKeys } from "@kvitbit/core";
import type { InvitationId, ShareToken } from "@kvitbit/domain/contract";
import { CryptoHasher } from "bun";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type ShareSecretsConfig, ShareSecretsConfigSchema } from "./config";

const trailingSlashes = /\/+$/;
const normalizeOrigin = Str.replace(trailingSlashes, "");

export class KeyDerivationError extends Schema.TaggedError<
  KeyDerivationError,
  { readonly brand: unique symbol }
>()("KeyDerivationError", { cause: Schema.Unknown }) {}

const encode = new TextEncoder();
const deriveKey = Effect.fn("deriveHmacKey")(function* (authSecret: string, info: string) {
  const key = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("raw", encode.encode(authSecret), "HKDF", false, ["deriveBits"]),
    catch: (cause) => KeyDerivationError.make({ cause }),
  });
  const bits = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encode.encode(info) },
        key,
        256,
      ),
    catch: (cause) => KeyDerivationError.make({ cause }),
  });
  return new Uint8Array(bits);
});

/** Derives a 32-byte share-link HMAC key for `version` via HKDF-SHA256. */
export const deriveShareLinkKey: {
  (version: number): (authSecret: string) => ReturnType<typeof deriveKey>;
  (authSecret: string, version: number): ReturnType<typeof deriveKey>;
} = Fn.dual(2, (authSecret: string, version: number) =>
  deriveKey(authSecret, `kvitbit/share-link/v${version}`),
);

/** Derives a 32-byte invitation token HMAC key via HKDF-SHA256. */
export const deriveInvitationTokenKey = (authSecret: string) =>
  deriveKey(authSecret, "kvitbit/invitation-token/v1");

export const makeShareLinkKeysLayer = (config: ShareSecretsConfig) =>
  Layer.effect(
    ShareLinkKeys,
    Effect.gen(function* () {
      const origin = normalizeOrigin(config.appOrigin);
      const secret = yield* deriveShareLinkKey(
        Redacted.value(config.authSecret),
        config.shareKeyVersion,
      );
      return ShareLinkKeys.of({
        version: config.shareKeyVersion,
        secret,
        pageUrl: (token: ShareToken) => `${origin}/s/${token}`,
        pdfUrl: (token: ShareToken) => `${origin}/s/${token}/pdf`,
      });
    }),
  );

export const makeInvitationTokensLayer = (authSecret: Redacted.Redacted<string>) =>
  Layer.effect(
    InvitationTokens,
    Effect.gen(function* () {
      const key = yield* Fn.pipe(authSecret, Redacted.value, deriveInvitationTokenKey);
      return InvitationTokens.of({
        token: Effect.fn("InvitationTokens.token")((invitationId: InvitationId, epoch: number) =>
          Effect.sync(() =>
            new CryptoHasher("sha256", key).update(`${invitationId}:${epoch}`).digest("base64url"),
          ),
        ),
      });
    }),
  );

export const ShareLinkKeysLive = Layer.unwrap(
  Effect.map(ShareSecretsConfigSchema, makeShareLinkKeysLayer),
);

export const InvitationTokensLive = Layer.unwrap(
  Effect.map(ShareSecretsConfigSchema, (cfg) => makeInvitationTokensLayer(cfg.authSecret)),
);
