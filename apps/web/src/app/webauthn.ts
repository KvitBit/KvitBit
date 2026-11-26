/**
 * Browser WebAuthn ceremonies matching `@better-auth/passkey` client/server contracts.
 *
 * Authentication:
 *   1. GET  /api/auth/passkey/generate-authenticate-options
 *   2. navigator.credentials.get({ publicKey })
 *   3. POST /api/auth/passkey/verify-authentication { response }
 *
 * Registration:
 *   1. GET  /api/auth/passkey/generate-register-options?name=...
 *   2. navigator.credentials.create({ publicKey })
 *   3. POST /api/auth/passkey/verify-registration { response, name }
 */

export const base64UrlToBuffer = (value: string): ArrayBuffer => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const mod = padded.length % 4;
  const b64 = mod === 0 ? padded : padded + "=".repeat(4 - mod);
  const binary =
    typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

export const bufferToBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decodeDescriptorList = (raw: unknown): Array<PublicKeyCredentialDescriptor> | undefined => {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: typeof item.id === "string" ? base64UrlToBuffer(item.id) : new ArrayBuffer(0),
      type: "public-key" as const,
      ...(Array.isArray(item.transports)
        ? { transports: item.transports as Array<AuthenticatorTransport> }
        : {}),
    }));
};

export interface PasskeyAuthenticationResult {
  readonly supported: boolean;
  readonly json?: unknown;
}

export const performPasskeyAuthentication = async (
  baseOrigin: string,
): Promise<PasskeyAuthenticationResult> => {
  if (
    typeof navigator === "undefined" ||
    navigator.credentials === undefined ||
    typeof navigator.credentials.get !== "function"
  ) {
    return { supported: false };
  }
  const optRes = await fetch(`${baseOrigin}/api/auth/passkey/generate-authenticate-options`, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!optRes.ok) {
    const json: unknown = optRes.headers.get("content-type")?.includes("json")
      ? await optRes.json().catch(() => null)
      : null;
    throw Object.assign(new Error(`passkey options ${optRes.status}`), {
      status: optRes.status,
      json,
    });
  }
  const options = (await optRes.json()) as Record<string, unknown>;
  const challenge =
    typeof options.challenge === "string"
      ? base64UrlToBuffer(options.challenge)
      : new ArrayBuffer(0);
  const allowCredentials = decodeDescriptorList(options.allowCredentials);
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge,
    ...(typeof options.rpId === "string" ? { rpId: options.rpId } : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : { timeout: 60_000 }),
    ...(typeof options.userVerification === "string"
      ? { userVerification: options.userVerification as UserVerificationRequirement }
      : { userVerification: "preferred" }),
    ...(allowCredentials !== undefined ? { allowCredentials } : {}),
  };

  const credential = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (credential === null) {
    throw Object.assign(new Error("Passkey authentication cancelled"), { status: 400 });
  }
  const assertion = credential.response as AuthenticatorAssertionResponse;
  const responseBody = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      authenticatorData: bufferToBase64Url(assertion.authenticatorData),
      clientDataJSON: bufferToBase64Url(assertion.clientDataJSON),
      signature: bufferToBase64Url(assertion.signature),
      ...(assertion.userHandle !== null
        ? { userHandle: bufferToBase64Url(assertion.userHandle) }
        : {}),
    },
    ...(credential.authenticatorAttachment !== null &&
    credential.authenticatorAttachment !== undefined
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    type: credential.type || "public-key",
  };

  const verifyRes = await fetch(`${baseOrigin}/api/auth/passkey/verify-authentication`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: responseBody }),
  });
  const json: unknown = verifyRes.headers.get("content-type")?.includes("json")
    ? await verifyRes.json().catch(() => null)
    : null;
  if (!verifyRes.ok) {
    throw Object.assign(new Error(`passkey verify ${verifyRes.status}`), {
      status: verifyRes.status,
      json,
    });
  }
  return { supported: true, json };
};

export interface PasskeyRegistrationResult {
  readonly supported: boolean;
  readonly json?: unknown;
}

export const performPasskeyRegistration = async (
  baseOrigin: string,
  name: string,
): Promise<PasskeyRegistrationResult> => {
  if (
    typeof navigator === "undefined" ||
    navigator.credentials === undefined ||
    typeof navigator.credentials.create !== "function"
  ) {
    return { supported: false };
  }
  const query = name.trim() === "" ? "" : `?name=${encodeURIComponent(name.trim())}`;
  const optRes = await fetch(`${baseOrigin}/api/auth/passkey/generate-register-options${query}`, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!optRes.ok) {
    const json: unknown = optRes.headers.get("content-type")?.includes("json")
      ? await optRes.json().catch(() => null)
      : null;
    throw Object.assign(new Error(`passkey register options ${optRes.status}`), {
      status: optRes.status,
      json,
    });
  }
  const options = (await optRes.json()) as Record<string, unknown>;
  const userObj =
    typeof options.user === "object" && options.user !== null
      ? (options.user as Record<string, unknown>)
      : {};
  const rpObj =
    typeof options.rp === "object" && options.rp !== null
      ? (options.rp as Record<string, unknown>)
      : {};
  const excludeCredentials = decodeDescriptorList(options.excludeCredentials);
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge:
      typeof options.challenge === "string"
        ? base64UrlToBuffer(options.challenge)
        : new ArrayBuffer(0),
    rp: {
      name: typeof rpObj.name === "string" ? rpObj.name : "Kvitbit",
      ...(typeof rpObj.id === "string" ? { id: rpObj.id } : {}),
    },
    user: {
      id: typeof userObj.id === "string" ? base64UrlToBuffer(userObj.id) : new ArrayBuffer(0),
      name: typeof userObj.name === "string" ? userObj.name : "",
      displayName: typeof userObj.displayName === "string" ? userObj.displayName : "",
    },
    pubKeyCredParams: Array.isArray(options.pubKeyCredParams)
      ? (options.pubKeyCredParams as Array<PublicKeyCredentialParameters>)
      : [{ type: "public-key", alg: -7 }],
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : { timeout: 60_000 }),
    ...(excludeCredentials !== undefined ? { excludeCredentials } : {}),
    ...(typeof options.authenticatorSelection === "object" &&
    options.authenticatorSelection !== null
      ? { authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria }
      : {}),
    ...(typeof options.attestation === "string"
      ? { attestation: options.attestation as AttestationConveyancePreference }
      : {}),
  };

  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (credential === null) {
    throw Object.assign(new Error("Passkey registration cancelled"), { status: 400 });
  }
  const attestation = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof attestation.getTransports === "function" ? attestation.getTransports() : undefined;
  const publicKeyAlg =
    typeof attestation.getPublicKeyAlgorithm === "function"
      ? attestation.getPublicKeyAlgorithm()
      : undefined;
  const pubKeyBuf =
    typeof attestation.getPublicKey === "function" ? attestation.getPublicKey() : null;
  const authDataBuf =
    typeof attestation.getAuthenticatorData === "function"
      ? attestation.getAuthenticatorData()
      : null;

  const responseBody = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    response: {
      attestationObject: bufferToBase64Url(attestation.attestationObject),
      clientDataJSON: bufferToBase64Url(attestation.clientDataJSON),
      ...(transports !== undefined ? { transports } : {}),
      ...(publicKeyAlg !== undefined ? { publicKeyAlgorithm: publicKeyAlg } : {}),
      ...(pubKeyBuf !== null ? { publicKey: bufferToBase64Url(pubKeyBuf) } : {}),
      ...(authDataBuf !== null ? { authenticatorData: bufferToBase64Url(authDataBuf) } : {}),
    },
    ...(credential.authenticatorAttachment !== null &&
    credential.authenticatorAttachment !== undefined
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
    type: credential.type || "public-key",
  };

  const verifyRes = await fetch(`${baseOrigin}/api/auth/passkey/verify-registration`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response: responseBody, name: name.trim() || undefined }),
  });
  const json: unknown = verifyRes.headers.get("content-type")?.includes("json")
    ? await verifyRes.json().catch(() => null)
    : null;
  if (!verifyRes.ok) {
    throw Object.assign(new Error(`passkey verify registration ${verifyRes.status}`), {
      status: verifyRes.status,
      json,
    });
  }
  return { supported: true, json };
};
