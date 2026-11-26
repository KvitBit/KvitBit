import type { WorkspaceSummary } from "@kvitbit/domain/contract";
import { idempotencyHeaders, UiError } from "@kvitbit/ui-port/api";
import { useEffect, useMemo, useRef } from "react";
import { captureStorage } from "../../platform/capture/capture-storage";
import { removeReceiptBytes, saveReceiptBytes } from "../../platform/capture/receipt-files";
import { useTransfer } from "../../platform/transfer";
import { useApi } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  type CaptureAccess,
  type CaptureNetwork,
  makeCaptureQueue,
  mayCapture,
} from "./capture-queue";
import { decodeExpenseDetail } from "./model";

export const captureQueue = makeCaptureQueue({
  storage: captureStorage,
  saveBytes: saveReceiptBytes,
  removeBytes: removeReceiptBytes,
});

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
    function accessFor(workspace: WorkspaceSummary): CaptureAccess | null {
      if (principalId === null || !mayCapture(principalId, workspace)) return null;
      return {
        scope: { principalId, workspaceId: workspace.id, workspaceSlug: workspace.slug },
        canWrite: () => {
          const current = authorization.current;
          const found = current.workspaces.find(({ id }) => id === workspace.id);
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
