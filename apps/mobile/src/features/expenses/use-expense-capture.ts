import type { ExpenseId, WorkspaceSummary } from "@kvitbit/domain/contract";
import { idempotencyHeaders, UiError } from "@kvitbit/ui-port/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTransfer } from "../../platform/transfer";
import { useApi } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import { useWorkspace } from "../../workspace/workspace-provider";
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

export { captureQueue };

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
          const found = current.workspaces.find(({ id }) => id === item.id);
          return (
            mounted.current &&
            current.principalId === principalId &&
            found !== undefined &&
            mayCapture(current.principalId, found)
          );
        },
      };
    }
    return {
      current: accessFor(workspace),
      all: workspaces.flatMap((item) => {
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

    async function refresh() {
      const currentGeneration = ++generation;
      if (principalId === null) return;
      try {
        const entries = await Promise.all(
          workspaces.map(async (item) => ({
            jobs: await captureQueue.load({
              principalId,
              workspaceId: item.id,
              workspaceSlug: item.slug,
            }),
            canWrite: mayCapture(principalId, item),
          })),
        );
        if (active && currentGeneration === generation) {
          setSummary(summarizeCaptureJobs(entries));
        }
      } catch {
        // Keep the last known summary if a transient storage read fails.
      }
    }

    const unsubscribe = captureQueue.subscribe((scope) => {
      if (scope.principalId === principalId) void refresh();
    });
    void refresh();
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

    async function refresh() {
      const currentGeneration = ++generation;
      if (expenseId === null) return;
      try {
        const items = await captureQueue.loadRejected(scope, expenseId);
        if (active && currentGeneration === generation) setRejected(items);
      } catch {
        // Keep the last known rejected list if a transient storage read fails.
      }
    }

    const unsubscribe = captureQueue.subscribe((changed) => {
      if (changed.principalId === principalId && changed.workspaceId === workspace.id) {
        void refresh();
      }
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [expenseId, principalId, workspace.id, workspace.slug]);

  return {
    rejected,
    dismiss: async (fileKey: string) => {
      if (current === null || expenseId === null) return;
      await captureQueue.dismissRejected(current, expenseId, fileKey);
    },
    clearAll: async () => {
      if (current === null || expenseId === null) return;
      await captureQueue.clearRejected(current, expenseId);
    },
  };
}

export function useCaptureNetwork(): CaptureNetwork {
  const api = useApi();
  const transfer = useTransfer();
  return useMemo(
    () => ({
      isOnline: async () => {
        try {
          const { getNetworkStateAsync } = await import("expo-network");
          const state = await getNetworkStateAsync();
          return state.isConnected !== false && state.isInternetReachable !== false;
        } catch {
          return true;
        }
      },
      record: async (scope, key, payload) => {
        const response = await api.run((client) =>
          client.expenses.record({
            params: { workspaceId: scope.workspaceId },
            headers: idempotencyHeaders(key),
            payload,
          }),
        );
        if (response._tag === "Err") return response;
        const { id } = decodeExpenseDetail(response.value);
        return id === ""
          ? { _tag: "Err", error: UiError.unexpected(200) }
          : { _tag: "Ok", value: id };
      },
      upload: transfer.upload,
    }),
    [api, transfer],
  );
}
