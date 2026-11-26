/**
 * Settings for the remote MCP adapter (http-mcp-contracts section 6).
 * Reads shared settings from `ServerConfig` and derives the stateless confirmation HMAC key
 * via HKDF-SHA256 from `BETTER_AUTH_SECRET`.
 */
import { hkdfSync } from "node:crypto";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import { ServerConfig } from "../config";

const CONFIRMATION_HKDF_SALT = "kvitbit-mcp-confirmation-salt-v1";
const CONFIRMATION_HKDF_INFO = "kvitbit:mcp:confirmation:v1";

export interface McpConfigShape {
  /** Public origin, no trailing slash (APP_ORIGIN). */
  readonly appOrigin: string;
  /** Origins allowed in the `Origin` header on `/mcp` requests (empty/absent Origin is allowed). */
  readonly trustedOrigins: ReadonlySet<string>;
  /** 32-byte HKDF-derived key for stateless confirmation tokens. */
  readonly confirmationKey: Redacted.Redacted<Uint8Array>;
  /** Server version advertised in MCP `serverInfo`. */
  readonly version: string;
}

export class McpConfig extends Context.Service<McpConfig, McpConfigShape>()(
  "kvitbit/server/mcp/McpConfig",
) {}

export const deriveConfirmationKey = (authSecret: Redacted.Redacted<string>): Uint8Array =>
  new Uint8Array(
    hkdfSync(
      "sha256",
      Buffer.from(Redacted.value(authSecret), "utf8"),
      Buffer.from(CONFIRMATION_HKDF_SALT, "utf8"),
      Buffer.from(CONFIRMATION_HKDF_INFO, "utf8"),
      32,
    ),
  );

const originList = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((raw) =>
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => new URL(entry).origin),
    ),
  );

export const makeMcpConfig = (base: {
  readonly appOrigin: string;
  readonly authSecret: Redacted.Redacted<string>;
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly version?: string;
}): McpConfigShape => {
  const appOrigin = new URL(base.appOrigin).origin;
  return {
    appOrigin,
    trustedOrigins: new Set([appOrigin, ...(base.trustedOrigins ?? [])]),
    confirmationKey: Redacted.make(deriveConfirmationKey(base.authSecret)),
    version: base.version ?? "0.0.0",
  };
};

/** `McpConfig` from the process environment (`ServerConfig` + optional MCP-relevant overrides). */
export const McpConfigLive: Layer.Layer<McpConfig, Config.ConfigError> = Layer.effect(
  McpConfig,
  Effect.gen(function* () {
    const server = yield* ServerConfig;
    const trustedOrigins = yield* originList("KVITBIT_TRUSTED_ORIGINS");
    const version = yield* Config.String("KVITBIT_VERSION").pipe(Config.withDefault("0.0.0"));
    return makeMcpConfig({
      appOrigin: server.appOrigin,
      authSecret: server.authSecret,
      trustedOrigins,
      version,
    });
  }),
);

/** Fixed `McpConfig` for tests. */
export const McpConfigTest = (
  overrides: Partial<Parameters<typeof makeMcpConfig>[0]> = {},
): Layer.Layer<McpConfig> =>
  Layer.succeed(
    McpConfig,
    makeMcpConfig({
      appOrigin: "https://kvitbit.test",
      authSecret: Redacted.make("test-mcp-auth-secret-at-least-32-bytes"),
      version: "0.0.0-test",
      ...overrides,
    }),
  );
