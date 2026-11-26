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
  deriveConfirmationKey,
  McpConfig,
  McpConfigLive,
  type McpConfigShape,
  McpConfigTest,
  makeMcpConfig,
} from "./config";
export {
  type ConfirmationContext,
  ConsumedConfirmationCache,
  type MintedConfirmation,
  mintConfirmationToken,
  type VerifiedConfirmation,
  verifyConfirmationToken,
} from "./confirmation";
export { McpRoutesLive } from "./routes";
