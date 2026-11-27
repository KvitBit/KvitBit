import * as Schema from "effect/Schema";
import type { JsonObject } from "./passkey-bridge";

const UserVerification = Schema.Literals(["required", "preferred", "discouraged"]);
const Transport = Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const Descriptor = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("public-key"),
  transports: Schema.optionalKey(Transport.pipe(Schema.Array, Schema.mutable)),
});
const PrfValues = Schema.Struct({
  first: Schema.String,
  second: Schema.optionalKey(Schema.String),
});
const Extensions = Schema.Struct({
  appid: Schema.optionalKey(Schema.String),
  credProps: Schema.optionalKey(Schema.Boolean),
  largeBlob: Schema.optionalKey(
    Schema.Struct({
      support: Schema.optionalKey(Schema.Literals(["preferred", "required"])),
      read: Schema.optionalKey(Schema.Boolean),
      write: Schema.optionalKey(Schema.String),
    }),
  ),
  prf: Schema.optionalKey(
    Schema.Struct({
      eval: Schema.optionalKey(PrfValues),
      evalByCredential: Schema.optionalKey(Schema.Record(Schema.String, PrfValues)),
    }),
  ),
});
const common = {
  challenge: Schema.String,
  timeout: Schema.optionalKey(Schema.Finite),
  extensions: Schema.optionalKey(Extensions),
  hints: Schema.optionalKey(Schema.String.pipe(Schema.Array, Schema.mutable)),
};

const CreationOptions = Schema.Struct({
  ...common,
  rp: Schema.Struct({ name: Schema.String, id: Schema.optionalKey(Schema.String) }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  pubKeyCredParams: Schema.Struct({ alg: Schema.Finite, type: Schema.Literal("public-key") }).pipe(
    Schema.Array,
    Schema.mutable,
  ),
  excludeCredentials: Schema.optionalKey(Descriptor.pipe(Schema.Array, Schema.mutable)),
  authenticatorSelection: Schema.optionalKey(
    Schema.Struct({
      authenticatorAttachment: Schema.optionalKey(Schema.Literals(["platform", "cross-platform"])),
      requireResidentKey: Schema.optionalKey(Schema.Boolean),
      residentKey: Schema.optionalKey(UserVerification),
      userVerification: Schema.optionalKey(UserVerification),
    }),
  ),
  attestation: Schema.optionalKey(Schema.Literals(["direct", "enterprise", "indirect", "none"])),
});
const RequestOptions = Schema.Struct({
  ...common,
  rpId: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Descriptor.pipe(Schema.Array, Schema.mutable)),
  userVerification: Schema.optionalKey(UserVerification),
});

const decodeCreation = Schema.decodeUnknownEffect(CreationOptions);
const decodeRequest = Schema.decodeUnknownEffect(RequestOptions);

export const decodeCreationOptions = (options: typeof CreationOptions.Encoded | JsonObject) =>
  decodeCreation(options);

export const decodeRequestOptions = (options: typeof RequestOptions.Encoded | JsonObject) =>
  decodeRequest(options);
