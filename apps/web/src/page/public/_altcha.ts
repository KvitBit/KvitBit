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
import { type AltchaSolveError, solveAltchaChallenge } from "./_altcha-solver";

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
  Schema.Struct({ header: Schema.String }),
  Schema.Struct({ error: Schema.String }),
]);
const readWorkerReply = Schema.decodeUnknownOption(WorkerReply);

const solveInBrowser = (challenge: AltchaChallenge) =>
  Effect.suspend(
    (): Effect.Effect<string, WorkerSolveError | Schema.SchemaError | AltchaSolveError> => {
      if (globalThis.Worker === undefined) return solveAltchaChallenge(challenge);
      return Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            new Worker(new URL("../../runtime/altcha.worker.ts", import.meta.url), {
              type: "module",
            }),
          catch: () => WorkerSolveError.make({ reason: "Could not start verification worker" }),
        }),
        (worker) =>
          Effect.callback<string, WorkerSolveError>((resume) => {
            worker.onmessage = (event: MessageEvent) => {
              const reply = readWorkerReply(event.data);
              if (Option.isNone(reply)) {
                resume(WorkerSolveError.make({ reason: "Invalid verification worker reply" }));
              } else if ("header" in reply.value) {
                resume(Effect.succeed(reply.value.header));
              } else {
                resume(WorkerSolveError.make({ reason: reply.value.error }));
              }
            };
            worker.onerror = (event) => resume(WorkerSolveError.make({ reason: event.message }));
            worker.postMessage(challenge);
          }).pipe(
            Effect.catchDefect(() =>
              WorkerSolveError.make({ reason: "Could not send verification challenge" }),
            ),
          ),
        (worker) => Effect.sync(() => worker.terminate()),
      );
    },
  );

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
    (failure): FetchAndSolveResult => ({ _tag: "Failed", reason: failure.tag }),
  ).pipe(
    Effect.andThen((out) => {
      if (out._tag !== "Challenge") return Effect.succeed(onResult(out));
      return solveInBrowser(out.challenge).pipe(
        Effect.match({
          onSuccess: (header) => onResult({ _tag: "Solved", header }),
          onFailure: (error) =>
            onResult({ _tag: "Failed", reason: "reason" in error ? error.reason : error.message }),
        }),
      );
    }),
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
