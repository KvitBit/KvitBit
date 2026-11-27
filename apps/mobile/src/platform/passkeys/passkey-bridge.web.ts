/**
 * Web / PWA PasskeyBridge over `navigator.credentials` (WebAuthn Level 3 JSON conversion).
 */
import type { JsonObject, PasskeyBridge, PasskeyOutcome } from "./passkey-bridge";
import { base64UrlToBytes, bytesToBase64Url, classifyWebPasskeyError } from "./passkey-codec";

export interface WebCredentialsEnv {
  readonly credentials?: {
    readonly create: (options: CredentialCreationOptions) => Promise<Credential | null>;
    readonly get: (options: CredentialRequestOptions) => Promise<Credential | null>;
  };
  readonly PublicKeyCredential?: {
    readonly isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    readonly parseCreationOptionsFromJSON?: (
      options: JsonObject,
    ) => PublicKeyCredentialCreationOptions;
    readonly parseRequestOptionsFromJSON?: (
      options: JsonObject,
    ) => PublicKeyCredentialRequestOptions;
  };
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const decodeDescriptors = (list: unknown): PublicKeyCredentialDescriptor[] | undefined => {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((d): d is Record<string, unknown> => isRecord(d) && typeof d.id === "string")
    .map((d) => ({
      id: base64UrlToBytes(d.id as string) as BufferSource,
      type: "public-key" as const,
      ...(Array.isArray(d.transports)
        ? { transports: d.transports as AuthenticatorTransport[] }
        : {}),
    }));
};

const toCreationOptions = (
  options: JsonObject,
  pkc?: WebCredentialsEnv["PublicKeyCredential"],
): PublicKeyCredentialCreationOptions => {
  if (typeof pkc?.parseCreationOptionsFromJSON === "function") {
    return pkc.parseCreationOptionsFromJSON(options);
  }
  const user = isRecord(options.user) ? options.user : {};
  const excludeCredentials =
    options.excludeCredentials !== undefined
      ? decodeDescriptors(options.excludeCredentials)
      : undefined;
  return {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(String(options.challenge ?? "")) as BufferSource,
    user: {
      ...(user as unknown as PublicKeyCredentialUserEntity),
      id: base64UrlToBytes(String(user.id ?? "")) as BufferSource,
    },
    ...(excludeCredentials !== undefined ? { excludeCredentials } : {}),
  };
};

const toRequestOptions = (
  options: JsonObject,
  pkc?: WebCredentialsEnv["PublicKeyCredential"],
): PublicKeyCredentialRequestOptions => {
  if (typeof pkc?.parseRequestOptionsFromJSON === "function") {
    return pkc.parseRequestOptionsFromJSON(options);
  }
  const allowCredentials =
    options.allowCredentials !== undefined
      ? decodeDescriptors(options.allowCredentials)
      : undefined;
  return {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBytes(String(options.challenge ?? "")) as BufferSource,
    ...(allowCredentials !== undefined ? { allowCredentials } : {}),
  };
};

const serializeAttestation = (cred: PublicKeyCredential): JsonObject => {
  const withToJson = cred as PublicKeyCredential & { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return withToJson.toJSON() as unknown as JsonObject;
  }
  const resp = cred.response as AuthenticatorAttestationResponse & {
    getTransports?: () => string[];
    getAuthenticatorData?: () => ArrayBuffer;
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
  };
  const transports = resp.getTransports?.();
  const authData = resp.getAuthenticatorData?.();
  const pubKey = resp.getPublicKey?.();
  const pubKeyAlg = resp.getPublicKeyAlgorithm?.();
  return {
    id: cred.id,
    rawId: bytesToBase64Url(cred.rawId),
    type: cred.type,
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bytesToBase64Url(resp.clientDataJSON),
      attestationObject: bytesToBase64Url(resp.attestationObject),
      ...(authData ? { authenticatorData: bytesToBase64Url(authData) } : {}),
      ...(transports ? { transports } : {}),
      ...(pubKeyAlg !== undefined ? { publicKeyAlgorithm: pubKeyAlg } : {}),
      ...(pubKey ? { publicKey: bytesToBase64Url(pubKey) } : {}),
    },
  };
};

const serializeAssertion = (cred: PublicKeyCredential): JsonObject => {
  const withToJson = cred as PublicKeyCredential & { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return withToJson.toJSON() as unknown as JsonObject;
  }
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToBase64Url(cred.rawId),
    type: cred.type,
    ...(cred.authenticatorAttachment
      ? { authenticatorAttachment: cred.authenticatorAttachment }
      : {}),
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bytesToBase64Url(resp.clientDataJSON),
      authenticatorData: bytesToBase64Url(resp.authenticatorData),
      signature: bytesToBase64Url(resp.signature),
      ...(resp.userHandle ? { userHandle: bytesToBase64Url(resp.userHandle) } : {}),
    },
  };
};

const defaultEnv = (): WebCredentialsEnv => ({
  ...(typeof navigator !== "undefined" && navigator.credentials !== undefined
    ? { credentials: navigator.credentials }
    : {}),
  ...(typeof globalThis.PublicKeyCredential === "function"
    ? {
        PublicKeyCredential: globalThis.PublicKeyCredential as unknown as NonNullable<
          WebCredentialsEnv["PublicKeyCredential"]
        >,
      }
    : {}),
});

export const makeWebPasskeyBridge = (
  getEnv: () => WebCredentialsEnv = defaultEnv,
): PasskeyBridge => ({
  availability: async () => {
    const { credentials, PublicKeyCredential: pkc } = getEnv();
    if (!credentials || !pkc) return "unavailable";
    try {
      if (typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
        const uvpa = await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
        return uvpa ? "available" : "hybrid_only";
      }
      return "hybrid_only";
    } catch {
      return "hybrid_only";
    }
  },
  create: async (options): Promise<PasskeyOutcome<JsonObject>> => {
    const { credentials, PublicKeyCredential: pkc } = getEnv();
    if (!credentials || !pkc) return { _tag: "Failed", message: "passkeys unavailable" };
    try {
      const cred = await credentials.create({ publicKey: toCreationOptions(options, pkc) });
      if (cred === null) return { _tag: "Cancelled" };
      return { _tag: "Ok", value: serializeAttestation(cred as PublicKeyCredential) };
    } catch (cause) {
      const classified = classifyWebPasskeyError(cause);
      return classified.kind === "cancelled"
        ? { _tag: "Cancelled" }
        : { _tag: "Failed", message: classified.message };
    }
  },
  get: async (options): Promise<PasskeyOutcome<JsonObject>> => {
    const { credentials, PublicKeyCredential: pkc } = getEnv();
    if (!credentials || !pkc) return { _tag: "Failed", message: "passkeys unavailable" };
    try {
      const cred = await credentials.get({ publicKey: toRequestOptions(options, pkc) });
      if (cred === null) return { _tag: "Cancelled" };
      return { _tag: "Ok", value: serializeAssertion(cred as PublicKeyCredential) };
    } catch (cause) {
      const classified = classifyWebPasskeyError(cause);
      return classified.kind === "cancelled"
        ? { _tag: "Cancelled" }
        : { _tag: "Failed", message: classified.message };
    }
  },
});

export const passkeyBridge: PasskeyBridge = makeWebPasskeyBridge();
