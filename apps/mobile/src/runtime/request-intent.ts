import { RequestKey } from "@kvitbit/domain/contract";
import { type ApiResult, UiError, uuidV7 } from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import {
  executeRequestIntent,
  makeRequestIntentStore,
  RequestIntentExpired,
  requestKeyReplayWindowOpen as replayWindowOpenAt,
} from "./request-intent-store";

export { settlesRequestIntent } from "./request-intent-store";

export const runMobileEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

export const runMobileSync = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

export const requestKeyReplayWindowOpen = (
  ...[firstAttemptAt, now]: [firstAttemptAt: number, now?: number]
): boolean => replayWindowOpenAt(firstAttemptAt, now ?? runMobileSync(Clock.currentTimeMillis));

export const forkMobileEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect);

class MobileBridgeError extends Schema.TaggedError<
  MobileBridgeError,
  { readonly brand: unique symbol }
>()("MobileBridgeError", {
  cause: Schema.Unknown,
}) {}

export const fromMobilePromise = <A>(tryPromise: () => Promise<A>) =>
  Effect.tryPromise({ try: tryPromise, catch: (cause) => MobileBridgeError.make({ cause }) });

const withWebLock = <A, E>(slot: string, work: Effect.Effect<A, E>) => {
  const locks = globalThis.navigator?.locks;
  if (!(Predicate.isObject(locks) && Predicate.isFunction(locks.request))) return;
  return Effect.tryPromise({
    try: (signal) => locks.request(slot, { signal }, () => Effect.runPromiseExit(work, { signal })),
    catch: (cause) => MobileBridgeError.make({ cause }),
  }).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
    ),
  );
};

const store = makeRequestIntentStore<MobileBridgeError, MobileBridgeError>({
  storage: {
    getItem: (slot) => fromMobilePromise(() => AsyncStorage.getItem(slot)),
    setItem: (slot, value) => fromMobilePromise(() => AsyncStorage.setItem(slot, value)),
    removeItem: (slot) => fromMobilePromise(() => AsyncStorage.removeItem(slot)),
  },
  digest: (value) =>
    fromMobilePromise(() => digestStringAsync(CryptoDigestAlgorithm.SHA256, value)),
  mint: Effect.map(uuidV7, RequestKey.make),
  withWebLock,
});
export const acquireRequestKey: {
  <P>(operation: string, payload: P): (owner: string) => Promise<RequestKey>;
  <P>(owner: string, operation: string, payload: P): Promise<RequestKey>;
} = Fn.dual(3, <P>(owner: string, operation: string, payload: P) =>
  runMobileEffect(store.acquireRequestKey(owner, operation, payload)),
);

export const reuseRequestKey: {
  <P>(operation: string, payload: P, key: RequestKey): (owner: string) => Promise<RequestKey>;
  <P>(owner: string, operation: string, payload: P, key: RequestKey): Promise<RequestKey>;
} = Fn.dual(4, <P>(owner: string, operation: string, payload: P, key: RequestKey) =>
  runMobileEffect(store.reuseRequestKey(owner, operation, payload, key)),
);

export const completeRequestKey: {
  (operation: string, key: RequestKey): (owner: string) => Promise<void>;
  (owner: string, operation: string, key: RequestKey): Promise<void>;
} = Fn.dual(3, (owner: string, operation: string, key: RequestKey) =>
  runMobileEffect(store.completeRequestKey(owner, operation, key)),
);

const expiredRequest = UiError.unexpected(409, null);

export const isRequestIntentExpired = (error: UiError): boolean => error === expiredRequest;

export const requestIntentReconciliationCopy = {
  en: "This change may already have been saved. Check the original result before starting another change.",
  cs: "Tato změna se už mohla uložit. Než ji provedete znovu, zkontrolujte původní výsledek.",
};

export const requestIntentFailure = (cause: unknown): UiError =>
  Schema.is(RequestIntentExpired)(cause) ? expiredRequest : UiError.offline;

export const runRequestIntent = <A, P>(
  ...input: [
    owner: string,
    operation: string,
    payload: P,
    request: (key: RequestKey) => Promise<ApiResult<A>>,
    persistSuccess?: (value: A) => Promise<void>,
  ]
) => {
  const [owner, operation, payload, request, persistSuccess] = input;
  return executeRequestIntent({
    acquire: store.acquireRequestKey(owner, operation, payload),
    request: (key) => fromMobilePromise(() => request(key)),
    checkpoint:
      persistSuccess === undefined
        ? undefined
        : (value) => fromMobilePromise(() => persistSuccess(value)),
    complete: (key) => store.completeRequestKey(owner, operation, key),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ _tag: "Err" as const, error: requestIntentFailure(error) }),
    ),
    runMobileEffect,
  );
};
