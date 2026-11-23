/**
 * Middleware and security tags (http-mcp-contracts section 2.3). apps/server implements them;
 * this package only declares what each provides, requires and fails with.
 *
 * effect 4.1.4 takes `provides` and `requires` as type parameters of
 * `HttpApiMiddleware.Service<Self, { provides; requires }>()`, not as runtime options.
 */

import {
  Channel,
  type CurrentCaller,
  Forbidden,
  Locale,
  NotFound,
  Scope,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { ApiKeyId } from "./api-key";
import { OriginRejected, PayloadTooLarge, RateLimited, Unauthorized } from "./edge-errors";

export const SESSION_COOKIE = "__Secure-kvitbit.session_token";

/** How the credential was presented and what it is bound to. Built only by apps/server. */
export const PrincipalCredential = Schema.Union([
  Schema.TaggedStruct("Session", { sessionId: Schema.String, authenticatedAt: Schema.String }),
  Schema.TaggedStruct("ApiKey", {
    keyId: ApiKeyId,
    keyName: Schema.String,
    workspaceId: WorkspaceId,
    scopes: Schema.Array(Scope),
  }),
  Schema.TaggedStruct("McpGrant", {
    grantId: Schema.String,
    clientId: Schema.String,
    clientName: Schema.String,
    workspaceId: WorkspaceId,
    scopes: Schema.Array(Scope),
  }),
]);
export type PrincipalCredential = typeof PrincipalCredential.Type;

/** What a verified credential proves. */
export const Principal = Schema.Struct({
  userId: UserId,
  email: Schema.String,
  channel: Channel,
  credential: PrincipalCredential,
  locale: Locale, // account preference, else Accept-Language, else "cs"
});
export type Principal = typeof Principal.Type;

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "kvitbit/edge/Principal",
) {}

/**
 * Session (cookie or bearer) or API Key. Provides the principal and an Account caller. Its
 * errors are the ones every authenticated endpoint can return (section 3.5 preamble).
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal | CurrentCaller }
>()("kvitbit/edge/Authentication", {
  error: [Unauthorized.schema, OriginRejected.schema, RateLimited.schema, PayloadTooLarge.schema],
  security: {
    session: HttpApiSecurity.apiKey({ in: "cookie", key: SESSION_COOKIE }),
    bearer: HttpApiSecurity.bearer,
  },
}) {}

/** Replaces CurrentCaller with the MemberCaller from Workspaces.enter. Needs Authentication. */
export class WorkspaceMember extends HttpApiMiddleware.Service<
  WorkspaceMember,
  { provides: CurrentCaller; requires: CurrentPrincipal }
>()("kvitbit/edge/WorkspaceMember", {
  error: [NotFound.schema, Forbidden.schema],
}) {}

/** Session only: rejects API Keys on account endpoints (rule A4). */
export class SessionOnly extends HttpApiMiddleware.Service<
  SessionOnly,
  { requires: CurrentPrincipal }
>()("kvitbit/edge/SessionOnly", {
  error: Unauthorized.schema,
}) {}

/** Public Share Link visitor. Provides Caller.shareLinkVisitor from the {token} path segment. */
export class ShareLinkVisitor extends HttpApiMiddleware.Service<
  ShareLinkVisitor,
  { provides: CurrentCaller }
>()("kvitbit/edge/ShareLinkVisitor", {
  error: RateLimited.schema,
}) {}
