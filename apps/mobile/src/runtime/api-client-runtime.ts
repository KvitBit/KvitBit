/**
 * One Effect runtime per signed-in session over ui-port's typed client (ui-port-contracts 7.2,
 * `MobileUiServices`). Screens reach the API only through `useApi`/`useRemote`.
 */
import {
  type ApiResult,
  attempt,
  bearer,
  type Credentials,
  err,
  fromCause,
  KvitbitApi,
  type KvitbitApiClient,
  layerFetch,
  type Remote,
  Remote as RemoteOps,
  sessionCookie,
  UiError,
} from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import {
  createContext,
  type DependencyList,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { forkMobileEffect, fromMobilePromise } from "./request-intent";

type ApiCall<A, E> = (api: KvitbitApiClient) => Effect.Effect<A, E, never>;

export interface ApiRunner {
  /** Runs one call: timeout, typed errors and transport failures folded into an ApiResult. */
  readonly run: <A, E>(call: ApiCall<A, E>) => Promise<ApiResult<A>>;
  readonly origin: string;
  readonly credentials: Credentials;
}

export const ApiContext = createContext<ApiRunner | null>(null);

export const credentialsFor = (token: string | null): Credentials =>
  token === null ? sessionCookie : bearer(token);

type SessionApiRunner = ApiRunner & { readonly dispose: () => Promise<void> };

export const makeApiRunner: {
  (credentials: Credentials, acceptLanguage: () => string): (origin: string) => SessionApiRunner;
  (origin: string, credentials: Credentials, acceptLanguage: () => string): SessionApiRunner;
} = Fn.dual(
  3,
  (origin: string, credentials: Credentials, acceptLanguage: () => string): SessionApiRunner => {
    const runtime = ManagedRuntime.make(
      layerFetch({ baseUrl: origin, credentials, acceptLanguage }),
    );
    return {
      origin,
      credentials,
      run: (call) =>
        runtime
          .runPromiseExit(
            attempt(
              Effect.gen(function* () {
                const api = yield* KvitbitApi;
                return yield* call(api);
              }),
            ),
          )
          .then((exit) => (Exit.isSuccess(exit) ? exit.value : exit.cause.pipe(fromCause, err))),
      dispose: () => runtime.dispose(),
    };
  },
);

export const useApi = (): ApiRunner => {
  const value = Option.fromNullOr(useContext(ApiContext));
  return Option.getOrThrowWith(value, () => new Error("useApi needs an ApiProvider"));
};

export interface RemoteHandle<A> {
  readonly state: Remote<A>;
  readonly reload: () => void;
  /** Replaces the loaded value locally (after a save returned the new view). */
  readonly set: (value: A) => void;
}

/**
 * Loads `call` on mount and whenever `deps` change; keeps the stale value while reloading.
 * Pass `null` to stay idle (a missing parameter).
 */
function useRemoteState<A, E>(call: ApiCall<A, E> | null, deps: DependencyList): RemoteHandle<A> {
  const { run } = useApi();
  const [state, setState] = useState<Remote<A>>(RemoteOps.idle);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers list the call's inputs in deps
  useEffect(() => {
    if (call === null) return;
    let live = true;
    setState((s) => RemoteOps.load(s));
    forkMobileEffect(
      fromMobilePromise(() => run(call)).pipe(
        Effect.orElseSucceed(() => err(UiError.offline)),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (live) setState((s) => RemoteOps.fromResult(s, result));
          }),
        ),
      ),
    );
    return () => {
      live = false;
    };
  }, [run, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((value: A) => setState(RemoteOps.ready(value)), []);
  return { state, reload, set };
}

export const useRemote: {
  (deps: DependencyList): <A, E>(call: ApiCall<A, E> | null) => RemoteHandle<A>;
  <A, E>(call: ApiCall<A, E> | null, deps: DependencyList): RemoteHandle<A>;
} = Fn.dual(2, useRemoteState);
