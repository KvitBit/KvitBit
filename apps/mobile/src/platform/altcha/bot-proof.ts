import * as FetchHttpClient from "effect/http/FetchHttpClient";
/**
 * BotProof (ui-port-contracts 3, 5.2; ADR 0002): fetch an ALTCHA PoW v2 challenge and solve it in
 * pure TS, yielding to the JS thread between chunks. The payload is the base64 `X-Altcha` value.
 */

import { type BotScope, RateLimited } from "@kvitbit/api-contract";
import { Unavailable } from "@kvitbit/domain/contract";
import { UiError } from "@kvitbit/ui-port/api";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { fromMobilePromise, runMobileEffect } from "../../runtime/request-intent";
import { tryPlatform } from "../platform-effect";
import { argon2id, bytesToHex, hexToBytes, pbkdf2Sha256, sha256, utf8ToBase64 } from "./kdf";

export type BotProofState =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "Fetching" }
  | { readonly _tag: "Solving"; readonly progress: number } // 0..1
  | { readonly _tag: "Solved"; readonly payload: string; readonly expiresAt: string | null }
  | { readonly _tag: "Failed"; readonly error: UiError };

export type FetchedChallenge =
  | { readonly _tag: "NotRequired" } // 204
  | { readonly _tag: "Challenge"; readonly challenge: ChallengeJson }
  | { readonly _tag: "Err"; readonly error: UiError };

export interface SolveOptions {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
}

export type SolveOutcome =
  | { readonly _tag: "Solved"; readonly payload: string; readonly expiresAt: string | null }
  | { readonly _tag: "Aborted" }
  | { readonly _tag: "Err"; readonly error: UiError };

const Challenge = Schema.StructWithRest(
  Schema.Struct({ parameters: Schema.Record(Schema.String, Schema.Unknown) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
type ChallengeJson = typeof Challenge.Type;
const isChallenge = Schema.is(Challenge);
const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const RetryAfter = Schema.Struct({
  retryAfterSeconds: Schema.Finite.check(Schema.isGreaterThan(0)),
});
const isRetryAfter = Schema.is(RetryAfter);

const parseRetryAfter = (header: string | null, body: typeof RetryAfter.Type | null): number => {
  if (body !== null) return Math.ceil(body.retryAfterSeconds);
  if (header !== null) {
    const parsed = Number.parseInt(header, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5;
};

/** Returns true when `expiresAt` (ISO timestamp) is within `marginMs` of `now` (epoch ms). */
export const isExpired: {
  (now: number, marginMs?: number): (expiresAt: string | null) => boolean;
  (expiresAt: string | null, now: number, marginMs?: number): boolean;
} = Fn.dual(
  (args) => !Predicate.isNumber(args[0]),
  (expiresAt: string | null, now: number, marginMs = 10_000): boolean => {
    if (expiresAt === null) return false;
    const time = DateTime.make(expiresAt);
    return Option.isNone(time) || DateTime.toEpochMillis(time.value) - marginMs <= now;
  },
);

const trailingSlash = /\/$/;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const fetchProof = Effect.fn("BotProof.fetch")(function* (
  origin: string,
  scope: BotScope,
  fetchImpl?: Fetch,
): Effect.fn.Return<FetchedChallenge, never> {
  const url = `${EffectString.replace(trailingSlash, "")(origin)}/api/v1/bot-protection/challenges/${encodeURIComponent(scope)}`;
  const fetch = fetchImpl ?? (yield* FetchHttpClient.Fetch);
  const response = yield* fromMobilePromise(() =>
    fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
    }),
  ).pipe(Effect.option);
  if (Option.isNone(response)) return { _tag: "Err", error: UiError.offline };
  return yield* readChallenge(response.value);
});

const readChallenge = Effect.fn("BotProof.readChallenge")(function* (
  response: Response,
): Effect.fn.Return<FetchedChallenge, never> {
  if (response.status === 204) return { _tag: "NotRequired" };
  const text = yield* fromMobilePromise(() => response.text()).pipe(Effect.orElseSucceed(() => ""));
  const body = Option.getOrNull(decodeJson(text));

  if (response.ok) {
    if (!isChallenge(body)) {
      return {
        _tag: "Err",
        error: UiError.unexpected(response.status, response.headers.get("x-request-id")),
      };
    }
    return { _tag: "Challenge", challenge: body };
  }

  const retryAfter = isRetryAfter(body) ? body : null;
  if (response.status === 429) {
    return {
      _tag: "Err",
      error: RateLimited.make({
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), retryAfter),
      }),
    };
  }
  if (response.status === 503) {
    return {
      _tag: "Err",
      error: Unavailable.make({
        dependency: "database",
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), retryAfter),
      }),
    };
  }
  return {
    _tag: "Err",
    error: UiError.unexpected(response.status, response.headers.get("x-request-id")),
  };
});

/** GET {origin}/api/v1/bot-protection/challenges/{scope}. */
export const fetchChallenge: {
  (scope: BotScope, fetchImpl?: Fetch): (origin: string) => Promise<FetchedChallenge>;
  (origin: string, scope: BotScope, fetchImpl?: Fetch): Promise<FetchedChallenge>;
} = Fn.dual(
  (args) => Predicate.isString(args[1]),
  (origin: string, scope: BotScope, fetchImpl?: Fetch) =>
    runMobileEffect(fetchProof(origin, scope, fetchImpl)),
);

interface ParsedParameters {
  readonly algorithm: "ARGON2ID" | "PBKDF2/SHA-256" | "SHA-256";
  readonly nonce: Uint8Array;
  readonly salt: Uint8Array;
  readonly cost: number;
  readonly keyLength: number;
  readonly memoryCost: number;
  readonly parallelism: number;
  readonly keyPrefix: string;
  readonly expiresAt: string | null;
}

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const hexPrefix = /^[0-9a-fA-F]+$/;
const Parameters = Schema.Struct({
  algorithm: Schema.Literals(["ARGON2ID", "PBKDF2/SHA-256", "SHA-256"]),
  nonce: Schema.NonEmptyString,
  salt: Schema.NonEmptyString,
  cost: positiveInt,
  keyLength: Schema.optionalKey(positiveInt),
  keyPrefix: Schema.String.check(Schema.isPattern(hexPrefix)),
  memoryCost: Schema.optionalKey(Schema.Unknown),
  parallelism: Schema.optionalKey(Schema.Unknown),
  expiresAt: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
});
const decodeParameters = Schema.decodeUnknownOption(Parameters);
const decodeParallelism = Schema.decodeUnknownOption(positiveInt);
const decodeMemoryCost = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(8)),
);

const parseParameters = (challenge: ChallengeJson): ParsedParameters | null => {
  const decoded = decodeParameters(challenge.parameters);
  if (Option.isNone(decoded)) return null;
  const params = decoded.value;
  const nonce = hexToBytes(params.nonce);
  const salt = hexToBytes(params.salt);
  if (nonce === null || salt === null || nonce.length === 0 || salt.length === 0) return null;

  const keyLength = params.keyLength ?? 32;
  if (params.keyPrefix.length > keyLength * 2) return null;
  const memory =
    params.algorithm === "ARGON2ID" ? decodeMemoryCost(params.memoryCost) : Option.some(0);
  if (Option.isNone(memory)) return null;
  const expiry =
    params.expiresAt === undefined
      ? Option.some(null)
      : DateTime.make(params.expiresAt * 1000).pipe(Option.map(DateTime.formatIso));
  if (Option.isNone(expiry)) return null;

  return {
    algorithm: params.algorithm,
    nonce,
    salt,
    cost: params.cost,
    keyLength,
    memoryCost: memory.value,
    parallelism: Option.getOrElse(decodeParallelism(params.parallelism), () => 1),
    keyPrefix: EffectString.toLowerCase(params.keyPrefix),
    expiresAt: expiry.value,
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

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const solve = Effect.fn("BotProof.solve")(function* (
  challenge: ChallengeJson,
  options?: SolveOptions,
): Effect.fn.Return<SolveOutcome, never> {
  const aborted = () => options?.signal?.aborted === true;
  if (aborted()) return { _tag: "Aborted" };

  const parsed = parseParameters(challenge);
  if (parsed === null) return { _tag: "Err", error: UiError.unexpected() };

  const password = new Uint8Array(parsed.nonce.length + 4);
  password.set(parsed.nonce, 0);
  const passwordView = new DataView(password.buffer);
  const expectedAttempts = Math.max(1, 16 ** parsed.keyPrefix.length);
  const chunkSize = parsed.algorithm === "ARGON2ID" ? 1 : 8;
  const startedAt = yield* Clock.currentTimeMillis;
  const maxCounter = 0xffffffff;

  for (let counter = 0; counter <= maxCounter; counter++) {
    if (aborted()) return { _tag: "Aborted" };
    passwordView.setUint32(parsed.nonce.length, counter, false);

    const derived = yield* derive(password, parsed).pipe(Effect.option);
    if (Option.isNone(derived)) return { _tag: "Err", error: UiError.unexpected() };
    const derivedHex = bytesToHex(derived.value);
    if (EffectString.startsWith(parsed.keyPrefix)(derivedHex)) {
      options?.onProgress?.(1);
      const now = yield* Clock.currentTimeMillis;
      const encoded = yield* encodePayload({
        challenge,
        solution: { counter, derivedKey: derivedHex, time: Math.max(0, now - startedAt) },
      }).pipe(Effect.option);
      if (Option.isNone(encoded)) return { _tag: "Err", error: UiError.unexpected() };
      return { _tag: "Solved", payload: utf8ToBase64(encoded.value), expiresAt: parsed.expiresAt };
    }

    const attempts = counter + 1;
    if (attempts % chunkSize === 0) {
      options?.onProgress?.(Math.min(0.99, 1 - Math.exp(-attempts / expectedAttempts)));
      yield* Effect.sleep(1);
    }
  }

  return { _tag: "Err", error: UiError.unexpected() };
});

const derive = Effect.fn("BotProof.derive")(function* (
  password: Uint8Array<ArrayBuffer>,
  params: ParsedParameters,
) {
  if (params.algorithm === "PBKDF2/SHA-256") {
    return yield* fromMobilePromise(() =>
      pbkdf2Sha256(password, params.salt, params.cost, params.keyLength),
    );
  }
  return yield* tryPlatform(() =>
    params.algorithm === "ARGON2ID"
      ? argon2id(password, params.salt, params)
      : deriveSha256(params.salt, password, params.cost, params.keyLength),
  );
});

/** Solve a fetched ALTCHA PoW v2 challenge in pure TS, yielding between chunks. */
export const solveChallenge = ({
  challenge,
  ...options
}: SolveOptions & { readonly challenge: ChallengeJson }) =>
  runMobileEffect(solve(challenge, options));
