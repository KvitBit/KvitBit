/**
 * Remote MCP Streamable HTTP server for `@kvitbit/server` (http-mcp-contracts section 6).
 */
export {
  type AuthenticatedMcpCaller,
  authenticateMcpRequest,
  type McpGrantCredential,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
} from "./caller";
export {
  McpConfig,
  McpConfigLive,
  type McpConfigShape,
  McpConfigTest,
  makeMcpConfig,
} from "./config";
export { McpRoutesLive } from "./routes";
