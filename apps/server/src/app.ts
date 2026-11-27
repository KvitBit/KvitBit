/**
 * Complete HTTP application composition for `@kvitbit/server`:
 * merges REST (`/api/v1/*`), Auth (`/api/auth/*`, RFC 8414), Health (`/healthz`, `/readyz`),
 * MCP Streamable HTTP (`/mcp`, RFC 9728), Mobile OTA/APK/App Links (`/api/mobile/*`,
 * `/.well-known/assetlinks.json`), and static web/PWA mounts (`/app/*`, `/*`).
 */
import { Config, Effect, Layer, Option } from "effect";
import {
  AltchaBotProtectionConfig,
  AuthServerLive,
  NoopBotProtection,
  PrincipalResolverLive,
} from "./auth";
import { HttpConfigLive, HttpRoutesLive, RateLimiterSql } from "./http";
import { MobileConfigLive, MobileRoutesLive, MobileStorageLive } from "./http/mobile";
import { McpConfigLive, McpRoutesLive } from "./mcp";

/**
 * BotProtection from the environment: ALTCHA PoW v2 when `ALTCHA_HMAC_KEY` is configured,
 * otherwise `NoopBotProtection` (matching `HttpConfigLive.botProtection`).
 */
export const BotProtectionLive = Layer.unwrap(
  Effect.gen(function* () {
    const key = yield* Config.option(Config.Redacted("ALTCHA_HMAC_KEY"));
    return Option.isSome(key) ? AltchaBotProtectionConfig() : NoopBotProtection;
  }),
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
