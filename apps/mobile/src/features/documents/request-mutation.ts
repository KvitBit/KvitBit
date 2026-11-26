import type { RequestKey, WorkspaceId } from "@kvitbit/domain/contract";
import { type ApiResult, err, type KvitbitApiClient, UiError } from "@kvitbit/ui-port/api";
import type { Effect } from "effect";
import { useCallback } from "react";
import { useApi } from "../../runtime/api-runtime";
import { runRequestIntent } from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";

export function useRequestMutation(workspaceId: WorkspaceId) {
  const { state, origin } = useSession();
  const { run } = useApi();
  const owner =
    state.status === "signed-in" ? JSON.stringify([origin, state.user.id, workspaceId]) : null;

  return useCallback(
    async <A, E>(
      operation: string,
      payload: unknown,
      call: (api: KvitbitApiClient, key: RequestKey) => Effect.Effect<A, E>,
    ): Promise<ApiResult<A>> => {
      if (owner === null) return err(UiError.cancelled);
      return runRequestIntent(owner, operation, payload, (key) => run((api) => call(api, key)));
    },
    [owner, run],
  );
}
