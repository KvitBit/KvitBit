import { InvalidBotProof, RateLimited, Unauthorized } from "@kvitbit/api-contract";
import { Conflict, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { type AuthInvalid, type AuthIssueCode, UiError } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { safeReturnTo } from "../../navigation/return-to";
import type { PasskeyBridge } from "../../platform/passkeys/passkey-bridge";
import type { AuthFetch, AuthResponse } from "../../session/auth-http";
import { readSessionUser, type SessionUser } from "../../session/session-user";
import { runFeatureEffect } from "../ui-effect";
import { inviteReturnTo, verifiedSignInHref } from "./auth-links";
import type {
  AuthClient,
  AuthResult,
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

const ok = <A>(value: A) => ({ _tag: "Ok", value }) as const;
const err = (error: UiError) => ({ _tag: "Err", error }) as const;
const cancelled = () => ({ _tag: "Cancelled" }) as const;

const authInvalid = (
  code: AuthIssueCode,
  path: ReadonlyArray<string | number> = [],
): AuthInvalid => ({
  _tag: "Invalid",
  issues: [{ path, code }],
});

const jsonObject = Fn.flow(Schema.decodeUnknownOption(Schema.JsonObject), Option.getOrNull);
const jsonString = Fn.flow(Schema.decodeUnknownOption(Schema.String), Option.getOrNull);
const jsonArray = Fn.flow(Schema.decodeUnknownOption(Schema.Array(Schema.Json)), Option.getOrNull);
const jsonNumber = Fn.flow(Schema.decodeUnknownOption(Schema.Finite), Option.getOrNull);

const altchaHeaders = (proof: BotProofPayload, extra?: Record<string, string>) =>
  proof === null ? { ...extra } : { ...extra, "x-altcha": proof };

/** Maps a non-OK Better Auth response into a `UiError`. */
const mapAuthError = (
  response: AuthResponse,
  context: { readonly notFoundOn400?: boolean } = {},
): UiError => {
  const body = jsonObject(response.body);
  const code = jsonString(body?._tag) ?? jsonString(body?.code) ?? jsonString(body?.error) ?? "";
  const upper = Str.toUpperCase(code);
  const msg = Str.toLowerCase(jsonString(body?.message) ?? "");

  if (code === "InvalidBotProof" || upper === "INVALID_BOT_PROOF") {
    return InvalidBotProof.make({});
  }
  if (response.status === 429 || code === "RateLimited" || upper === "TOO_MANY_REQUESTS") {
    const retryAfter = jsonNumber(body?.retryAfterSeconds) ?? 60;
    return RateLimited.make({ retryAfterSeconds: retryAfter });
  }
  if (response.status === 503 || code === "Unavailable") {
    return Unavailable.make({ dependency: "database", retryAfterSeconds: 5 });
  }

  // Better Auth semantic codes
  if (upper === "EMAIL_NOT_VERIFIED" || Str.includes("email not verified")(msg)) {
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
    Str.includes("last sign-in method")(msg) ||
    Str.includes("last sign in method")(msg)
  ) {
    return Conflict.make({ reason: "illegal_transition" });
  }
  if (
    upper === "SOLE_OWNER" ||
    code === "sole_owner" ||
    Str.includes("owns a workspace")(msg) ||
    Str.includes("transfer ownership")(msg)
  ) {
    return authInvalid("auth.sole_owner");
  }
  if (
    upper === "INVALID_TOKEN" ||
    upper === "TOKEN_EXPIRED" ||
    upper === "EXPIRED_TOKEN" ||
    Str.includes("expired")(msg) ||
    (context.notFoundOn400 === true && (response.status === 400 || response.status === 404))
  ) {
    return NotFound.make({ entity: "Workspace", id: "token" });
  }
  if (response.status === 401) {
    return Unauthorized.make({ reason: "invalid" });
  }
  if (response.status === 404) {
    return NotFound.make({ entity: "Workspace", id: "resource" });
  }
  if (response.status === 409) {
    return Conflict.make({ reason: "duplicate" });
  }
  return UiError.unexpected(response.status, null);
};

const unixEpoch = DateTime.makeUnsafe(0);
const parseDate = Fn.flow(
  Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Finite])),
  Option.match({
    onNone: () => DateTime.formatIso(unixEpoch),
    onSome: (value) =>
      jsonString(value) ??
      DateTime.formatIso(Option.getOrElse(DateTime.make(value), () => unixEpoch)),
  }),
);

const parsePasskey = Fn.flow(jsonObject, (row) => {
  const id = jsonString(row?.id);
  if (id === null) return Option.none<PasskeyView>();
  const name = jsonString(row?.name);
  return Option.some<PasskeyView>({
    id,
    name: name === null || name.length === 0 ? id : name,
    createdAt: parseDate(row?.createdAt),
    deviceType: jsonString(row?.deviceType),
    backedUp: row?.backedUp === true,
  });
});

const parseSession = (currentSessionId: string) =>
  Fn.flow(jsonObject, (row): SessionView | null => {
    const rowId = jsonString(row?.id);
    const id = jsonString(row?.token) ?? rowId;
    if (id === null) return null;
    return {
      id,
      current: rowId === currentSessionId,
      userAgent: jsonString(row?.userAgent),
      ipAddress: jsonString(row?.ipAddress),
      createdAt: parseDate(row?.createdAt),
      expiresAt: parseDate(row?.expiresAt),
    };
  });

const guard = <A>(workflow: Effect.Effect<AuthResult<A>>): Promise<AuthResult<A>> =>
  runFeatureEffect(Effect.catchCause(workflow, () => Effect.succeed(err(UiError.offline))));

export const makeAuthClient = (deps: AuthClientDeps): AuthClient => {
  const establishSession = Effect.fn("establishSession")(function* (response: AuthResponse) {
    const token = response.token;
    let user: SessionUser | null = readSessionUser(response.body);
    if (!(yield* Effect.promise(() => deps.signedIn(token))))
      return err(UiError.unexpected(response.status, null));
    if (user === null) {
      const sessionRes = yield* Effect.promise(() => deps.auth("/get-session"));
      user = sessionRes.ok ? readSessionUser(sessionRes.body) : null;
    }
    if (user === null) return err(UiError.unexpected(response.status, null));
    return ok({ user, token });
  });

  return {
    signUpEmail: (input, proof) =>
      guard(
        Effect.gen(function* () {
          const headers = altchaHeaders(proof, { "accept-language": input.locale });
          const res = yield* Effect.promise(() =>
            deps.auth("/sign-up/email", {
              method: "POST",
              headers,
              body: {
                email: input.email,
                password: input.password,
                name: input.name,
                callbackURL: `/app${verifiedSignInHref(inviteReturnTo(input.invitation))}`,
                invitation: input.invitation,
              },
            }),
          );
          if (!res.ok) return err(mapAuthError(res));
          if (input.invitation === undefined) return ok(null);
          const invited = readSessionUser(res.body);
          if (
            invited === null ||
            !invited.emailVerified ||
            Str.toLowerCase(invited.email) !== Str.toLowerCase(input.email)
          )
            return err(UiError.unexpected(res.status, null));
          return yield* establishSession(res);
        }),
      ),

    signInEmail: (input, proof) =>
      guard(
        Effect.gen(function* () {
          const headers = altchaHeaders(proof);
          const res = yield* Effect.promise(() =>
            deps.auth("/sign-in/email", {
              method: "POST",
              headers,
              body: { email: input.email, password: input.password },
            }),
          );
          return res.ok ? yield* establishSession(res) : err(mapAuthError(res));
        }),
      ),

    sendMagicLink: (email, proof, returnTo, signUp) =>
      guard(
        Effect.gen(function* () {
          const headers = altchaHeaders(
            proof,
            signUp === undefined ? undefined : { "accept-language": signUp.locale },
          );
          const destination = safeReturnTo(returnTo ?? undefined);
          const res = yield* Effect.promise(() =>
            deps.auth("/sign-in/magic-link", {
              method: "POST",
              headers,
              body: {
                email,
                callbackURL: `/app${destination ?? "/"}`,
                name: signUp?.name,
              },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    verifyLink: (kind, token) =>
      guard(
        Effect.gen(function* () {
          const path = kind === "verify" ? "/verify-email" : "/magic-link/verify";
          const res = yield* Effect.promise(() =>
            deps.auth(path, { method: "GET", query: { token } }),
          );
          if (!res.ok) return err(mapAuthError(res, { notFoundOn400: true }));
          const body = jsonObject(res.body);
          if (
            kind === "verify" &&
            body?.status === true &&
            body.user === null &&
            res.token === null
          ) {
            return ok(null);
          }
          return yield* establishSession(res);
        }),
      ),

    resendVerification: (email, returnTo = null) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/send-verification-email", {
              method: "POST",
              body: { email, callbackURL: `/app${verifiedSignInHref(returnTo)}` },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    requestPasswordReset: (email, proof) =>
      guard(
        Effect.gen(function* () {
          const headers = altchaHeaders(proof);
          const res = yield* Effect.promise(() =>
            deps.auth("/request-password-reset", {
              method: "POST",
              headers,
              body: { email },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    resetPassword: (token, password) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/reset-password", {
              method: "POST",
              body: { token, newPassword: password },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res, { notFoundOn400: true }));
        }),
      ),

    changePassword: (current, next, revokeOthers) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/change-password", {
              method: "POST",
              body: {
                currentPassword: current,
                newPassword: next,
                revokeOtherSessions: revokeOthers,
              },
            }),
          );
          if (!res.ok) return err(mapAuthError(res));
          if (res.token !== null) {
            const token = res.token;
            yield* Effect.promise(() => deps.signedIn(token));
          }
          return ok(undefined);
        }),
      ),

    changeEmail: (email) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/change-email", {
              method: "POST",
              body: { newEmail: email },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    updateUser: (patch) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/update-user", { method: "POST", body: patch }),
          );
          if (!res.ok) return err(mapAuthError(res));
          yield* Effect.promise(() => deps.refresh());
          return ok(undefined);
        }),
      ),

    passkeySignIn: () =>
      guard(
        Effect.gen(function* () {
          const avail = yield* Effect.promise(() => deps.passkeyBridge.availability());
          if (avail === "unavailable") return err(authInvalid("auth.passkey_unsupported"));

          const optRes = yield* Effect.promise(() =>
            deps.auth("/passkey/generate-authenticate-options", { method: "GET" }),
          );
          if (!optRes.ok) return err(mapAuthError(optRes));
          const options = jsonObject(optRes.body);
          if (options === null) return err(UiError.unexpected(optRes.status, null));

          const assertion = yield* Effect.promise(() => deps.passkeyBridge.get(options));
          if (assertion._tag === "Cancelled") return cancelled();
          if (assertion._tag === "Failed") return err(authInvalid("auth.passkey_failed"));

          const verifyRes = yield* Effect.promise(() =>
            deps.auth("/passkey/verify-authentication", {
              method: "POST",
              body: { response: assertion.value },
            }),
          );
          return verifyRes.ok ? yield* establishSession(verifyRes) : err(mapAuthError(verifyRes));
        }),
      ),

    passkeyAdd: (name) =>
      guard(
        Effect.gen(function* () {
          const avail = yield* Effect.promise(() => deps.passkeyBridge.availability());
          if (avail === "unavailable") return err(authInvalid("auth.passkey_unsupported"));

          const optRes = yield* Effect.promise(() =>
            deps.auth("/passkey/generate-register-options", {
              method: "GET",
              query: name.length > 0 ? { name } : {},
            }),
          );
          if (!optRes.ok) return err(mapAuthError(optRes));
          const options = jsonObject(optRes.body);
          if (options === null) return err(UiError.unexpected(optRes.status, null));

          const registration = yield* Effect.promise(() => deps.passkeyBridge.create(options));
          if (registration._tag === "Cancelled") return cancelled();
          if (registration._tag === "Failed") return err(authInvalid("auth.passkey_failed"));

          const verifyRes = yield* Effect.promise(() =>
            deps.auth("/passkey/verify-registration", {
              method: "POST",
              body: { name, response: registration.value },
            }),
          );
          if (!verifyRes.ok) return err(mapAuthError(verifyRes));
          const body = jsonObject(verifyRes.body);
          const parsed = parsePasskey(jsonObject(body?.passkey) ?? body);
          return Option.match(parsed, {
            onNone: () => err(UiError.unexpected(verifyRes.status, null)),
            onSome: ok,
          });
        }),
      ),

    passkeys: () =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/passkey/list-user-passkeys", { method: "GET" }),
          );
          if (!res.ok) return err(mapAuthError(res));
          const list = jsonArray(res.body) ?? jsonArray(jsonObject(res.body)?.passkeys) ?? [];
          return ok(Arr.getSomes(Arr.map(list, (row) => parsePasskey(row))));
        }),
      ),

    renamePasskey: (id, name) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/passkey/update-passkey", {
              method: "POST",
              body: { id, name },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    removePasskey: (id) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/passkey/delete-passkey", {
              method: "POST",
              body: { id },
            }),
          );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    sessions: () =>
      guard(
        Effect.gen(function* () {
          const [res, current] = yield* Effect.all(
            [
              Effect.promise(() => deps.auth("/list-sessions", { method: "GET" })),
              Effect.promise(() => deps.auth("/get-session", { method: "GET" })),
            ],
            { concurrency: 2 },
          );
          if (!res.ok) return err(mapAuthError(res));
          if (!current.ok) return err(mapAuthError(current));
          const session = jsonObject(jsonObject(current.body)?.session);
          const currentSessionId = jsonString(session?.id);
          if (currentSessionId === null) return err(UiError.unexpected(current.status, null));
          const list = jsonArray(res.body) ?? jsonArray(jsonObject(res.body)?.sessions) ?? [];
          return ok(
            Arr.filter(
              Arr.map(list, (row) => parseSession(currentSessionId)(row)),
              (s): s is SessionView => s !== null,
            ),
          );
        }),
      ),

    revokeSession: (id) =>
      guard(
        Effect.gen(function* () {
          const res =
            id === "others"
              ? yield* Effect.promise(() =>
                  deps.auth("/revoke-other-sessions", { method: "POST", body: {} }),
                )
              : yield* Effect.promise(() =>
                  deps.auth("/revoke-session", { method: "POST", body: { token: id } }),
                );
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    signOut: () =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/sign-out", { method: "POST", body: {} }),
          );
          yield* Effect.promise(() => deps.clear());
          return res.ok ? ok(undefined) : err(mapAuthError(res));
        }),
      ),

    deleteAccount: (confirm) =>
      guard(
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            deps.auth("/delete-user", {
              method: "POST",
              body: confirm.password !== undefined ? { password: confirm.password } : {},
            }),
          );
          if (!res.ok) return err(mapAuthError(res));
          yield* Effect.promise(() => deps.clear());
          return ok(undefined);
        }),
      ),
  };
};
