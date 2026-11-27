/**
 * BotProof (ui-port-contracts 3, 5.2; ADR 0002): fetch an ALTCHA PoW v2 challenge and solve it in
 * pure TS, yielding to the JS thread between chunks. The payload is the base64 `X-Altcha` value.
 */
import { type BotScope, RateLimited } from "@kvitbit/api-contract";
import { Unavailable } from "@kvitbit/domain/contract";
import { UiError } from "@kvitbit/ui-port/api";
import { bytesToHex, createArgon2id, hexToBytes, pbkdf2Sha256, sha256, utf8ToBase64 } from "./kdf";

export type BotProofState =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "Fetching" }
  | { readonly _tag: "Solving"; readonly progress: number } // 0..1
  | { readonly _tag: "Solved"; readonly payload: string; readonly expiresAt: string | null }
  | { readonly _tag: "Failed"; readonly error: UiError };

export type FetchedChallenge =
  | { readonly _tag: "NotRequired" } // 204
  | { readonly _tag: "Challenge"; readonly challenge: { readonly [key: string]: unknown } }
  | { readonly _tag: "Err"; readonly error: UiError };

export interface SolveOptions {
  readonly onProgress?: (progress: number) => void;
  readonly signal?: AbortSignal;
}

export type SolveOutcome =
  | { readonly _tag: "Solved"; readonly payload: string; readonly expiresAt: string | null }
  | { readonly _tag: "Aborted" }
  | { readonly _tag: "Err"; readonly error: UiError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRetryAfter = (header: string | null, body: unknown): number => {
  if (isRecord(body) && typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0) {
    return Math.ceil(body.retryAfterSeconds);
  }
  if (header !== null) {
    const parsed = Number.parseInt(header, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5;
};

/** Returns true when `expiresAt` (ISO timestamp) is within `marginMs` of `now` (epoch ms). */
export const isExpired = (expiresAt: string | null, now: number, marginMs = 10_000): boolean => {
  if (expiresAt === null) return false;
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || ms - marginMs <= now;
};

/** GET {origin}/api/v1/bot-protection/challenges/{scope}. */
export const fetchChallenge = async (
  origin: string,
  scope: BotScope,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): Promise<FetchedChallenge> => {
  const url = `${origin.replace(/\/$/, "")}/api/v1/bot-protection/challenges/${encodeURIComponent(scope)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
    });
  } catch {
    return { _tag: "Err", error: UiError.offline };
  }
  if (response.status === 204) return { _tag: "NotRequired" };

  let body: unknown = null;
  try {
    const text = await response.text();
    if (text.length > 0) body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (response.ok) {
    if (!isRecord(body) || !isRecord(body.parameters)) {
      return {
        _tag: "Err",
        error: UiError.unexpected(response.status, response.headers.get("x-request-id")),
      };
    }
    return { _tag: "Challenge", challenge: body };
  }

  if (response.status === 429) {
    return {
      _tag: "Err",
      error: new RateLimited({
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), body),
      }),
    };
  }
  if (response.status === 503) {
    return {
      _tag: "Err",
      error: new Unavailable({
        dependency: "database",
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), body),
      }),
    };
  }
  return {
    _tag: "Err",
    error: UiError.unexpected(response.status, response.headers.get("x-request-id")),
  };
};

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

const parseParameters = (challenge: {
  readonly [key: string]: unknown;
}): ParsedParameters | null => {
  const params = challenge.parameters;
  if (!isRecord(params)) return null;
  const algorithm = params.algorithm;
  if (algorithm !== "ARGON2ID" && algorithm !== "PBKDF2/SHA-256" && algorithm !== "SHA-256") {
    return null;
  }
  if (typeof params.nonce !== "string" || typeof params.salt !== "string") return null;
  const nonce = hexToBytes(params.nonce);
  const salt = hexToBytes(params.salt);
  if (nonce === null || salt === null || nonce.length === 0 || salt.length === 0) return null;

  const cost = params.cost;
  if (typeof cost !== "number" || !Number.isInteger(cost) || cost < 1) return null;

  const keyLength = params.keyLength === undefined ? 32 : params.keyLength;
  if (typeof keyLength !== "number" || !Number.isInteger(keyLength) || keyLength < 1) return null;

  const keyPrefix = params.keyPrefix;
  if (
    typeof keyPrefix !== "string" ||
    keyPrefix.length === 0 ||
    keyPrefix.length > keyLength * 2 ||
    !/^[0-9a-fA-F]+$/.test(keyPrefix)
  ) {
    return null;
  }

  let memoryCost = 0;
  if (algorithm === "ARGON2ID") {
    if (
      typeof params.memoryCost !== "number" ||
      !Number.isInteger(params.memoryCost) ||
      params.memoryCost < 8
    ) {
      return null;
    }
    memoryCost = params.memoryCost;
  }
  const parallelism =
    typeof params.parallelism === "number" &&
    Number.isInteger(params.parallelism) &&
    params.parallelism >= 1
      ? params.parallelism
      : 1;

  let expiresAt: string | null = null;
  if (params.expiresAt !== undefined) {
    if (
      typeof params.expiresAt !== "number" ||
      !Number.isFinite(params.expiresAt) ||
      params.expiresAt <= 0
    ) {
      return null;
    }
    expiresAt = new Date(params.expiresAt * 1000).toISOString();
  }

  return {
    algorithm,
    nonce,
    salt,
    cost,
    keyLength,
    memoryCost,
    parallelism,
    keyPrefix: keyPrefix.toLowerCase(),
    expiresAt,
  };
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

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

/** Solve a fetched ALTCHA PoW v2 challenge in pure TS, yielding between chunks. */
export const solveChallenge = async (
  challenge: { readonly [key: string]: unknown },
  options?: SolveOptions,
): Promise<SolveOutcome> => {
  const signal = options?.signal;
  if (signal?.aborted) return { _tag: "Aborted" };

  const parsed = parseParameters(challenge);
  if (parsed === null) {
    return { _tag: "Err", error: UiError.unexpected() };
  }

  const password = new Uint8Array(parsed.nonce.length + 4);
  password.set(parsed.nonce, 0);
  const passwordView = new DataView(password.buffer);

  const expectedAttempts = Math.max(1, 16 ** parsed.keyPrefix.length);
  const chunkSize = parsed.algorithm === "ARGON2ID" ? 1 : 8;
  const startedAt = Date.now();
  const maxCounter = 0xffffffff;
  let deriveArgon2id: ReturnType<typeof createArgon2id> | undefined;

  for (let counter = 0; counter <= maxCounter; counter++) {
    if (signal?.aborted) return { _tag: "Aborted" };
    passwordView.setUint32(parsed.nonce.length, counter, false);

    let derived: Uint8Array;
    try {
      if (parsed.algorithm === "ARGON2ID") {
        deriveArgon2id ??= createArgon2id(parsed);
        derived = deriveArgon2id(password, parsed.salt);
      } else if (parsed.algorithm === "PBKDF2/SHA-256") {
        derived = await pbkdf2Sha256(password, parsed.salt, parsed.cost, parsed.keyLength);
      } else {
        derived = deriveSha256(parsed.salt, password, parsed.cost, parsed.keyLength);
      }
    } catch {
      return { _tag: "Err", error: UiError.unexpected() };
    }

    const derivedHex = bytesToHex(derived);
    if (derivedHex.startsWith(parsed.keyPrefix)) {
      options?.onProgress?.(1);
      const time = Math.max(0, Date.now() - startedAt);
      const payload = utf8ToBase64(
        JSON.stringify({
          challenge,
          solution: { counter, derivedKey: derivedHex, time },
        }),
      );
      return { _tag: "Solved", payload, expiresAt: parsed.expiresAt };
    }

    const attempts = counter + 1;
    if (attempts % chunkSize === 0) {
      const progress = Math.min(0.99, 1 - Math.exp(-attempts / expectedAttempts));
      options?.onProgress?.(progress);
      await yieldToEventLoop();
    }
  }

  return { _tag: "Err", error: UiError.unexpected() };
};
