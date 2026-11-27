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
import { Clock, Effect, Result } from "effect";
import { acceptLanguageLocale } from "../http/edge/request";
import type { AuthEffectRunner } from "./logging";

const SIGN_UP_PATH = "/sign-up/email";

const isInvitationSignUp = (body: unknown): body is Record<string, unknown> =>
  typeof body === "object" &&
  body !== null &&
  (Object.hasOwn(body, "invitationToken") || Object.hasOwn(body, "invitation"));

// Web sends invitationToken and the native client sends invitation. Both are explicit opt-ins.
const readInvitationToken = (body: Record<string, unknown>) => {
  const web = Object.hasOwn(body, "invitationToken");
  const native = Object.hasOwn(body, "invitation");
  if (web && native && body.invitationToken !== body.invitation) return undefined;
  const token = web ? body.invitationToken : body.invitation;
  return typeof token === "string" && token.length > 0 ? InvitationToken.make(token) : undefined;
};

const invitationNotFound = () =>
  new APIError("NOT_FOUND", { _tag: "NotFound", code: "InvitationNotFound" });

const invitationSignUpHook = (
  workspaces: Workspaces["Service"],
  clock: Clock.Clock,
  verifiedEmails: WeakMap<Request, string>,
  runAuthEffect: AuthEffectRunner,
): BeforeHook => ({
  matcher: (ctx) => ctx.path === SIGN_UP_PATH,
  handler: createAuthMiddleware(async (ctx) => {
    const token = isInvitationSignUp(ctx.body) ? readInvitationToken(ctx.body) : undefined;
    if (token === undefined || ctx.request === undefined) {
      throw new APIError("BAD_REQUEST", { code: "InvalidInvitation" });
    }

    const invitation = await runAuthEffect(
      Effect.result(
        workspaces.peekInvitation.pipe(
          Effect.provideService(
            CurrentCaller,
            Caller.invitationHolder({
              token,
              locale:
                acceptLanguageLocale(ctx.headers?.get("accept-language") ?? undefined) ?? "cs",
            }),
          ),
          Effect.provideService(Clock.Clock, clock),
        ),
      ),
    );
    if (Result.isFailure(invitation)) {
      if (invitation.failure._tag === "Unavailable") {
        throw new APIError(
          "SERVICE_UNAVAILABLE",
          { _tag: "Unavailable", code: "Unavailable" },
          { "Retry-After": "5" },
        );
      }
      throw invitationNotFound();
    }
    if (invitation.success.status !== "pending") throw invitationNotFound();
    const email = invitation.success.email.toLowerCase();
    if (typeof ctx.body.email !== "string" || ctx.body.email.toLowerCase() !== email) {
      throw new APIError("FORBIDDEN", { code: "InvitationEmailMismatch" });
    }
    verifiedEmails.set(ctx.request, email);
  }),
});

const usesInvitation = async (request: Request): Promise<boolean> => {
  if (request.method !== "POST" || new URL(request.url).pathname !== `/api/auth${SIGN_UP_PATH}`) {
    return false;
  }
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const readBody = async () => {
    if (mediaType === "application/json") return request.clone().json();
    if (mediaType === "application/x-www-form-urlencoded") {
      return Object.fromEntries(await request.clone().formData());
    }
    return undefined;
  };
  // Better Auth handles malformed bodies and unsupported media types through its usual handler.
  return isInvitationSignUp(await readBody().catch(() => undefined));
};

export const makeAuthWithInvitationSignUp = async (
  auth: Auth,
  config: AuthConfig,
  workspaces: Workspaces["Service"],
  clock: Clock.Clock,
  runAuthEffect: AuthEffectRunner,
) => {
  // The normal OAuth provider initializes its resource rows before the invitation-only instance.
  await auth.$context;
  const verifiedEmails = new WeakMap<Request, string>();
  const options = authOptions({
    ...config,
    botProtection: {
      ...config.botProtection,
      verify: (scope, payload) =>
        config.botProtection.verify(scope === "sign_up" ? "invitation_accept" : scope, payload),
    },
    beforeHooks: [
      invitationSignUpHook(workspaces, clock, verifiedEmails, runAuthEffect),
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
    logger: { disabled: true },
    onAPIError: { throw: true },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (ctx?.path !== SIGN_UP_PATH || ctx.request === undefined) return false;
            if (verifiedEmails.get(ctx.request) !== user.email) return false;
            return { data: { emailVerified: true } };
          },
        },
      },
    },
  });

  await invitationAuth.$context;
  return {
    ...auth,
    handler: async (request: Request) => {
      if (!(await usesInvitation(request))) return auth.handler(request);
      try {
        return await invitationAuth.handler(request);
      } catch {
        await runAuthEffect(Effect.logError("Invitation signup request failed"));
        return Response.json({ code: "InvitationSignupFailed" }, { status: 500 });
      }
    },
  };
};
