/**
 * The AuthClient port (ui-port-contracts 5.1) for apps/mobile, Promise-shaped like the
 * scaffold's `useApi().run`: every call ends in an `AuthResult`, never a rejection.
 * Implemented over `useSession().auth` (Better Auth REST under /api/auth) in auth-client.ts.
 */
import type { UiError } from "@kvitbit/ui-port/api";
import type { Locale } from "@kvitbit/ui-port/i18n";
import type { SessionUser } from "../../session/session-user";

export type AuthResult<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Err"; readonly error: UiError }
  /** The user dismissed the passkey sheet: return to the form with no banner (flow 1.5). */
  | { readonly _tag: "Cancelled" };

/** A sign-in that produced a session; the client already called `session.signedIn(token)`. */
export interface AuthSession {
  readonly user: SessionUser;
  /** Bearer issued by the server (`set-auth-token`), null for cookie sessions (web). */
  readonly token: string | null;
}

export interface PasskeyView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string; // ISO timestamp
  readonly deviceType: string | null; // "singleDevice" | "multiDevice"
  readonly backedUp: boolean;
}

export interface SessionView {
  readonly id: string;
  readonly current: boolean;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** `proof` is the solved ALTCHA payload sent as `X-Altcha`, or null when not required. */
export type BotProofPayload = string | null;

export interface AuthClient {
  readonly signUpEmail: (
    input: {
      readonly email: string;
      readonly password: string;
      readonly name: string;
      readonly locale: Locale;
      readonly invitation?: string | undefined;
    },
    proof: BotProofPayload,
  ) => Promise<AuthResult<AuthSession | null>>; // invitation signup returns its verified session
  readonly signInEmail: (
    input: { readonly email: string; readonly password: string },
    proof: BotProofPayload,
  ) => Promise<AuthResult<AuthSession>>;
  readonly sendMagicLink: (
    email: string,
    proof: BotProofPayload,
    returnTo: string | null,
    signUp?: { readonly name: string; readonly locale: Locale },
  ) => Promise<AuthResult<void>>;
  /** Null means email verification succeeded, and the user can sign in. */
  readonly verifyLink: (
    kind: "verify" | "magic",
    token: string,
  ) => Promise<AuthResult<AuthSession | null>>;
  readonly resendVerification: (
    email: string,
    returnTo?: string | null,
  ) => Promise<AuthResult<void>>;
  readonly requestPasswordReset: (
    email: string,
    proof: BotProofPayload,
  ) => Promise<AuthResult<void>>;
  readonly resetPassword: (token: string, password: string) => Promise<AuthResult<void>>;
  readonly changePassword: (
    current: string,
    next: string,
    revokeOthers: boolean,
  ) => Promise<AuthResult<void>>;
  readonly changeEmail: (email: string) => Promise<AuthResult<void>>;
  readonly updateUser: (patch: { readonly name?: string }) => Promise<AuthResult<void>>;
  readonly passkeySignIn: () => Promise<AuthResult<AuthSession>>;
  readonly passkeyAdd: (name: string) => Promise<AuthResult<PasskeyView>>;
  readonly passkeys: () => Promise<AuthResult<ReadonlyArray<PasskeyView>>>;
  readonly renamePasskey: (id: string, name: string) => Promise<AuthResult<void>>;
  /** Conflict{last_sign_in_method} when it is the last way to sign in (flow 1.5). */
  readonly removePasskey: (id: string) => Promise<AuthResult<void>>;
  readonly sessions: () => Promise<AuthResult<ReadonlyArray<SessionView>>>;
  readonly revokeSession: (id: string | "others") => Promise<AuthResult<void>>;
  /** Signs out on the server, then `session.clear()`. */
  readonly signOut: () => Promise<AuthResult<void>>;
  /** Soft delete (Q7); clears the local session on success. */
  readonly deleteAccount: (confirm: { readonly password?: string }) => Promise<AuthResult<void>>;
}
