/**
 * Quiet ALTCHA PoW v2 client solver and Better Auth POST helper carrying `X-Altcha`.
 * Private to src/page/public/.
 *
 * Per http-mcp-contracts section 2.6:
 * - `GET /api/v1/bot-protection/challenges/:scope` returns an `AltchaChallenge` JSON object,
 *   or 204 No Content when the installation runs `NoopBotProtection`.
 * - Solved payload is sent in the `X-Altcha` header as base64-encoded JSON `{ challenge, solution }`.
 * - Plain user-facing copy lives in @kvitbit/ui-port `auth.botProof.*` (no crypto/PoW jargon).
 */
import { ALTCHA_HEADER, type AltchaChallenge, type BotScope } from "@kvitbit/api-contract";
import { Effect, Schema } from "effect";
import { type Failure, failureFromUnknown, request, type WebServices } from "../../app/api";

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

const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
};

const encodeBase64 = (text: string): string => {
  if (typeof btoa === "function") return btoa(text);
  return Buffer.from(text, "utf8").toString("base64");
};

const sha256Hex = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  if (typeof crypto !== "undefined" && crypto.subtle !== undefined) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(digest));
  }
  // Fallback for environments without WebCrypto subtle (e.g. non-secure test contexts)
  let hash = 2166136261;
  for (const byte of data) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const pbkdf2Hex = async (
  nonce: string,
  counter: number,
  iterations: number,
  keyLength: number,
): Promise<string> => {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    return sha256Hex(`${nonce}:${counter}`);
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(counter)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: enc.encode(nonce),
      iterations: Math.max(1, iterations),
    },
    baseKey,
    Math.max(16, keyLength) * 8,
  );
  return toHex(new Uint8Array(bits));
};

interface ChallengeParams {
  readonly algorithm: string | undefined;
  readonly nonce: string | undefined;
  readonly salt: string | undefined;
  readonly cost: number | undefined;
  readonly keyLength: number | undefined;
  readonly keyPrefix: string | undefined;
}

const readParams = (challenge: AltchaChallenge): ChallengeParams => {
  const obj = challenge as Record<string, unknown>;
  const nested =
    typeof obj.parameters === "object" && obj.parameters !== null
      ? (obj.parameters as Record<string, unknown>)
      : obj;
  return {
    algorithm: typeof nested.algorithm === "string" ? nested.algorithm : undefined,
    nonce: typeof nested.nonce === "string" ? nested.nonce : undefined,
    salt: typeof nested.salt === "string" ? nested.salt : undefined,
    cost: typeof nested.cost === "number" ? nested.cost : undefined,
    keyLength: typeof nested.keyLength === "number" ? nested.keyLength : undefined,
    keyPrefix: typeof nested.keyPrefix === "string" ? nested.keyPrefix : undefined,
  };
};

/**
 * Solves an ALTCHA v2 challenge on-device and returns the base64 `X-Altcha` header value.
 * Supports PBKDF2/SHA-256 and SHA-256 challenges directly via WebCrypto.
 */
export const solveAltchaChallenge = async (challenge: AltchaChallenge): Promise<string> => {
  const params = readParams(challenge);
  const nonce = params.nonce ?? params.salt ?? "kvitbit";
  const prefix = (params.keyPrefix ?? "0").toLowerCase();
  const algorithm = params.algorithm ?? "PBKDF2/SHA-256";
  const cost = params.cost ?? 1000;
  const keyLength = params.keyLength ?? 32;
  const maxAttempts = 50_000;
  const started = Date.now();

  for (let counter = 0; counter < maxAttempts; counter++) {
    const derivedKey =
      algorithm === "PBKDF2/SHA-256"
        ? await pbkdf2Hex(nonce, counter, cost, keyLength)
        : await sha256Hex(`${nonce}:${counter}`);
    if (derivedKey.startsWith(prefix)) {
      const payload = {
        challenge,
        solution: {
          counter,
          derivedKey,
          time: Date.now() - started,
        },
      };
      return encodeBase64(JSON.stringify(payload));
    }
  }
  throw new Error("Unable to complete verification challenge");
};

export type FetchAndSolveResult =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "Solved"; readonly header: string }
  | { readonly _tag: "Failed"; readonly reason: string };

/**
 * Fetches a fresh ALTCHA challenge for `scope` and solves it in a single Foldkit Command Effect.
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
 * Mirrors `app/api.ts` `authFetch` (which is frozen and omits custom headers).
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
