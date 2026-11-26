/**
 * Quiet ALTCHA PoW v2 client solver and Better Auth POST helper carrying `X-Altcha`.
 * Supports ARGON2ID (server default), PBKDF2/SHA-256, and SHA-256 compatible with `altcha-lib`.
 * Private to src/page/public/.
 */
import { ALTCHA_HEADER, type AltchaChallenge, type BotScope } from "@kvitbit/api-contract";
import { Effect, Schema } from "effect";
import { type Failure, failureFromUnknown, request, type WebServices } from "../../app/api";
import {
  argon2id,
  bytesToHex,
  hexToBytes,
  pbkdf2Sha256,
  sha256,
  utf8ToBase64,
} from "./_altcha_kdf";

export const BotProofState = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("NotRequired", {}),
  Schema.TaggedStruct("Solving", { seq: Schema.Int }),
  Schema.TaggedStruct("Solved", { seq: Schema.Int, header: Schema.String }),
  Schema.TaggedStruct("Failed", { seq: Schema.Int, reason: Schema.String }),
]);
export type BotProofState = typeof BotProofState.Type;

export const isBotProofReady = (state: BotProofState): boolean =>
  state._tag === "NotRequired" || state._tag === "Solved";

export const botProofHeader = (state: BotProofState): string | undefined =>
  state._tag === "Solved" ? state.header : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const parseParameters = (challenge: AltchaChallenge): ParsedParameters => {
  const obj = challenge as Record<string, unknown>;
  const nested = isRecord(obj.parameters) ? obj.parameters : obj;
  const rawAlgo = typeof nested.algorithm === "string" ? nested.algorithm : "ARGON2ID";
  if (rawAlgo !== "ARGON2ID" && rawAlgo !== "PBKDF2/SHA-256" && rawAlgo !== "SHA-256") {
    throw new Error(`Unsupported ALTCHA algorithm: ${rawAlgo}`);
  }
  const nonceStr = typeof nested.nonce === "string" ? nested.nonce : "";
  const saltStr = typeof nested.salt === "string" ? nested.salt : nonceStr;
  if (nonceStr === "" || saltStr === "") {
    throw new Error("Malformed ALTCHA challenge: missing nonce or salt");
  }
  const nonce = toBytesOrUtf8(nonceStr);
  const salt = toBytesOrUtf8(saltStr);
  const cost = typeof nested.cost === "number" && nested.cost >= 1 ? Math.trunc(nested.cost) : 1;
  const keyLength =
    typeof nested.keyLength === "number" && nested.keyLength >= 1
      ? Math.trunc(nested.keyLength)
      : 32;
  const memoryCost =
    typeof nested.memoryCost === "number" && nested.memoryCost >= 8
      ? Math.trunc(nested.memoryCost)
      : 19_456;
  const parallelism =
    typeof nested.parallelism === "number" && nested.parallelism >= 1
      ? Math.trunc(nested.parallelism)
      : 1;
  const keyPrefix = (typeof nested.keyPrefix === "string" ? nested.keyPrefix : "0").toLowerCase();
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

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Solves an ALTCHA PoW v2 challenge on-device and returns the base64 `X-Altcha` header value.
 * Matches `altcha-lib` for ARGON2ID, PBKDF2/SHA-256, and SHA-256.
 */
export const solveAltchaChallenge = async (challenge: AltchaChallenge): Promise<string> => {
  const params = parseParameters(challenge);
  const password = new Uint8Array(params.nonce.length + 4);
  password.set(params.nonce, 0);
  const passwordView = new DataView(password.buffer);
  const chunkSize = params.algorithm === "ARGON2ID" ? 1 : 8;
  const maxAttempts = 50_000;
  const started = Date.now();

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
          ? await pbkdf2Sha256(password, params.salt, params.cost, params.keyLength)
          : deriveSha256(params.salt, password, params.cost, params.keyLength);

    const derivedKey = bytesToHex(derived);
    if (derivedKey.startsWith(params.keyPrefix)) {
      const payload = {
        challenge,
        solution: {
          counter,
          derivedKey,
          time: Math.max(0, Date.now() - started),
        },
      };
      return utf8ToBase64(JSON.stringify(payload));
    }

    if ((counter + 1) % chunkSize === 0) {
      await yieldToEventLoop();
    }
  }
  throw new Error("Unable to complete verification challenge");
};

export type FetchAndSolveResult =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "Solved"; readonly header: string }
  | { readonly _tag: "Failed"; readonly reason: string };

/**
 * Fetches a fresh ALTCHA challenge for `scope` and solves it in a single Effect UI Command Effect.
 * 204 No Content (NoopBotProtection) yields `NotRequired`.
 */
export const fetchAndSolveBotProof = <M>(
  scope: BotScope,
  onResult: (result: FetchAndSolveResult) => M,
): Effect.Effect<M, never, WebServices> =>
  request(
    (client) => client.botProtection.issueChallenge({ params: { scope } }),
    (challenge): FetchAndSolveResult | AltchaChallenge =>
      challenge === undefined ? { _tag: "NotRequired" } : challenge,
    (failure): FetchAndSolveResult => ({ _tag: "Failed", reason: failure.tag }),
  ).pipe(
    Effect.andThen((out) => {
      if (typeof out === "object" && out !== null && "_tag" in out) {
        return Effect.succeed(onResult(out as FetchAndSolveResult));
      }
      return Effect.tryPromise({
        try: () => solveAltchaChallenge(out as AltchaChallenge),
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      }).pipe(
        Effect.map((header) => onResult({ _tag: "Solved", header })),
        Effect.catch((reason) => Effect.succeed(onResult({ _tag: "Failed", reason }))),
      );
    }),
  );

const origin = (): string =>
  typeof location === "undefined" || location.origin === "null"
    ? "http://localhost"
    : location.origin;

/**
 * Same-origin Better Auth POST carrying an optional `X-Altcha` proof header.
 */
export const authPostWithProof = <M1, M2>(
  path: string,
  body: unknown,
  altchaHeader: string | undefined,
  onSuccess: (json: unknown) => M1,
  onFailure: (failure: Failure) => M2,
): Effect.Effect<M1 | M2> =>
  Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (altchaHeader !== undefined) headers[ALTCHA_HEADER] = altchaHeader;
      const res = await fetch(`${origin()}/api/auth${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(body),
      });
      const json: unknown = res.headers.get("content-type")?.includes("json")
        ? await res.json()
        : null;
      if (!res.ok) {
        throw Object.assign(new Error(`auth ${res.status}`), { status: res.status, json });
      }
      return json;
    },
    catch: (e) => e,
  }).pipe(
    Effect.map((json): M1 | M2 => onSuccess(json)),
    Effect.catch((e) => Effect.succeed<M1 | M2>(onFailure(failureFromUnknown(e)))),
  );
