import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiOrigin } from "../config/env";
import { type AuthFetch, makeAuthFetch } from "./auth-http";
import { readSessionUser, type SessionUser } from "./session-user";
import { tokenStore } from "./token-store";

export type SessionState =
  | { readonly status: "restoring" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly user: SessionUser; readonly token: string | null };

export interface Session {
  readonly state: SessionState;
  readonly origin: string;
  /** Better Auth access carrying the current credentials. */
  readonly auth: AuthFetch;
  /** Call after a sign-in response: stores its token (Android) and loads the user. */
  readonly signedIn: (token: string | null) => Promise<boolean>;
  /** Re-reads the session (after a profile change). */
  readonly refresh: () => Promise<void>;
  /** Forgets the session locally; the auth client signs out on the server first. */
  readonly clear: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider(props: { readonly children: ReactNode; readonly origin?: string }) {
  const origin = props.origin ?? apiOrigin();
  const [state, setState] = useState<SessionState>({ status: "restoring" });
  const tokenRef = useRef<string | null>(null);
  const auth = useMemo(() => makeAuthFetch(origin, () => tokenRef.current), [origin]);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const response = await auth("/get-session");
      const user = response.ok ? readSessionUser(response.body) : null;
      if (user === null) {
        setState({ status: "signed-out" });
        return false;
      }
      setState({ status: "signed-in", user, token: tokenRef.current });
      return true;
    } catch {
      // Offline at launch with a stored token: stay signed out of the UI but keep the token,
      // so the next launch restores it.
      setState({ status: "signed-out" });
      return false;
    }
  }, [auth]);

  useEffect(() => {
    void (async () => {
      tokenRef.current = tokenStore.usesBearer ? await tokenStore.read().catch(() => null) : null;
      if (tokenStore.usesBearer && tokenRef.current === null) setState({ status: "signed-out" });
      else await load();
    })();
  }, [load]);

  const value = useMemo<Session>(
    () => ({
      state,
      origin,
      auth,
      signedIn: async (token) => {
        if (token !== null && tokenStore.usesBearer) {
          tokenRef.current = token;
          await tokenStore.write(token);
        }
        return load();
      },
      refresh: async () => {
        await load();
      },
      clear: async () => {
        tokenRef.current = null;
        await tokenStore.clear();
        setState({ status: "signed-out" });
      },
    }),
    [state, origin, auth, load],
  );
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}

export const useSession = (): Session => {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession needs a SessionProvider");
  return value;
};
