import type { RequestKey, WorkspaceId } from "@kvitbit/domain/contract";
import { type ApiResult, err, type KvitbitApiClient, UiError, uuidV7 } from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Effect } from "effect";
import { useCallback, useRef } from "react";
import { useApi } from "../../runtime/api-runtime";
import { runRequestIntent } from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";

export function useRequestOwner(workspaceId: WorkspaceId) {
  const { state, origin } = useSession();
  return state.status === "signed-in" ? JSON.stringify([origin, state.user.id, workspaceId]) : null;
}

export function useRequestMutation(workspaceId: WorkspaceId) {
  const { run } = useApi();
  const owner = useRequestOwner(workspaceId);

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

export function usePaymentMutation(workspaceId: WorkspaceId) {
  const owner = useRequestOwner(workspaceId);
  const run = useRequestMutation(workspaceId);
  const active = useRef<{
    readonly slot: string;
    readonly suffix: string | null;
    readonly confirmed: boolean;
  } | null>(null);
  const submitting = useRef(false);

  return useCallback<ReturnType<typeof useRequestMutation>>(
    async (target, payload, call) => {
      if (owner === null || submitting.current) return err(UiError.cancelled);
      submitting.current = true;
      try {
        const slot = `kvitbit.payment-form.v1.${JSON.stringify([owner, target])}`;
        const previous = active.current?.slot === slot ? active.current : null;
        let suffix = previous === null ? await AsyncStorage.getItem(slot) : previous.suffix;
        if (previous?.confirmed === true) {
          // The user opened a new form after a confirmed payment. Keep earlier unresolved keys.
          suffix = Effect.runSync(uuidV7);
          await AsyncStorage.setItem(slot, suffix);
        }
        active.current = { slot, suffix, confirmed: false };
        const result = await run(suffix === null ? target : `${target}:${suffix}`, payload, call);
        if (result._tag === "Ok") active.current = { slot, suffix, confirmed: true };
        return result;
      } catch {
        return err(UiError.unexpected());
      } finally {
        submitting.current = false;
      }
    },
    [owner, run],
  );
}
