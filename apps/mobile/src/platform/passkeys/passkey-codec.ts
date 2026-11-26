/**
 * WebAuthn Level 3 JSON normalization & base64url helpers shared by native and web passkey bridges.
 * Adapted from DeskoHub's passkey-credential.ts & native-passkey-error.ts.
 */
import type { JsonObject } from "./passkey-bridge";

const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export const toBase64Url = (value: string): string =>
  value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

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
  return out.replaceAll("+", "-").replaceAll("/", "_");
};

export const base64UrlToBytes = (value: string): Uint8Array => {
  const std = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = padded[i] ?? "";
    const c1 = padded[i + 1] ?? "";
    const c2 = padded[i + 2] ?? "=";
    const c3 = padded[i + 3] ?? "=";
    const a = B64_ALPHA.indexOf(c0);
    const b = B64_ALPHA.indexOf(c1);
    const c = c2 === "=" ? -1 : B64_ALPHA.indexOf(c2);
    const d = c3 === "=" ? -1 : B64_ALPHA.indexOf(c3);
    if (a < 0 || b < 0) break;
    out.push((a << 2) | (b >>> 4));
    if (c >= 0) out.push(((b & 0x0f) << 4) | (c >>> 2));
    if (d >= 0) out.push(((c & 0x03) << 6) | d);
  }
  return new Uint8Array(out);
};

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const optionalBytes = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? toBase64Url(value) : undefined;

const filterTransports = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((t): t is string => typeof t === "string" && TRANSPORTS.has(t))
    : undefined;

const toAttachment = (value: unknown): "platform" | "cross-platform" | undefined =>
  value === "platform" || value === "cross-platform" ? value : undefined;

/** Normalizes a native `react-native-passkeys` registration result into WebAuthn Level 3 JSON. */
export const normalizeRegistrationResponse = (raw: unknown): JsonObject | null => {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.response)) return null;
  const resp = raw.response;
  if (typeof resp.clientDataJSON !== "string" || typeof resp.attestationObject !== "string") {
    return null;
  }
  const attachment = toAttachment(raw.authenticatorAttachment);
  const authenticatorData = optionalBytes(resp.authenticatorData);
  const transports = filterTransports(resp.transports);
  const publicKeyAlgorithm =
    typeof resp.publicKeyAlgorithm === "number" && Number.isFinite(resp.publicKeyAlgorithm)
      ? resp.publicKeyAlgorithm
      : undefined;
  const publicKey = optionalBytes(resp.publicKey);
  return {
    id: toBase64Url(raw.id),
    rawId: toBase64Url(typeof raw.rawId === "string" ? raw.rawId : raw.id),
    type: "public-key",
    ...(attachment !== undefined ? { authenticatorAttachment: attachment } : {}),
    clientExtensionResults: isRecord(raw.clientExtensionResults) ? raw.clientExtensionResults : {},
    response: {
      clientDataJSON: toBase64Url(resp.clientDataJSON),
      attestationObject: toBase64Url(resp.attestationObject),
      ...(authenticatorData !== undefined ? { authenticatorData } : {}),
      ...(transports !== undefined ? { transports } : {}),
      ...(publicKeyAlgorithm !== undefined ? { publicKeyAlgorithm } : {}),
      ...(publicKey !== undefined ? { publicKey } : {}),
    },
  };
};

/** Normalizes a native `react-native-passkeys` authentication result into WebAuthn Level 3 JSON. */
export const normalizeAuthenticationResponse = (raw: unknown): JsonObject | null => {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.response)) return null;
  const resp = raw.response;
  if (
    typeof resp.clientDataJSON !== "string" ||
    typeof resp.authenticatorData !== "string" ||
    typeof resp.signature !== "string"
  ) {
    return null;
  }
  const attachment = toAttachment(raw.authenticatorAttachment);
  const userHandle = optionalBytes(resp.userHandle);
  return {
    id: toBase64Url(raw.id),
    rawId: toBase64Url(typeof raw.rawId === "string" ? raw.rawId : raw.id),
    type: "public-key",
    ...(attachment !== undefined ? { authenticatorAttachment: attachment } : {}),
    clientExtensionResults: isRecord(raw.clientExtensionResults) ? raw.clientExtensionResults : {},
    response: {
      clientDataJSON: toBase64Url(resp.clientDataJSON),
      authenticatorData: toBase64Url(resp.authenticatorData),
      signature: toBase64Url(resp.signature),
      ...(userHandle !== undefined ? { userHandle } : {}),
    },
  };
};

const textOf = (cause: unknown, key: "code" | "message" | "name"): string => {
  if (typeof cause !== "object" || cause === null || !(key in cause)) return "";
  const val = (cause as Record<string, unknown>)[key];
  return typeof val === "string" ? val : "";
};

const CANCELLED_CODES = new Set(["ERR_USER_CANCELLED"]);
const CANCELLED_SUBSTRINGS = ["UserCancelled", "Interrupted", "DomError: NotAllowedError"];

/** Classifies native Credential Manager / ASAuthorization rejections (DeskoHub pattern). */
export const classifyNativePasskeyError = (
  cause: unknown,
): { readonly kind: "cancelled" } | { readonly kind: "failed"; readonly message: string } => {
  const code = textOf(cause, "code");
  const message = textOf(cause, "message");
  if (CANCELLED_CODES.has(code) || CANCELLED_SUBSTRINGS.some((s) => message.includes(s))) {
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
