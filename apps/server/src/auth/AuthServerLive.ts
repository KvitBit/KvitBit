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
import { APIError } from "better-auth/api";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpConfig } from "../http/config";
import { acceptLanguageLocale } from "../http/edge/request";
import { AuthServer } from "./AuthServer";
import { makeDrizzleOverSqlClient, runAuthEffect } from "./drizzleBridge";
import { makeAuthWithInvitationSignUp } from "./invitationSignUp";
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
      const sql = yield* SqlClient.SqlClient;
      const botProtection = yield* BotProtection;
      const emailSender = yield* EmailSender;
      const workspaces = yield* Workspaces;
      const clock = yield* Clock.Clock;
      const emailRateLimiter = yield* makeEmailRateLimiter();

      const db = makeDrizzleOverSqlClient(sql);
      const rpID = new URL(config.appOrigin).hostname;

      const sendTemplate = Effect.fn("sendAuthTemplate")(function* (
        to: string,
        template: EmailTemplate,
        request?: Request,
      ) {
        const rendered = renderEmail(template, requestLocale(request));
        yield* emailSender.send(
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
        );
      });

      const checkAccountDeletion = Effect.fn("checkAccountDeletion")(function* (
        deleted: Parameters<NonNullable<AuthConfig["beforeDeleteUser"]>>[0],
        request?: Request,
      ) {
        const accountCaller = Caller.account({
          userId: UserId.make(deleted.id),
          email: deleted.email,
          locale: requestLocale(request),
          channel: "web",
        });
        const list = yield* workspaces.listMine.pipe(
          Effect.provideService(CurrentCaller, accountCaller),
        );
        if (Arr.some(list, (workspace) => workspace.role === "owner")) {
          return yield* Effect.fail(
            new APIError("CONFLICT", {
              code: "WORKSPACE_OWNER",
              message: "Transfer or close owned workspaces before deleting your account.",
            }),
          );
        }
      });

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
          ? undefined
          : { fetchClientMetadata: overrides.fetchClientMetadata }),
        ...(overrides.beforeHooks === undefined
          ? undefined
          : { beforeHooks: overrides.beforeHooks }),
        sendVerificationEmail: ({ user, url }, request) =>
          runAuthEffect(
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
          ),
        sendResetPassword: ({ user, url }, request) =>
          runAuthEffect(
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
          ),
        sendMagicLink: ({ email, url }, request) =>
          runAuthEffect(
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
          ),
        sendChangeEmailConfirmation: ({ user, newEmail, url }, request) =>
          runAuthEffect(
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
          ),
        beforeDeleteUser: (deleted, request) =>
          runAuthEffect(checkAccountDeletion(deleted, request)),
      };

      const auth = yield* makeWorkspaceAuth(sql)(authConfig).pipe(Effect.orDie);
      const withInvitations = yield* makeAuthWithInvitationSignUp(
        auth,
        authConfig,
        workspaces,
        clock,
      ).pipe(Effect.orDie);
      return AuthServer.of(withInvitations);
    }),
  );

/** Production `AuthServer` layer. */
export const AuthServerLive = makeAuthServerLayer();
