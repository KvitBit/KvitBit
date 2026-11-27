import { AltchaChallenge } from "@kvitbit/api-contract";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  argon2id,
  bytesToHex,
  hexToBytes,
  pbkdf2Sha256,
  sha256,
  utf8ToBase64,
} from "./_altcha_kdf";

const isRecord = Schema.is(Schema.JsonObject);
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Finite);
const isAlgorithm = Schema.is(Schema.Literals(["ARGON2ID", "PBKDF2/SHA-256", "SHA-256"]));

export class AltchaSolveError extends Schema.TaggedError<
  AltchaSolveError,
  { readonly brand: unique symbol }
>()("AltchaSolveError", {
  reason: Schema.String,
}) {}

interface ParsedParameters {
  readonly algorithm: "ARGON2ID" | "PBKDF2/SHA-256" | "SHA-256";
  readonly nonce: Uint8Array;
  readonly salt: Uint8Array;
  readonly cost: number;
  readonly keyLength: number;
  readonly memoryCost: number;
  readonly parallelism: number;
  readonly keyPrefix: string;
}

const toBytesOrUtf8 = (value: string): Uint8Array =>
  hexToBytes(value) ?? new TextEncoder().encode(value);

const parseParameters = (challenge: AltchaChallenge): ParsedParameters | AltchaSolveError => {
  const nested = isRecord(challenge.parameters) ? challenge.parameters : challenge;
  const rawAlgo = isString(nested.algorithm) ? nested.algorithm : "ARGON2ID";
  if (!isAlgorithm(rawAlgo)) {
    return AltchaSolveError.make({ reason: `Unsupported ALTCHA algorithm: ${rawAlgo}` });
  }
  const nonceStr = isString(nested.nonce) ? nested.nonce : "";
  const saltStr = isString(nested.salt) ? nested.salt : nonceStr;
  if (nonceStr === "" || saltStr === "") {
    return AltchaSolveError.make({ reason: "Malformed ALTCHA challenge: missing nonce or salt" });
  }
  const nonce = toBytesOrUtf8(nonceStr);
  const salt = toBytesOrUtf8(saltStr);
  const cost = isNumber(nested.cost) && nested.cost >= 1 ? Math.trunc(nested.cost) : 1;
  const keyLength =
    isNumber(nested.keyLength) && nested.keyLength >= 1 ? Math.trunc(nested.keyLength) : 32;
  const memoryCost =
    isNumber(nested.memoryCost) && nested.memoryCost >= 8 ? Math.trunc(nested.memoryCost) : 19_456;
  const parallelism =
    isNumber(nested.parallelism) && nested.parallelism >= 1 ? Math.trunc(nested.parallelism) : 1;
  const keyPrefix = Str.toLowerCase(isString(nested.keyPrefix) ? nested.keyPrefix : "0");
  return {
    algorithm: rawAlgo,
    nonce,
    salt,
    cost,
    keyLength,
    memoryCost,
    parallelism,
    keyPrefix,
  };
};

const deriveSha256 = (
  salt: Uint8Array,
  password: Uint8Array,
  cost: number,
  keyLength: number,
): Uint8Array => {
  const first = new Uint8Array(salt.length + password.length);
  first.set(salt, 0);
  first.set(password, salt.length);
  let digest = sha256(first);
  for (let i = 1; i < cost; i++) digest = sha256(digest);
  return digest.subarray(0, keyLength);
};

const ProofJson = Schema.fromJsonString(
  Schema.Struct({
    challenge: AltchaChallenge,
    solution: Schema.Struct({ counter: Schema.Int, derivedKey: Schema.String, time: Schema.Int }),
  }),
);

/**
 * Solves an ALTCHA PoW v2 challenge on-device and returns the base64 `X-Altcha` header value.
 * Matches `altcha-lib` for ARGON2ID, PBKDF2/SHA-256, and SHA-256.
 */
export const solveAltchaChallenge = Effect.fn("solveAltchaChallenge")(function* (
  challenge: AltchaChallenge,
) {
  const params = parseParameters(challenge);
  if ("reason" in params) return yield* params;
  const password = new Uint8Array(params.nonce.length + 4);
  password.set(params.nonce, 0);
  const passwordView = new DataView(password.buffer);
  const chunkSize = params.algorithm === "ARGON2ID" ? 1 : 8;
  const maxAttempts = 50_000;
  const started = yield* Clock.currentTimeMillis;

  for (let counter = 0; counter < maxAttempts; counter++) {
    passwordView.setUint32(params.nonce.length, counter, false);
    const derived =
      params.algorithm === "ARGON2ID"
        ? argon2id(password, params.salt, {
            memoryCost: params.memoryCost,
            cost: params.cost,
            parallelism: params.parallelism,
            keyLength: params.keyLength,
          })
        : params.algorithm === "PBKDF2/SHA-256"
          ? yield* pbkdf2Sha256({
              password,
              salt: params.salt,
              iterations: params.cost,
              keyLength: params.keyLength,
            })
          : deriveSha256(params.salt, password, params.cost, params.keyLength);

    const derivedKey = bytesToHex(derived);
    if (Str.startsWith(params.keyPrefix)(derivedKey)) {
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      const payload = {
        challenge,
        solution: {
          counter,
          derivedKey,
          time: Math.max(0, elapsed),
        },
      };
      return yield* Schema.encodeEffect(ProofJson)(payload).pipe(Effect.map(utf8ToBase64));
    }

    if ((counter + 1) % chunkSize === 0) {
      yield* Effect.sleep(1);
    }
  }
  return yield* AltchaSolveError.make({ reason: "Unable to complete verification challenge" });
});
