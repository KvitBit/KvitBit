/**
 * AuthClient implementation over Better Auth REST (`/api/auth/*`), `Session`, and `PasskeyBridge`.
 * Every method resolves to an `AuthResult`, never rejects.
 */
import { InvalidBotProof, RateLimited, Unauthorized } from "@kvitbit/api-contract";
import { Conflict, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { type AuthInvalid, type AuthIssueCode, UiError } from "@kvitbit/ui-port/api";
import { safeReturnTo } from "../../navigation/return-to";
import type { JsonObject, PasskeyBridge } from "../../platform/passkeys/passkey-bridge";
import type { AuthFetch, AuthResponse } from "../../session/auth-http";
import { readSessionUser, type SessionUser } from "../../session/session-user";
import { inviteReturnTo, verifiedSignInHref } from "./auth-links";
import type {
  AuthClient,
  AuthResult,
  AuthSession,
  BotProofPayload,
  PasskeyView,
  SessionView,
} from "./auth-port";

export interface AuthClientDeps {
  readonly auth: AuthFetch;
  readonly signedIn: (token: string | null) => Promise<boolean>;
  readonly refresh: () => Promise<void>;
  readonly clear: () => Promise<void>;
  readonly passkeyBridge: PasskeyBridge;
}

const ok = <A>(value: A): AuthResult<A> => ({ _tag: "Ok", value });
const err = <A>(error: UiError): AuthResult<A> => ({ _tag: "Err", error });
const cancelled = <A>(): AuthResult<A> => ({ _tag: "Cancelled" });

const authInvalid = (
  code: AuthIssueCode,
  path: ReadonlyArray<string | number> = [],
): AuthInvalid => ({
  _tag: "Invalid",
  issues: [{ path, code }],
});

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

const altchaHeaders = (proof: BotProofPayload, extra?: Record<string, string>) => {
  const headers: Record<string, string> = { ...extra };
  if (proof !== null) headers["x-altcha"] = proof;
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const readCode = (body: unknown): string => {
  if (!isRecord(body)) return "";
  if (typeof body._tag === "string") return body._tag;
  if (typeof body.code === "string") return body.code;
  if (typeof body.error === "string") return body.error;
  return "";
};

const readMessage = (body: unknown): string =>
  isRecord(body) && typeof body.message === "string" ? body.message : "";

/** Maps a non-OK Better Auth response into a `UiError`. */
export const mapAuthError = (
  response: AuthResponse,
  context: { readonly notFoundOn400?: boolean } = {},
): UiError => {
  const code = readCode(response.body);
  const upper = code.toUpperCase();
  const msg = readMessage(response.body).toLowerCase();

  if (code === "InvalidBotProof" || upper === "INVALID_BOT_PROOF") {
    return new InvalidBotProof({});
  }
  if (response.status === 429 || code === "RateLimited" || upper === "TOO_MANY_REQUESTS") {
    const retryAfter =
      isRecord(response.body) && typeof response.body.retryAfterSeconds === "number"
        ? response.body.retryAfterSeconds
        : 60;
    return new RateLimited({ retryAfterSeconds: retryAfter });
  }
  if (response.status === 503 || code === "Unavailable") {
    return new Unavailable({ dependency: "database", retryAfterSeconds: 5 });
  }

  // Better Auth semantic codes
  if (upper === "EMAIL_NOT_VERIFIED" || msg.includes("email not verified")) {
    return authInvalid("auth.email_not_verified", ["email"]);
  }
  if (
    upper === "INVALID_EMAIL_OR_PASSWORD" ||
    upper === "INVALID_CREDENTIALS" ||
    upper === "USER_NOT_FOUND"
  ) {
    return authInvalid("auth.invalid_credentials");
  }
  if (upper === "INVALID_PASSWORD" || upper === "PASSWORD_MISMATCH") {
    return authInvalid("auth.password_wrong", ["currentPassword"]);
  }
  if (upper === "PASSWORD_TOO_SHORT" || upper === "PASSWORD_TOO_WEAK") {
    return authInvalid("auth.password_weak", ["password"]);
  }
  if (upper === "PASSWORD_COMPROMISED" || upper === "PASSWORD_BREACHED") {
    return authInvalid("auth.password_breached", ["password"]);
  }
  if (upper === "USER_ALREADY_EXISTS" || upper === "EMAIL_ALREADY_EXISTS") {
    return authInvalid("auth.email_taken", ["email"]);
  }
  if (upper === "BOT_PROOF_REQUIRED" || code === "auth.bot_proof_required") {
    return authInvalid("auth.bot_proof_required");
  }
  if (
    upper === "LAST_SIGN_IN_METHOD" ||
    code === "last_sign_in_method" ||
    msg.includes("last sign-in method") ||
    msg.includes("last sign in method")
  ) {
    return new Conflict({ reason: "illegal_transition" });
  }
  if (
    upper === "SOLE_OWNER" ||
    code === "sole_owner" ||
    msg.includes("owns a workspace") ||
    msg.includes("transfer ownership")
  ) {
    return authInvalid("auth.sole_owner");
  }
  if (
    upper === "INVALID_TOKEN" ||
    upper === "TOKEN_EXPIRED" ||
    upper === "EXPIRED_TOKEN" ||
    msg.includes("expired") ||
    (context.notFoundOn400 === true && (response.status === 400 || response.status === 404))
  ) {
    return new NotFound({ entity: "Workspace", id: "token" });
  }
  if (response.status === 401) {
    return new Unauthorized({ reason: "invalid" });
  }
  if (response.status === 404) {
    return new NotFound({ entity: "Workspace", id: "resource" });
  }
  if (response.status === 409) {
    return new Conflict({ reason: "duplicate" });
  }
  return UiError.unexpected(response.status, null);
};

const toIso = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(0).toISOString();
};

const parsePasskey = (raw: unknown): PasskeyView | null => {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id,
    createdAt: toIso(raw.createdAt),
    deviceType: typeof raw.deviceType === "string" ? raw.deviceType : null,
    backedUp: raw.backedUp === true,
  };
};

const parseSession = (raw: unknown, currentSessionId: string): SessionView | null => {
  if (!isRecord(raw)) return null;
  const token = typeof raw.token === "string" ? raw.token : null;
  const id = token ?? (typeof raw.id === "string" ? raw.id : null);
  if (id === null) return null;
  return {
    id,
    current: raw.id === currentSessionId,
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : null,
    ipAddress: typeof raw.ipAddress === "string" ? raw.ipAddress : null,
    createdAt: toIso(raw.createdAt),
    expiresAt: toIso(raw.expiresAt),
  };
};

const guard = async <A>(fn: () => Promise<AuthResult<A>>): Promise<AuthResult<A>> => {
  try {
    return await fn();
  } catch {
    return err(UiError.offline);
  }
};

export const makeAuthClient = (deps: AuthClientDeps): AuthClient => {
  const establishSession = async (response: AuthResponse): Promise<AuthResult<AuthSession>> => {
    const token = response.token;
    let user: SessionUser | null = readSessionUser(response.body);
    if (!(await deps.signedIn(token))) return err(UiError.unexpected(response.status, null));
    if (user === null) {
      const sessionRes = await deps.auth("/get-session");
      user = sessionRes.ok ? readSessionUser(sessionRes.body) : null;
    }
    if (user === null) return err(UiError.unexpected(response.status, null));
    return ok({ user, token });
  };

  return {
    signUpEmail: (input, proof) =>
      guard(async () => {
        const headers = altchaHeaders(proof, { "accept-language": input.locale });
        const res = await deps.auth("/sign-up/email", {
          method: "POST",
          ...(headers !== undefined ? { headers } : {}),
          body: {
            email: input.email,
            password: input.password,
            name: input.name,
            callbackURL: `/app${verifiedSignInHref(inviteReturnTo(input.invitation))}`,
            ...(input.invitation !== undefined ? { invitation: input.invitation } : {}),
          },
        });
        if (!res.ok) return err(mapAuthError(res));
        if (input.invitation === undefined) return ok(null);
        const invited = readSessionUser(res.body);
        if (
          invited === null ||
          !invited.emailVerified ||
          invited.email.toLowerCase() !== input.email.toLowerCase()
        )
          return err(UiError.unexpected(res.status, null));
        return establishSession(res);
      }),

    signInEmail: (input, proof) =>
      guard(async () => {
        const headers = altchaHeaders(proof);
        const res = await deps.auth("/sign-in/email", {
          method: "POST",
          ...(headers !== undefined ? { headers } : {}),
          body: { email: input.email, password: input.password },
        });
        return res.ok ? establishSession(res) : err(mapAuthError(res));
      }),

    sendMagicLink: (email, proof, returnTo, signUp) =>
      guard(async () => {
        const headers = altchaHeaders(
          proof,
          signUp === undefined ? undefined : { "accept-language": signUp.locale },
        );
        const destination = safeReturnTo(returnTo ?? undefined);
        const res = await deps.auth("/sign-in/magic-link", {
          method: "POST",
          ...(headers !== undefined ? { headers } : {}),
          body: {
            email,
            callbackURL: `/app${destination ?? "/"}`,
            ...(signUp === undefined ? {} : { name: signUp.name }),
          },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    verifyLink: (kind, token) =>
      guard(async () => {
        const path = kind === "verify" ? "/verify-email" : "/magic-link/verify";
        const res = await deps.auth(path, { method: "GET", query: { token } });
        if (!res.ok) return err(mapAuthError(res, { notFoundOn400: true }));
        if (
          kind === "verify" &&
          isRecord(res.body) &&
          res.body.status === true &&
          res.body.user === null &&
          res.token === null
        ) {
          return ok(null);
        }
        return establishSession(res);
      }),

    resendVerification: (email, returnTo = null) =>
      guard(async () => {
        const res = await deps.auth("/send-verification-email", {
          method: "POST",
          body: { email, callbackURL: `/app${verifiedSignInHref(returnTo)}` },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    requestPasswordReset: (email, proof) =>
      guard(async () => {
        const headers = altchaHeaders(proof);
        const res = await deps.auth("/request-password-reset", {
          method: "POST",
          ...(headers !== undefined ? { headers } : {}),
          body: { email },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    resetPassword: (token, password) =>
      guard(async () => {
        const res = await deps.auth("/reset-password", {
          method: "POST",
          body: { token, newPassword: password },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res, { notFoundOn400: true }));
      }),

    changePassword: (current, next, revokeOthers) =>
      guard(async () => {
        const res = await deps.auth("/change-password", {
          method: "POST",
          body: {
            currentPassword: current,
            newPassword: next,
            revokeOtherSessions: revokeOthers,
          },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    changeEmail: (email) =>
      guard(async () => {
        const res = await deps.auth("/change-email", {
          method: "POST",
          body: { newEmail: email },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    updateUser: (patch) =>
      guard(async () => {
        const res = await deps.auth("/update-user", { method: "POST", body: patch });
        if (!res.ok) return err(mapAuthError(res));
        await deps.refresh();
        return ok(undefined);
      }),

    passkeySignIn: () =>
      guard(async () => {
        const avail = await deps.passkeyBridge.availability();
        if (avail === "unavailable") return err(authInvalid("auth.passkey_unsupported"));

        const optRes = await deps.auth("/passkey/generate-authenticate-options", { method: "GET" });
        if (!optRes.ok) return err(mapAuthError(optRes));
        if (!isRecord(optRes.body)) return err(UiError.unexpected(optRes.status, null));

        const assertion = await deps.passkeyBridge.get(optRes.body as JsonObject);
        if (assertion._tag === "Cancelled") return cancelled();
        if (assertion._tag === "Failed") return err(authInvalid("auth.passkey_failed"));

        const verifyRes = await deps.auth("/passkey/verify-authentication", {
          method: "POST",
          body: { response: assertion.value },
        });
        return verifyRes.ok ? establishSession(verifyRes) : err(mapAuthError(verifyRes));
      }),

    passkeyAdd: (name) =>
      guard(async () => {
        const avail = await deps.passkeyBridge.availability();
        if (avail === "unavailable") return err(authInvalid("auth.passkey_unsupported"));

        const optRes = await deps.auth("/passkey/generate-register-options", {
          method: "GET",
          ...(name.length > 0 ? { query: { name } } : {}),
        });
        if (!optRes.ok) return err(mapAuthError(optRes));
        if (!isRecord(optRes.body)) return err(UiError.unexpected(optRes.status, null));

        const registration = await deps.passkeyBridge.create(optRes.body as JsonObject);
        if (registration._tag === "Cancelled") return cancelled();
        if (registration._tag === "Failed") return err(authInvalid("auth.passkey_failed"));

        const verifyRes = await deps.auth("/passkey/verify-registration", {
          method: "POST",
          body: { name, response: registration.value },
        });
        if (!verifyRes.ok) return err(mapAuthError(verifyRes));
        const parsed = parsePasskey(
          isRecord(verifyRes.body) && isRecord(verifyRes.body.passkey)
            ? verifyRes.body.passkey
            : verifyRes.body,
        );
        return parsed === null ? err(UiError.unexpected(verifyRes.status, null)) : ok(parsed);
      }),

    passkeys: () =>
      guard(async () => {
        const res = await deps.auth("/passkey/list-user-passkeys", { method: "GET" });
        if (!res.ok) return err(mapAuthError(res));
        const list = Array.isArray(res.body)
          ? res.body
          : isRecord(res.body) && Array.isArray(res.body.passkeys)
            ? res.body.passkeys
            : [];
        return ok(list.map(parsePasskey).filter((p): p is PasskeyView => p !== null));
      }),

    renamePasskey: (id, name) =>
      guard(async () => {
        const res = await deps.auth("/passkey/update-passkey", {
          method: "POST",
          body: { id, name },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    removePasskey: (id) =>
      guard(async () => {
        const res = await deps.auth("/passkey/delete-passkey", {
          method: "POST",
          body: { id },
        });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    sessions: () =>
      guard(async () => {
        const [res, current] = await Promise.all([
          deps.auth("/list-sessions", { method: "GET" }),
          deps.auth("/get-session", { method: "GET" }),
        ]);
        if (!res.ok) return err(mapAuthError(res));
        if (!current.ok) return err(mapAuthError(current));
        const session = isRecord(current.body) ? current.body.session : null;
        if (!isRecord(session) || typeof session.id !== "string")
          return err(UiError.unexpected(current.status, null));
        const currentSessionId = session.id;
        const list = Array.isArray(res.body)
          ? res.body
          : isRecord(res.body) && Array.isArray(res.body.sessions)
            ? res.body.sessions
            : [];
        return ok(
          list
            .map((row) => parseSession(row, currentSessionId))
            .filter((s): s is SessionView => s !== null),
        );
      }),

    revokeSession: (id) =>
      guard(async () => {
        const res =
          id === "others"
            ? await deps.auth("/revoke-other-sessions", { method: "POST", body: {} })
            : await deps.auth("/revoke-session", { method: "POST", body: { token: id } });
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    signOut: () =>
      guard(async () => {
        const res = await deps.auth("/sign-out", { method: "POST", body: {} });
        await deps.clear();
        return res.ok ? ok(undefined) : err(mapAuthError(res));
      }),

    deleteAccount: (confirm) =>
      guard(async () => {
        const res = await deps.auth("/delete-user", {
          method: "POST",
          body: confirm.password !== undefined ? { password: confirm.password } : {},
        });
        if (!res.ok) return err(mapAuthError(res));
        await deps.clear();
        return ok(undefined);
      }),
  };
};
