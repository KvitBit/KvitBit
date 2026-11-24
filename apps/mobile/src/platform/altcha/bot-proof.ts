/**
 * BotProof (ui-port-contracts 3, 5.2; ADR 0002): fetch an ALTCHA PoW v2 challenge and solve it in
 * pure TS, yielding to the JS thread between chunks. The payload is the base64 `X-Altcha` value.
 */
import type { BotScope } from "@kvitbit/api-contract";
import type { UiError } from "@kvitbit/ui-port/api";

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

/** GET {origin}/api/v1/bot-protection/challenges/{scope}. Stub until the solver lands. */
export const fetchChallenge = async (
  _origin: string,
  _scope: BotScope,
  _fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<FetchedChallenge> => ({ _tag: "NotRequired" });

/** Solve a fetched challenge. Stub until the solver lands. */
export const solveChallenge = async (
  _challenge: { readonly [key: string]: unknown },
  _options?: SolveOptions,
): Promise<SolveOutcome> => ({ _tag: "Aborted" });
