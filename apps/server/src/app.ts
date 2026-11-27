/**
 * Complete HTTP application composition for `@kvitbit/server`:
 * merges REST (`/api/v1/*`), Auth (`/api/auth/*`, RFC 8414), Health (`/healthz`, `/readyz`),
 * MCP Streamable HTTP (`/mcp`, RFC 9728), Mobile OTA/APK/App Links (`/api/mobile/*`,
 * `/.well-known/assetlinks.json`), and static web/PWA mounts (`/app/*`, `/*`).
 */
import { Effect, Layer, Redacted } from "effect";
import {
  AltchaBotProtection,
  AuthServerLive,
  NoopBotProtection,
  PrincipalResolverLive,
} from "./auth";
import { loadBotProtectionConfig } from "./config-contract";
import { HttpConfigLive, HttpRoutesLive, RateLimiterSql } from "./http";
import { MobileConfigLive, MobileRoutesLive, MobileStorageLive } from "./http/mobile";
import { McpConfigLive, McpRoutesLive } from "./mcp";

/**
 * BotProtection from the validated typed-mode contract: ALTCHA PoW v2 when active,
 * `NoopBotProtection` only when explicitly permitted in non-production (matching
 * `HttpConfigLive.botProtection`). Fails fast in production/staging/preview when
 * `ALTCHA_HMAC_KEY` is missing or whitespace-only without an allowed explicit mode.
 */
export const BotProtectionLive = Layer.unwrap(
  Effect.map(loadBotProtectionConfig, (resolved) =>
    resolved.mode === "altcha" && resolved.hmacKey !== undefined
      ? AltchaBotProtection({ hmacKey: Redacted.make(resolved.hmacKey) })
      : NoopBotProtection,
  ),
);

/** All route groups registered on the `effect/http` `HttpRouter`. */
export const AllRoutesLive = Layer.mergeAll(McpRoutesLive, MobileRoutesLive, HttpRoutesLive);

/** All edge dependencies (config, auth, principal resolver, rate limiter, bot protection, mobile storage). */
export const EdgeServicesLive = Layer.mergeAll(
  HttpConfigLive,
  McpConfigLive,
  MobileConfigLive,
  MobileStorageLive.pipe(Layer.provide(MobileConfigLive)),
  RateLimiterSql,
  BotProtectionLive,
  PrincipalResolverLive.pipe(
    Layer.provideMerge(AuthServerLive.pipe(Layer.provide(BotProtectionLive))),
  ),
).pipe(Layer.provideMerge(HttpConfigLive));
