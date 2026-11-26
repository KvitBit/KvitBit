/**
 * Quiet ALTCHA PoW v2 client solver and Better Auth POST helper carrying `X-Altcha`.
 * Supports ARGON2ID (server default), PBKDF2/SHA-256, and SHA-256 compatible with `altcha-lib`.
 * Private to src/page/public/.
 */
import { ALTCHA_HEADER, type AltchaChallenge, type BotScope } from "@kvitbit/api-contract";
import { Effect, Schema } from "effect";
import { type Failure, failureFromUnknown, request, type WebServices } from "../../app/api";
import { solveAltchaChallenge } from "./_altcha-solver";

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

export type FetchAndSolveResult =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "Solved"; readonly header: string }
  | { readonly _tag: "Failed"; readonly reason: string };

const solveInBrowser = (challenge: AltchaChallenge, signal: AbortSignal): Promise<string> => {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return solveAltchaChallenge(challenge);
  }
  const worker = new Worker(new URL("./_altcha.worker.ts", import.meta.url), { type: "module" });
  const proof = new Promise<string>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const finish = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ header: string } | { error: string }>) => {
      finish();
      if ("header" in event.data) resolve(event.data.header);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    if (signal.aborted) abort();
    else worker.postMessage(challenge);
  });
  return proof.finally(() => worker.terminate());
};

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
        try: (signal) => solveInBrowser(out as AltchaChallenge, signal),
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
