/** Browser ceremonies for the pinned Better Auth passkey endpoints. */

const decodeBase64Url = (value: string): ArrayBuffer => {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
};

const encodeBase64Url = (buffer: ArrayBuffer): string =>
  btoa(Array.from(new Uint8Array(buffer), (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decodeDescriptor = ({
  id,
  transports,
}: PublicKeyCredentialDescriptorJSON): PublicKeyCredentialDescriptor => ({
  type: "public-key",
  id: decodeBase64Url(id),
  ...(transports === undefined ? {} : { transports: transports as Array<AuthenticatorTransport> }),
});

const decodePrfValues = ({ first, second }: AuthenticationExtensionsPRFValuesJSON) => ({
  first: decodeBase64Url(first),
  ...(second === undefined ? {} : { second: decodeBase64Url(second) }),
});

const decodeExtensions = ({
  largeBlob,
  prf,
  ...rest
}: AuthenticationExtensionsClientInputsJSON): AuthenticationExtensionsClientInputs => ({
  ...rest,
  ...(largeBlob === undefined
    ? {}
    : {
        largeBlob: {
          ...(largeBlob.read === undefined ? {} : { read: largeBlob.read }),
          ...(largeBlob.support === undefined ? {} : { support: largeBlob.support }),
          ...(largeBlob.write === undefined ? {} : { write: decodeBase64Url(largeBlob.write) }),
        },
      }),
  ...(prf === undefined
    ? {}
    : {
        prf: {
          ...(prf.eval === undefined ? {} : { eval: decodePrfValues(prf.eval) }),
          ...(prf.evalByCredential === undefined
            ? {}
            : {
                evalByCredential: Object.fromEntries(
                  Object.entries(prf.evalByCredential).map(([id, values]) => [
                    id,
                    decodePrfValues(values),
                  ]),
                ),
              }),
        },
      }),
});

const requestOptions = (options: PublicKeyCredentialRequestOptionsJSON) => {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(options);
  }
  const { challenge, allowCredentials, extensions, userVerification, ...rest } = options;
  return {
    ...rest,
    challenge: decodeBase64Url(challenge),
    ...(extensions === undefined ? {} : { extensions: decodeExtensions(extensions) }),
    ...(userVerification === undefined
      ? {}
      : { userVerification: userVerification as UserVerificationRequirement }),
    ...(allowCredentials === undefined
      ? {}
      : { allowCredentials: allowCredentials.map(decodeDescriptor) }),
  } as PublicKeyCredentialRequestOptions;
};

const creationOptions = (options: PublicKeyCredentialCreationOptionsJSON) => {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(options);
  }
  const { challenge, user, excludeCredentials, extensions, pubKeyCredParams, ...rest } = options;
  return {
    ...rest,
    challenge: decodeBase64Url(challenge),
    user: { ...user, id: decodeBase64Url(user.id) },
    pubKeyCredParams: pubKeyCredParams.map(({ alg }) => ({ alg, type: "public-key" as const })),
    ...(extensions === undefined ? {} : { extensions: decodeExtensions(extensions) }),
    ...(excludeCredentials === undefined
      ? {}
      : { excludeCredentials: excludeCredentials.map(decodeDescriptor) }),
  } as PublicKeyCredentialCreationOptions;
};

const credentialJson = (
  credential: PublicKeyCredential,
  encodeResponse: () => Record<string, unknown>,
): Record<string, unknown> => {
  if (typeof credential.toJSON === "function") {
    const { clientExtensionResults: _extensions, ...response } = credential.toJSON();
    return response;
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    response: encodeResponse(),
    type: credential.type,
    ...(credential.authenticatorAttachment === null
      ? {}
      : { authenticatorAttachment: credential.authenticatorAttachment }),
  };
};

const authRequest = async (
  baseOrigin: string,
  path: string,
  signal: AbortSignal | undefined,
  body?: object,
): Promise<unknown> => {
  const res = await fetch(`${baseOrigin}/api/auth/passkey/${path}`, {
    credentials: "same-origin",
    ...(signal === undefined ? {} : { signal }),
    ...(body === undefined
      ? { method: "GET", headers: { accept: "application/json" } }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const json: unknown = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok)
    throw Object.assign(new Error(`passkey ${res.status}`), { status: res.status, json });
  return json;
};

type PasskeyResult =
  | { readonly supported: false }
  | { readonly supported: true; readonly json: unknown };

export const performPasskeyAuthentication = async (
  baseOrigin: string,
  signal?: AbortSignal,
): Promise<PasskeyResult> => {
  if (
    typeof PublicKeyCredential === "undefined" ||
    typeof navigator.credentials?.get !== "function"
  ) {
    return { supported: false };
  }
  const options = await authRequest(baseOrigin, "generate-authenticate-options", signal);
  const credential = await navigator.credentials.get({
    publicKey: requestOptions(options as PublicKeyCredentialRequestOptionsJSON),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("No passkey assertion returned");
  const assertion = credential.response as AuthenticatorAssertionResponse;
  const response = credentialJson(credential, () => ({
    authenticatorData: encodeBase64Url(assertion.authenticatorData),
    clientDataJSON: encodeBase64Url(assertion.clientDataJSON),
    signature: encodeBase64Url(assertion.signature),
    ...(assertion.userHandle === null ? {} : { userHandle: encodeBase64Url(assertion.userHandle) }),
  }));
  const json = await authRequest(baseOrigin, "verify-authentication", signal, { response });
  return { supported: true, json };
};

export const performPasskeyRegistration = async (
  baseOrigin: string,
  name: string,
  signal?: AbortSignal,
): Promise<PasskeyResult> => {
  if (
    typeof PublicKeyCredential === "undefined" ||
    typeof navigator.credentials?.create !== "function"
  ) {
    return { supported: false };
  }
  const trimmedName = name.trim();
  const query = trimmedName === "" ? "" : `?${new URLSearchParams({ name: trimmedName })}`;
  const options = await authRequest(baseOrigin, `generate-register-options${query}`, signal);
  const credential = await navigator.credentials.create({
    publicKey: creationOptions(options as PublicKeyCredentialCreationOptionsJSON),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("No passkey attestation returned");
  const attestation = credential.response as AuthenticatorAttestationResponse;
  const response = credentialJson(credential, () => ({
    attestationObject: encodeBase64Url(attestation.attestationObject),
    clientDataJSON: encodeBase64Url(attestation.clientDataJSON),
    transports: attestation.getTransports?.(),
  }));
  const json = await authRequest(baseOrigin, "verify-registration", signal, {
    response,
    ...(trimmedName === "" ? {} : { name: trimmedName }),
  });
  return { supported: true, json };
};
