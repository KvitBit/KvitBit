/**
 * The AuthClient bound to the current session.
 */
import { useMemo } from "react";
import { passkeyBridge } from "../../platform/passkeys/passkey-bridge";
import { useSession } from "../../session/session-provider";
import { makeAuthClient } from "./auth-client";
import type { AuthClient } from "./auth-port";

export const useAuthClient = (): AuthClient => {
  const session = useSession();
  return useMemo(
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
};
