/**
 * Public entry point of `apps/server/src/auth`: exports the parent-owned seam tags alongside
 * their live implementations and the Better Auth / RFC 8414 router layer.
 */
export {
  AltchaBotProtection,
  AltchaBotProtectionConfig,
  BotProtection,
  NoopBotProtection,
} from "@kvitbit/adapters/altcha";
export { AuthServer } from "./AuthServer";
export { AuthServerLive, type AuthServerOverrides, makeAuthServerLayer } from "./AuthServerLive";
export { makeDrizzleOverSqlClient } from "./drizzleBridge";
export { PrincipalResolver, type PrincipalResolverShape } from "./PrincipalResolver";
export { PrincipalResolverLive } from "./PrincipalResolverLive";
export { AuthRoutesLive } from "./routes";
