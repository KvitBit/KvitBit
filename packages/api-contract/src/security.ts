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
  Unavailable,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Str from "effect/String";
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
  "@kvitbit/api-contract/security/CurrentPrincipal",
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
const REQUEST_SCHEMA_ERROR_KINDS = ["Params", "Query", "Headers", "Payload"] as const;

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type IssuePath = ReadonlyArray<string | number>;

const toPathSegment = (segment: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = Predicate.isObjectOrArray(segment) ? segment.key : segment;
  return Predicate.isNumber(key) ? key : String(key);
};

const encodeIssuePath = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));

/**
 * The failing paths of a request decode error. Payload paths are the body's own field names and
 * array indices (what a form maps to its fields); params, query and headers paths start with the
 * slot (`["query", "limit"]`). A failure at the root of a slot keeps the slot alone.
 */
const requestIssuePaths = (
  error: HttpApiError.HttpApiSchemaError,
): readonly [IssuePath, ...Array<IssuePath>] => {
  const slot = Str.toLowerCase(error.kind);
  const paths = Arr.map(formatIssues(error.cause.issue).issues, (issue) =>
    Arr.map(issue.path ?? [], toPathSegment),
  );
  const prefixed = Arr.map(paths, (path) =>
    error.kind === "Payload" ? (path.length === 0 ? [slot] : path) : [slot, ...path],
  );
  const keyed = Arr.map(
    prefixed,
    (path) => [Result.getOrThrow(encodeIssuePath(path)), path] as const,
  );
  const [first = [slot], ...rest] = new Map(keyed).values();
  return [first, ...rest];
};

const malformed = ([first, ...rest]: readonly [IssuePath, ...Array<IssuePath>]) => {
  const issue = (path: IssuePath) => ({ path, code: "request.malformed" as const });
  return [issue(first), ...Arr.map(rest, issue)] as const;
};

/**
 * The SchemaErrors transform for `layerSchemaErrorTransform`: request decode failures become
 * `Invalid` with one `request.malformed` issue per failing path (422, section 3.3); response
 * encoding failures (`Body`, `ResponseHeaders`) pass through unchanged and stay 500 defects.
 */
export const schemaErrorToInvalid = Effect.fn(function* (error: HttpApiError.HttpApiSchemaError) {
  if (Arr.some(REQUEST_SCHEMA_ERROR_KINDS, (kind) => kind === error.kind)) {
    return yield* error.pipe(
      requestIssuePaths,
      malformed,
      (issues) => Invalid.make({ issues }),
      Effect.fail,
    );
  }
  return yield* Effect.fail(error);
});

/**
 * Session (cookie or bearer) or API Key. Provides the principal and an Account caller. Fails
 * only with Unauthorized; the other edge checks are EdgeGuard's.
 * HttpApiBuilder supplies these request services to authentication middleware.
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
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
  error: [NotFound.schema, Unavailable.schema, Forbidden.schema],
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
