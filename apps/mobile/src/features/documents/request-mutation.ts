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
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useCallback, useRef } from "react";
import { useApi } from "../../runtime/api-runtime";
import {
  fromMobilePromise,
  isRequestIntentExpired,
  requestIntentReconciliationCopy,
  runRequestIntent,
} from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
import { requestOwner } from "../request-owner";
import { runFeatureEffect } from "../ui-effect";

export function useRequestOwner(workspaceId: WorkspaceId) {
  const { state, origin } = useSession();
  return state.status === "signed-in" ? requestOwner([origin, state.user.id, workspaceId]) : null;
}

export function useRequestMutation(workspaceId: WorkspaceId) {
  const { run } = useApi();
  const owner = useRequestOwner(workspaceId);

  return useCallback(
    <A, E, P>(
      operation: string,
      payload: P,
      call: (api: KvitbitApiClient, key: RequestKey) => Effect.Effect<A, E>,
    ): Promise<ApiResult<A>> =>
      owner === null
        ? runFeatureEffect(Effect.succeed(err(UiError.cancelled)))
        : runRequestIntent(owner, operation, payload, (key) => run((api) => call(api, key))),
    [owner, run],
  );
}

const encodePaymentTarget = Schema.encodeOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

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
    (target, payload, call) =>
      runFeatureEffect(
        Effect.suspend(() => {
          if (owner === null || submitting.current) return Effect.succeed(err(UiError.cancelled));
          const encoded = encodePaymentTarget([owner, target]);
          if (Option.isNone(encoded)) return Effect.succeed(err(UiError.unexpected()));
          const slot = `kvitbit.payment-form.v1.${encoded.value}`;
          submitting.current = true;
          return Effect.gen(function* () {
            const scope = yield* fromMobilePromise(() => AsyncStorage.getItem(slot));
            return yield* fromMobilePromise(() =>
              runRequestIntent(
                owner,
                scope === null ? target : `${target}:${scope}`,
                payload,
                (key) => run((api) => call(api, key)),
                // A failed scope update leaves the original payment key available for replay.
                () =>
                  runFeatureEffect(
                    Effect.flatMap(uuidV7, (nextScope) =>
                      fromMobilePromise(() => AsyncStorage.setItem(slot, nextScope)),
                    ),
                  ),
              ),
            );
          }).pipe(
            Effect.orElseSucceed(() => err(UiError.unexpected())),
            Effect.ensuring(
              Effect.sync(() => {
                submitting.current = false;
              }),
            ),
          );
        }),
      ),
    [owner, run],
  );
}

/** Text for a failed write, including an unresolved write whose safe replay window closed. */
interface RequestErrorTranslator {
  readonly local: (copy: typeof requestIntentReconciliationCopy) => string;
  readonly text: (text: ReturnType<typeof describeError>["text"]) => string;
}

export const requestErrorText: {
  (error: UiError, i18n: RequestErrorTranslator): string;
  (i18n: RequestErrorTranslator): (error: UiError) => string;
} = Fn.dual(2, (error: UiError, i18n: RequestErrorTranslator): string =>
  isRequestIntentExpired(error)
    ? i18n.local(requestIntentReconciliationCopy)
    : i18n.text(describeError(error).text),
);
