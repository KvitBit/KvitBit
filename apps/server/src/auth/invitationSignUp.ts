import {
  type Auth,
  type AuthConfig,
  authOptions,
  authTables,
  type BeforeHook,
} from "@kvitbit/adapters/auth";
import { Caller, CurrentCaller, InvitationToken, type Workspaces } from "@kvitbit/domain/contract";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { acceptLanguageLocale } from "../http/edge/request";
import { fromAuthPromise, runAuthEffect, withDrizzleSqlContext } from "./drizzleBridge";

const SIGN_UP_PATH = "/sign-up/email";

// Better Auth can log Drizzle errors with raw SQL parameters before returning a response.
const logInvitationSignUpError = () =>
  // biome-ignore lint/plugin/no-direct-effect-runs: Better Auth requires a synchronous logger callback.
  Effect.runSync(Effect.logError("Invitation signup request failed"));

const InvitationBody = Schema.Record(Schema.String, Schema.Unknown);
const parseInvitationBody = Schema.decodeUnknownOption(InvitationBody);
const isString = Schema.is(Schema.String);
const isNonEmptyString = Schema.is(Schema.NonEmptyString);

const includesInvitation = (body: typeof InvitationBody.Type) =>
  Rec.has(body, "invitationToken") || Rec.has(body, "invitation");

// Web sends invitationToken and the native client sends invitation. Both are explicit opt-ins.
const readInvitationToken = (body: typeof InvitationBody.Type) => {
  const web = Rec.has(body, "invitationToken");
  const native = Rec.has(body, "invitation");
  if (web && native && body.invitationToken !== body.invitation) return;
  const token = web ? body.invitationToken : body.invitation;
  return isNonEmptyString(token) ? InvitationToken.make(token) : undefined;
};

const invitationNotFound = () =>
  new APIError("NOT_FOUND", { _tag: "NotFound", code: "InvitationNotFound" });

const invitationSignUpHook = (
  workspaces: Workspaces["Service"],
  clock: Clock.Clock,
  verifiedEmails: WeakMap<Request, string>,
): BeforeHook => {
  const verifyInvitation = Effect.fn("verifyInvitationSignUp")(function* (
    ctx: Parameters<BeforeHook["handler"]>[0],
  ) {
    const body = parseInvitationBody(ctx.body);
    if (Option.isNone(body) || ctx.request === undefined) {
      return yield* Effect.fail(new APIError("BAD_REQUEST", { code: "InvalidInvitation" }));
    }
    const token = readInvitationToken(body.value);
    if (token === undefined) {
      return yield* Effect.fail(new APIError("BAD_REQUEST", { code: "InvalidInvitation" }));
    }
    const invitation = yield* workspaces.peekInvitation.pipe(
      Effect.provideService(
        CurrentCaller,
        Caller.invitationHolder({
          token,
          locale: acceptLanguageLocale(ctx.headers?.get("accept-language") ?? undefined) ?? "cs",
        }),
      ),
      Effect.provideService(Clock.Clock, clock),
      Effect.mapError((error) =>
        error._tag === "Unavailable"
          ? new APIError(
              "SERVICE_UNAVAILABLE",
              { _tag: "Unavailable", code: "Unavailable" },
              { "Retry-After": "5" },
            )
          : invitationNotFound(),
      ),
    );
    if (invitation.status !== "pending") return yield* Effect.fail(invitationNotFound());
    const email = Str.toLowerCase(invitation.email);
    if (!isString(body.value.email) || Str.toLowerCase(body.value.email) !== email) {
      return yield* Effect.fail(new APIError("FORBIDDEN", { code: "InvitationEmailMismatch" }));
    }
    verifiedEmails.set(ctx.request, email);
  });

  return {
    matcher: (ctx) => ctx.path === SIGN_UP_PATH,
    handler: createAuthMiddleware((ctx) => runAuthEffect(verifyInvitation(ctx))),
  };
};

const usesInvitation = Effect.fn("isInvitationSignUp")(function* (request: Request) {
  if (request.method !== "POST" || new URL(request.url).pathname !== `/api/auth${SIGN_UP_PATH}`) {
    return false;
  }
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = Str.toLowerCase(Str.trim(Str.split(contentType, ";")[0]));
  // Better Auth handles malformed bodies and unsupported media types through its usual handler.
  if (mediaType === "application/json") {
    return yield* fromAuthPromise(() => request.clone().text()).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InvitationBody))),
      Effect.map(includesInvitation),
      Effect.orElseSucceed(() => false),
    );
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    return yield* fromAuthPromise(() => request.clone().formData()).pipe(
      Effect.map((form) => form.has("invitationToken") || form.has("invitation")),
      Effect.orElseSucceed(() => false),
    );
  }
  return false;
});

export const makeAuthWithInvitationSignUp = Effect.fn("auth.invitationSetup")(function* (
  auth: Auth,
  config: AuthConfig,
  workspaces: Workspaces["Service"],
  clock: Clock.Clock,
) {
  // The normal OAuth provider initializes its resource rows before the invitation-only instance.
  yield* withDrizzleSqlContext(() => auth.$context);
  const verifiedEmails = new WeakMap<Request, string>();
  const options = authOptions({
    ...config,
    botProtection: {
      ...config.botProtection,
      verify: (scope, payload) =>
        config.botProtection.verify(scope === "sign_up" ? "invitation_accept" : scope, payload),
    },
    beforeHooks: [
      invitationSignUpHook(workspaces, clock, verifiedEmails),
      ...(config.beforeHooks ?? []),
    ],
  });

  // Only the invitation signup request reaches this instance. It uses the same credentials,
  // rate limits, CSRF checks and cookies, with the invitation supplying email verification.
  const invitationAuth = betterAuth({
    ...options,
    advanced: { ...options.advanced, disableOriginCheck: false },
    database: drizzleAdapter(config.db, { provider: "pg", schema: authTables, transaction: true }),
    emailAndPassword: { ...options.emailAndPassword, requireEmailVerification: false },
    emailVerification: { ...options.emailVerification, sendOnSignUp: false },
    logger: { level: "error", log: logInvitationSignUpError },
    onAPIError: { throw: true },
    databaseHooks: {
      user: {
        create: {
          before: (user, ctx) =>
            runAuthEffect(
              Effect.sync(() => {
                if (ctx?.path !== SIGN_UP_PATH || ctx.request === undefined) return false;
                if (verifiedEmails.get(ctx.request) !== user.email) return false;
                return { data: { emailVerified: true } };
              }),
            ),
        },
      },
    },
  });

  yield* withDrizzleSqlContext(() => invitationAuth.$context);
  const handleInvitationSignUp = Effect.fn("handleInvitationSignUp")(function* (request: Request) {
    if (!(yield* usesInvitation(request))) {
      return yield* withDrizzleSqlContext(() => auth.handler(request));
    }
    return yield* withDrizzleSqlContext(() => invitationAuth.handler(request)).pipe(
      Effect.catch(() =>
        Effect.logError("Invitation signup request failed").pipe(
          Effect.as(Response.json({ code: "InvitationSignupFailed" }, { status: 500 })),
        ),
      ),
    );
  });
  return { ...auth, handler: (request: Request) => runAuthEffect(handleInvitationSignUp(request)) };
});
