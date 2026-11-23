/**
 * ALTCHA bot protection at the edge (http-mcp-contracts section 2.6, ADR 0002).
 *
 * The spec names `AltchaChallenge` and the base64 `X-Altcha` payload without fields. The shapes
 * below follow the ALTCHA proof-of-work wire format (`altcha-lib` `createChallenge` output and
 * the widget's solved payload); confirm them against the pinned `altcha-lib` version.
 */
import { Schema } from "effect";

/** The route picks the scope; it is signed into the challenge (rule B1). */
export const BotScope = Schema.Literals([
  "sign_up",
  "sign_in",
  "magic_link",
  "password_reset",
  "invitation_accept",
]);
export type BotScope = typeof BotScope.Type;

export const AltchaAlgorithm = Schema.Literals(["SHA-256", "SHA-384", "SHA-512"]);
export type AltchaAlgorithm = typeof AltchaAlgorithm.Type;

const HexString = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]+$/)));
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** `GET /api/v1/bot-protection/challenges/{scope}` success body. */
export const AltchaChallenge = Schema.Struct({
  algorithm: AltchaAlgorithm,
  challenge: HexString,
  maxnumber: Schema.optional(NonNegativeInt),
  /** Carries the signed scope and expiry as query parameters (`?scope=...&expires=...`). */
  salt: Schema.NonEmptyString,
  signature: HexString,
});
export type AltchaChallenge = typeof AltchaChallenge.Type;

/** The solved challenge the widget produces. */
export const AltchaPayload = Schema.Struct({
  algorithm: AltchaAlgorithm,
  challenge: HexString,
  number: NonNegativeInt,
  salt: Schema.NonEmptyString,
  signature: HexString,
  took: Schema.optional(NonNegativeInt),
});
export type AltchaPayload = typeof AltchaPayload.Type;

/** The `X-Altcha` header value: base64 of the JSON `AltchaPayload`. */
export const AltchaPayloadFromHeader = Schema.StringFromBase64.pipe(
  Schema.decodeTo(Schema.fromJsonString(AltchaPayload)),
);

export const ALTCHA_HEADER = "x-altcha";

/** Headers of a protected request; the server verifies the payload before any side effect. */
export const AltchaHeaders = Schema.Struct({ [ALTCHA_HEADER]: AltchaPayloadFromHeader });

/** Better Auth paths (relative to `/api/auth`) guarded by the ALTCHA before-hook. */
export const BOT_PROTECTED_AUTH_PATHS: Readonly<Record<string, BotScope>> = {
  "/sign-up/email": "sign_up",
  "/sign-in/email": "sign_in",
  "/sign-in/magic-link": "magic_link",
  "/request-password-reset": "password_reset",
};
