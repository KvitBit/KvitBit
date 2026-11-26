/**
 * HKDF-derived keys for `ShareLinkKeys` and `InvitationTokens` from `BETTER_AUTH_SECRET`,
 * `KVITBIT_SHARE_KEY_VERSION`, and `APP_ORIGIN` (settled board contract #871/#899).
 */
import { createHmac, hkdfSync } from "node:crypto";
import { InvitationTokens, ShareLinkKeys } from "@kvitbit/core";
import type { InvitationId, ShareToken } from "@kvitbit/domain/contract";
import { type Config, Effect, Layer, Redacted } from "effect";
import { type ShareSecretsConfig, ShareSecretsConfigSchema } from "./config";

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

/** Derives a 32-byte share-link HMAC key for `version` via HKDF-SHA256. */
export const deriveShareLinkKey = (authSecret: string, version: number): Uint8Array =>
  new Uint8Array(
    hkdfSync(
      "sha256",
      Buffer.from(authSecret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(`kvitbit/share-link/v${version}`, "utf8"),
      32,
    ),
  );

/** Derives a 32-byte invitation token HMAC key via HKDF-SHA256. */
export const deriveInvitationTokenKey = (authSecret: string): Uint8Array =>
  new Uint8Array(
    hkdfSync(
      "sha256",
      Buffer.from(authSecret, "utf8"),
      Buffer.alloc(0),
      Buffer.from("kvitbit/invitation-token/v1", "utf8"),
      32,
    ),
  );

export const makeShareLinkKeysLayer = (config: ShareSecretsConfig): Layer.Layer<ShareLinkKeys> => {
  const origin = normalizeOrigin(config.appOrigin);
  const secret = deriveShareLinkKey(Redacted.value(config.authSecret), config.shareKeyVersion);
  return Layer.succeed(
    ShareLinkKeys,
    ShareLinkKeys.of({
      version: config.shareKeyVersion,
      secret,
      pageUrl: (token: ShareToken) => `${origin}/s/${token}`,
      pdfUrl: (token: ShareToken) => `${origin}/s/${token}/pdf`,
    }),
  );
};

export const makeInvitationTokensLayer = (
  authSecret: Redacted.Redacted<string>,
): Layer.Layer<InvitationTokens> => {
  const key = deriveInvitationTokenKey(Redacted.value(authSecret));
  return Layer.succeed(
    InvitationTokens,
    InvitationTokens.of({
      token: (invitationId: InvitationId, epoch: number) =>
        Effect.sync(() =>
          createHmac("sha256", key).update(`${invitationId}:${epoch}`).digest("base64url"),
        ),
    }),
  );
};

export const ShareLinkKeysLive: Layer.Layer<ShareLinkKeys, Config.ConfigError> = Layer.unwrap(
  Effect.map(ShareSecretsConfigSchema, makeShareLinkKeysLayer),
);

export const InvitationTokensLive: Layer.Layer<InvitationTokens, Config.ConfigError> = Layer.unwrap(
  Effect.map(ShareSecretsConfigSchema, (cfg) => makeInvitationTokensLayer(cfg.authSecret)),
);
