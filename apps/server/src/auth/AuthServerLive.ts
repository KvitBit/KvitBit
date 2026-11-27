/**
 * Live Better Auth service (`AuthServerLive`), wrapping `@kvitbit/adapters/auth` `makeAuth`
 * with transactional email rendering (E01-E03, E07), ALTCHA bot protection, per-email rate
 * limiting, invitation signup, and the Workspace-ownership account deletion guard.
 */
import { BotProtection } from "@kvitbit/adapters/altcha";
import { type AuthConfig, generateId, makeEmailRateLimiter } from "@kvitbit/adapters/auth";
import { type EmailTemplate, renderEmail } from "@kvitbit/adapters/templates/email";
import { Caller, CurrentCaller, type Locale, UserId, Workspaces } from "@kvitbit/domain/contract";
import { EmailSender } from "@kvitbit/domain/ports";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { Clock, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { HttpConfig } from "../http/config";
import { acceptLanguageLocale } from "../http/edge/request";
import { Analytics } from "../runtime/analytics";
import { AuthServer } from "./AuthServer";
import { makeDrizzleOverSqlClient } from "./drizzleBridge";
import { makeAuthWithInvitationSignUp, SIGN_UP_PATH } from "./invitationSignUp";
import { makeAuthEffectRunner } from "./logging";
import { makeWorkspaceAuth } from "./oauthWorkspace";

const DEFAULT_LINK_VALID_MINUTES = 60;

export interface AuthServerOverrides {
  readonly fetchClientMetadata?: AuthConfig["fetchClientMetadata"];
  readonly beforeHooks?: AuthConfig["beforeHooks"];
  readonly rpName?: string;
}

const requestLocale = (request?: Request): Locale =>
  acceptLanguageLocale(request?.headers.get("accept-language") ?? undefined) ?? "cs";

/** Builds an `AuthServer` layer with optional overrides (e.g. test CIMD fetch transport). */
export const makeAuthServerLayer = (overrides: AuthServerOverrides = {}) =>
  Layer.effect(
    AuthServer,
    Effect.gen(function* () {
      const config = yield* HttpConfig;
      const analytics = yield* Analytics;
      const sql = yield* SqlClient.SqlClient;
      const botProtection = yield* BotProtection;
      const emailSender = yield* EmailSender;
      const workspaces = yield* Workspaces;
      const clock = yield* Clock.Clock;
      const emailRateLimiter = yield* makeEmailRateLimiter();
      const runAuthEffect = yield* makeAuthEffectRunner;

      const db = makeDrizzleOverSqlClient(sql);
      const rpID = new URL(config.appOrigin).hostname;

      const sendTemplate = async (
        to: string,
        template: EmailTemplate,
        request?: Request,
      ): Promise<void> => {
        const locale = requestLocale(request);
        const rendered = renderEmail(template, locale);
        await runAuthEffect(
          emailSender.send(
            {
              to: [to],
              replyTo: `noreply@${rpID}`,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              attachments: [],
              tags: { template: template.id },
            },
            { idempotencyKey: `auth:${template.id}:${generateId()}` },
          ),
        );
      };

      const authConfig: AuthConfig = {
        baseURL: config.appOrigin,
        secret: config.visitorSecret,
        db,
        rpID,
        rpName: overrides.rpName ?? "Kvitbit",
        trustedOrigins: [...config.trustedOrigins],
        oauthLoginPage: "/sign-in",
        oauthConsentPage: "/oauth/consent",
        mcpResource: `${config.appOrigin}/mcp`,
        botProtection,
        emailRateLimiter,
        ...(overrides.fetchClientMetadata === undefined
          ? {}
          : { fetchClientMetadata: overrides.fetchClientMetadata }),
        ...(overrides.beforeHooks === undefined ? {} : { beforeHooks: overrides.beforeHooks }),
        sendVerificationEmail: ({ user, url }, request) =>
          sendTemplate(
            user.email,
            {
              id: "E01",
              variant: "verify",
              url,
              validForMinutes: DEFAULT_LINK_VALID_MINUTES,
            },
            request,
          ),
        sendResetPassword: ({ user, url }, request) =>
          sendTemplate(
            user.email,
            {
              id: "E03",
              email: user.email,
              url,
              validForMinutes: DEFAULT_LINK_VALID_MINUTES,
            },
            request,
          ),
        sendMagicLink: ({ email, url }, request) =>
          sendTemplate(
            email,
            {
              id: "E02",
              email,
              url,
              validForMinutes: 15,
            },
            request,
          ),
        sendChangeEmailConfirmation: ({ user, newEmail, url }, request) =>
          sendTemplate(
            newEmail,
            {
              id: "E07",
              variant: "confirm_new",
              oldEmail: user.email,
              newEmail,
              url,
              validForMinutes: DEFAULT_LINK_VALID_MINUTES,
            },
            request,
          ),
        beforeDeleteUser: async (deleted, request) => {
          const accountCaller = Caller.account({
            userId: UserId.make(deleted.id),
            email: deleted.email,
            locale: requestLocale(request),
            channel: "web",
          });
          const list = await runAuthEffect(
            workspaces.listMine.pipe(Effect.provideService(CurrentCaller, accountCaller)),
          );
          if (list.some((ws) => ws.role === "owner")) {
            throw new APIError("CONFLICT", {
              code: "WORKSPACE_OWNER",
              message: "Transfer or close owned workspaces before deleting your account.",
            });
          }
        },
      };

      // A duplicate email signup can return 200 with a synthetic user. The database
      // hook marks real creations, and the handler confirms the request succeeded.
      const signUps = new WeakMap<Request, string>();
      const signupHooks = {
        user: {
          create: {
            after: async (user, ctx) => {
              if (ctx?.path === SIGN_UP_PATH && ctx.request !== undefined) {
                signUps.set(ctx.request, user.id);
              }
            },
          },
        },
      } satisfies NonNullable<BetterAuthOptions["databaseHooks"]>;

      const auth = makeWorkspaceAuth(sql, authConfig, runAuthEffect, signupHooks);
      const withInvitations = yield* Effect.promise(() =>
        makeAuthWithInvitationSignUp(auth, authConfig, workspaces, clock, runAuthEffect, {
          databaseHooks: signupHooks,
          capture: async (request, method) => {
            const userId = signUps.get(request);
            if (userId !== undefined) {
              await runAuthEffect(analytics.capture({ event: "user_signed_up", userId, method }));
            }
          },
        }),
      );
      return AuthServer.of(withInvitations);
    }),
  );

/** Production `AuthServer` layer. */
export const AuthServerLive = makeAuthServerLayer();
