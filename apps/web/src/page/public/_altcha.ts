/**
 * Quiet ALTCHA PoW v2 client solver and Better Auth POST helper carrying `X-Altcha`.
 * Supports ARGON2ID (server default), PBKDF2/SHA-256, and SHA-256 compatible with `altcha-lib`.
 * Private to src/page/public/.
 */

import type { AltchaChallenge, BotScope } from "@kvitbit/api-contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { request, type WebServices } from "../../app/api";
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

class WorkerSolveError extends Schema.TaggedError<
  WorkerSolveError,
  { readonly brand: unique symbol }
>()("WorkerSolveError", {
  reason: Schema.String,
}) {}

const WorkerReply = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Solved", { header: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
]);
const readWorkerReply = Schema.decodeUnknownOption(WorkerReply);

const solveInWorker = (challenge: AltchaChallenge) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        new Worker(new URL("../../runtime/altcha.worker.ts", import.meta.url), { type: "module" }),
      catch: () => WorkerSolveError.make({ reason: "Could not start verification worker" }),
    }),
    (worker) =>
      Effect.callback<string, WorkerSolveError>((resume) => {
        const startup = AbortSignal.timeout(3_000);
        const stalled = () =>
          resume(WorkerSolveError.make({ reason: "Verification worker did not start" }));
        startup.addEventListener("abort", stalled, { once: true });
        worker.onmessage = ({ data }: MessageEvent<unknown>) => {
          const reply = readWorkerReply(data);
          if (Option.isNone(reply)) {
            resume(WorkerSolveError.make({ reason: "Invalid verification worker reply" }));
            return;
          }
          switch (reply.value._tag) {
            case "Ready":
              startup.removeEventListener("abort", stalled);
              break;
            case "Solved":
              resume(Effect.succeed(reply.value.header));
              break;
            case "Failed":
              resume(WorkerSolveError.make({ reason: reply.value.reason }));
              break;
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          resume(WorkerSolveError.make({ reason: event.message }));
        };
        worker.onmessageerror = () =>
          resume(WorkerSolveError.make({ reason: "Could not read verification worker message" }));
        worker.postMessage(challenge);
        return Effect.sync(() => startup.removeEventListener("abort", stalled));
      }).pipe(
        Effect.catchDefect(() =>
          WorkerSolveError.make({ reason: "Could not send verification challenge" }),
        ),
      ),
    (worker) => Effect.sync(() => worker.terminate()),
  );

const solveInBrowser = (challenge: AltchaChallenge) =>
  Effect.suspend(() => {
    if (globalThis.Worker === undefined) return solveAltchaChallenge(challenge);
    return solveInWorker(challenge).pipe(Effect.catch(() => solveAltchaChallenge(challenge)));
  });

const failed = (reason: string): FetchAndSolveResult => ({ _tag: "Failed", reason });

/**
 * Fetches a fresh ALTCHA challenge for `scope` and solves it in a single Effect UI Command Effect.
 * 204 No Content (NoopBotProtection) yields `NotRequired`.
 */
const fetchAndSolveBotProofImpl = <M>(
  scope: BotScope,
  onResult: (result: FetchAndSolveResult) => M,
): Effect.Effect<M, never, WebServices> =>
  request(
    (client) => client.botProtection.issueChallenge({ params: { scope } }),
    (
      challenge,
    ): FetchAndSolveResult | { readonly _tag: "Challenge"; readonly challenge: AltchaChallenge } =>
      challenge === undefined ? { _tag: "NotRequired" } : { _tag: "Challenge", challenge },
    (failure) => failed(failure.tag),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.succeed(failed("challenge_timeout")),
    }),
    Effect.andThen((out): Effect.Effect<FetchAndSolveResult> => {
      if (out._tag !== "Challenge") return Effect.succeed(out);
      return solveInBrowser(out.challenge).pipe(
        Effect.match({
          onSuccess: (header): FetchAndSolveResult => ({ _tag: "Solved", header }),
          onFailure: (error) => failed("reason" in error ? error.reason : error.message),
        }),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.succeed(failed("solve_timeout")),
        }),
      );
    }),
    Effect.map(onResult),
  );

export const fetchAndSolveBotProof: {
  <M>(
    onResult: (result: FetchAndSolveResult) => M,
  ): (scope: BotScope) => Effect.Effect<M, never, WebServices>;
  <M>(
    scope: BotScope,
    onResult: (result: FetchAndSolveResult) => M,
  ): Effect.Effect<M, never, WebServices>;
} = Fn.dual(2, fetchAndSolveBotProofImpl);
