/**
 * Pure, injectable BotProof controller (agreement #922/#925).
 * Manages fetch + solve lifecycle, AbortController per run, progress updates, and local expiry
 * checking without importing platform internals outside the frozen `fetchChallenge`/`solveChallenge`
 * seam.
 */
import type { BotScope } from "@kvitbit/api-contract";
import type {
  BotProofState,
  FetchedChallenge,
  SolveOptions,
  SolveOutcome,
} from "../../platform/altcha/bot-proof";

export interface BotProofDeps {
  readonly fetchChallenge: (origin: string, scope: BotScope) => Promise<FetchedChallenge>;
  readonly solveChallenge: (
    challenge: { readonly [key: string]: unknown },
    options?: SolveOptions,
  ) => Promise<SolveOutcome>;
  readonly origin: string;
  readonly scope: BotScope;
  readonly onState: (state: BotProofState) => void;
  readonly now?: () => number;
  readonly marginMs?: number;
}

export interface BotProofController {
  readonly start: () => Promise<BotProofState>;
  readonly restart: () => Promise<BotProofState>;
  readonly cancel: () => void;
  readonly getState: () => BotProofState;
  readonly isExpired: () => boolean;
  /** Returns current solved payload if still fresh, or re-fetches/re-solves when expired/idle. */
  readonly ensureFresh: () => Promise<BotProofState>;
}

const DEFAULT_MARGIN_MS = 10_000;

const expiredAt = (expiresAt: string | null, now: number, marginMs: number): boolean => {
  if (expiresAt === null) return false;
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || ms - marginMs <= now;
};

export const makeBotProof = (deps: BotProofDeps): BotProofController => {
  const now = deps.now ?? (() => Date.now());
  const marginMs = deps.marginMs ?? DEFAULT_MARGIN_MS;

  let state: BotProofState = { _tag: "NotRequired" };
  let activeController: AbortController | null = null;
  let activeRun: Promise<BotProofState> | null = null;
  let runSeq = 0;

  const setState = (next: BotProofState): BotProofState => {
    state = next;
    deps.onState(next);
    return next;
  };

  const cancel = (): void => {
    runSeq += 1;
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
    activeRun = null;
  };

  const run = (): Promise<BotProofState> => {
    cancel();
    const mySeq = runSeq;
    const controller = new AbortController();
    activeController = controller;
    setState({ _tag: "Fetching" });

    const promise = (async (): Promise<BotProofState> => {
      const fetched = await deps.fetchChallenge(deps.origin, deps.scope);
      if (mySeq !== runSeq || controller.signal.aborted) return state;

      if (fetched._tag === "NotRequired") {
        activeController = null;
        activeRun = null;
        return setState({ _tag: "NotRequired" });
      }
      if (fetched._tag === "Err") {
        activeController = null;
        activeRun = null;
        return setState({ _tag: "Failed", error: fetched.error });
      }

      setState({ _tag: "Solving", progress: 0 });
      const solved = await deps.solveChallenge(fetched.challenge, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (mySeq === runSeq && !controller.signal.aborted) {
            setState({ _tag: "Solving", progress });
          }
        },
      });
      if (mySeq !== runSeq || controller.signal.aborted) return state;

      activeController = null;
      activeRun = null;
      if (solved._tag === "Aborted") return state;
      if (solved._tag === "Err") {
        return setState({ _tag: "Failed", error: solved.error });
      }
      return setState({
        _tag: "Solved",
        payload: solved.payload,
        expiresAt: solved.expiresAt,
      });
    })();

    activeRun = promise;
    return promise;
  };

  const checkExpired = (): boolean =>
    state._tag === "Solved" && expiredAt(state.expiresAt, now(), marginMs);

  return {
    start: () => {
      if (activeRun !== null) return activeRun;
      if (state._tag === "Solved" && !checkExpired()) return Promise.resolve(state);
      return run();
    },
    restart: () => run(),
    cancel,
    getState: () => state,
    isExpired: checkExpired,
    ensureFresh: () => {
      if (state._tag === "Solved" && !checkExpired()) return Promise.resolve(state);
      if (activeRun !== null) return activeRun;
      return run();
    },
  };
};
