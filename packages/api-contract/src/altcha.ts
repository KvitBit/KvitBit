/**
 * ALTCHA bot protection at the edge (http-mcp-contracts section 2.6, ADR 0002).
 *
 * The spec names `AltchaChallenge` and the base64 `X-Altcha` payload without fields, and ADR
 * 0002 picks ALTCHA PoW v2 without pinning an `altcha-lib` 2.x release. Both shapes are therefore
 * open JSON objects here: the edge passes the challenge through from `BotProtection.issue` and
 * hands the decoded payload to `BotProtection.verify`, which owns the field-level checks. Narrow
 * them once the library version is pinned.
 *
 * Which Better Auth requests need a proof, and with which scope, is the server hook's decision:
 * sign-up alone can carry `sign_up` or `invitation_accept` (section 3.5.1), so no static path
 * map lives here.
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

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** `GET /api/v1/bot-protection/challenges/{scope}` success body: a non-empty JSON object. */
export const AltchaChallenge = JsonObject.pipe(
  Schema.check(Schema.isMinProperties(1)),
  Schema.brand("AltchaChallenge"),
);
export type AltchaChallenge = typeof AltchaChallenge.Type;

/** The solved challenge the widget produces, as a JSON object. */
export const AltchaPayload = JsonObject.pipe(Schema.brand("AltchaPayload"));
export type AltchaPayload = typeof AltchaPayload.Type;

/** Upper bound on the `X-Altcha` header value, in characters of base64. */
export const ALTCHA_HEADER_MAX_LENGTH = 8 * 1024;

/** The `X-Altcha` header value: bounded base64 that decodes to a JSON object. */
export const AltchaPayloadFromHeader = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(ALTCHA_HEADER_MAX_LENGTH)),
  Schema.decodeTo(Schema.StringFromBase64),
  Schema.decodeTo(Schema.fromJsonString(AltchaPayload)),
);

export const ALTCHA_HEADER = "x-altcha";

/** Headers of a protected request; the server verifies the payload before any side effect. */
export const AltchaHeaders = Schema.Struct({ [ALTCHA_HEADER]: AltchaPayloadFromHeader });
