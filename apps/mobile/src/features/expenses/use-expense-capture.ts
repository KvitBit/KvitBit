import type { ExpenseId, WorkspaceSummary } from "@kvitbit/domain/contract";
import { idempotencyHeaders, UiError } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTransfer } from "../../platform/transfer";
import { useApi } from "../../runtime/api-runtime";
import { fromMobilePromise } from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
import { useWorkspace } from "../../workspace/workspace-provider";
import { runFeatureEffect } from "../ui-effect";
import {
  type CaptureAccess,
  type CaptureNetwork,
  type CaptureQueueSummary,
  mayCapture,
  type RejectedReceipt,
  summarizeCaptureJobs,
} from "./capture-queue";
import { captureQueue } from "./capture-queue-instance";
import { decodeExpenseDetail } from "./model";

const EMPTY_SUMMARY: CaptureQueueSummary = { pendingCount: 0, blockedCount: 0, hasBlocked: false };

export function useCaptureAccess() {
  const { workspace, workspaces } = useWorkspace();
  const { state } = useSession();
  const principalId = state.status === "signed-in" ? state.user.id : null;
  const authorization = useRef({ principalId, workspaces });
  authorization.current = { principalId, workspaces };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const accesses = useMemo(() => {
    function accessFor(item: WorkspaceSummary): CaptureAccess | null {
      if (principalId === null || !mayCapture(principalId, item)) return null;
      return {
        scope: { principalId, workspaceId: item.id, workspaceSlug: item.slug },
        canWrite: () => {
          const current = authorization.current;
          const found = Option.getOrUndefined(
            Arr.findFirst(current.workspaces, ({ id }) => id === item.id),
          );
          return (
            mounted.current === true &&
            current.principalId === principalId &&
            found !== undefined &&
            mayCapture(current.principalId, found)
          );
        },
      };
    }
    return {
      current: accessFor(workspace),
      all: Arr.flatMap(workspaces, (item) => {
        const access = accessFor(item);
        return access === null ? [] : [access];
      }),
    };
  }, [principalId, workspace, workspaces]);
  return accesses;
}

export function useCaptureQueueSummary(): CaptureQueueSummary {
  const { workspaces } = useWorkspace();
  const { state } = useSession();
  const principalId = state.status === "signed-in" ? state.user.id : null;
  const [summary, setSummary] = useState<CaptureQueueSummary>(EMPTY_SUMMARY);

  useEffect(() => {
    if (principalId === null || workspaces.length === 0) {
      setSummary(EMPTY_SUMMARY);
      return;
    }
    let active = true;
    let generation = 0;

    const refresh = Effect.fn("CaptureQueueSummary.refresh")(
      function* () {
        const currentGeneration = ++generation;
        const entries = yield* Effect.forEach(
          workspaces,
          (item) =>
            fromMobilePromise(() =>
              captureQueue.load({
                principalId,
                workspaceId: item.id,
                workspaceSlug: item.slug,
              }),
            ).pipe(Effect.map((jobs) => ({ jobs, canWrite: mayCapture(principalId, item) }))),
          { concurrency: "unbounded" },
        );
        if (active && currentGeneration === generation) setSummary(summarizeCaptureJobs(entries));
      },
      Effect.ignore,
      runFeatureEffect,
    );

    const unsubscribe = captureQueue.subscribe((scope) => {
      if (scope.principalId === principalId) refresh();
    });
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [principalId, workspaces]);

  return summary;
}

export function useRejectedReceipts(expenseId: ExpenseId | null) {
  const { workspace } = useWorkspace();
  const { state } = useSession();
  const principalId = state.status === "signed-in" ? state.user.id : null;
  const { current } = useCaptureAccess();
  const [rejected, setRejected] = useState<readonly RejectedReceipt[]>([]);

  useEffect(() => {
    if (principalId === null || expenseId === null) {
      setRejected([]);
      return;
    }
    let active = true;
    let generation = 0;
    const scope = { principalId, workspaceId: workspace.id, workspaceSlug: workspace.slug };

    const refresh = Effect.fn("RejectedReceipts.refresh")(
      function* () {
        const currentGeneration = ++generation;
        const items = yield* fromMobilePromise(() => captureQueue.loadRejected(scope, expenseId));
        if (active && currentGeneration === generation) setRejected(items);
      },
      Effect.ignore,
      runFeatureEffect,
    );

    const unsubscribe = captureQueue.subscribe((changed) => {
      if (changed.principalId === principalId && changed.workspaceId === workspace.id) {
        refresh();
      }
    });
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [expenseId, principalId, workspace.id, workspace.slug]);

  return {
    rejected,
    dismiss: (fileKey: string) =>
      current === null || expenseId === null
        ? runFeatureEffect(Effect.void)
        : captureQueue.dismissRejected(current, expenseId, fileKey),
    clearAll: () =>
      current === null || expenseId === null
        ? runFeatureEffect(Effect.void)
        : captureQueue.clearRejected(current, expenseId),
  };
}

export function useCaptureNetwork(): CaptureNetwork {
  const api = useApi();
  const transfer = useTransfer();
  return useMemo(
    () => ({
      isOnline: Effect.fn("CaptureNetwork.isOnline")(
        function* () {
          const { getNetworkStateAsync } = yield* fromMobilePromise(() => import("expo-network"));
          const state = yield* fromMobilePromise(getNetworkStateAsync);
          return state.isConnected !== false && state.isInternetReachable !== false;
        },
        Effect.orElseSucceed(() => true),
        runFeatureEffect,
      ),
      record: (scope, key, payload) =>
        runFeatureEffect(
          fromMobilePromise(() =>
            api.run((client) =>
              client.expenses.record({
                params: { workspaceId: scope.workspaceId },
                headers: idempotencyHeaders(key),
                payload,
              }),
            ),
          ).pipe(
            Effect.map((response) => {
              if (response._tag === "Err") return response;
              const expense = decodeExpenseDetail(response.value);
              return expense === null
                ? ({ _tag: "Err", error: UiError.unexpected(200) } as const)
                : ({ _tag: "Ok", value: expense.id } as const);
            }),
          ),
        ),
      upload: transfer.upload,
    }),
    [api, transfer],
  );
}
