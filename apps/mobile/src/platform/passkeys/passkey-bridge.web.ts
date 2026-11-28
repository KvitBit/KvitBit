/** Web / PWA passkeys use the browser's JSON helpers when present. */
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";
import type { PasskeyAvailability, PasskeyBridge, PasskeyOutcome } from "./passkey-bridge";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  classifyWebPasskeyError,
  JsonObject,
} from "./passkey-codec";
import { decodeCreationOptions, decodeRequestOptions } from "./passkey-options";

export interface WebCredentialsEnv {
  readonly credentials?: Pick<CredentialsContainer, "create" | "get"> | undefined;
  readonly PublicKeyCredential?:
    | undefined
    | Partial<
        Pick<
          typeof PublicKeyCredential,
          | "isUserVerifyingPlatformAuthenticatorAvailable"
          | "parseCreationOptionsFromJSON"
          | "parseRequestOptionsFromJSON"
        >
      >;
}

const isBrowserTransport = Schema.is(Schema.Literals(["ble", "hybrid", "internal", "nfc", "usb"]));
const isJsonObject = Schema.is(JsonObject);

const decodeDescriptor = (
  descriptor: PublicKeyCredentialDescriptorJSON,
): PublicKeyCredentialDescriptor => {
  const fields: PublicKeyCredentialDescriptor = {
    id: base64UrlToBytes(descriptor.id),
    type: "public-key",
  };
  if (descriptor.transports !== undefined) {
    fields.transports = EffectArray.filter(descriptor.transports, isBrowserTransport);
  }
  return fields;
};

const decodePrf = (
  values: AuthenticationExtensionsPRFValuesJSON,
): AuthenticationExtensionsPRFValues => {
  const fields: AuthenticationExtensionsPRFValues = { first: base64UrlToBytes(values.first) };
  if (values.second !== undefined) fields.second = base64UrlToBytes(values.second);
  return fields;
};

const decodeExtensions = (
  extensions: AuthenticationExtensionsClientInputsJSON,
): AuthenticationExtensionsClientInputs => {
  const { largeBlob, prf, ...rest } = extensions;
  const fields: AuthenticationExtensionsClientInputs = rest;
  if (largeBlob !== undefined) {
    const { write, ...options } = largeBlob;
    fields.largeBlob = options;
    if (write !== undefined) fields.largeBlob.write = base64UrlToBytes(write);
  }
  if (prf !== undefined) {
    fields.prf = {};
    if (prf.eval !== undefined) fields.prf.eval = decodePrf(prf.eval);
    if (prf.evalByCredential !== undefined) {
      fields.prf.evalByCredential = EffectRecord.map(prf.evalByCredential, decodePrf);
    }
  }
  return fields;
};

const toCreationOptions = (
  options: PublicKeyCredentialCreationOptionsJSON,
  pkc: NonNullable<WebCredentialsEnv["PublicKeyCredential"]>,
): PublicKeyCredentialCreationOptions => {
  if (pkc.parseCreationOptionsFromJSON !== undefined)
    return pkc.parseCreationOptionsFromJSON(options);
  const { attestation, excludeCredentials, extensions, ...rest } = options;
  const fields: PublicKeyCredentialCreationOptions = {
    ...rest,
    challenge: base64UrlToBytes(options.challenge),
    user: { ...options.user, id: base64UrlToBytes(options.user.id) },
  };
  if (isAttestation(attestation)) fields.attestation = attestation;
  if (excludeCredentials !== undefined) {
    fields.excludeCredentials = EffectArray.map(excludeCredentials, decodeDescriptor);
  }
  if (extensions !== undefined) fields.extensions = decodeExtensions(extensions);
  return fields;
};

const toRequestOptions = (
  options: PublicKeyCredentialRequestOptionsJSON,
  pkc: NonNullable<WebCredentialsEnv["PublicKeyCredential"]>,
): PublicKeyCredentialRequestOptions => {
  if (pkc.parseRequestOptionsFromJSON !== undefined)
    return pkc.parseRequestOptionsFromJSON(options);
  const { userVerification, allowCredentials, extensions, ...rest } = options;
  const fields: PublicKeyCredentialRequestOptions = {
    ...rest,
    challenge: base64UrlToBytes(options.challenge),
  };
  if (isVerification(userVerification)) fields.userVerification = userVerification;
  if (allowCredentials !== undefined)
    fields.allowCredentials = EffectArray.map(allowCredentials, decodeDescriptor);
  if (extensions !== undefined) fields.extensions = decodeExtensions(extensions);
  return fields;
};

const isAttestation = Schema.is(Schema.Literals(["direct", "enterprise", "indirect", "none"]));
const isVerification = Schema.is(Schema.Literals(["required", "preferred", "discouraged"]));
const arrayBuffer = Schema.instanceOf(ArrayBuffer);
const isArrayBuffer = Schema.is(arrayBuffer);
const isMethod = Schema.is(Schema.instanceOf(globalThis.Function));
const isCredential = Schema.is(
  Schema.Struct({
    rawId: arrayBuffer,
    response: Schema.Struct({ clientDataJSON: arrayBuffer }),
    authenticatorAttachment: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  }),
);
const isAttestationResponse = Schema.is(
  Schema.Struct({
    clientDataJSON: arrayBuffer,
    attestationObject: arrayBuffer,
  }),
);
const isAssertionResponse = Schema.is(
  Schema.Struct({
    clientDataJSON: arrayBuffer,
    authenticatorData: arrayBuffer,
    signature: arrayBuffer,
    userHandle: arrayBuffer.pipe(Schema.NullOr, Schema.optionalKey),
  }),
);
const isTransports = Schema.is(Schema.Array(Schema.String));
const isAlgorithm = Schema.is(Schema.Finite);

const invokeOptional = (input: Credential | AuthenticatorResponse, key: string): unknown => {
  const method: unknown = Reflect.get(input, key);
  return isMethod(method) ? Reflect.apply(method, input, []) : undefined;
};

const serializeAttestation = (response: AuthenticatorResponse): typeof JsonObject.Type | null => {
  if (!isAttestationResponse(response)) return null;
  const transports = invokeOptional(response, "getTransports");
  const authData = invokeOptional(response, "getAuthenticatorData");
  const pubKey = invokeOptional(response, "getPublicKey");
  const pubKeyAlg = invokeOptional(response, "getPublicKeyAlgorithm");
  const fields = {
    clientDataJSON: bytesToBase64Url(response.clientDataJSON),
    attestationObject: bytesToBase64Url(response.attestationObject),
  };
  if (isArrayBuffer(authData))
    Object.assign(fields, { authenticatorData: bytesToBase64Url(authData) });
  if (isTransports(transports)) Object.assign(fields, { transports });
  if (isAlgorithm(pubKeyAlg)) Object.assign(fields, { publicKeyAlgorithm: pubKeyAlg });
  if (isArrayBuffer(pubKey)) Object.assign(fields, { publicKey: bytesToBase64Url(pubKey) });
  return fields;
};

const serializeAssertion = (response: AuthenticatorResponse): typeof JsonObject.Type | null => {
  if (!isAssertionResponse(response)) return null;
  const fields = {
    clientDataJSON: bytesToBase64Url(response.clientDataJSON),
    authenticatorData: bytesToBase64Url(response.authenticatorData),
    signature: bytesToBase64Url(response.signature),
  };
  return isArrayBuffer(response.userHandle)
    ? { ...fields, userHandle: bytesToBase64Url(response.userHandle) }
    : fields;
};

const serialize = (
  credential: Credential,
  kind: "create" | "get",
): typeof JsonObject.Type | null => {
  const json = invokeOptional(credential, "toJSON");
  if (json !== undefined) return isJsonObject(json) ? json : null;
  if (!isCredential(credential)) return null;
  const response =
    kind === "create"
      ? serializeAttestation(credential.response)
      : serializeAssertion(credential.response);
  if (response === null) return null;
  const fields = {
    id: credential.id,
    type: credential.type,
    rawId: bytesToBase64Url(credential.rawId),
    clientExtensionResults: invokeOptional(credential, "getClientExtensionResults") ?? {},
    response,
  };
  if (
    credential.authenticatorAttachment !== undefined &&
    credential.authenticatorAttachment !== null
  ) {
    return { ...fields, authenticatorAttachment: credential.authenticatorAttachment };
  }
  return fields;
};

const defaultEnv = (): WebCredentialsEnv => ({
  credentials: globalThis.navigator?.credentials,
  PublicKeyCredential: globalThis.PublicKeyCredential,
});

const availability = Effect.fn("WebPasskeys.availability")(function* (env: WebCredentialsEnv) {
  const { credentials, PublicKeyCredential: pkc } = env;
  if (credentials === undefined || pkc === undefined) return "unavailable" as const;
  const verify = pkc.isUserVerifyingPlatformAuthenticatorAvailable;
  if (verify === undefined) return "hybrid_only" as const;
  const available = yield* fromMobilePromise(() => verify.call(pkc));
  return available ? ("available" as const) : ("hybrid_only" as const);
});

const prompt = Effect.fn("WebPasskeys.prompt")(function* (
  kind: "create" | "get",
  options: typeof JsonObject.Type,
  env: WebCredentialsEnv,
): Effect.fn.Return<PasskeyOutcome<typeof JsonObject.Type>, never> {
  const { credentials, PublicKeyCredential: pkc } = env;
  if (credentials === undefined || pkc === undefined) {
    return { _tag: "Failed", message: "passkeys unavailable" };
  }
  if (kind === "create") {
    return yield* decodeCreationOptions(options).pipe(
      Effect.flatMap((decoded) =>
        fromMobilePromise(() =>
          credentials.create({ publicKey: toCreationOptions({ ...options, ...decoded }, pkc) }),
        ),
      ),
      Effect.flatMap((credential) => outcome(credential, kind)),
      Effect.catch((error) => {
        const result = failure(error);
        return Effect.succeed(result);
      }),
    );
  }
  return yield* decodeRequestOptions(options).pipe(
    Effect.flatMap((decoded) =>
      fromMobilePromise(() =>
        credentials.get({ publicKey: toRequestOptions({ ...options, ...decoded }, pkc) }),
      ),
    ),
    Effect.flatMap((credential) => outcome(credential, kind)),
    Effect.catch((error) => {
      const result = failure(error);
      return Effect.succeed(result);
    }),
  );
});

const outcome = (credential: Credential | null, kind: "create" | "get") =>
  tryPlatform((): PasskeyOutcome<typeof JsonObject.Type> => {
    if (credential === null) return { _tag: "Cancelled" };
    const result = serialize(credential, kind);
    return result === null
      ? { _tag: "Failed", message: "invalid passkey response" }
      : { _tag: "Ok", value: result };
  });

const failure = (error: {
  readonly cause?: unknown;
  readonly message: string;
}): PasskeyOutcome<typeof JsonObject.Type> => {
  const classified = classifyWebPasskeyError(error.cause ?? error);
  return classified.kind === "cancelled"
    ? { _tag: "Cancelled" }
    : { _tag: "Failed", message: classified.message };
};

export const makeWebPasskeyBridge = (
  getEnv: () => WebCredentialsEnv = defaultEnv,
): PasskeyBridge => {
  const env = tryPlatform(getEnv);
  return {
    availability: () =>
      runMobileEffect(
        env.pipe(
          Effect.flatMap((resolved) =>
            availability(resolved).pipe(
              Effect.orElseSucceed((): PasskeyAvailability => "hybrid_only"),
            ),
          ),
        ),
      ),
    create: (options) =>
      runMobileEffect(env.pipe(Effect.flatMap((resolved) => prompt("create", options, resolved)))),
    get: (options) =>
      runMobileEffect(env.pipe(Effect.flatMap((resolved) => prompt("get", options, resolved)))),
  };
};

export const passkeyBridge: PasskeyBridge = makeWebPasskeyBridge();
