/**
 * Settings of the HTTP edge (http-mcp-contracts section 1). The shared process settings come
 * from `ServerConfig`; the variables below are read only by this stream.
 */
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { ServerConfig } from "../config";
import { type FeedbackConfig, makeFeedbackConfig } from "./feedback/access";

export interface HttpConfigShape {
  /** Public origin, no trailing slash (APP_ORIGIN). */
  readonly appOrigin: string;
  /**
   * Origins trusted for cookie writes (rule A5): the app origin plus KVITBIT_TRUSTED_ORIGINS.
   */
  readonly trustedOrigins: ReadonlySet<string>;
  /** Extra origins allowed to call `/api/v1` cross-origin (KVITBIT_CORS_ORIGINS); none by default. */
  readonly corsOrigins: ReadonlyArray<string>;
  /** Reverse-proxy hops whose `X-Forwarded-For` entries are trusted (KVITBIT_TRUSTED_PROXY_HOPS). */
  readonly trustedProxyHops: number;
  readonly webDir: Option.Option<string>;
  readonly pwaDir: Option.Option<string>;
  /** Reported by `GET /api/v1/config` (KVITBIT_VERSION). */
  readonly version: string;
  /** `GET /api/v1/config` `features.signUp` (KVITBIT_SIGN_UP, default true). */
  readonly signUp: boolean;
  /** `GET /api/v1/config` `botProtection` (`"altcha"` when ALTCHA_HMAC_KEY is set, else `"none"`). */
  readonly botProtection: "altcha" | "none";
  /** Keys the daily `VisitorHash` of share-link visitors (derived from BETTER_AUTH_SECRET). */
  readonly visitorSecret: Redacted.Redacted<string>;
  readonly feedback?: FeedbackConfig | undefined;
}

export class HttpConfig extends Context.Service<HttpConfig, HttpConfigShape>()(
  "kvitbit/server/http/HttpConfig",
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

export const makeHttpConfig = (
  base: Pick<
    HttpConfigShape,
    "appOrigin" | "trustedProxyHops" | "webDir" | "pwaDir" | "visitorSecret"
  > &
    Partial<
      Pick<HttpConfigShape, "corsOrigins" | "version" | "signUp" | "botProtection" | "feedback">
    > & {
      readonly trustedOrigins?: ReadonlyArray<string>;
    },
): HttpConfigShape => {
  const appOrigin = new URL(base.appOrigin).origin;
  return {
    appOrigin,
    trustedOrigins: new Set([appOrigin, ...(base.trustedOrigins ?? [])]),
    corsOrigins: base.corsOrigins ?? [],
    trustedProxyHops: base.trustedProxyHops,
    webDir: base.webDir,
    pwaDir: base.pwaDir,
    version: base.version ?? "0.0.0",
    signUp: base.signUp ?? true,
    botProtection: base.botProtection ?? "none",
    visitorSecret: base.visitorSecret,
    feedback: base.feedback,
  };
};

/** HttpConfig from the environment. */
export const HttpConfigLive: Layer.Layer<HttpConfig, Config.ConfigError> = Layer.effect(
  HttpConfig,
  Effect.gen(function* () {
    const server = yield* ServerConfig;
    const trustedOrigins = yield* originList("KVITBIT_TRUSTED_ORIGINS");
    const corsOrigins = yield* originList("KVITBIT_CORS_ORIGINS");
    const version = yield* Config.String("KVITBIT_VERSION").pipe(Config.withDefault("0.0.0"));
    const signUp = yield* Config.Boolean("KVITBIT_SIGN_UP").pipe(Config.withDefault(true));
    const altchaKey = yield* Config.option(Config.Redacted("ALTCHA_HMAC_KEY"));
    const feedbackToken = yield* Config.option(Config.Redacted("KVITBIT_FEEDBACK_GITHUB_TOKEN"));
    const feedbackRepo = yield* Config.String("KVITBIT_FEEDBACK_GITHUB_REPO").pipe(
      Config.withDefault(""),
    );
    const feedbackOwners = yield* Config.String("KVITBIT_FEEDBACK_OWNER_EMAILS").pipe(
      Config.withDefault(""),
    );
    return makeHttpConfig({
      appOrigin: server.appOrigin,
      trustedProxyHops: server.trustedProxyHops,
      webDir: server.webDir,
      pwaDir: server.pwaDir,
      visitorSecret: server.authSecret,
      trustedOrigins,
      corsOrigins,
      version,
      signUp,
      botProtection: Option.isSome(altchaKey) ? "altcha" : "none",
      feedback: makeFeedbackConfig(
        Option.getOrUndefined(feedbackToken),
        feedbackRepo,
        feedbackOwners,
      ),
    });
  }),
);

/** For tests: a fixed configuration. */
export const HttpConfigTest = (overrides: Partial<Parameters<typeof makeHttpConfig>[0]> = {}) =>
  Layer.succeed(
    HttpConfig,
    makeHttpConfig({
      appOrigin: "https://kvitbit.test",
      trustedProxyHops: 1,
      webDir: Option.none(),
      pwaDir: Option.none(),
      visitorSecret: Redacted.make("test-visitor-secret"),
      ...overrides,
    }),
  );
