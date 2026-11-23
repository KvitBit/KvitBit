/**
 * Middleware and security tags (http-mcp-contracts section 2.3). apps/server implements them;
 * this package only declares what each provides, requires and fails with.
 *
 * effect 4.1.4 takes `provides` and `requires` as type parameters of
 * `HttpApiMiddleware.Service<Self, { provides; requires }>()`, not as runtime options.
 *
 * Execution order. HttpApiBuilder wraps the handler with an endpoint's middleware in the order
 * they were added, so the last one added runs first (outermost). `.middleware()` on a group or
 * the API appends to the endpoints already added. Groups therefore add, innermost first,
 * WorkspaceMember, SessionOnly, EdgeGuard, Authentication, and the API adds SchemaErrors
 * last, giving SchemaErrors → Authentication → EdgeGuard → SessionOnly → WorkspaceMember →
 * handler.
 */

import {
  Channel,
  type CurrentCaller,
  Forbidden,
  Invalid,
  Locale,
  NotFound,
  Scope,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Effect, Schema } from "effect";
import { type HttpApiError, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
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
 * Request decode failures (params, query, headers, payload) as `Invalid` with code
 * `request.malformed` (section 3.3), so typed clients see 422 in the endpoint error union.
 * Declared API-wide and outermost. apps/server provides it with
 * `HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrors, schemaErrorToInvalid)`.
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "kvitbit/edge/SchemaErrors",
  { error: Invalid.schema },
) {}

/** `HttpApiSchemaError` kinds raised while decoding the request; the others are response-side. */
export const REQUEST_SCHEMA_ERROR_KINDS = ["Params", "Query", "Headers", "Payload"] as const;

/**
 * The SchemaErrors transform for `layerSchemaErrorTransform`: request decode failures become
 * `Invalid` with code `request.malformed` (422); response encoding failures (`Body`,
 * `ResponseHeaders`) pass through unchanged and stay 500 defects.
 */
export const schemaErrorToInvalid = (
  error: HttpApiError.HttpApiSchemaError,
): Effect.Effect<never, Invalid | HttpApiError.HttpApiSchemaError> =>
  REQUEST_SCHEMA_ERROR_KINDS.some((kind) => kind === error.kind)
    ? Effect.fail(
        new Invalid({ issues: [{ path: [error.kind.toLowerCase()], code: "request.malformed" }] }),
      )
    : Effect.fail(error);

/**
 * Session (cookie or bearer) or API Key. Provides the principal and an Account caller. Fails
 * only with Unauthorized; the other edge checks are EdgeGuard's.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal | CurrentCaller }
>()("kvitbit/edge/Authentication", {
  error: Unauthorized.schema,
  security: {
    session: HttpApiSecurity.apiKey({ in: "cookie", key: SESSION_COOKIE }),
    bearer: HttpApiSecurity.bearer,
  },
}) {}

/**
 * Edge checks every authenticated request passes after Authentication (section 3.5
 * preamble): Origin on cookie sessions, per-principal rate limits, body size.
 */
export class EdgeGuard extends HttpApiMiddleware.Service<
  EdgeGuard,
  { requires: CurrentPrincipal }
>()("kvitbit/edge/EdgeGuard", {
  error: [OriginRejected.schema, RateLimited.schema, PayloadTooLarge.schema],
}) {}

/** Replaces CurrentCaller with the MemberCaller from Workspaces.enter. Needs Authentication. */
export class WorkspaceMember extends HttpApiMiddleware.Service<
  WorkspaceMember,
  { provides: CurrentCaller; requires: CurrentPrincipal | CurrentCaller }
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
