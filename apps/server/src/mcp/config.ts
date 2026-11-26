/**
 * Settings for the remote MCP adapter (http-mcp-contracts section 6).
 * Reads shared settings from `ServerConfig`.
 */
import { Config, Context, Effect, Layer } from "effect";
import { ServerConfig } from "../config";

export interface McpConfigShape {
  /** Public origin, no trailing slash (APP_ORIGIN). */
  readonly appOrigin: string;
  /** Origins allowed in the `Origin` header on `/mcp` requests (empty/absent Origin is allowed). */
  readonly trustedOrigins: ReadonlySet<string>;
  /** Server version advertised in MCP `serverInfo`. */
  readonly version: string;
}

export class McpConfig extends Context.Service<McpConfig, McpConfigShape>()(
  "kvitbit/server/mcp/McpConfig",
) {}

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
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly version?: string;
}): McpConfigShape => {
  const appOrigin = new URL(base.appOrigin).origin;
  return {
    appOrigin,
    trustedOrigins: new Set([appOrigin, ...(base.trustedOrigins ?? [])]),
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
      version: "0.0.0-test",
      ...overrides,
    }),
  );
