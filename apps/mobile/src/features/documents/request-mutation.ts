import type { RequestKey, WorkspaceId } from "@kvitbit/domain/contract";
import {
  type ApiResult,
  describeError,
  err,
  type KvitbitApiClient,
  UiError,
  uuidV7,
} from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Effect } from "effect";
import { useCallback, useRef } from "react";
import { useApi } from "../../runtime/api-runtime";
import {
  isRequestIntentExpired,
  requestIntentReconciliationCopy,
  runRequestIntent,
} from "../../runtime/request-intent";
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

const paymentFormSlot = (owner: string, target: string) =>
  `kvitbit.payment-form.v1.${JSON.stringify([owner, target])}`;

/**
 * Payment details can legitimately repeat, so each payment form gets its own request-intent
 * scope. The current scope is stored per target. An unresolved write keeps its exact key in
 * that scope until it settles. A confirmed payment moves the stored scope forward before its
 * key is cleared, so a later form, even after a remount, cannot reuse an older unresolved key.
 */
export function usePaymentMutation(workspaceId: WorkspaceId) {
  const { run } = useApi();
  const owner = useRequestOwner(workspaceId);
  const submitting = useRef(false);

  return useCallback<ReturnType<typeof useRequestMutation>>(
    async (target, payload, call) => {
      if (owner === null || submitting.current) return err(UiError.cancelled);
      submitting.current = true;
      try {
        const slot = paymentFormSlot(owner, target);
        const scope = await AsyncStorage.getItem(slot);
        return await runRequestIntent(
          owner,
          scope === null ? target : `${target}:${scope}`,
          payload,
          (key) => run((api) => call(api, key)),
          // If this write fails, runRequestIntent reports the outcome as unknown and keeps the
          // key. A retry then replays the confirmed payment and advances the scope again.
          () => AsyncStorage.setItem(slot, Effect.runSync(uuidV7)),
        );
      } catch {
        return err(UiError.unexpected());
      } finally {
        submitting.current = false;
      }
    },
    [owner, run],
  );
}

/** Text for a failed write, including an unresolved write whose safe replay window closed. */
export const requestErrorText = (
  error: UiError,
  i18n: {
    readonly local: (copy: typeof requestIntentReconciliationCopy) => string;
    readonly text: (text: ReturnType<typeof describeError>["text"]) => string;
  },
): string =>
  isRequestIntentExpired(error)
    ? i18n.local(requestIntentReconciliationCopy)
    : i18n.text(describeError(error).text);
