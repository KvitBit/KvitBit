import * as Option from "effect/Option";
import { createContext, useContext } from "react";
import type { AuthFetch } from "./auth-http";
import type { SessionUser } from "./session-user";

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

export const SessionContext = createContext<Session | null>(null);

export const useSession = (): Session => {
  const value = Option.fromNullOr(useContext(SessionContext));
  return Option.getOrThrowWith(value, () => new Error("useSession needs a SessionProvider"));
};
