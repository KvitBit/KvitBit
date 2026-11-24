/**
 * Thin React hook over `makeBotProof` and the frozen `fetchChallenge`/`solveChallenge` seam
 * (agreement #922/#925).
 */
import type { BotScope } from "@kvitbit/api-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BotProofState,
  fetchChallenge,
  solveChallenge,
} from "../../platform/altcha/bot-proof";
import { useSession } from "../../session/session-provider";
import { type BotProofController, makeBotProof } from "./bot-proof-model";

export interface UseBotProofOptions {
  /** `"auto"` starts solving immediately on mount; `"idle"` stays `NotRequired` until triggered. */
  readonly initial?: "auto" | "idle";
}

export interface BotProofHandle {
  readonly state: BotProofState;
  readonly start: () => Promise<BotProofState>;
  readonly restart: () => Promise<BotProofState>;
  readonly cancel: () => void;
  readonly ensureFresh: () => Promise<BotProofState>;
  readonly payload: string | null;
  readonly busy: boolean;
}

export const useBotProof = (scope: BotScope, options: UseBotProofOptions = {}): BotProofHandle => {
  const { origin } = useSession();
  const initial = options.initial ?? "auto";
  const [state, setState] = useState<BotProofState>({ _tag: "NotRequired" });
  const controllerRef = useRef<BotProofController | null>(null);

  useEffect(() => {
    const controller = makeBotProof({
      fetchChallenge,
      solveChallenge,
      origin,
      scope,
      onState: setState,
    });
    controllerRef.current = controller;
    if (initial === "auto") {
      void controller.start();
    } else {
      setState({ _tag: "NotRequired" });
    }
    return () => {
      controller.cancel();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [origin, scope, initial]);

  const start = useCallback(
    () => controllerRef.current?.start() ?? Promise.resolve<BotProofState>({ _tag: "NotRequired" }),
    [],
  );
  const restart = useCallback(
    () =>
      controllerRef.current?.restart() ?? Promise.resolve<BotProofState>({ _tag: "NotRequired" }),
    [],
  );
  const cancel = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);
  const ensureFresh = useCallback(
    () =>
      controllerRef.current?.ensureFresh() ??
      Promise.resolve<BotProofState>({ _tag: "NotRequired" }),
    [],
  );

  return {
    state,
    start,
    restart,
    cancel,
    ensureFresh,
    payload: state._tag === "Solved" ? state.payload : null,
    busy: state._tag === "Fetching" || state._tag === "Solving",
  };
};
