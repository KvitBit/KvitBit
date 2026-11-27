/**
 * WebAuthn Level 3 JSON normalization & base64url helpers shared by native and web passkey bridges.
 * Adapted from DeskoHub's passkey-credential.ts & native-passkey-error.ts.
 */

import * as EffectArray from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";

const Transport = Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const isTransport = Schema.is(Transport);
const padding = /[=]+$/;
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

export const toBase64Url = (value: string): string =>
  EffectString.replace(
    padding,
    "",
  )(EffectString.replaceAll("/", "_")(EffectString.replaceAll("+", "-")(value)));

// biome-ignore lint/security/noSecrets: Standard base64 alphabet.
const B64_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const bytesToBase64Url = (input: ArrayBuffer | Uint8Array): string => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64_ALPHA[(n >>> 18) & 63];
    out += B64_ALPHA[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHA[(n >>> 6) & 63] : "";
    out += i + 2 < bytes.length ? B64_ALPHA[n & 63] : "";
  }
  return EffectString.replaceAll("/", "_")(EffectString.replaceAll("+", "-")(out));
};

export const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const std = EffectString.replaceAll("_", "/")(EffectString.replaceAll("-", "+")(value));
  const padded = std + EffectString.repeat((4 - (std.length % 4)) % 4)("=");
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = padded[i] ?? "";
    const c1 = padded[i + 1] ?? "";
    const c2 = padded[i + 2] ?? "=";
    const c3 = padded[i + 3] ?? "=";
    const a = Option.getOrElse(EffectString.indexOf(c0)(B64_ALPHA), () => -1);
    const b = Option.getOrElse(EffectString.indexOf(c1)(B64_ALPHA), () => -1);
    const c = c2 === "=" ? -1 : Option.getOrElse(EffectString.indexOf(c2)(B64_ALPHA), () => -1);
    const d = c3 === "=" ? -1 : Option.getOrElse(EffectString.indexOf(c3)(B64_ALPHA), () => -1);
    if (a < 0 || b < 0) break;
    out.push((a << 2) | (b >>> 4));
    if (c >= 0) out.push(((b & 0x0f) << 4) | (c >>> 2));
    if (d >= 0) out.push(((c & 0x03) << 6) | d);
  }
  return new Uint8Array(out);
};

const isNonEmptyText = Schema.is(Schema.NonEmptyString);
const isAttachment = Schema.is(Schema.Literals(["platform", "cross-platform"]));
const isFiniteNumber = Schema.is(Schema.Finite);
const isJsonArray = Schema.is(Schema.Array(Schema.Unknown));
const isJsonObject = Schema.is(JsonObject);
const NativeFields = Schema.Struct({
  id: Schema.String,
  rawId: Schema.optionalKey(Schema.Unknown),
  authenticatorAttachment: Schema.optionalKey(Schema.Unknown),
  clientExtensionResults: Schema.optionalKey(Schema.Unknown),
  response: JsonObject,
});
const decodeNative = Schema.decodeUnknownOption(NativeFields);
const Registration = Schema.Struct({
  clientDataJSON: Schema.String,
  attestationObject: Schema.String,
});
const AuthenticationFields = Schema.Struct({
  clientDataJSON: Schema.String,
  authenticatorData: Schema.String,
  signature: Schema.String,
});
const isRegistration = Schema.is(Registration);
const isAuthentication = Schema.is(AuthenticationFields);

const normalize = (
  fields: typeof NativeFields.Type,
  response: typeof JsonObject.Type,
): typeof JsonObject.Type => {
  const output = {
    id: toBase64Url(fields.id),
    rawId: toBase64Url(isText(fields.rawId) ? fields.rawId : fields.id),
    type: "public-key",
    clientExtensionResults: isJsonObject(fields.clientExtensionResults)
      ? fields.clientExtensionResults
      : {},
    response,
  };
  if (isAttachment(fields.authenticatorAttachment)) {
    return { ...output, authenticatorAttachment: fields.authenticatorAttachment };
  }
  return output;
};

/** Normalizes a native registration result into WebAuthn Level 3 JSON. */
// biome-ignore lint/plugin/no-unknown-parameters: The native package's response is checked here.
export const normalizeRegistrationResponse = (raw: unknown): typeof JsonObject.Type | null => {
  const decoded = decodeNative(raw);
  if (Option.isNone(decoded)) return null;
  const { response } = decoded.value;
  if (!isRegistration(response)) return null;
  const output = {
    clientDataJSON: toBase64Url(response.clientDataJSON),
    attestationObject: toBase64Url(response.attestationObject),
  };
  if (isNonEmptyText(response["authenticatorData"]))
    Object.assign(output, {
      authenticatorData: toBase64Url(response["authenticatorData"]),
    });
  if (isJsonArray(response["transports"]))
    Object.assign(output, {
      transports: EffectArray.filter(response["transports"], isTransport),
    });
  if (isFiniteNumber(response["publicKeyAlgorithm"]))
    Object.assign(output, { publicKeyAlgorithm: response["publicKeyAlgorithm"] });
  if (isNonEmptyText(response["publicKey"]))
    Object.assign(output, { publicKey: toBase64Url(response["publicKey"]) });
  return normalize(decoded.value, output);
};

/** Normalizes a native authentication result into WebAuthn Level 3 JSON. */
// biome-ignore lint/plugin/no-unknown-parameters: The native package's response is checked here.
export const normalizeAuthenticationResponse = (raw: unknown): typeof JsonObject.Type | null => {
  const decoded = decodeNative(raw);
  if (Option.isNone(decoded)) return null;
  const { response } = decoded.value;
  if (!isAuthentication(response)) return null;
  const output = {
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.authenticatorData),
    signature: toBase64Url(response.signature),
  };
  return normalize(
    decoded.value,
    isNonEmptyText(response["userHandle"])
      ? { ...output, userHandle: toBase64Url(response["userHandle"]) }
      : output,
  );
};

const ErrorFields = Schema.Struct({
  code: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
});
const isErrorFields = Schema.is(ErrorFields);
const isText = Schema.is(Schema.String);

const textOf = (cause: unknown, key: "code" | "message" | "name"): string => {
  if (!isErrorFields(cause)) return "";
  const value = cause[key];
  return isText(value) ? value : "";
};

const CANCELLED_CODES = new Set(["ERR_USER_CANCELLED"]);
const CANCELLED_SUBSTRINGS = ["UserCancelled", "Interrupted", "DomError: NotAllowedError"];

/** Classifies native Credential Manager / ASAuthorization rejections (DeskoHub pattern). */
export const classifyNativePasskeyError = (
  cause: unknown,
): { readonly kind: "cancelled" } | { readonly kind: "failed"; readonly message: string } => {
  const code = textOf(cause, "code");
  const message = textOf(cause, "message");
  if (
    CANCELLED_CODES.has(code) ||
    EffectArray.some(CANCELLED_SUBSTRINGS, (s) => EffectString.includes(s)(message))
  ) {
    return { kind: "cancelled" };
  }
  return { kind: "failed", message: message || code || "passkey ceremony failed" };
};

/** Classifies WebAuthn `navigator.credentials` rejections. */
export const classifyWebPasskeyError = (
  cause: unknown,
): { readonly kind: "cancelled" } | { readonly kind: "failed"; readonly message: string } => {
  const name = textOf(cause, "name");
  const message = textOf(cause, "message");
  if (name === "NotAllowedError" || name === "AbortError") {
    return { kind: "cancelled" };
  }
  return { kind: "failed", message: message || name || "passkey ceremony failed" };
};
