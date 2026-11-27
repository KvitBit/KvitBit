import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { sendAuthRequest } from "./api";

/** Browser ceremonies for the pinned Better Auth passkey endpoints. */

const opt = Schema.optionalKey;
const verification = Schema.Literals(["discouraged", "preferred", "required"]);
const isBrowserTransport = Schema.is(Schema.Literals(["ble", "hybrid", "internal", "nfc", "usb"]));
const descriptor = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("public-key"),
  transports: Schema.String.pipe(Schema.Array, Schema.mutable, opt),
});
const prfValues = Schema.Struct({
  first: Schema.String,
  second: opt(Schema.String),
});
const ExtensionOptions = Schema.Struct({
  appid: opt(Schema.String),
  credProps: opt(Schema.Boolean),
  largeBlob: opt(
    Schema.Struct({
      read: opt(Schema.Boolean),
      support: opt(Schema.String),
      write: opt(Schema.String),
    }),
  ),
  prf: opt(
    Schema.Struct({
      eval: opt(prfValues),
      evalByCredential: opt(Schema.Record(Schema.String, prfValues)),
    }),
  ),
});
const RequestOptions = Schema.Struct({
  challenge: Schema.String,
  timeout: opt(Schema.Finite),
  rpId: opt(Schema.String),
  userVerification: opt(verification),
  allowCredentials: descriptor.pipe(Schema.Array, Schema.mutable, opt),
  extensions: opt(ExtensionOptions),
  hints: Schema.String.pipe(Schema.Array, Schema.mutable, opt),
});
const CreationOptions = Schema.Struct({
  challenge: Schema.String,
  timeout: opt(Schema.Finite),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  rp: Schema.Struct({ id: opt(Schema.String), name: Schema.String }),
  pubKeyCredParams: Schema.Struct({
    type: Schema.Literal("public-key"),
    alg: Schema.Int,
  }).pipe(Schema.Array, Schema.mutable),
  attestation: opt(Schema.Literals(["direct", "enterprise", "indirect", "none"])),
  authenticatorSelection: opt(
    Schema.Struct({
      authenticatorAttachment: opt(Schema.Literals(["platform", "cross-platform"])),
      requireResidentKey: opt(Schema.Boolean),
      residentKey: opt(verification),
      userVerification: opt(verification),
    }),
  ),
  excludeCredentials: descriptor.pipe(Schema.Array, Schema.mutable, opt),
  extensions: opt(ExtensionOptions),
  hints: Schema.String.pipe(Schema.Array, Schema.mutable, opt),
});

class PasskeyError extends Schema.TaggedError<PasskeyError, { readonly brand: unique symbol }>()(
  "PasskeyError",
  {
    operation: Schema.String,
  },
) {}

const decodeBase64Url = (value: string): ArrayBuffer => {
  const binary = globalThis.atob(Str.replaceAll("_", "/")(Str.replaceAll("-", "+")(value)));
  return Uint8Array.from(binary, (character) =>
    Option.getOrElse(Str.charCodeAt(character, 0), () => Number.NaN),
  ).buffer;
};

const padding = /[=]+$/;
const encodeBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = Array.from(new Uint8Array(buffer), (byte) => String.fromCharCode(byte));
  return Fn.pipe(
    globalThis.btoa(Arr.join(bytes, "")),
    Str.replaceAll("+", "-"),
    Str.replaceAll("/", "_"),
    Str.replace(padding, ""),
  );
};

const decodeDescriptor = ({
  id,
  transports,
}: typeof descriptor.Type): PublicKeyCredentialDescriptor => {
  const result: PublicKeyCredentialDescriptor = { type: "public-key", id: decodeBase64Url(id) };
  if (transports !== undefined) result.transports = Arr.filter(transports, isBrowserTransport);
  return result;
};

const decodePrfValues = ({ first, second }: typeof prfValues.Type) => {
  const values: AuthenticationExtensionsPRFValues = { first: decodeBase64Url(first) };
  if (second !== undefined) values.second = decodeBase64Url(second);
  return values;
};

const decodeExtensions = ({
  largeBlob,
  prf,
  ...rest
}: typeof ExtensionOptions.Type): AuthenticationExtensionsClientInputs => {
  const decoded: AuthenticationExtensionsClientInputs = rest;
  if (largeBlob !== undefined) {
    const { write, ...other } = largeBlob;
    decoded.largeBlob = other;
    if (write !== undefined) decoded.largeBlob.write = decodeBase64Url(write);
  }
  if (prf !== undefined) {
    decoded.prf = {};
    if (prf.eval !== undefined) decoded.prf.eval = decodePrfValues(prf.eval);
    if (prf.evalByCredential !== undefined) {
      decoded.prf.evalByCredential = EffectRecord.map(prf.evalByCredential, decodePrfValues);
    }
  }
  return decoded;
};

const toRequestOptions = (
  options: typeof RequestOptions.Type,
): PublicKeyCredentialRequestOptions => {
  if (PublicKeyCredential.parseRequestOptionsFromJSON !== undefined) {
    return PublicKeyCredential.parseRequestOptionsFromJSON(options);
  }
  const { challenge, allowCredentials, extensions, ...rest } = options;
  const decoded: PublicKeyCredentialRequestOptions = {
    ...rest,
    challenge: decodeBase64Url(challenge),
  };
  if (extensions !== undefined) decoded.extensions = decodeExtensions(extensions);
  if (allowCredentials !== undefined)
    decoded.allowCredentials = Arr.map(allowCredentials, decodeDescriptor);
  return decoded;
};

const toCreationOptions = (
  options: typeof CreationOptions.Type,
): PublicKeyCredentialCreationOptions => {
  if (PublicKeyCredential.parseCreationOptionsFromJSON !== undefined) {
    return PublicKeyCredential.parseCreationOptionsFromJSON(options);
  }
  const { challenge, user, excludeCredentials, extensions, ...rest } = options;
  const decoded: PublicKeyCredentialCreationOptions = {
    ...rest,
    challenge: decodeBase64Url(challenge),
    user: { ...user, id: decodeBase64Url(user.id) },
  };
  if (extensions !== undefined) decoded.extensions = decodeExtensions(extensions);
  if (excludeCredentials !== undefined)
    decoded.excludeCredentials = Arr.map(excludeCredentials, decodeDescriptor);
  return decoded;
};

const encodeCredential = Schema.decodeUnknownEffect(Schema.JsonObject);

const credentialJson = (
  credential: PublicKeyCredential,
  encodeResponse: () => Schema.JsonObject,
) => {
  if (credential.toJSON !== undefined) {
    const { clientExtensionResults: _extensions, ...response } = credential.toJSON();
    return encodeCredential(response);
  }
  const result = {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    response: encodeResponse(),
    type: credential.type,
  };
  return Effect.succeed(
    credential.authenticatorAttachment === null
      ? result
      : { ...result, authenticatorAttachment: credential.authenticatorAttachment },
  );
};

const decodeRequest = Schema.decodeUnknownEffect(RequestOptions);
const decodeCreation = Schema.decodeUnknownEffect(CreationOptions);

export const performPasskeyAuthentication = Effect.gen(function* () {
  if (
    globalThis.PublicKeyCredential === undefined ||
    globalThis.navigator?.credentials === undefined
  ) {
    return { supported: false } as const;
  }
  const options = yield* sendAuthRequest({ path: "/passkey/generate-authenticate-options" }).pipe(
    Effect.flatMap(decodeRequest),
  );
  const credential = yield* Effect.tryPromise({
    try: (signal) => navigator.credentials.get({ publicKey: toRequestOptions(options), signal }),
    catch: () => PasskeyError.make({ operation: "authenticate" }),
  });
  if (
    !(
      credential instanceof PublicKeyCredential &&
      credential.response instanceof AuthenticatorAssertionResponse
    )
  ) {
    return yield* PasskeyError.make({ operation: "read assertion" });
  }
  const assertion = credential.response;
  const response = yield* credentialJson(credential, () => {
    const result = {
      authenticatorData: encodeBase64Url(assertion.authenticatorData),
      clientDataJSON: encodeBase64Url(assertion.clientDataJSON),
      signature: encodeBase64Url(assertion.signature),
    };
    return assertion.userHandle === null
      ? result
      : { ...result, userHandle: encodeBase64Url(assertion.userHandle) };
  });
  yield* sendAuthRequest({
    path: "/passkey/verify-authentication",
    method: "POST",
    body: { response },
  });
  return { supported: true } as const;
});

export const performPasskeyRegistration = Effect.fn("performPasskeyRegistration")(function* (
  name: string,
) {
  if (
    globalThis.PublicKeyCredential === undefined ||
    globalThis.navigator?.credentials === undefined
  ) {
    return { supported: false } as const;
  }
  const trimmedName = Str.trim(name);
  const query = trimmedName === "" ? "" : `?${new URLSearchParams({ name: trimmedName })}`;
  const options = yield* sendAuthRequest({
    path: `/passkey/generate-register-options${query}`,
  }).pipe(Effect.flatMap(decodeCreation));
  const credential = yield* Effect.tryPromise({
    try: (signal) =>
      navigator.credentials.create({ publicKey: toCreationOptions(options), signal }),
    catch: () => PasskeyError.make({ operation: "register" }),
  });
  if (
    !(
      credential instanceof PublicKeyCredential &&
      credential.response instanceof AuthenticatorAttestationResponse
    )
  ) {
    return yield* PasskeyError.make({ operation: "read attestation" });
  }
  const attestation = credential.response;
  const response = yield* credentialJson(credential, () => {
    const result = {
      attestationObject: encodeBase64Url(attestation.attestationObject),
      clientDataJSON: encodeBase64Url(attestation.clientDataJSON),
    };
    const transports = attestation.getTransports?.();
    return transports === undefined ? result : { ...result, transports };
  });
  const body = trimmedName === "" ? { response } : { response, name: trimmedName };
  yield* sendAuthRequest({ path: "/passkey/verify-registration", method: "POST", body });
  return { supported: true } as const;
});
