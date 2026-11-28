import * as Effect from "effect/Effect";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiOrigin } from "../config/env";
import { forkMobileEffect, fromMobilePromise, runMobileEffect } from "../runtime/request-intent";
import { makeAuthFetch } from "./auth-http";
import { type Session, SessionContext, type SessionState } from "./session-context";
import { readSessionUser } from "./session-user";
import { tokenStore } from "./token-store";

export function SessionProvider(props: { readonly children: ReactNode; readonly origin?: string }) {
  const origin = props.origin ?? apiOrigin();
  const [state, setState] = useState<SessionState>({ status: "restoring" });
  const tokenRef = useRef<string | null>(null);
  const auth = useMemo(() => makeAuthFetch(origin, () => tokenRef.current), [origin]);

  const load = useCallback(
    () =>
      fromMobilePromise(() => auth("/get-session")).pipe(
        Effect.match({
          // Keep a stored bearer when restoring the session offline.
          onFailure: () => {
            setState({ status: "signed-out" });
            return false;
          },
          onSuccess: (response) => {
            const user = response.ok ? readSessionUser(response.body) : null;
            if (user === null) {
              setState({ status: "signed-out" });
              return false;
            }
            setState({ status: "signed-in", user, token: tokenRef.current });
            return true;
          },
        }),
      ),
    [auth],
  );

  useEffect(() => {
    const restore = Effect.gen(function* () {
      tokenRef.current = tokenStore.usesBearer
        ? yield* fromMobilePromise(tokenStore.read).pipe(Effect.orElseSucceed(() => null))
        : null;
      if (tokenStore.usesBearer && tokenRef.current === null) setState({ status: "signed-out" });
      else yield* load();
    });
    forkMobileEffect(restore);
  }, [load]);

  const value = useMemo<Session>(() => {
    const signedIn = Effect.fn("MobileSession.signedIn")(function* (token: string | null) {
      if (token !== null && tokenStore.usesBearer) {
        tokenRef.current = token;
        yield* fromMobilePromise(() => tokenStore.write(token));
      }
      return yield* load();
    });
    const clear = Effect.gen(function* () {
      tokenRef.current = null;
      yield* fromMobilePromise(tokenStore.clear);
      setState({ status: "signed-out" });
    });
    return {
      state,
      origin,
      auth,
      signedIn: (token) => runMobileEffect(signedIn(token)),
      refresh: () => load().pipe(Effect.asVoid, runMobileEffect),
      clear: () => runMobileEffect(clear),
    };
  }, [state, origin, auth, load]);
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}
