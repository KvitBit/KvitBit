/**
 * Process configuration shared by every entrypoint. Names follow the Phase 3 runtime contract
 * agreed with phase3d-infra on board thread #871. Stream-specific settings live next to their
 * stream (`./<area>/config.ts`) and read their own variables.
 */
import { Config, Effect, Option, type Redacted, Schema } from "effect";

export type RunnerMode = "single" | "cluster";

export interface PostHogSettings {
  readonly apiKey: string;
  readonly host: string;
}

const postHogKey = Config.schema(
  Schema.Trim.check(Schema.isPattern(/^(?:phc_\S+)?$/)),
  "KVITBIT_POSTHOG_KEY",
).pipe(Config.withDefault(""));

const postHogHost = Config.schema(
  Schema.Trim.check(
    Schema.makeFilter((value) => {
      const url = URL.parse(value);
      return (
        (/^https:\/\//i.test(value) &&
          url?.protocol === "https:" &&
          !url.username &&
          !url.password) ||
        "Expected an HTTPS URL without credentials"
      );
    }),
  ),
  "KVITBIT_POSTHOG_HOST",
).pipe(Config.option);

export const PostHogConfig = Config.all({ apiKey: postHogKey, host: postHogHost }).pipe(
  Config.map(({ apiKey, host }): PostHogSettings | null =>
    apiKey === ""
      ? null
      : { apiKey, host: Option.getOrElse(host, () => "https://eu.i.posthog.com") },
  ),
);

export interface ServerConfigShape {
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

export const ServerConfig: Config.Config<ServerConfigShape> = Config.all({
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Int("PORT").pipe(Config.withDefault(8080)),
  appOrigin: Config.String("APP_ORIGIN").pipe(Config.withDefault("http://localhost:8080")),
  databaseUrl: Config.Redacted("DATABASE_URL"),
  runnerMode: Config.Literals(["single", "cluster"] as const, "KVITBIT_RUNNER_MODE").pipe(
    Config.withDefault("single" as const),
  ),
  authSecret: Config.Redacted("BETTER_AUTH_SECRET"),
  webDir: Config.option(Config.String("KVITBIT_WEB_DIR")),
  pwaDir: Config.option(Config.String("KVITBIT_PWA_DIR")),
  trustedProxyHops: Config.Int("KVITBIT_TRUSTED_PROXY_HOPS").pipe(Config.withDefault(1)),
});

export const loadServerConfig = Effect.gen(function* () {
  return yield* ServerConfig;
});
