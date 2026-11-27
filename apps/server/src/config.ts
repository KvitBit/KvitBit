/**
 * Process configuration shared by every entrypoint. Names follow the Phase 3 runtime contract
 * agreed with phase3d-infra on board thread #871. Stream-specific settings live next to their
 * stream (`./<area>/config.ts`) and read their own variables.
 */
import { Config, Effect, type Option, Redacted } from "effect";
import {
  InvalidRuntimeConfig,
  type KvitbitEnv,
  loadKvitbitEnv,
  loadValidatedAppOrigin,
  toConfigError,
} from "./config-contract";

export type RunnerMode = "single" | "cluster";

export interface ServerConfigShape {
  readonly env: KvitbitEnv;
  readonly host: string;
  readonly port: number;
  /** Public origin, e.g. `https://kvitbit.cz` (APP_ORIGIN). */
  readonly appOrigin: string;
  /** Pooled runtime-role URL (DATABASE_URL). */
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly runnerMode: RunnerMode;
  readonly authSecret: Redacted.Redacted<string>;
  /** Static roots; absent directories are simply not mounted. */
  readonly webDir: Option.Option<string>;
  readonly pwaDir: Option.Option<string>;
  /** Number of trusted reverse-proxy hops for X-Forwarded-For (default 1). */
  readonly trustedProxyHops: number;
}

const requireNonEmptyRedacted = (
  name: string,
): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> =>
  Effect.gen(function* () {
    const value = yield* Config.Redacted(name);
    if (Redacted.value(value).trim().length === 0) {
      return yield* Effect.fail(
        toConfigError(
          new InvalidRuntimeConfig({ field: name, reason: `${name} must be non-empty` }),
        ),
      );
    }
    return value;
  });

export const ServerConfig: Effect.Effect<ServerConfigShape, Config.ConfigError> = Effect.gen(
  function* () {
    const env = yield* loadKvitbitEnv;
    const host = yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0"));
    const port = yield* Config.Int("PORT").pipe(Config.withDefault(8080));
    const appOrigin = yield* loadValidatedAppOrigin;
    const databaseUrl = yield* requireNonEmptyRedacted("DATABASE_URL");
    const runnerMode = yield* Config.Literals(
      ["single", "cluster"] as const,
      "KVITBIT_RUNNER_MODE",
    ).pipe(Config.withDefault("single" as const));
    const authSecret = yield* requireNonEmptyRedacted("BETTER_AUTH_SECRET");
    const webDir = yield* Config.option(Config.String("KVITBIT_WEB_DIR"));
    const pwaDir = yield* Config.option(Config.String("KVITBIT_PWA_DIR"));
    const trustedProxyHops = yield* Config.Int("KVITBIT_TRUSTED_PROXY_HOPS").pipe(
      Config.withDefault(1),
    );
    return {
      env,
      host,
      port,
      appOrigin,
      databaseUrl,
      runnerMode,
      authSecret,
      webDir,
      pwaDir,
      trustedProxyHops,
    } satisfies ServerConfigShape;
  },
);

export const loadServerConfig = ServerConfig;
