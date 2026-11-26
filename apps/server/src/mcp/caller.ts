/**
 * Per-request MCP authentication, RFC 9728 protected resource metadata, and `MemberCaller`
 * resolution (http-mcp-contracts sections 6.2, 6.4; board agreements #887/#889).
 */
import {
  MCP_PATH,
  MCP_SERVER_NAME,
  OAUTH_SCOPES_SUPPORTED,
  type Principal,
  type PrincipalCredential,
  Unauthorized,
} from "@kvitbit/api-contract";
import { Caller, CurrentCaller, type MemberCaller, Workspaces } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import { PrincipalResolver } from "../auth/PrincipalResolver";
import type { McpConfigShape } from "./config";

export type McpGrantCredential = Extract<PrincipalCredential, { readonly _tag: "McpGrant" }>;

export interface AuthenticatedMcpCaller {
  readonly caller: MemberCaller;
  readonly principal: Principal;
  readonly grant: McpGrantCredential;
}

/**
 * RFC 9728 Protected Resource Metadata document (section 6.2 step 2).
 * Served at both `/.well-known/oauth-protected-resource` and
 * `/.well-known/oauth-protected-resource/mcp`.
 */
export const protectedResourceMetadata = (appOrigin: string) => ({
  resource: `${appOrigin}${MCP_PATH}`,
  authorization_servers: [`${appOrigin}/api/auth`],
  scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
  bearer_methods_supported: ["header"] as const,
  resource_name: MCP_SERVER_NAME,
  resource_documentation: `${appOrigin}/docs/mcp`,
});

/**
 * `WWW-Authenticate` header on HTTP 401 from `/mcp` (section 6.2 step 1; #887/#889).
 * Includes `error="invalid_token"` whenever a token was presented and rejected.
 */
export const wwwAuthenticateHeader = (
  appOrigin: string,
  reason: Unauthorized["reason"],
): string => {
  const resourceMetadata = `${appOrigin}/.well-known/oauth-protected-resource/mcp`;
  const base = `Bearer resource_metadata="${resourceMetadata}", scope="kvitbit:read"`;
  return reason === "missing" ? base : `${base}, error="invalid_token"`;
};

const toHeadersWebRequest = (request: HttpServerRequest, origin: string): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(new URL(request.url, origin).toString(), {
    method: request.method,
    headers,
  });
};

/**
 * Authenticates one `/mcp` request strictly through `PrincipalResolver.fromMcpBearer` (rule A1),
 * then enters the grant's Workspace via `Workspaces.enter` so membership and current role are
 * re-read on every request. Missing or revoked membership maps to `Unauthorized{invalid}`.
 */
export const authenticateMcpRequest = (
  request: HttpServerRequest,
  config: McpConfigShape,
): Effect.Effect<AuthenticatedMcpCaller, Unauthorized, PrincipalResolver | Workspaces> =>
  Effect.gen(function* () {
    const resolver = yield* PrincipalResolver;
    const workspaces = yield* Workspaces;
    const principal = yield* resolver.fromMcpBearer(toHeadersWebRequest(request, config.appOrigin));
    if (principal.credential._tag !== "McpGrant") {
      return yield* new Unauthorized({ reason: "invalid" });
    }
    const grant = principal.credential;
    const account = Caller.account({
      userId: principal.userId,
      email: principal.email,
      locale: principal.locale,
      channel: "mcp",
    });
    const caller = yield* workspaces
      .enter(grant.workspaceId, {
        scopes: grant.scopes,
        channel: "mcp",
        client: { kind: "mcp", id: grant.grantId, name: grant.clientName },
      })
      .pipe(
        Effect.provideService(CurrentCaller, account),
        Effect.catchTag("NotFound", () => Effect.fail(new Unauthorized({ reason: "invalid" }))),
        Effect.catchTag("Forbidden", () => Effect.fail(new Unauthorized({ reason: "invalid" }))),
        Effect.catchTag("Unavailable", () => Effect.fail(new Unauthorized({ reason: "invalid" }))),
      );
    return { caller, principal, grant };
  });
