/**
 * Seam between the HTTP stream (owner of `src/auth/**`, which implements it over Better Auth
 * and `kvb_` API keys) and the MCP stream (which consumes `fromMcpBearer`). Rule A1: MCP
 * access tokens are only accepted by `fromMcpBearer`, sessions and API keys only by
 * `fromApiRequest` (http-mcp-contracts 2.1).
 */
import type { Principal, Unauthorized } from "@kvitbit/api-contract";
import { Context, type Effect } from "effect";

export interface PrincipalResolverShape {
  /** Session cookie, session bearer or `kvb_` API key -> principal (channel web|mobile|api). */
  readonly fromApiRequest: (request: Request) => Effect.Effect<Principal, Unauthorized>;
  /**
   * OAuth 2.1 access token bound to the `/mcp` audience -> principal with a `McpGrant`
   * credential (channel mcp). Anything else is `Unauthorized`.
   */
  readonly fromMcpBearer: (request: Request) => Effect.Effect<Principal, Unauthorized>;
}

export class PrincipalResolver extends Context.Service<PrincipalResolver, PrincipalResolverShape>()(
  "kvitbit/server/PrincipalResolver",
) {}
