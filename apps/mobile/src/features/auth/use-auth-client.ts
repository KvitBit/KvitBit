/**
 * The AuthClient bound to the current session (and injectable via `AuthClientProvider` in tests).
 */
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";
import { passkeyBridge } from "../../platform/passkeys/passkey-bridge";
import { useSession } from "../../session/session-provider";
import { makeAuthClient } from "./auth-client";
import type { AuthClient } from "./auth-port";

const AuthClientContext = createContext<AuthClient | null>(null);

export function AuthClientProvider(props: {
  readonly value: AuthClient;
  readonly children: ReactNode;
}) {
  return createElement(AuthClientContext.Provider, { value: props.value }, props.children);
}

export const useAuthClient = (): AuthClient => {
  const override = useContext(AuthClientContext);
  const session = useSession();
  const built = useMemo(
    () =>
      makeAuthClient({
        auth: session.auth,
        signedIn: session.signedIn,
        refresh: session.refresh,
        clear: session.clear,
        passkeyBridge,
      }),
    [session.auth, session.signedIn, session.refresh, session.clear],
  );

  return override ?? built;
};
