/**
 * One Effect runtime per signed-in session over ui-port's typed client (ui-port-contracts 7.2,
 * `MobileUiServices`). Screens reach the API only through `useApi`/`useRemote`.
 */
import {
  type ApiResult,
  attempt,
  bearer,
  type Credentials,
  KvitbitApi,
  type KvitbitApiClient,
  layerFetch,
  type Remote,
  Remote as RemoteOps,
  sessionCookie,
} from "@kvitbit/ui-port/api";
import { Effect, ManagedRuntime } from "effect";
import {
  createContext,
  type DependencyList,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiOrigin } from "../config/env";
import { useI18n } from "../i18n/i18n-provider";

export type ApiCall<A, E> = (api: KvitbitApiClient) => Effect.Effect<A, E, never>;

export interface ApiRunner {
  /** Runs one call: timeout, typed errors and transport failures folded into an ApiResult. */
  readonly run: <A, E>(call: ApiCall<A, E>) => Promise<ApiResult<A>>;
  readonly origin: string;
  readonly credentials: Credentials;
}

const ApiContext = createContext<ApiRunner | null>(null);

export const credentialsFor = (token: string | null): Credentials =>
  token === null ? sessionCookie : bearer(token);

export const makeApiRunner = (
  origin: string,
  credentials: Credentials,
  acceptLanguage: () => string,
): ApiRunner & { readonly dispose: () => Promise<void> } => {
  const runtime = ManagedRuntime.make(layerFetch({ baseUrl: origin, credentials, acceptLanguage }));
  return {
    origin,
    credentials,
    run: (call) =>
      runtime.runPromise(
        attempt(
          Effect.gen(function* () {
            const api = yield* KvitbitApi;
            return yield* call(api);
          }),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
};

export function ApiProvider(props: {
  readonly children: ReactNode;
  /** The session bearer on Android; null on the web, where the session cookie rides along. */
  readonly token: string | null;
  readonly origin?: string;
}) {
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const origin = props.origin ?? apiOrigin();
  const runner = useMemo(
    () => makeApiRunner(origin, credentialsFor(props.token), () => localeRef.current),
    [origin, props.token],
  );
  useEffect(() => () => void runner.dispose(), [runner]);
  return <ApiContext.Provider value={runner}>{props.children}</ApiContext.Provider>;
}

export const useApi = (): ApiRunner => {
  const value = useContext(ApiContext);
  if (value === null) throw new Error("useApi needs an ApiProvider");
  return value;
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
export const useRemote = <A, E>(
  call: ApiCall<A, E> | null,
  deps: DependencyList,
): RemoteHandle<A> => {
  const { run } = useApi();
  const [state, setState] = useState<Remote<A>>(RemoteOps.idle);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers list the call's inputs in deps
  useEffect(() => {
    if (call === null) return;
    let live = true;
    setState((s) => RemoteOps.load(s));
    void run(call).then((result) => {
      if (live) setState((s) => RemoteOps.fromResult(s, result));
    });
    return () => {
      live = false;
    };
  }, [run, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((value: A) => setState(RemoteOps.ready(value)), []);
  return { state, reload, set };
};
