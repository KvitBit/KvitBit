import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { fromAccessToken, Providers as GcpProviders } from "@alchemy.run/gcp";
import { Secret } from "@alchemy.run/gcp/SecretManager";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Apply from "alchemy/Apply";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { loadAlchemyStackConfig } from "../alchemy.run";
import {
  altchaSecretFqn,
  assertTargetedSecretSelection,
  BootstrapPopulatedStateError,
  BootstrapSelectionError,
  declareKvitbitStack,
  feedbackSecretFqn,
  foundationResourceIds,
  KVITBIT_STACK_NAME,
  resendSecretFqn,
  turboCacheSecretFqn,
} from "../src/bootstrap";
import {
  composeStackEnvLayers,
  defaultSecretBindings,
  imageReference,
  KVITBIT_PROD_DEFAULTS,
  type KvitbitStackConfig,
  loadStackConfig,
  makeStackEnvLayer,
  readAlchemyRawEnv,
  resourceNames,
  StackEnv,
  validateStackConfig,
} from "../src/config";
import { type PlainEnvVar, runnerPlainEnv, serverPlainEnv, serverSecretEnv } from "../src/env";
import {
  declareKvitbitEdge,
  declareTokenRouteLogExclusion,
  edgeDynamicBackendProps,
  edgeObjectNames,
  edgeSecurityPolicyProps,
  edgeStaticAssetPaths,
  edgeStaticBackendProps,
  edgeUrlMapProps,
  tokenRouteExclusionFilter,
  tokenRoutePatterns,
} from "../src/resources/edge";
import { EdgeBackendServiceProvider } from "../src/resources/edge-backend-service";
import { EdgeSecurityPolicyProvider } from "../src/resources/edge-security-policy";
import {
  artifactRepositoryProps,
  blobsBucketProps,
  declareFoundation,
  mobileAssetsBucketProps,
  secretAccessorGrants,
  secretDeclarations,
} from "../src/resources/foundation";
import {
  buildRunnerStartupScript,
  buildRunnerWorkerConfig,
  COS_STABLE_IMAGE,
  declareNetworkAndRunners,
  networkProps,
  routerProps,
  runnerFirewallProps,
  runnerInstanceProps,
  runnerWorkerConfigSha,
  serializeRunnerWorkerConfig,
  subnetworkProps,
} from "../src/resources/network";
import { declareServerService, serverServiceProps } from "../src/resources/server";
import { fixtureFileSystem, fixturePath, runCommand, systemPath } from "./process-fixture";

const { join, resolve } = fixturePath;

const kvitbitPosthogKeyPattern = /KVITBIT_POSTHOG_KEY: \$\{\{ vars\.KVITBIT_POSTHOG_KEY \}\}/;
const kvitbitPosthogHostPattern = /KVITBIT_POSTHOG_HOST: \$\{\{ vars\.KVITBIT_POSTHOG_HOST \}\}/;
const matchPattern = /^sha256:[a-f0-9]{64}$/;
const catReconcileVarPattern =
  /cat <<'RECONCILE' > \/var\/lib\/kvitbit\/reconcile-worker\.sh\n([\s\S]*?)\nRECONCILE\n/;
const httprequestRequesturlPattern = /httpRequest\.requestUrl=~"([^"]+)"/;
const kvitbitAlertEmailPattern = /KVITBIT_ALERT_EMAIL: \$\{\{ vars\.KVITBIT_ALERT_EMAIL \}\}/;
const tfTfvarsJsonPattern = /\.(tf|tfvars)(\.json)?$/;

const SAMPLE_DIGEST = `sha256:${Str.repeat(64)("a")}`;
const PROD_DNS_ZONES = ["kvitbit.cz", "kvitbit.app", "kvitbit.com", "kvitbit.eu", "kvitbit.dev"];

const sampleProdConfig = (overrides: Partial<KvitbitStackConfig> = {}): KvitbitStackConfig => ({
  stage: "prod",
  bootstrapFoundation: false,
  projectId: KVITBIT_PROD_DEFAULTS.projectId,
  projectNumber: KVITBIT_PROD_DEFAULTS.projectNumber,
  region: KVITBIT_PROD_DEFAULTS.region,
  zone: KVITBIT_PROD_DEFAULTS.zone,
  stateBucket: KVITBIT_PROD_DEFAULTS.stateBucket,
  artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
  imageName: KVITBIT_PROD_DEFAULTS.imageName,
  imageDigest: SAMPLE_DIGEST,
  blobsBucket: "kvitbit-prod-blobs-prod",
  mobileAssetsBucket: "kvitbit-prod-mobile-prod",
  runnerCount: 2,
  runnerMachineType: "e2-standard-2",
  runnerPort: 34431,
  runnerCidr: "10.42.0.0/20",
  serverMinInstances: 0,
  serverMaxInstances: 10,
  appOrigin: "https://kvitbit.cz",
  emailFrom: "Kvitbit <no-reply@kvitbit.cz>",
  alertEmail: undefined,
  trustedProxyHops: 2,
  shareKeyVersion: 1,
  androidAssetlinksSha256: "AA:BB:CC",
  feedbackGitHubRepo: undefined,
  feedbackOwnerEmails: undefined,
  secrets: defaultSecretBindings("prod", {
    enableResend: true,
    enableSmtp: true,
    enableMobileSigningKey: true,
    enableAltchaHmacKey: true,
  }),
  dnsZones: [],
  edge: {
    domains: ["kvitbit.cz", "kvitbit.app"],
    enableHttps: true,
    staticCdnEnabled: true,
    wafPreview: false,
    authRateLimitPerMinute: 60,
    restrictDirectIngress: true,
  },
  ...overrides,
});

const PROD_REQUIRED_ENV = {
  KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
  KVITBIT_APP_ORIGIN: "https://kvitbit.cz",
  KVITBIT_EMAIL_FROM: "Kvitbit <no-reply@kvitbit.cz>",
  KVITBIT_EDGE_DOMAINS: "kvitbit.cz, kvitbit.app",
  KVITBIT_ENABLE_RESEND_SECRET: "true",
  KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "true",
} as const;

describe("Kvitbit Alchemy stack config", () => {
  test("loads kvitbit-prod defaults from ConfigProvider with required prod services", async () => {
    const provider = ConfigProvider.fromEnv({
      env: { ...PROD_REQUIRED_ENV },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.stage).toBe("prod");
    expect(config.projectId).toBe("kvitbit-prod");
    expect(config.projectNumber).toBe("449188423567");
    expect(config.region).toBe("europe-west3");
    expect(config.zone).toBe("europe-west3-a");
    expect(config.stateBucket).toBe("alchemy-state-kvitbit-prod");
    expect(config.runnerPort).toBe(34431);
    expect(config.trustedProxyHops).toBe(2);
    expect(config.edge?.domains).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(config.dnsZones).toEqual([]);
    expect(imageReference(config)).toBe(
      `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${SAMPLE_DIGEST}`,
    );
  });

  test("rejects incomplete prod configs and non-prod modes in prod", async () => {
    for (const [label, overrides] of [
      ["missing APP_ORIGIN", { KVITBIT_APP_ORIGIN: "" }],
      ["http APP_ORIGIN", { KVITBIT_APP_ORIGIN: "http://kvitbit.cz" }],
      ["localhost APP_ORIGIN", { KVITBIT_APP_ORIGIN: "https://localhost" }],
      ["trailing-dot localhost APP_ORIGIN", { KVITBIT_APP_ORIGIN: "https://localhost." }],
      ["trailing-dot sub.localhost APP_ORIGIN", { KVITBIT_APP_ORIGIN: "https://app.localhost." }],
      ["missing EMAIL_FROM", { KVITBIT_EMAIL_FROM: "" }],
      ["malformed consecutive-dot EMAIL_FROM", { KVITBIT_EMAIL_FROM: "a..b@example.org" }],
      ["missing edge domains", { KVITBIT_EDGE_DOMAINS: "" }],
      [
        "no email secret",
        { KVITBIT_ENABLE_RESEND_SECRET: "false", KVITBIT_ENABLE_SMTP_SECRET: "false" },
      ],
      ["no ALTCHA secret", { KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "false" }],
      ["capture email mode", { KVITBIT_EMAIL_MODE: "capture" }],
      ["console email mode", { KVITBIT_EMAIL_MODE: "console" }],
      ["disabled email mode", { KVITBIT_EMAIL_MODE: "disabled" }],
      ["none bot protection mode", { KVITBIT_BOT_PROTECTION_MODE: "none" }],
      ["disabled bot protection mode", { KVITBIT_BOT_PROTECTION_MODE: "disabled" }],
      ["local blob driver", { KVITBIT_BLOB_DRIVER: "local" }],
      ["legacy disable flag", { KVITBIT_PREVIEW_DISABLE_EMAIL: "true" }],
      ["disable bot protection flag", { KVITBIT_DISABLE_BOT_PROTECTION: "true" }],
      ["dynamic disable blob flag", { KVITBIT_DISABLE_BLOB: "true" }],
      ["dynamic custom disable flag", { KVITBIT_DISABLE_ANYTHING: "1" }],
    ] as const) {
      const provider = ConfigProvider.fromEnv({
        env: { ...PROD_REQUIRED_ENV, ...overrides },
      });
      const error = await Fn.pipe(
        Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider)))),
        Effect.runPromise,
      );
      expect(error, `expected failure for ${label}`).toMatchObject({ _tag: "InvalidStackConfig" });
    }
  });

  test("loads and normalizes the configured DNS zone apexes without enabling the edge in staging", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_STAGE: "staging",
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_APP_ORIGIN: "https://staging.kvitbit.cz",
        KVITBIT_EMAIL_MODE: "capture",
        KVITBIT_BOT_PROTECTION_MODE: "none",
        KVITBIT_DNS_ZONES:
          " Kvitbit.cz., kvitbit.APP, kvitbit.com, kvitbit.eu, kvitbit.dev, kvitbit.cz ",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.dnsZones).toEqual(PROD_DNS_ZONES);
    expect(config.edge).toBeUndefined();
  });

  test.each([
    "*.kvitbit.cz",
    "https://kvitbit.cz",
    "kvitbit.cz/path",
    "kvitbit.cz..",
    "single-label",
    "-kvitbit.cz",
    "192.0.2.1",
    `${Str.repeat(64)("x")}.cz`,
    `${Str.repeat(4)(`${Str.repeat(63)("x")}.`)}cz`,
  ])("rejects invalid DNS zone %s", async (zone) => {
    const provider = ConfigProvider.fromEnv({
      env: { ...PROD_REQUIRED_ENV, KVITBIT_DNS_ZONES: zone },
    });
    const error = await Fn.pipe(
      Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider)))),
      Effect.runPromise,
    );
    expect(error).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_DNS_ZONES" });
  });

  test("rejects DNS zones that leave no room for www when the edge is enabled", async () => {
    const domain = `${Str.repeat(3)(`${Str.repeat(63)("x")}.`)}${Str.repeat(58)("y")}.cz`;
    const error = await Fn.pipe(
      Effect.flip(validateStackConfig(sampleProdConfig({ dnsZones: [domain] }))),
      Effect.runPromise,
    );
    expect(error.field).toBe("KVITBIT_DNS_ZONES");
    expect(error.reason).toContain("www");
  });

  test("enables HTTPS edge, restricts direct Cloud Run ingress by default, and bumps trustedProxyHops when KVITBIT_EDGE_DOMAINS is set", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        ...PROD_REQUIRED_ENV,
        KVITBIT_EDGE_DOMAINS: "kvitbit.cz, kvitbit.app",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.edge?.domains).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(config.edge?.enableHttps).toBe(true);
    expect(config.edge?.restrictDirectIngress).toBe(true);
    expect(config.trustedProxyHops).toBe(2);
  });

  test("handles empty GitHub Actions vars, optional secret flags, and bootstrapFoundation mode", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_BOOTSTRAP_FOUNDATION: "true",
        KVITBIT_DNS_ZONES: "",
        KVITBIT_RUNNER_COUNT: "",
        KVITBIT_ENABLE_RESEND_SECRET: "true",
        KVITBIT_ENABLE_SMTP_SECRET: "",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "true",
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: " ",
        KVITBIT_FEEDBACK_GITHUB_REPO: "",
        KVITBIT_FEEDBACK_OWNER_EMAILS: " ",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.bootstrapFoundation).toBe(true);
    expect(config.imageDigest).toBe("");
    expect(config.dnsZones).toEqual([]);
    expect(config.runnerCount).toBe(KVITBIT_PROD_DEFAULTS.runnerCount);
    const secretIds = Arr.map(config.secrets, (s) => s.secretId);
    expect(secretIds).toContain("kvitbit-prod-database-url");
    expect(secretIds).toContain("kvitbit-prod-runner-database-url-unpooled");
    expect(secretIds).toContain("kvitbit-prod-resend-api-key");
    expect(secretIds).toContain("kvitbit-prod-mobile-updates-signing-key");
    expect(secretIds).not.toContain("kvitbit-prod-smtp-url");
    expect(secretIds).not.toContain("kvitbit-prod-feedback-github-token");
    expect(config.feedbackGitHubRepo).toBeUndefined();
    expect(config.feedbackOwnerEmails).toBeUndefined();
  });

  test("rejects mutable image tags, cross-region zones, and out-of-range runnerCount", async () => {
    const badDigest = await Fn.pipe(
      Effect.flip(validateStackConfig(sampleProdConfig({ imageDigest: "latest" }))),
      Effect.runPromise,
    );
    expect(badDigest.field).toBe("imageDigest");

    const badZone = await Fn.pipe(
      Effect.flip(validateStackConfig(sampleProdConfig({ zone: "us-central1-a" }))),
      Effect.runPromise,
    );
    expect(badZone.field).toBe("zone");

    const badRunners = await Fn.pipe(
      Effect.flip(validateStackConfig(sampleProdConfig({ runnerCount: 0 }))),
      Effect.runPromise,
    );
    expect(badRunners.field).toBe("runnerCount");
  });

  test("normalizes optional secret boolean flags case-insensitively (true/1/yes/on, false/0/no/off) and rejects invalid values", async () => {
    const enabledProvider = ConfigProvider.fromEnv({
      env: {
        ...PROD_REQUIRED_ENV,
        KVITBIT_ENABLE_RESEND_SECRET: "YES",
        KVITBIT_ENABLE_SMTP_SECRET: "1",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "On",
      },
    });
    const enabledConfig = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(enabledProvider))),
    );
    const enabledIds = Arr.map(enabledConfig.secrets, (s) => s.secretId);
    expect(enabledIds).toContain("kvitbit-prod-resend-api-key");
    expect(enabledIds).toContain("kvitbit-prod-smtp-url");
    expect(enabledIds).toContain("kvitbit-prod-mobile-updates-signing-key");

    const disabledProvider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_STAGE: "staging",
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_APP_ORIGIN: "https://staging.kvitbit.cz",
        KVITBIT_EMAIL_MODE: "capture",
        KVITBIT_BOT_PROTECTION_MODE: "none",
        KVITBIT_ENABLE_RESEND_SECRET: "OFF",
        KVITBIT_ENABLE_SMTP_SECRET: "0",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "No",
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: "OFF",
        KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "OFF",
      },
    });
    const disabledConfig = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(disabledProvider))),
    );
    const disabledIds = Arr.map(disabledConfig.secrets, (s) => s.secretId);
    expect(disabledIds).not.toContain("kvitbit-staging-resend-api-key");
    expect(disabledIds).not.toContain("kvitbit-staging-smtp-url");
    expect(disabledIds).not.toContain("kvitbit-staging-mobile-updates-signing-key");
    expect(disabledIds).not.toContain("kvitbit-staging-feedback-github-token");

    const invalidProvider = ConfigProvider.fromEnv({
      env: {
        ...PROD_REQUIRED_ENV,
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: "maybe",
      },
    });
    const invalidError = await Fn.pipe(
      Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(invalidProvider)))),
      Effect.runPromise,
    );
    expect(invalidError).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
    });
  });

  test("loadStackConfig rejects IPv4-mapped IPv6 loopback, >63-octet email labels, Array-node disable flags, and fallback provider opt-outs", async () => {
    const loadWithLayer = <A>(layer: Layer.Layer<A>) =>
      Effect.runPromise(loadStackConfig.pipe(Effect.provide(layer), Effect.result));

    // Valid boundary controls: 63-octet domain label, public IPv4-mapped IPv6 origin,
    // permitted scalar KVITBIT_DISABLE, and permitted longer exact-key neighbors are accepted.
    for (const [label, extra] of [
      ["63-octet email label", { KVITBIT_EMAIL_FROM: `a@${Str.repeat(63)("b")}.org` }],
      ["public IPv4-mapped IPv6", { KVITBIT_APP_ORIGIN: "https://[::ffff:192.0.2.1]" }],
      ["permitted scalar KVITBIT_DISABLE=metadata", { KVITBIT_DISABLE: "metadata" }],
      ["permitted empty KVITBIT_DISABLE", { KVITBIT_DISABLE: "" }],
      ["permitted KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA empty", { KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "" }],
      [
        "permitted KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA metadata",
        { KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
      ],
    ] as const) {
      expect(
        (await loadWithLayer(makeStackEnvLayer({ ...PROD_REQUIRED_ENV, ...extra })))._tag,
        `makeStackEnvLayer ${label}`,
      ).toBe("Success");
      expect(
        (
          await ConfigProvider.fromEnv({ env: { ...PROD_REQUIRED_ENV, ...extra } }).pipe(
            ConfigProvider.layer,
            loadWithLayer,
          )
        )._tag,
        `bare ConfigProvider ${label}`,
      ).toBe("Success");
    }

    for (const [label, overrides, expectedField] of [
      [
        "IPv4-mapped IPv6 loopback",
        { KVITBIT_APP_ORIGIN: "https://[::ffff:127.0.0.1]" },
        "appOrigin",
      ],
      [
        "IPv4-mapped IPv6 unspecified",
        { KVITBIT_APP_ORIGIN: "https://[::ffff:0.0.0.0]" },
        "appOrigin",
      ],
      [
        "64-char email domain label",
        { KVITBIT_EMAIL_FROM: `a@${Str.repeat(64)("b")}.org` },
        "emailFrom",
      ],
      [
        "64-char email TLD label",
        { KVITBIT_EMAIL_FROM: `a@example.${Str.repeat(64)("c")}` },
        "emailFrom",
      ],
      ["Array-node disable flag", { KVITBIT_DISABLE_HTTP_2: "true" }, "KVITBIT_DISABLE_HTTP_2"],
      [
        "sparse Array-node disable flag (1200=true + 3000 empty)",
        { KVITBIT_DISABLE_HTTP_1200: "true", KVITBIT_DISABLE_HTTP_3000: "" },
        "KVITBIT_DISABLE_HTTP_1200",
      ],
      [
        "very sparse Array-node disable flag (5000=true + 10000 empty)",
        { KVITBIT_DISABLE_HTTP_5000: "true", KVITBIT_DISABLE_HTTP_10000: "" },
        "KVITBIT_DISABLE_HTTP_5000",
      ],
      [
        "empty forbidden key KVITBIT_DISABLE_OTHER",
        { KVITBIT_DISABLE_OTHER: "" },
        "KVITBIT_DISABLE_OTHER",
      ],
      [
        "empty exact KVITBIT_ALLOW_LOCAL_BLOBS alone",
        { KVITBIT_ALLOW_LOCAL_BLOBS: "" },
        "KVITBIT_ALLOW_LOCAL_BLOBS",
      ],
      [
        "empty exact KVITBIT_ALLOW_LOCAL_BLOBS alongside EXTRA",
        { KVITBIT_ALLOW_LOCAL_BLOBS: "", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
        "KVITBIT_ALLOW_LOCAL_BLOBS",
      ],
      [
        "non-empty exact KVITBIT_ALLOW_LOCAL_BLOBS alongside EXTRA",
        { KVITBIT_ALLOW_LOCAL_BLOBS: "true", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
        "KVITBIT_ALLOW_LOCAL_BLOBS",
      ],
    ] as const) {
      const res = await loadWithLayer(makeStackEnvLayer({ ...PROD_REQUIRED_ENV, ...overrides }));
      expect(res._tag, `expected InvalidStackConfig for ${label}`).toBe("Failure");
      if (res._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(res.failure).toMatchObject({ _tag: "InvalidStackConfig", field: expectedField });
    }

    // Bare ConfigProvider.fromEnv also rejects empty exact KVITBIT_ALLOW_LOCAL_BLOBS alone.
    const bareEmptyExact = await ConfigProvider.fromEnv({
      env: { ...PROD_REQUIRED_ENV, KVITBIT_ALLOW_LOCAL_BLOBS: "" },
    }).pipe(ConfigProvider.layer, loadWithLayer);
    expect(bareEmptyExact._tag).toBe("Failure");
    if (bareEmptyExact._tag !== "Failure") throw new Error("Expected the asserted result");
    expect(bareEmptyExact.failure).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_ALLOW_LOCAL_BLOBS",
    });

    for (const [label, primaryExtra, fallbackEnv, expectedField] of [
      [
        "fallback KVITBIT_DISABLE_CUSTOM",
        {},
        { KVITBIT_DISABLE_CUSTOM: "true" },
        "KVITBIT_DISABLE_CUSTOM",
      ],
      [
        "scalar primary KVITBIT_DISABLE=metadata + fallback KVITBIT_DISABLE_CUSTOM=true",
        { KVITBIT_DISABLE: "metadata" },
        { KVITBIT_DISABLE_CUSTOM: "true" },
        "KVITBIT_DISABLE_CUSTOM",
      ],
      [
        "empty primary KVITBIT_DISABLE_OTHER + fallback KVITBIT_DISABLE_CUSTOM=true",
        { KVITBIT_DISABLE_OTHER: "" },
        { KVITBIT_DISABLE_CUSTOM: "true" },
        "KVITBIT_DISABLE_CUSTOM",
      ],
      [
        "empty primary KVITBIT_PREVIEW_DISABLE_OTHER + fallback KVITBIT_PREVIEW_DISABLE_CUSTOM=true",
        { KVITBIT_PREVIEW_DISABLE_OTHER: "" },
        { KVITBIT_PREVIEW_DISABLE_CUSTOM: "true" },
        "KVITBIT_PREVIEW_DISABLE_CUSTOM",
      ],
      [
        "empty primary KVITBIT_ALLOW_LOCAL_BLOBS + EXTRA + fallback KVITBIT_ALLOW_LOCAL_BLOBS=true",
        { KVITBIT_ALLOW_LOCAL_BLOBS: "", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
        { KVITBIT_ALLOW_LOCAL_BLOBS: "true" },
        "KVITBIT_ALLOW_LOCAL_BLOBS",
      ],
      [
        "fallback KVITBIT_DISABLE_HTTP_2",
        {},
        { KVITBIT_DISABLE_HTTP_2: "true" },
        "KVITBIT_DISABLE_HTTP_2",
      ],
      [
        "fallback KVITBIT_PREVIEW_DISABLE_CUSTOM",
        {},
        { KVITBIT_PREVIEW_DISABLE_CUSTOM: "true" },
        "KVITBIT_PREVIEW_DISABLE_CUSTOM",
      ],
    ] as const) {
      const res = await loadWithLayer(
        composeStackEnvLayers({ ...PROD_REQUIRED_ENV, ...primaryExtra }, fallbackEnv),
      );
      expect(res._tag, `expected InvalidStackConfig for ${label}`).toBe("Failure");
      if (res._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(res.failure).toMatchObject({ _tag: "InvalidStackConfig", field: expectedField });
    }
  });

  test("alchemy.run.ts stack entrypoint preserves CLI --env-file precedence and rejects forbidden keys from both file and shell", async () => {
    const sandbox = await Effect.runPromise(
      fixtureFileSystem.makeTempDirectory({ prefix: "kvitbit-alchemy-envfile-" }),
    );
    try {
      // 1. Valid production shell + --env-file with forbidden KVITBIT_DISABLE_CUSTOM=true:
      // Alchemy CLI's provider (dotEnv over shell) flows into alchemy.run.ts without being replaced.
      const forbiddenFile = join(sandbox, "forbidden.env");
      await Effect.runPromise(
        fixtureFileSystem.writeFileString(forbiddenFile, "KVITBIT_DISABLE_CUSTOM=true\n"),
      );
      const forbiddenCliProvider = ConfigProvider.orElse(
        ConfigProvider.fromDotEnvContents(
          await Effect.runPromise(fixtureFileSystem.readFileString(forbiddenFile)),
        ),
        ConfigProvider.fromEnv({ env: PROD_REQUIRED_ENV }),
      );
      const forbiddenRes = await Effect.runPromise(
        loadAlchemyStackConfig.pipe(
          Effect.provide(ConfigProvider.layer(forbiddenCliProvider)),
          Effect.result,
        ),
      );
      expect(forbiddenRes._tag).toBe("Failure");
      if (forbiddenRes._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(forbiddenRes.failure).toMatchObject({
        _tag: "InvalidStackConfig",
        field: "KVITBIT_DISABLE_CUSTOM",
      });

      // 2. Valid production shell + --env-file overriding stage, stateBucket, origin, and emailMode:
      // confirms --env-file governs both state selection and stack declaration.
      const stagingFile = join(sandbox, "staging.env");
      await Effect.runPromise(
        fixtureFileSystem.writeFileString(
          stagingFile,
          Arr.join(
            [
              "KVITBIT_STAGE=staging",
              "KVITBIT_ALCHEMY_STATE_BUCKET=custom-staging-state-bucket",
              "KVITBIT_APP_ORIGIN=https://staging.kvitbit.cz",
              "KVITBIT_EMAIL_MODE=capture",
              "KVITBIT_BOT_PROTECTION_MODE=none",
              "KVITBIT_ENABLE_RESEND_SECRET=false",
              "KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET=false",
            ],
            "\n",
          ),
        ),
      );
      const stagingCliProvider = ConfigProvider.orElse(
        ConfigProvider.fromDotEnvContents(
          await Effect.runPromise(fixtureFileSystem.readFileString(stagingFile)),
        ),
        ConfigProvider.fromEnv({ env: PROD_REQUIRED_ENV }),
      );
      const stagingCfg = await Effect.runPromise(
        loadAlchemyStackConfig.pipe(Effect.provide(ConfigProvider.layer(stagingCliProvider))),
      );
      expect(stagingCfg.stage).toBe("staging");
      expect(stagingCfg.stateBucket).toBe("custom-staging-state-bucket");
      expect(stagingCfg.appOrigin).toBe("https://staging.kvitbit.cz");
      expect(stagingCfg.emailMode).toBe("capture");

      // 3. readAlchemyRawEnv preserves exact keys from both --env-file and shell (including empty exact keys alongside EXTRA and scalar KVITBIT_DISABLE + fallback .env).
      const emptyExactFile = join(sandbox, "empty-exact.env");
      await Effect.runPromise(
        fixtureFileSystem.writeFileString(
          emptyExactFile,
          'KVITBIT_ALLOW_LOCAL_BLOBS=""\nKVITBIT_ALLOW_LOCAL_BLOBS_EXTRA=metadata\n',
        ),
      );
      const rawWithEnvFile = await readAlchemyRawEnv({
        argv: ["bun", "alchemy", "plan", "--env-file", emptyExactFile],
        env: PROD_REQUIRED_ENV,
        cwd: sandbox,
      }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
      const emptyExactRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(
            Layer.merge(
              ConfigProvider.layer(
                ConfigProvider.orElse(
                  ConfigProvider.fromDotEnvContents(
                    await Effect.runPromise(fixtureFileSystem.readFileString(emptyExactFile)),
                  ),
                  ConfigProvider.fromEnv({ env: PROD_REQUIRED_ENV }),
                ),
              ),
              Layer.succeed(StackEnv, rawWithEnvFile),
            ),
          ),
          Effect.result,
        ),
      );
      expect(emptyExactRes._tag).toBe("Failure");
      if (emptyExactRes._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(emptyExactRes.failure).toMatchObject({
        _tag: "InvalidStackConfig",
        field: "KVITBIT_ALLOW_LOCAL_BLOBS",
      });

      // 4. Default .env fallback behind shell KVITBIT_DISABLE=metadata still rejects .env's KVITBIT_DISABLE_CUSTOM=true.
      await Effect.runPromise(
        fixtureFileSystem.writeFileString(join(sandbox, ".env"), "KVITBIT_DISABLE_CUSTOM=true\n"),
      );
      const shellWithScalar = { ...PROD_REQUIRED_ENV, KVITBIT_DISABLE: "metadata" };
      const rawWithDotEnv = await readAlchemyRawEnv({
        argv: ["bun", "alchemy", "plan"],
        env: shellWithScalar,
        cwd: sandbox,
      }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
      const dotEnvRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(
            Layer.merge(
              ConfigProvider.layer(
                ConfigProvider.orElse(
                  ConfigProvider.fromEnv({ env: shellWithScalar }),
                  ConfigProvider.fromDotEnvContents(
                    await Effect.runPromise(
                      fixtureFileSystem.readFileString(join(sandbox, ".env")),
                    ),
                  ),
                ),
              ),
              Layer.succeed(StackEnv, rawWithDotEnv),
            ),
          ),
          Effect.result,
        ),
      );
      expect(dotEnvRes._tag).toBe("Failure");
      if (dotEnvRes._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(dotEnvRes.failure).toMatchObject({
        _tag: "InvalidStackConfig",
        field: "KVITBIT_DISABLE_CUSTOM",
      });
    } finally {
      await Effect.runPromise(fixtureFileSystem.remove(sandbox, { recursive: true, force: true }));
    }
  });
});

describe("PostHog deployment configuration", () => {
  const load = (env: Record<string, string> = {}) =>
    loadStackConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { ...PROD_REQUIRED_ENV, KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST, ...env },
          }),
        ),
      ),
    );

  test.each([
    {},
    { KVITBIT_POSTHOG_KEY: "", KVITBIT_POSTHOG_HOST: "" },
    { KVITBIT_POSTHOG_KEY: "  ", KVITBIT_POSTHOG_HOST: "\t" },
  ])("treats absent or blank values as unset (%j)", async (env) => {
    const config = await Effect.runPromise(load(env));
    expect(config.posthogKey).toBeUndefined();
    expect(config.posthogHost).toBeUndefined();
  });

  test("trims the project key and defaults a blank host to the EU endpoint", async () => {
    const config = await Effect.runPromise(
      load({ KVITBIT_POSTHOG_KEY: "  phc_test_key  ", KVITBIT_POSTHOG_HOST: " " }),
    );
    expect(config.posthogKey).toBe("phc_test_key");
    expect(config.posthogHost).toBe("https://eu.i.posthog.com");
  });

  test("normalizes a custom HTTPS host, including when a key is absent", async () => {
    const host = "https://analytics.example.test/proxy%20name/%7Btenant%7D";
    const env = { KVITBIT_POSTHOG_HOST: `  ${host}///  ` };
    const config = await Effect.runPromise(load(env));
    expect(config.posthogKey).toBeUndefined();
    expect(config.posthogHost).toBe(host);

    const withKey = await Effect.runPromise(load({ ...env, KVITBIT_POSTHOG_KEY: "phc_test_key" }));
    expect(withKey.posthogHost).toBe(host);
  });

  test.each([
    "https://localhost",
    "https://analytics.example.test.:8443/proxy",
    "https://měření.example.test/čas",
    "https://127.0.0.1:8443",
    "https://[::1]:8443",
  ])("accepts a valid HTTPS endpoint %s", async (host) => {
    const config = await Effect.runPromise(load({ KVITBIT_POSTHOG_HOST: host }));
    expect(config.posthogHost).toBe(host);
  });

  test.each(["personal_key", "phc_test key"])("rejects invalid project key %s", async (key) => {
    expect(
      await Fn.pipe(Effect.flip(load({ KVITBIT_POSTHOG_KEY: key })), Effect.runPromise),
    ).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_POSTHOG_KEY",
    });
  });

  test.each([
    "http://analytics.example.test",
    "https:///analytics.example.test",
    "https://{tenant}.example.test",
    "https://-analytics.example.test",
    "https://analytics..example.test",
    "https://127.1",
    "https://analytics.example.test:invalid",
    "https://analytics.example.test/proxy%2",
    "https://analytics.example.test/proxy%zz",
    "https://analytics.example.test/{tenant}",
    "https://analytics.example.test/[tenant]",
    "https://analytics.example.test/proxy name",
    "https://analytics.example.test/path\u0000segment",
    "https://analytics.example.test/?source=test",
    "https://analytics.example.test/?",
    "https://analytics.example.test/#fragment",
    "https://analytics.example.test/#",
    "https://user:password@analytics.example.test",
    "https://@analytics.example.test",
  ])("rejects invalid host %s", async (host) => {
    expect(
      await Fn.pipe(Effect.flip(load({ KVITBIT_POSTHOG_HOST: host })), Effect.runPromise),
    ).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_POSTHOG_HOST" });
  });

  test("supplies the PostHog pair to server and runner only when a key is set", () => {
    const cases: ReadonlyArray<[Partial<KvitbitStackConfig>, PlainEnvVar[]]> = [
      [{}, []],
      [{ posthogHost: "https://analytics.example.test" }, []],
      [
        { posthogKey: "phc_test_key" },
        [
          { name: "KVITBIT_POSTHOG_KEY", value: "phc_test_key" },
          { name: "KVITBIT_POSTHOG_HOST", value: "https://eu.i.posthog.com" },
        ],
      ],
      [
        { posthogKey: "phc_test_key", posthogHost: "https://analytics.example.test" },
        [
          { name: "KVITBIT_POSTHOG_KEY", value: "phc_test_key" },
          { name: "KVITBIT_POSTHOG_HOST", value: "https://analytics.example.test" },
        ],
      ],
    ];
    for (const [overrides, expected] of cases) {
      const config = sampleProdConfig(overrides);
      const server = serverPlainEnv({
        config,
        buckets: { blobsBucket: "blobs", mobileAssetsBucket: "mobile" },
      });
      const runner = runnerPlainEnv({ config, blobsBucket: "blobs" });
      expect(Arr.filter(server, ({ name }) => Str.startsWith("KVITBIT_POSTHOG_")(name))).toEqual(
        expected,
      );
      expect(Arr.filter(runner, ({ name }) => Str.startsWith("KVITBIT_POSTHOG_")(name))).toEqual(
        expected,
      );
    }
  });

  test("passes the repository variables to the Alchemy deploy step", async () => {
    const workflow = await Effect.runPromise(
      fixtureFileSystem.readFileString(
        fileURLToPath(new URL("../../../.github/workflows/deploy.yml", import.meta.url)),
      ),
    );
    const deployStep = Option.getOrUndefined(
      Arr.findFirst(Str.split(workflow, "      - name: "), (step) =>
        Str.startsWith("Run pure-Alchemy GCP stack")(step),
      ),
    );
    expect(deployStep).toMatch(kvitbitPosthogKeyPattern);
    expect(deployStep).toMatch(kvitbitPosthogHostPattern);
  });
});

describe("Bootstrap state safety guard", () => {
  const config = sampleProdConfig({ bootstrapFoundation: true, imageDigest: "" });
  const compileBootstrap = (state: Layer.Layer<State.State>) =>
    Stack.Stack(
      KVITBIT_STACK_NAME,
      { state, providers: Layer.empty },
      declareKvitbitStack(config).pipe(Effect.orDie),
    ).pipe(Effect.provideService(Stage, "prod"));

  const makeFakeResourceState = (logicalId: string) =>
    ({
      kind: "resource",
      status: "created",
      logicalId,
      fqn: logicalId,
      resourceType: "Test",
      namespace: undefined,
      instanceId: logicalId,
      providerVersion: 0,
      downstream: [],
      bindings: [],
      props: {},
      attr: {},
    }) satisfies State.CreatedResourceState;

  test("hard-fails bootstrapFoundation when state already contains non-foundation production workloads", async () => {
    const populatedStateLayer = State.inMemoryState({
      [KVITBIT_STACK_NAME]: {
        prod: {
          KvitbitImages: makeFakeResourceState("KvitbitImages"),
          KvitbitVpc: makeFakeResourceState("KvitbitVpc"),
          KvitbitRunner0: makeFakeResourceState("KvitbitRunner0"),
          KvitbitServer: makeFakeResourceState("KvitbitServer"),
        },
      },
    });

    const compiled = populatedStateLayer.pipe(compileBootstrap, Effect.scoped, Effect.runPromise);
    await expect(compiled).rejects.toBeInstanceOf(BootstrapPopulatedStateError);
    await expect(compiled).rejects.toMatchObject({
      stackName: KVITBIT_STACK_NAME,
      stage: "prod",
      unexpectedResources: ["KvitbitRunner0", "KvitbitServer", "KvitbitVpc"],
    });
  });

  test("selected feedback secret bootstrap adds only the container to populated state", async () => {
    const target = { stack: KVITBIT_STACK_NAME, stage: "prod" };
    const secretId = "kvitbit-prod-feedback-github-token";
    const fqn = `Secret-${secretId}`;
    const existing = {
      KvitbitImages: makeFakeResourceState("KvitbitImages"),
      KvitbitVpc: makeFakeResourceState("KvitbitVpc"),
      KvitbitRunner0: makeFakeResourceState("KvitbitRunner0"),
      KvitbitServer: makeFakeResourceState("KvitbitServer"),
    };
    const existingOutput = { serverService: "kvitbit-prod-server", repository: "kvitbit" };
    const state = State.inMemoryState(
      { [target.stack]: { [target.stage]: { ...existing } } },
      { [target.stack]: { [target.stage]: existingOutput } },
    );
    const providers = Provider.succeed(Secret, {
      read: () => Effect.undefined,
      reconcile: ({ news }) => {
        expect(news.secretId).toBe(secretId);
        return Effect.succeed({
          name: `projects/kvitbit-prod/secrets/${secretId}`,
          secretId,
          project: "kvitbit-prod",
          labels: {},
          annotations: {},
          replication: { automatic: {} },
          expireTime: undefined,
          createTime: undefined,
          etag: undefined,
          topics: [],
          rotation: undefined,
          versionAliases: {},
          versionDestroyTtl: undefined,
        });
      },
      delete: () => Effect.die("Unexpected secret deletion"),
    });
    const feedbackConfig = sampleProdConfig({
      bootstrapFeedbackSecret: true,
      appOrigin: undefined,
      emailFrom: undefined,
      edge: undefined,
      secrets: defaultSecretBindings("prod", { enableFeedbackGitHubToken: true }),
    });
    // CLI selection guard enforces exact --include for feedback secret bootstrap.
    expect(
      await Fn.pipe(
        Effect.result(assertTargetedSecretSelection(feedbackConfig, ["bun", "alchemy", "deploy"])),
        Effect.runPromise,
      ),
    ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
    expect(
      await Fn.pipe(
        Effect.result(
          assertTargetedSecretSelection(feedbackConfig, [
            "bun",
            "alchemy",
            "deploy",
            "--include",
            fqn,
            "--include",
            "KvitbitServer",
          ]),
        ),
        Effect.runPromise,
      ),
    ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
    expect(
      await Fn.pipe(
        Effect.result(
          assertTargetedSecretSelection(feedbackConfig, [
            "bun",
            "alchemy",
            "deploy",
            "--include",
            fqn,
          ]),
        ),
        Effect.runPromise,
      ),
    ).toMatchObject({ _tag: "Success" });
    expect(
      await Fn.pipe(
        Effect.result(
          assertTargetedSecretSelection(feedbackConfig, [`--include=${feedbackSecretFqn("prod")}`]),
        ),
        Effect.runPromise,
      ),
    ).toMatchObject({ _tag: "Success" });

    await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* Stack.Stack(
          target.stack,
          { state, providers },
          declareKvitbitStack(feedbackConfig).pipe(Effect.orDie),
        );
        // Feedback bootstrap never declares server, runner, VPC, or edge workloads.
        expect(EffectRecord.keys(compiled.resources)).toEqual([fqn]);
        yield* Effect.gen(function* () {
          const plan = yield* Plan.make(compiled, { include: [fqn] });
          expect(EffectRecord.keys(plan.resources)).toEqual([fqn]);
          expect(plan.resources[fqn]?.action).toBe("create");
          expect(plan.deletions).toEqual({});
          yield* Apply.apply(plan);

          const stateService = yield* State.State;
          const store = yield* stateService;
          const listed = yield* store.list(target);
          expect(Arr.sort(listed, Order.String)).toEqual(
            [...EffectRecord.keys(existing), fqn].sort(Order.String),
          );
          const created = yield* store.get({ ...target, fqn });
          expect(created).toMatchObject({
            status: "created",
            resourceType: Secret.Type,
            attr: { secretId },
          });
          for (const [existingFqn, row] of EffectRecord.toEntries(existing)) {
            const value_1 = yield* store.get({ ...target, fqn: existingFqn });
            expect(value_1).toEqual(row);
          }
          const output = yield* store.getOutput(target);
          expect(output).toEqual(existingOutput);
        }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
      }).pipe(Effect.provideService(Stage, target.stage), Effect.scoped),
    );
  });

  test("selected ALTCHA secret bootstrap adds only the container to populated state", async () => {
    const target = { stack: KVITBIT_STACK_NAME, stage: "prod" };
    const secretId = "kvitbit-prod-altcha-hmac-key";
    const fqn = altchaSecretFqn("prod");
    const existing = {
      KvitbitImages: makeFakeResourceState("KvitbitImages"),
      KvitbitVpc: makeFakeResourceState("KvitbitVpc"),
      KvitbitRunner0: makeFakeResourceState("KvitbitRunner0"),
      KvitbitServer: makeFakeResourceState("KvitbitServer"),
    };
    const existingOutput = { serverService: "kvitbit-prod-server", repository: "kvitbit" };
    const state = State.inMemoryState(
      { [target.stack]: { [target.stage]: { ...existing } } },
      { [target.stack]: { [target.stage]: existingOutput } },
    );
    const providers = Provider.succeed(Secret, {
      read: () => Effect.undefined,
      reconcile: ({ news }) => {
        expect(news.secretId).toBe(secretId);
        return Effect.succeed({
          name: `projects/kvitbit-prod/secrets/${secretId}`,
          secretId,
          project: "kvitbit-prod",
          labels: {},
          annotations: {},
          replication: { automatic: {} },
          expireTime: undefined,
          createTime: undefined,
          etag: undefined,
          topics: [],
          rotation: undefined,
          versionAliases: {},
          versionDestroyTtl: undefined,
        });
      },
      delete: () => Effect.die("Unexpected secret deletion"),
    });
    const altchaConfig = sampleProdConfig({
      bootstrapAltchaSecret: true,
      appOrigin: undefined,
      emailFrom: undefined,
      edge: undefined,
      secrets: defaultSecretBindings("prod", { enableAltchaHmacKey: true }),
    });
    expect(
      await Fn.pipe(
        Effect.result(assertTargetedSecretSelection(altchaConfig, ["bun", "alchemy", "deploy"])),
        Effect.runPromise,
      ),
    ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
    expect(
      await Fn.pipe(
        Effect.result(
          assertTargetedSecretSelection(altchaConfig, [
            "bun",
            "alchemy",
            "deploy",
            "--include",
            fqn,
          ]),
        ),
        Effect.runPromise,
      ),
    ).toMatchObject({ _tag: "Success" });

    await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* Stack.Stack(
          target.stack,
          { state, providers },
          declareKvitbitStack(altchaConfig).pipe(Effect.orDie),
        );
        expect(EffectRecord.keys(compiled.resources)).toEqual([fqn]);
        yield* Effect.gen(function* () {
          const plan = yield* Plan.make(compiled, { include: [fqn] });
          expect(EffectRecord.keys(plan.resources)).toEqual([fqn]);
          expect(plan.resources[fqn]?.action).toBe("create");
          expect(plan.deletions).toEqual({});
          yield* Apply.apply(plan);

          const stateService = yield* State.State;
          const store = yield* stateService;
          const listed = yield* store.list(target);
          expect(Arr.sort(listed, Order.String)).toEqual(
            [...EffectRecord.keys(existing), fqn].sort(Order.String),
          );
          const created = yield* store.get({ ...target, fqn });
          expect(created).toMatchObject({
            status: "created",
            resourceType: Secret.Type,
            attr: { secretId },
          });
          const output = yield* store.getOutput(target);
          expect(output).toEqual(existingOutput);
        }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
      }).pipe(Effect.provideService(Stage, target.stage), Effect.scoped),
    );
  });

  test.each([
    {
      label: "Resend",
      secretId: "kvitbit-prod-resend-api-key",
      fqn: resendSecretFqn("prod"),
      unrelatedFqn: altchaSecretFqn("prod"),
      config: sampleProdConfig({
        bootstrapResendSecret: true,
        appOrigin: undefined,
        emailFrom: undefined,
        edge: undefined,
        secrets: defaultSecretBindings("prod", { enableResend: true }),
      }),
    },
    {
      label: "Turbo Cache",
      secretId: "kvitbit-prod-turbo-cache-token",
      fqn: turboCacheSecretFqn("prod"),
      unrelatedFqn: resendSecretFqn("prod"),
      config: sampleProdConfig({
        bootstrapTurboCacheSecret: true,
        appOrigin: undefined,
        emailFrom: undefined,
        edge: undefined,
        secrets: defaultSecretBindings("prod", { enableTurboCache: true }),
      }),
    },
  ])(
    "selected $label secret bootstrap compiles only its expected container and rejects unrelated --include",
    async ({ secretId, fqn, unrelatedFqn, config: targetConfig }) => {
      const target = { stack: KVITBIT_STACK_NAME, stage: "prod" };
      const existing = {
        KvitbitImages: makeFakeResourceState("KvitbitImages"),
        KvitbitVpc: makeFakeResourceState("KvitbitVpc"),
        KvitbitRunner0: makeFakeResourceState("KvitbitRunner0"),
        KvitbitServer: makeFakeResourceState("KvitbitServer"),
      };
      const existingOutput = { serverService: "kvitbit-prod-server", repository: "kvitbit" };
      const state = State.inMemoryState(
        { [target.stack]: { [target.stage]: { ...existing } } },
        { [target.stack]: { [target.stage]: existingOutput } },
      );
      const providers = Provider.succeed(Secret, {
        read: () => Effect.undefined,
        reconcile: ({ news }) => {
          expect(news.secretId).toBe(secretId);
          return Effect.succeed({
            name: `projects/kvitbit-prod/secrets/${secretId}`,
            secretId,
            project: "kvitbit-prod",
            labels: {},
            annotations: {},
            replication: { automatic: {} },
            expireTime: undefined,
            createTime: undefined,
            etag: undefined,
            topics: [],
            rotation: undefined,
            versionAliases: {},
            versionDestroyTtl: undefined,
          });
        },
        delete: () => Effect.die("Unexpected secret deletion"),
      });

      expect(
        await Fn.pipe(
          Effect.result(assertTargetedSecretSelection(targetConfig, ["bun", "alchemy", "deploy"])),
          Effect.runPromise,
        ),
      ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
      expect(
        await Fn.pipe(
          Effect.result(
            assertTargetedSecretSelection(targetConfig, [
              "bun",
              "alchemy",
              "deploy",
              "--include",
              unrelatedFqn,
            ]),
          ),
          Effect.runPromise,
        ),
      ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
      expect(
        await Fn.pipe(
          Effect.result(
            assertTargetedSecretSelection(targetConfig, [
              "bun",
              "alchemy",
              "deploy",
              "--include",
              fqn,
            ]),
          ),
          Effect.runPromise,
        ),
      ).toMatchObject({ _tag: "Success" });

      await Effect.runPromise(
        Effect.gen(function* () {
          const compiled = yield* Stack.Stack(
            target.stack,
            { state, providers },
            declareKvitbitStack(targetConfig).pipe(Effect.orDie),
          );
          expect(EffectRecord.keys(compiled.resources)).toEqual([fqn]);
          yield* Effect.gen(function* () {
            const plan = yield* Plan.make(compiled, { include: [fqn] });
            expect(EffectRecord.keys(plan.resources)).toEqual([fqn]);
            expect(plan.resources[fqn]?.action).toBe("create");
            expect(plan.deletions).toEqual({});
            yield* Apply.apply(plan);

            const stateService = yield* State.State;
            const store = yield* stateService;
            const listed = yield* store.list(target);
            expect(Arr.sort(listed, Order.String)).toEqual(
              [...EffectRecord.keys(existing), fqn].sort(Order.String),
            );
            const created = yield* store.get({ ...target, fqn });
            expect(created).toMatchObject({
              status: "created",
              resourceType: Secret.Type,
              attr: { secretId },
            });
            const output = yield* store.getOutput(target);
            expect(output).toEqual(existingOutput);
          }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
        }).pipe(Effect.provideService(Stage, target.stage), Effect.scoped),
      );
    },
  );

  test.each([
    ["empty", []],
    ["foundation-only", ["KvitbitImages", "KvitbitBlobs", "EdgeTokenRouteExclusion"]],
  ] as const)("lists %s state under the stack's active lease", async (_kind, existingFqns) => {
    const lease = Symbol("stack state lease");
    let activeLease: symbol | undefined;
    const events: string[] = [];
    const state = Layer.effect(
      State.State,
      Effect.acquireRelease(
        Effect.sync(() => {
          expect(activeLease).toBeUndefined();
          activeLease = lease;
          events.push("acquire");
        }),
        () =>
          Effect.sync(() => {
            activeLease = undefined;
            events.push("release");
          }),
      ).pipe(
        Effect.andThen(State.InMemoryService()),
        Effect.map((memory) =>
          Effect.succeed({
            ...memory,
            list: ({ stack, stage }) =>
              Effect.sync(() => {
                expect(activeLease).toBe(lease);
                expect({ stack, stage }).toEqual({ stack: KVITBIT_STACK_NAME, stage: "prod" });
                events.push("list");
                return existingFqns;
              }),
          } satisfies State.StateService),
        ),
      ),
    );

    await Fn.pipe(
      Effect.scoped(
        Effect.gen(function* () {
          const compiled = yield* compileBootstrap(state);
          expect(EffectRecord.keys(compiled.resources).sort(Order.String)).toEqual(
            [...foundationResourceIds(config)].sort(Order.String),
          );
          expect(activeLease).toBe(lease);
          expect(events).toEqual(["acquire", "list"]);
        }),
      ),
      Effect.runPromise,
    );
    expect(events).toEqual(["acquire", "list", "release"]);
    expect(activeLease).toBeUndefined();
  });

  test("aborts bootstrap when listing state fails", async () => {
    const listError = new State.StateStoreError({ message: "state listing failed" });
    const state = Layer.succeed(
      State.State,
      State.InMemoryService().pipe(Effect.map((memory) => ({ ...memory, list: () => listError }))),
    );

    const bootstrap = state.pipe(compileBootstrap, Effect.scoped, Effect.runPromise);
    await expect(bootstrap).rejects.toBe(listError);
  });

  test("bootstraps the Cloud DNS API without declaring zones, including on retry", async () => {
    const dnsConfig = { ...config, dnsZones: PROD_DNS_ZONES };
    const state = State.inMemoryState({
      [KVITBIT_STACK_NAME]: { prod: { CloudDnsApi: makeFakeResourceState("CloudDnsApi") } },
    });
    const stack = Stack.Stack(
      KVITBIT_STACK_NAME,
      { state, providers: Layer.empty },
      declareKvitbitStack(dnsConfig).pipe(Effect.orDie),
    );
    const compiled = await Effect.scoped(stack).pipe(
      Effect.provideService(Stage, "prod"),
      Effect.runPromise,
    );
    expect(EffectRecord.keys(compiled.resources).sort(Order.String)).toEqual(
      [...foundationResourceIds(dnsConfig)].sort(Order.String),
    );
    expect(compiled.resources["CloudDnsApi"]?.Props).toEqual({
      project: "kvitbit-prod",
      service: "dns.googleapis.com",
    });
    expect(
      Arr.some(EffectRecord.keys(compiled.resources), (id) => Str.startsWith("DnsZone-")(id)),
    ).toBe(false);
  });
});

describe("Foundation resources", () => {
  test("configures immutable Artifact Registry, private versioned GCS buckets, and least-privilege secret grants", () => {
    const config = sampleProdConfig();
    const repo = artifactRepositoryProps(config);
    expect(repo.location).toBe("europe-west3");
    expect(repo.format).toBe("DOCKER");
    expect(repo.dockerConfig?.immutableTags).toBe(true);

    const blobs = blobsBucketProps(config);
    expect(blobs.uniformBucketLevelAccess).toBe(true);
    expect(blobs.versioning).toBe(true);
    expect(blobs.forceDestroy).toBe(false);

    const mobile = mobileAssetsBucketProps(config);
    expect(mobile.uniformBucketLevelAccess).toBe(true);
    expect(mobile.versioning).toBe(true);
    expect(mobile.forceDestroy).toBe(false);

    const secrets = secretDeclarations(config);
    expect(Arr.map(secrets, (s) => s.secretId)).toContain("kvitbit-prod-database-url");
    expect(Arr.map(secrets, (s) => s.secretId)).toContain(
      "kvitbit-prod-runner-database-url-unpooled",
    );
    expect(Arr.map(secrets, (s) => s.secretId)).toContain("kvitbit-prod-better-auth-secret");

    const grants = secretAccessorGrants(config);
    const mobileSigningGrants = Arr.filter(
      grants,
      (g) => g.secretId === "kvitbit-prod-mobile-updates-signing-key",
    );
    expect(Arr.map(mobileSigningGrants, (g) => g.workload)).toEqual(["server"]);
    const altchaGrants = Arr.filter(grants, (g) => g.secretId === "kvitbit-prod-altcha-hmac-key");
    expect(Arr.map(altchaGrants, (g) => g.workload)).toEqual(["server"]);
    const serverEnvSecretNames = Arr.map(serverSecretEnv(config), (s) => s.name);
    expect(serverEnvSecretNames).toContain("ALTCHA_HMAC_KEY");
    const runnerSecretNames = Arr.map(
      buildRunnerWorkerConfig({ config }).secrets,
      (s) => s.environmentVariable,
    );
    expect(runnerSecretNames).not.toContain("ALTCHA_HMAC_KEY");
    const dbGrants = Arr.filter(grants, (g) => g.secretId === "kvitbit-prod-database-url");
    expect(Arr.map(dbGrants, (g) => g.workload).sort(Order.String)).toEqual(["runner", "server"]);
    const runnerUnpooledGrants = Arr.filter(
      grants,
      (g) => g.secretId === "kvitbit-prod-runner-database-url-unpooled",
    );
    expect(Arr.map(runnerUnpooledGrants, (g) => g.workload)).toEqual(["runner"]);
  });

  test("constructs the full Alchemy stack with real Output proxies without coercion errors and wires explicit DAG dependencies", async () => {
    const config = sampleProdConfig({ edge: undefined });

    const providers = Layer.mergeAll(
      Layer.effect(GcpProviders, Provider.collection([])),
      EdgeBackendServiceProvider,
      EdgeSecurityPolicyProvider,
    ).pipe(
      Layer.provide(
        fromAccessToken({
          accessToken: Redacted.make("declaration-only"),
          project: config.projectId,
        }),
      ),
    );

    const compileHermetic = <A, E>(
      name: string,
      program: Effect.Effect<A, E, Layer.Success<typeof providers>>,
    ) =>
      Stack.Stack(
        name,
        { state: State.inMemoryState(), providers },
        program.pipe(Effect.orDie),
      ).pipe(Effect.scoped, Effect.provideService(Stage, "prod"), Effect.runPromise);

    const compiled = await compileHermetic(
      "KvitbitTest",
      Effect.gen(function* () {
        const foundation = yield* declareFoundation(config);
        const tokenRouteExclusion = yield* declareTokenRouteLogExclusion(config);
        const network = yield* declareNetworkAndRunners(config, {
          runnerServiceAccountEmail: foundation.runnerServiceAccountEmail,
          blobsBucketName: config.blobsBucket,
          runnerDependencies: foundation.runnerDependencies,
        });
        const server = yield* declareServerService(config, {
          networkName: network.networkName,
          subnetworkName: network.subnetworkName,
          blobsBucketName: config.blobsBucket,
          mobileAssetsBucketName: config.mobileAssetsBucket,
          serverServiceAccountEmail: foundation.serverServiceAccountEmail,
          serverDependencies: [
            ...foundation.serverDependencies,
            ...network.networkReadyDependencies,
          ],
        });
        return { foundation, tokenRouteExclusion, network, server };
      }),
    );

    const resourceIds = EffectRecord.keys(compiled.resources);
    // Token-route log exclusion is installed unconditionally even when edge is disabled
    expect(resourceIds).toContain("EdgeTokenRouteExclusion");

    const runner0 = compiled.resources["KvitbitRunner0"];
    const serverRes = compiled.resources["KvitbitServer"];
    expect(runner0).toBeDefined();
    expect(serverRes).toBeDefined();

    const runnerUpstreams = EffectRecord.keys(Output.upstreamAny(runner0?.Props));
    expect(runnerUpstreams).toEqual(
      expect.arrayContaining([
        "KvitbitRunnerSubnet",
        "KvitbitRouter",
        "KvitbitRunnerClusterIngress",
        "RunnerBlobsAdmin",
        "RunnerArtifactReader",
        "SecretAccess-kvitbit-prod-database-url-runner",
        "SecretAccess-kvitbit-prod-runner-database-url-unpooled-runner",
        "SecretAccess-kvitbit-prod-better-auth-secret-runner",
      ]),
    );

    const serverUpstreams = EffectRecord.keys(Output.upstreamAny(serverRes?.Props));
    expect(serverUpstreams).toEqual(
      expect.arrayContaining([
        "KvitbitRunnerSubnet",
        "KvitbitRouter",
        "KvitbitRunnerClusterIngress",
        "ServerBlobsAdmin",
        "ServerMobileAssetsViewer",
        "SecretAccess-kvitbit-prod-database-url-server",
        "SecretAccess-kvitbit-prod-better-auth-secret-server",
      ]),
    );
    expect(serverUpstreams).not.toContain(
      "SecretAccess-kvitbit-prod-runner-database-url-unpooled-server",
    );

    // Also verify edge construction with real Outputs produces zero coercion exceptions
    const edgeConfig = sampleProdConfig();
    const compiledWithEdge = await compileHermetic(
      "KvitbitEdgeTest",
      Effect.gen(function* () {
        const foundation = yield* declareFoundation(edgeConfig);
        const network = yield* declareNetworkAndRunners(edgeConfig, {
          runnerServiceAccountEmail: foundation.runnerServiceAccountEmail,
          blobsBucketName: edgeConfig.blobsBucket,
          runnerDependencies: foundation.runnerDependencies,
        });
        const server = yield* declareServerService(edgeConfig, {
          networkName: network.networkName,
          subnetworkName: network.subnetworkName,
          blobsBucketName: edgeConfig.blobsBucket,
          mobileAssetsBucketName: edgeConfig.mobileAssetsBucket,
          serverServiceAccountEmail: foundation.serverServiceAccountEmail,
          serverDependencies: [
            ...foundation.serverDependencies,
            ...network.networkReadyDependencies,
          ],
        });
        const edge =
          edgeConfig.edge === undefined
            ? undefined
            : yield* declareKvitbitEdge(edgeConfig, edgeConfig.edge, server.serviceId);
        return { edge };
      }),
    );
    expect(EffectRecord.keys(compiledWithEdge.resources)).toContain("EdgeSecurityPolicy");
  });
});

describe("Pure-Alchemy Compute Engine runner pool (#908)", () => {
  test("declares custom VPC, private subnet with Cloud NAT, internal TCP 34431 firewall, and private COS instances", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);

    const vpc = networkProps(config);
    expect(vpc.autoCreateSubnetworks).toBe(false);

    const subnet = subnetworkProps({ config, network: names.networkName });
    expect(subnet.privateIpGoogleAccess).toBe(true);
    expect(subnet.ipCidrRange).toBe("10.42.0.0/20");

    const router = routerProps({ config, network: names.networkName });
    expect(router.nats?.[0]?.natIpAllocateOption).toBe("AUTO_ONLY");

    const fw = runnerFirewallProps({ config, network: names.networkName });
    expect(fw.direction).toBe("INGRESS");
    expect(fw.allowed).toEqual([{ protocol: "tcp", ports: ["34431"] }]);
    expect(fw.sourceRanges).toEqual(["10.42.0.0/20"]);
    expect(fw.targetTags).toEqual([names.runnerTag]);

    const vm = runnerInstanceProps({
      config,
      index: 0,
      deps: {
        network: names.networkName,
        subnetwork: names.subnetworkName,
      },
    });
    expect(vm.sourceImage).toBe(COS_STABLE_IMAGE);
    expect(vm.associatePublicIp).toBe(false);
    expect(vm.zone).toBe("europe-west3-a");
    expect(vm.shieldedInstanceConfig?.enableSecureBoot).toBe(true);
    expect(vm.tags).toEqual([names.runnerTag]);
  });

  test("startup script configures COS host iptables, /bin/bash reconciler invocation (noexec-safe), systemd digest+config reconciliation, backoff retries, and S5 runner DB secrets", async () => {
    const config = sampleProdConfig();
    const script = buildRunnerStartupScript();

    // Valid bash syntax
    const syntaxCheck = await runCommand({
      command: ["bash", "-n"],
      stdin: new TextEncoder().encode(script),
    });
    expect(syntaxCheck.exitCode).toBe(0);

    // Boot and timer start the same unit. Bash makes the script usable on a noexec mount.
    expect(script).toContain("ExecStart=/bin/bash /var/lib/kvitbit/reconcile-worker.sh");
    expect(script).toContain("\nsystemctl start kvitbit-worker-reconcile.service\n");
    expect(script).toContain("\nUnit=kvitbit-worker-reconcile.service\n");
    expect(script).not.toContain("ExecStart=/var/lib/kvitbit/reconcile-worker.sh");
    expect(script).not.toContain("\n/var/lib/kvitbit/reconcile-worker.sh\n");

    expect(script).toContain("network-interfaces/0/ip");
    expect(script).toContain('iptables -C INPUT -s "$cidr" -p tcp --dport "$port" -j ACCEPT');
    expect(script).toContain('iptables -I INPUT -s "$cidr" -p tcp --dport "$port" -j ACCEPT');
    expect(script).toContain("kvitbit-worker-reconcile.timer");
    expect(script).toContain("instance/attributes/kvitbit-image-ref");
    expect(script).toContain("instance/attributes/kvitbit-image-digest");
    expect(script).toContain("instance/attributes/kvitbit-worker-config");
    expect(script).toContain("instance/attributes/kvitbit-worker-config-sha");
    expect(script).toContain('publish_guest_attribute "active-digest"');
    expect(script).toContain('publish_guest_attribute "active-config-sha"');
    expect(script).toContain('publish_guest_attribute "active-target"');
    expect(script).toContain("retry_with_backoff");
    expect(script).toContain("secretmanager.googleapis.com/v1/projects/");

    const workerConfig = buildRunnerWorkerConfig({ config });
    const workerConfigSha = runnerWorkerConfigSha(workerConfig);
    expect(workerConfigSha).toMatch(matchPattern);
    expect(Arr.map(workerConfig.secrets, (s) => s.secretId)).toEqual(
      expect.arrayContaining([
        "kvitbit-prod-database-url",
        "kvitbit-prod-runner-database-url-unpooled",
        "kvitbit-prod-better-auth-secret",
      ]),
    );

    const vm = runnerInstanceProps({
      config,
      index: 0,
      deps: {
        network: "vpc",
        subnetwork: "subnet",
      },
    });
    expect(vm.metadata?.["kvitbit-image-ref"]).toBe(imageReference(config));
    expect(vm.metadata?.["kvitbit-image-digest"]).toBe(config.imageDigest);
    expect(vm.metadata?.["kvitbit-worker-config"]).toBe(serializeRunnerWorkerConfig(workerConfig));
    expect(vm.metadata?.["kvitbit-worker-config-sha"]).toBe(workerConfigSha);
    expect(vm.metadata?.["enable-guest-attributes"]).toBe("TRUE");

    const runnerEnvNames = Arr.map(
      runnerPlainEnv({ config, blobsBucket: config.blobsBucket }),
      (e) => e.name,
    );
    expect(runnerEnvNames).toEqual(
      expect.arrayContaining([
        "PORT",
        "LISTEN_HOST",
        "KVITBIT_RUNNER_MODE",
        "KVITBIT_BLOB_DRIVER",
        "KVITBIT_BLOB_BUCKET",
        "KVITBIT_GCS_PROJECT",
        "KVITBIT_CHROMIUM_PATH",
        "APP_ORIGIN",
        "EMAIL_FROM",
      ]),
    );
  });

  const makeRunnerSandbox = async (sandbox: string) => {
    const config1 = sampleProdConfig({
      emailFrom: "Kvitbit <no-reply@kvitbit.cz>",
      secrets: defaultSecretBindings("prod", { enableResend: true, enableSmtp: false }),
    });
    const config2 = sampleProdConfig({
      emailFrom: "Billing <billing@kvitbit.cz>",
      secrets: defaultSecretBindings("prod", { enableResend: true, enableSmtp: true }),
    });

    const workerConfig1 = buildRunnerWorkerConfig({ config: config1 });
    const workerConfig2 = buildRunnerWorkerConfig({ config: config2 });
    const configJson1 = serializeRunnerWorkerConfig(workerConfig1);
    const configJson2 = serializeRunnerWorkerConfig(workerConfig2);
    const configSha1 = runnerWorkerConfigSha(workerConfig1);
    const configSha2 = runnerWorkerConfigSha(workerConfig2);
    if (configSha1 === configSha2)
      throw new Error("Expected worker configs with different digests");

    const startup = buildRunnerStartupScript();
    const match = Option.getOrNull(Str.match(catReconcileVarPattern)(startup));
    if (match?.[1] === undefined) throw new Error("Expected an embedded worker reconciler");

    const binDir = join(sandbox, "bin");
    const runDir = join(sandbox, "run");
    const stateDir = join(sandbox, "state");
    const systemdDir = join(sandbox, "systemd");
    for (const dir of [binDir, runDir, stateDir, systemdDir]) {
      await Effect.runPromise(fixtureFileSystem.makeDirectory(dir, { recursive: true }));
    }

    // Rewrite /run/kvitbit and /etc/systemd/system to sandboxed dirs for hermetic execution
    const reconcileScript = Str.replaceAll(
      "/etc/systemd/system",
      systemdDir,
    )(Str.replaceAll("/run/kvitbit", runDir)(match[1]));
    const scriptPath = join(sandbox, "reconcile-worker.sh");
    await Effect.runPromise(fixtureFileSystem.writeFileString(scriptPath, reconcileScript));
    // Do NOT set +x: proves /bin/bash execution works even on noexec filesystems
    await Effect.runPromise(fixtureFileSystem.chmod(scriptPath, 0o600));

    const digest2 = `sha256:${Str.repeat(64)("b")}`;
    const ref1 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${SAMPLE_DIGEST}`;
    const ref2 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest2}`;
    const imageId1 = `sha256:${Str.repeat(64)("c")}`;
    const imageId2 = `sha256:${Str.repeat(64)("d")}`;
    await Effect.runPromise(fixtureFileSystem.writeFileString(join(stateDir, "target-ref"), ref1));
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(stateDir, "target-digest"), SAMPLE_DIGEST),
    );
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(stateDir, "target-config"), configJson1),
    );
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(stateDir, "target-config-sha"), configSha1),
    );
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(stateDir, "attributes-etag"), "initial"),
    );
    await Effect.runPromise(fixtureFileSystem.writeFileString(join(stateDir, "fail-once"), "1"));
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(stateDir, "registry-ref"), ref1),
    );
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(stateDir, "registry-image-id"), imageId1),
    );

    // Stub sleep (no-op for fast retry test)
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n"),
    );
    await Effect.runPromise(fixtureFileSystem.chmod(join(binDir, "sleep"), 0o755));

    // Stub iptables (tracks whether rule is installed)
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(
        join(binDir, "iptables"),
        `#!/bin/sh
set -eu
RULE_FILE="${stateDir}/iptables-rule"
if [ "$1" = "-C" ]; then
  [ -f "$RULE_FILE" ]
  exit $?
elif [ "$1" = "-I" ]; then
  echo "$*" > "$RULE_FILE"
  echo "iptables:$*" >> "${stateDir}/log"
  exit 0
fi
exit 1
`,
      ),
    );
    await Effect.runPromise(fixtureFileSystem.chmod(join(binDir, "iptables"), 0o755));

    // Stub curl (simulates metadata, transient failure on first metadata call, Secret Manager, and guest attributes PUT)
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(
        join(binDir, "curl"),
        `#!/bin/sh
set -eu
URL=""
DATA=""
METHOD="GET"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) METHOD="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    -H|--connect-timeout|--max-time|--dump-header|--output) shift 2 ;;
    -*) shift ;;
    *) URL="$1"; shift ;;
  esac
done

if [ "$METHOD" = "PUT" ]; then
  printf '%s %s\\n' "$URL" "$DATA" >> "${stateDir}/guest-writes"
  case "$URL" in
    *"guest-attributes/kvitbit/active-digest")
      printf '%s' "$DATA" > "${stateDir}/guest-active-digest"
      ;;
    *"guest-attributes/kvitbit/active-config-sha")
      printf '%s' "$DATA" > "${stateDir}/guest-active-config-sha"
      ;;
    *"guest-attributes/kvitbit/active-target")
      if [ "$DATA" = "pending" ] && [ -f "${stateDir}/fail-invalidation" ]; then
        exit 22
      fi
      if [ "$DATA" != "pending" ] && [ -f "${stateDir}/fail-active-target-once" ]; then
        rm -f "${stateDir}/fail-active-target-once"
        exit 22
      fi
      printf '%s' "$DATA" > "${stateDir}/guest-active-target"
      ;;
  esac
  exit 0
fi

case "$URL" in
  *"instance/attributes/?recursive=true")
    printf 'HTTP/1.1 200 OK\\r\\nETag: %s\\r\\n\\r\\n' "$(cat "${stateDir}/attributes-etag")"
    ;;
  *"network-interfaces/0/ip")
    if [ -f "${stateDir}/fail-once" ]; then
      rm -f "${stateDir}/fail-once"
      exit 22
    fi
    printf '10.42.0.10'
    ;;
  *"service-accounts/default/token")
    printf '{"access_token":"tok-123","expires_in":3600}'
    ;;
  *"attributes/kvitbit-image-ref")
    cat "${stateDir}/target-ref"
    ;;
  *"attributes/kvitbit-image-digest")
    cat "${stateDir}/target-digest"
    ;;
  *"attributes/kvitbit-worker-config-sha")
    cat "${stateDir}/target-config-sha"
    ;;
  *"attributes/kvitbit-worker-config")
    echo "config fetch" >> "${stateDir}/config-reads"
    cat "${stateDir}/target-config"
    if [ -f "${stateDir}/next-attributes-etag" ]; then
      mv "${stateDir}/next-attributes-etag" "${stateDir}/attributes-etag"
    fi
    ;;
  *"secretmanager.googleapis.com"*"kvitbit-prod-smtp-url"*)
    SECRET_VAL="$(printf '%s' "smtps://mailer.example:465" | base64 | tr -d '\\n')"
    printf '{"payload":{"data":"%s"}}' "$SECRET_VAL"
    ;;
  *"secretmanager.googleapis.com"*)
    SECRET_VAL="$(printf '%s' "secret-val" | base64 | tr -d '\\n')"
    printf '{"payload":{"data":"%s"}}' "$SECRET_VAL"
    ;;
  *)
    exit 1
    ;;
esac
`,
      ),
    );
    await Effect.runPromise(fixtureFileSystem.chmod(join(binDir, "curl"), 0o755));

    // Stub docker with a local image store enforcing --pull=never restart semantics.
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(
        join(binDir, "docker"),
        `#!/bin/sh
set -eu
case "$1" in
  inspect)
    [ -f "${stateDir}/running-image-id" ] || exit 1
    image_id="$(cat "${stateDir}/running-image-id")"
    if printf '%s' "$*" | grep -Fq 'if .State.Running'; then
      printf '%s' "$image_id"
      exit 0
    fi
    configured_image="$image_id"
    if [ -f "${stateDir}/legacy-image-ref" ]; then
      configured_image="$(cat "${stateDir}/legacy-image-ref")"
    fi
    printf 'true|%s|%s|%s|%s' "$image_id" "$configured_image" "$(cat "${stateDir}/running-digest")" "$(cat "${stateDir}/running-config-sha")"
    ;;
  login)
    cat >/dev/null
    echo "docker:login" >> "${stateDir}/log"
    ;;
  pull)
    [ "$2" = "--" ] || exit 1
    echo "docker:pull:$3" >> "${stateDir}/log"
    if [ -f "${stateDir}/fail-pull" ]; then
      exit 1
    fi
    printf '%s' "$3" > "${stateDir}/pulled-ref"
    cp "${stateDir}/registry-image-id" "${stateDir}/pulled-image-id"
    cp "${stateDir}/registry-ref" "${stateDir}/pulled-repo-digest"
    cat "${stateDir}/registry-image-id" >> "${stateDir}/images"
    printf '\\n' >> "${stateDir}/images"
    ;;
  container)
    if [ "$2" = "prune" ]; then
      echo "docker:prune:containers" >> "${stateDir}/log"
      exit 0
    fi
    exit 1
    ;;
  image)
    if [ "$2" = "ls" ]; then
      if [ -f "${stateDir}/images" ]; then
        cat "${stateDir}/images"
      fi
      exit 0
    fi
    if [ "$2" = "rm" ]; then
      target_id=""
      for arg in "$@"; do
        target_id="$arg"
      done
      echo "docker:rmi:$target_id" >> "${stateDir}/log"
      if [ -f "${stateDir}/images" ]; then
        grep -Fxv -- "$target_id" "${stateDir}/images" > "${stateDir}/images.tmp" || true
        mv -f "${stateDir}/images.tmp" "${stateDir}/images"
      fi
      exit 0
    fi
    [ "$2" = "inspect" ] && [ -f "${stateDir}/pulled-ref" ] || exit 1
    [ "$5" = "$(cat "${stateDir}/pulled-ref")" ] || exit 1
    printf '%s\\n%s\\n' "$(cat "${stateDir}/pulled-image-id")" "$(cat "${stateDir}/pulled-repo-digest")"
    ;;
  *) exit 1 ;;
esac
`,
      ),
    );
    await Effect.runPromise(fixtureFileSystem.chmod(join(binDir, "docker"), 0o755));

    // Stub systemctl (activates target digest + config sha as running; enforces --pull=never)
    await Effect.runPromise(
      fixtureFileSystem.writeFileString(
        join(binDir, "systemctl"),
        `#!/bin/sh
set -eu
echo "systemctl:$*" >> "${stateDir}/log"
if [ "$1" = "stop" ]; then
  rm -f "${stateDir}/running-image-id" "${stateDir}/running-digest" "${stateDir}/running-config-sha" "${stateDir}/legacy-image-ref"
fi
if [ "$1" = "start" ]; then
  . "${runDir}/worker-target.env"
  grep -Fq 'docker run --pull=never ' "${systemdDir}/kvitbit-worker.service"
  grep -Fxq -- "$KVITBIT_WORKER_IMAGE" "${stateDir}/images"
  printf '%s' "$KVITBIT_WORKER_IMAGE" > "${stateDir}/running-image-id"
  printf '%s' "$KVITBIT_WORKER_DIGEST" > "${stateDir}/running-digest"
  printf '%s' "$KVITBIT_WORKER_CONFIG_SHA" > "${stateDir}/running-config-sha"
fi
`,
      ),
    );
    await Effect.runPromise(fixtureFileSystem.chmod(join(binDir, "systemctl"), 0o755));

    const env = { PATH: `${binDir}:${systemPath}` };
    const reconcile = () => runCommand({ command: ["/bin/bash", scriptPath], env });

    return {
      binDir,
      reconcile,
      runDir,
      stateDir,
      digest1: SAMPLE_DIGEST,
      digest2,
      ref1,
      ref2,
      imageId1,
      imageId2,
      configSha1,
      configSha2,
      configJson2,
    };
  };

  const withRunnerSandbox = async (
    run: (fixture: Awaited<ReturnType<typeof makeRunnerSandbox>>) => Promise<void>,
  ) => {
    const sandbox = await Effect.runPromise(
      fixtureFileSystem.makeTempDirectory({ prefix: "kvitbit-reconcile-" }),
    );
    try {
      await run(await makeRunnerSandbox(sandbox));
    } finally {
      await Effect.runPromise(fixtureFileSystem.remove(sandbox, { recursive: true, force: true }));
    }
  };

  test("reconcile replaces legacy workers, rolls out config and digest changes, and skips no-op ticks", async () => {
    await withRunnerSandbox(
      async ({
        binDir,
        reconcile,
        runDir,
        stateDir,
        digest1,
        digest2,
        ref1,
        ref2,
        imageId1,
        imageId2,
        configSha1,
        configSha2,
        configJson2,
      }) => {
        // A legacy worker can have the expected labels and image with stale environment values.
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "legacy-image-ref"), ref1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "pulled-ref"), ref1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "pulled-repo-digest"), ref1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "pulled-image-id"), imageId1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "running-image-id"), imageId1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "running-digest"), digest1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "running-config-sha"), configSha1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(
            join(runDir, "worker.env"),
            "EMAIL_FROM=stale@example.invalid\n",
          ),
        );

        // The initial reconcile survives a transient request failure and replaces the legacy worker.
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-image-id")),
          ),
        ).toBe(imageId1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-digest")),
          ),
        ).toBe(digest1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-config-sha")),
          ),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-target")),
          ),
        ).toBe(`${digest1}|${configSha1}`);
        const env1 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(runDir, "worker.env")),
        );
        expect(env1).toContain("DATABASE_URL_UNPOOLED=secret-val");
        expect(env1).toContain("EMAIL_FROM=Kvitbit <no-reply@kvitbit.cz>");
        expect(env1).not.toContain("KVITBIT_SMTP_URL=");
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "iptables-rule")),
          ),
        ).toContain("10.42.0.0/20");

        const logAfterFirst = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );
        expect(logAfterFirst).toContain("systemctl:start kvitbit-worker.service");

        // 2. Second reconcile with same digest AND same config is a no-op
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
        ).toBe(logAfterFirst);

        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config"), configJson2),
        );
        expect((await reconcile()).exitCode).toBe(0);
        const env2 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(runDir, "worker.env")),
        );
        expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
        expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
        const logAfterConfigUpdate = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );

        // Image metadata updates must agree before the runner pulls anything.
        const guestWritesAfterConfigUpdate = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "guest-writes")),
        );
        const targetEnv2 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(runDir, "worker-target.env")),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-ref"), ref2),
        );
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
        ).toBe(logAfterConfigUpdate);

        // A successful pull still needs to report the requested registry digest.
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-digest"), digest2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "registry-image-id"), imageId2),
        );
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-digest")),
          ),
        ).toBe(digest1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-image-id")),
          ),
        ).toBe(imageId1);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "guest-writes"))),
        ).toBe(guestWritesAfterConfigUpdate);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(runDir, "worker.env"))),
        ).toBe(env2);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(runDir, "worker-target.env")),
          ),
        ).toBe(targetEnv2);

        // Simulate --rm worker exiting (5s systemd RestartSec window, no running container)
        // while a stale image is on disk and the replacement pull fails: stale image must be
        // pruned before pull, while worker-target.env's installed imageId1 survives so systemd
        // can restart kvitbit-worker with --pull=never.
        const staleImageId = `sha256:${Str.repeat(64)("9")}`;
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(
            join(stateDir, "images"),
            `${staleImageId}\n${imageId1}\n`,
          ),
        );
        await Effect.runPromise(fixtureFileSystem.remove(join(stateDir, "running-image-id")));
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "fail-pull"), "1"),
        );
        const logBeforeFailedPull = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );
        expect((await reconcile()).exitCode).toBe(1);
        const failedPullDelta = Str.split(
          Str.trim(
            Str.slice(logBeforeFailedPull.length)(
              await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
            ),
          ),
          "\n",
        );
        const staleRmiIdx = failedPullDelta.indexOf(`docker:rmi:${staleImageId}`);
        const failedPullIdx = failedPullDelta.indexOf(`docker:pull:${ref2}`);
        expect(staleRmiIdx).toBeGreaterThanOrEqual(0);
        expect(failedPullIdx).toBeGreaterThan(staleRmiIdx);
        expect(failedPullDelta).not.toContain(`docker:rmi:${imageId1}`);
        const imagesAfterFailedPull = Arr.filter(
          Str.split(
            Str.trim(
              await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "images"))),
            ),
            "\n",
          ),
          Boolean,
        );
        expect(imagesAfterFailedPull).toEqual([imageId1]);
        // Confirm systemd can still restart the installed worker with --pull=never.
        const restartCheck = await runCommand({
          command: [join(binDir, "systemctl"), "start", "kvitbit-worker.service"],
        });
        expect(restartCheck.exitCode).toBe(0);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-image-id")),
          ),
        ).toBe(imageId1);
        await Effect.runPromise(fixtureFileSystem.remove(join(stateDir, "fail-pull")));

        // Now allow the verified pull to succeed and inspect ONLY this reconcile's delta log.
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "registry-ref"), ref2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(
            join(stateDir, "images"),
            `${staleImageId}\n${imageId1}\n`,
          ),
        );
        const logBeforeRollout = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-image-id")),
          ),
        ).toBe(imageId2);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-digest")),
          ),
        ).toBe(digest2);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-config-sha")),
          ),
        ).toBe(configSha2);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-target")),
          ),
        ).toBe(`${digest2}|${configSha2}`);
        const rolloutDelta = Str.split(
          Str.trim(
            Str.slice(logBeforeRollout.length)(
              await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
            ),
          ),
          "\n",
        );
        const prePullContainerPruneIdx = rolloutDelta.indexOf("docker:prune:containers");
        const prePullRmiIdx = rolloutDelta.indexOf(`docker:rmi:${staleImageId}`);
        const pullRef2Idx = rolloutDelta.indexOf(`docker:pull:${ref2}`);
        const startIdx = rolloutDelta.indexOf("systemctl:start kvitbit-worker.service");
        const postSwitchRmiOldIdx = rolloutDelta.indexOf(`docker:rmi:${imageId1}`, startIdx);
        expect(prePullContainerPruneIdx).toBeGreaterThanOrEqual(0);
        expect(prePullRmiIdx).toBeGreaterThan(prePullContainerPruneIdx);
        expect(pullRef2Idx).toBeGreaterThan(prePullRmiIdx);
        expect(startIdx).toBeGreaterThan(pullRef2Idx);
        expect(postSwitchRmiOldIdx).toBeGreaterThan(startIdx);
        expect(rolloutDelta).not.toContain(`docker:rmi:${imageId2}`);
        const imagesAfterRollout = Arr.filter(
          Str.split(
            Str.trim(
              await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "images"))),
            ),
            "\n",
          ),
          Boolean,
        );
        expect(imagesAfterRollout).toEqual([imageId2]);
        expect(
          Arr.filter(
            Str.split(
              Str.trim(
                await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
              ),
              "\n",
            ),
            (l) => l === "systemctl:start kvitbit-worker.service",
          ).length,
        ).toBe(4);
      },
    );
  });

  test("reconcile retries unavailable config without changing the running target, then converges on recovery", async () => {
    await withRunnerSandbox(
      async ({ reconcile, runDir, stateDir, digest1, configSha1, configSha2, configJson2 }) => {
        expect((await reconcile()).exitCode).toBe(0);
        const env1 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(runDir, "worker.env")),
        );
        const logAfterFirst = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );

        // A new config SHA can become visible while fetching its JSON still fails.
        const guestWrites = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "guest-writes")),
        );
        const configReads = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "config-reads")),
        );
        const targetEnv1 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(runDir, "worker-target.env")),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(fixtureFileSystem.remove(join(stateDir, "target-config")));
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "config-reads"))),
        ).toBe(configReads + Str.repeat(6)("config fetch\n"));

        // The expected SHA covers every response byte, including any trailing newline.
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config"), `${configJson2}\n`),
        );
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-config-sha")),
          ),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-config-sha")),
          ),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "guest-writes"))),
        ).toBe(guestWrites);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(runDir, "worker.env"))),
        ).toBe(env1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(runDir, "worker-target.env")),
          ),
        ).toBe(targetEnv1);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
        ).toBe(logAfterFirst);

        // The next tick applies the config-only rollout once its JSON is available.
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config"), configJson2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(
            join(stateDir, "next-attributes-etag"),
            "changed-during-fetch",
          ),
        );
        const readsBeforeRecovery = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "config-reads")),
        );
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "config-reads"))),
        ).toBe(readsBeforeRecovery + Str.repeat(2)("config fetch\n"));
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-digest")),
          ),
        ).toBe(digest1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-config-sha")),
          ),
        ).toBe(configSha2);
        const env2 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(runDir, "worker.env")),
        );
        expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
        expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
        expect(
          Arr.filter(
            Str.split(
              await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
              "\n",
            ),
            (l) => l === "systemctl:start kvitbit-worker.service",
          ).length,
        ).toBe(2);
        const logAfterConfigUpdate = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
        ).toBe(logAfterConfigUpdate);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-target")),
          ),
        ).toBe(`${digest1}|${configSha2}`);
      },
    );
  });

  test("deploy waits for the verified rollback after a worker acknowledgement fails", async () => {
    await withRunnerSandbox(
      async ({ binDir, reconcile, stateDir, digest1, configSha1, configSha2, configJson2 }) => {
        const workflowSchema = Schema.Struct({
          jobs: Schema.Struct({
            deploy: Schema.Struct({
              steps: Schema.Array(
                Schema.Struct({
                  name: Schema.optional(Schema.String),
                  run: Schema.optional(Schema.String),
                }),
              ),
            }),
          }),
        });
        const workflow = Schema.decodeUnknownResult(workflowSchema)(
          Bun.YAML.parse(
            await Effect.runPromise(
              fixtureFileSystem.readFileString(
                resolve(import.meta.dir, "../../../.github/workflows/deploy.yml"),
              ),
            ),
          ),
        ).pipe(Result.getOrThrow);
        const verify = Option.getOrUndefined(
          Arr.findFirst(
            workflow.jobs.deploy.steps,
            (step) => step.name === "Verify runner pool reconciled target digest and config",
          ),
        )?.run;
        if (verify === undefined) throw new Error("Expected the runner verification step");
        const gcloud = join(binDir, "gcloud");
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(
            gcloud,
            `#!/bin/sh
set -eu
case "$3" in
  list) printf 'runner\\n' ;;
  describe)
    printf '{"metadata":{"items":[{"key":"kvitbit-worker-config-sha","value":"%s"}]}}' "$(cat "${stateDir}/target-config-sha")"
    ;;
  get-guest-attributes) cat "${stateDir}/guest-active-target" ;;
  reset) : ;;
  *) exit 1 ;;
esac
`,
          ),
        );
        await Effect.runPromise(fixtureFileSystem.chmod(gcloud, 0o755));
        const verifyRollout = () =>
          runCommand({
            command: ["bash", "-c", verify],
            env: {
              PATH: `${binDir}:${systemPath}`,
              GCP_PROJECT_ID: "kvitbit-prod",
              GCP_ZONE: "europe-west3-a",
              KVITBIT_STAGE: "prod",
              TARGET_DIGEST: digest1,
            },
          });

        expect((await reconcile()).exitCode).toBe(0);
        const configJson1 = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "target-config")),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config"), configJson2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "fail-active-target-once"), ""),
        );
        const changed = await reconcile();
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-config-sha")),
          ),
        ).toBe(configSha2);

        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config"), configJson1),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config-sha"), configSha1),
        );
        expect((await verifyRollout()).exitCode).toBe(1);
        expect(changed.exitCode).toBe(1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-target")),
          ),
        ).toBe("pending");
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-config-sha")),
          ),
        ).toBe(configSha1);
        expect((await verifyRollout()).exitCode).toBe(0);

        // If invalidation fails, the current worker must remain running and acknowledged.
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config"), configJson2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "fail-invalidation"), ""),
        );
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "running-config-sha")),
          ),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(
            fixtureFileSystem.readFileString(join(stateDir, "guest-active-target")),
          ),
        ).toBe(`${digest1}|${configSha1}`);

        // A later tick can confirm a running target after an acknowledgement write failure.
        await Effect.runPromise(fixtureFileSystem.remove(join(stateDir, "fail-invalidation")));
        await Effect.runPromise(
          fixtureFileSystem.writeFileString(join(stateDir, "fail-active-target-once"), ""),
        );
        expect((await reconcile()).exitCode).toBe(1);
        const log = await Effect.runPromise(
          fixtureFileSystem.readFileString(join(stateDir, "log")),
        );
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(fixtureFileSystem.readFileString(join(stateDir, "log"))),
        ).toBe(log);
        expect((await verifyRollout()).exitCode).toBe(0);
      },
    );
  });
});

describe("Cloud Run server service", () => {
  test("wires configured feedback to Cloud Run with a server-only Secret Manager grant", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_STAGE: "staging",
        KVITBIT_GCP_PROJECT_ID: "kvitbit-staging",
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_APP_ORIGIN: "https://staging.kvitbit.cz",
        KVITBIT_EMAIL_MODE: "capture",
        KVITBIT_BOT_PROTECTION_MODE: "none",
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: " YES ",
        KVITBIT_FEEDBACK_GITHUB_REPO: " owner/feedback ",
        KVITBIT_FEEDBACK_OWNER_EMAILS: " owner@example.com, admin@example.com ",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    const names = resourceNames(config);
    const secretId = "kvitbit-staging-feedback-github-token";
    const secret = `projects/kvitbit-staging/secrets/${secretId}`;
    expect(Arr.map(secretDeclarations(config), (entry) => entry.secretId)).toContain(secretId);
    expect(
      Arr.filter(secretAccessorGrants(config), (grant) => grant.secretId === secretId),
    ).toEqual([
      {
        id: `SecretAccess-${secretId}-server`,
        secretId,
        workload: "server",
        props: {
          kind: "secretmanager.secret",
          name: secret,
          role: "roles/secretmanager.secretAccessor",
          member: `serviceAccount:${names.serverServiceAccountId}@kvitbit-staging.iam.gserviceaccount.com`,
        },
      },
    ]);

    const service = serverServiceProps({
      config,
      deps: {
        networkName: names.networkName,
        subnetworkName: names.subnetworkName,
        blobsBucketName: config.blobsBucket,
        mobileAssetsBucketName: config.mobileAssetsBucket,
      },
    });
    const container = service.template?.containers?.[0];
    const env = container !== undefined && "env" in container ? container.env : undefined;
    expect(env).toContainEqual({ name: "KVITBIT_FEEDBACK_GITHUB_REPO", value: "owner/feedback" });
    expect(env).toContainEqual({
      name: "KVITBIT_FEEDBACK_OWNER_EMAILS",
      value: "owner@example.com, admin@example.com",
    });
    expect(env).toContainEqual({
      name: "KVITBIT_FEEDBACK_GITHUB_TOKEN",
      valueSource: { secretKeyRef: { secret, version: "latest" } },
    });

    const runner = buildRunnerWorkerConfig({ config });
    expect(
      Arr.some(runner.plainEnv, (entry) => Str.startsWith("KVITBIT_FEEDBACK_")(entry.name)),
    ).toBe(false);
    expect(Arr.map(runner.secrets, (entry) => entry.secretId)).not.toContain(secretId);
  });

  test("wires Direct VPC egress, /healthz probes, cluster mode, and all shared env vars", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);
    const props = serverServiceProps({
      config,
      deps: {
        networkName: names.networkName,
        subnetworkName: names.subnetworkName,
        blobsBucketName: config.blobsBucket,
        mobileAssetsBucketName: config.mobileAssetsBucket,
      },
    });

    expect(props.location).toBe("europe-west3");
    expect(props.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(props.template?.vpcAccess?.egress).toBe("PRIVATE_RANGES_ONLY");
    expect(props.template?.vpcAccess?.networkInterfaces?.[0]).toEqual({
      network: names.networkName,
      subnetwork: names.subnetworkName,
    });

    const container = props.template?.containers?.[0];
    expect(container !== undefined && "image" in container ? container.image : undefined).toBe(
      imageReference(config),
    );
    expect(
      container !== undefined && "startupProbe" in container
        ? container.startupProbe?.httpGet?.path
        : null,
    ).toBe("/healthz");
    expect(
      container !== undefined && "livenessProbe" in container
        ? container.livenessProbe?.httpGet?.path
        : null,
    ).toBe("/healthz");

    const plainNames = Arr.map(
      serverPlainEnv({
        config,
        buckets: {
          blobsBucket: config.blobsBucket,
          mobileAssetsBucket: config.mobileAssetsBucket,
        },
      }),
      (e) => e.name,
    );
    const secretNames = Arr.map(serverSecretEnv(config), (e) => e.name);
    expect(plainNames).not.toContain("KVITBIT_FEEDBACK_GITHUB_REPO");
    expect(plainNames).not.toContain("KVITBIT_FEEDBACK_OWNER_EMAILS");
    expect(secretNames).not.toContain("KVITBIT_FEEDBACK_GITHUB_TOKEN");

    for (const required of [
      "KVITBIT_RUNNER_MODE",
      "KVITBIT_BLOB_DRIVER",
      "KVITBIT_BLOB_DIR",
      "KVITBIT_BLOB_BUCKET",
      "KVITBIT_GCS_PROJECT",
      "KVITBIT_WEB_DIR",
      "KVITBIT_PWA_DIR",
      "KVITBIT_CHROMIUM_PATH",
      "APP_ORIGIN",
      "EMAIL_FROM",
      "KVITBIT_TRUSTED_PROXY_HOPS",
      "KVITBIT_SHARE_KEY_VERSION",
      "KVITBIT_MOBILE_STORAGE_BUCKET",
      "KVITBIT_MOBILE_STORAGE_DIR",
      "KVITBIT_ANDROID_ASSETLINKS_SHA256",
    ]) {
      expect(plainNames).toContain(required);
    }

    for (const requiredSecret of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "RESEND_API_KEY",
      "KVITBIT_SMTP_URL",
      "KVITBIT_MOBILE_UPDATES_SIGNING_KEY",
    ]) {
      expect(secretNames).toContain(requiredSecret);
    }
    // S5: Cloud Run server never receives runner direct-connection credentials
    expect(secretNames).not.toContain("DATABASE_URL_UNPOOLED");
  });
});

describe("Pure-Alchemy Edge (Cloud Armor + Cloud CDN + Token Log Exclusion)", () => {
  test("wires WAF, /api/auth/ throttling, static CDN, and token-route log exclusion", () => {
    const config = sampleProdConfig();
    const edge = config.edge;
    if (edge === undefined) {
      throw new Error("expected edge config");
    }

    const names = edgeObjectNames(config);
    expect(names.securityPolicy).toBe("kvitbit-prod-edge-armor");

    const policy = edgeSecurityPolicyProps({ config, edge });
    expect(policy.type).toBe("CLOUD_ARMOR");
    expect(Arr.some(policy.rules, (r) => r.action === "throttle")).toBe(true);
    expect(Arr.some(policy.rules, (r) => r.priority === 2147483647 && r.action === "allow")).toBe(
      true,
    );

    const links = { backendGroup: "neg-link", securityPolicy: "policy-link" };
    const dyn = edgeDynamicBackendProps({ config, links });
    expect(dyn.logConfig.enable).toBe(false);

    const stat = edgeStaticBackendProps({ config, edge, links });
    expect("cdnPolicy" in stat && stat.cdnPolicy.cacheMode).toBe("USE_ORIGIN_HEADERS");

    const urlMap = edgeUrlMapProps({ config, edge, backends: { dynamic: "dyn", static: "stat" } });
    expect(urlMap.hostRules[0]?.hosts).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(urlMap.pathMatchers[0]?.pathRules[0]?.paths).toEqual([...edgeStaticAssetPaths]);

    expect(tokenRouteExclusionFilter).toContain("/i/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/invite/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/share/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/invitations/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/auth/magic-link/verify");

    // Behavioral regex check against real token-bearing and non-token URLs
    const regexMatch = Option.getOrNull(
      Str.match(httprequestRequesturlPattern)(tokenRouteExclusionFilter),
    );
    expect(regexMatch?.[1]).toBeDefined();
    const pattern = new RegExp(regexMatch?.[1] ?? "");

    for (const url of [
      "https://kvitbit.cz/i/tok123",
      "https://kvitbit.cz/i/tok123?download=1",
      "https://kvitbit.cz/invite/inv456",
      "https://kvitbit.cz/api/v1/share/tok123",
      "https://kvitbit.cz/api/v1/share/tok123/pdf",
      "https://kvitbit.cz/api/v1/invitations/inv456",
      "https://kvitbit.cz/api/v1/invitations/inv456/accept",
      "https://kvitbit.cz/api/auth/magic-link/verify?token=secret",
      "https://kvitbit.cz/api/auth/reset-password/reset789",
      "https://kvitbit.cz/app/auth/callback?code=abc",
    ]) {
      expect(pattern.test(url)).toBe(true);
    }

    for (const url of [
      "https://kvitbit.cz/healthz",
      "https://kvitbit.cz/readyz",
      "https://kvitbit.cz/api/v1/documents",
      "https://kvitbit.cz/api/v1/share",
      "https://kvitbit.cz/api/v1/invitations",
    ]) {
      expect(pattern.test(url)).toBe(false);
    }
    expect(tokenRoutePatterns.length).toBeGreaterThanOrEqual(7);
  });
});

describe("Pure-Alchemy Cloud DNS", () => {
  const compile = (config: KvitbitStackConfig) =>
    Effect.scoped(
      Stack.Stack(
        KVITBIT_STACK_NAME,
        { state: State.inMemoryState(), providers: Layer.empty },
        declareKvitbitStack(config).pipe(Effect.orDie),
      ),
    ).pipe(Effect.provideService(Stage, config.stage), Effect.runPromise);

  const resolveOutputs = <Value>(value: Value, upstream: Readonly<Record<string, Schema.Json>>) =>
    Effect.runPromise(Output.evaluate(value, upstream).pipe(Effect.provide(State.inMemoryState())));

  test.each(["prod", "staging"] as const)(
    "keeps DNS opt-in for %s even when the edge is configured",
    async (stage) => {
      const compiled = await compile(sampleProdConfig({ stage }));
      expect(compiled.resources["EdgeAddress"]).toBeDefined();
      expect(compiled.resources["CloudDnsApi"]).toBeUndefined();
      expect(
        Arr.some(EffectRecord.keys(compiled.resources), (id) => Str.startsWith("DnsZone-")(id)),
      ).toBe(false);
      expect(compiled.output).not.toHaveProperty("dnsNameServers");
    },
  );

  test("declares public zones and exports each zone's nameservers before edge setup", async () => {
    const compiled = await compile(sampleProdConfig({ dnsZones: PROD_DNS_ZONES, edge: undefined }));
    const api = compiled.resources["CloudDnsApi"];
    expect(api?.Type).toBe("GCP.ServiceUsage.ProjectService");
    expect(api?.Props).toEqual({ project: "kvitbit-prod", service: "dns.googleapis.com" });
    expect(
      Arr.filter(EffectRecord.keys(compiled.resources), (id) => Str.startsWith("DnsZone-")(id)),
    ).toEqual(Arr.map(PROD_DNS_ZONES, (domain) => `DnsZone-${domain}`));

    const upstream = EffectRecord.singleton<string, Schema.Json>("CloudDnsApi", {
      state: "ENABLED",
    });
    const expectedNameServers: Record<string, string[]> = {};
    for (const [index, domain] of PROD_DNS_ZONES.entries()) {
      const id = `DnsZone-${domain}`;
      const resource = compiled.resources[id];
      expect(resource?.Type).toBe("GCP.DNS.ManagedZone");
      expect(EffectRecord.keys(Output.upstreamAny(resource?.Props))).toEqual(["CloudDnsApi"]);
      expect(await resolveOutputs(resource?.Props, upstream)).toMatchObject({
        zoneName: expect.stringMatching(
          new RegExp(`^kvitbit-prod-${Str.replace(".", "-")(domain)}-[0-9a-f]{12}$`),
        ),
        dnsName: `${domain}.`,
        visibility: "public",
        labels: { app: "kvitbit", stage: "prod", "managed-by": "alchemy" },
      });
      const nameServers = [`ns-cloud-a${index + 1}.googledomains.com.`];
      upstream[id] = { nameServers };
      expectedNameServers[domain] = nameServers;
    }
    if (
      compiled.output.bootstrapFoundation ||
      ("bootstrapFeedbackSecret" in compiled.output && compiled.output.bootstrapFeedbackSecret) ||
      ("bootstrapAltchaSecret" in compiled.output && compiled.output.bootstrapAltchaSecret) ||
      ("bootstrapResendSecret" in compiled.output && compiled.output.bootstrapResendSecret) ||
      ("bootstrapTurboCacheSecret" in compiled.output && compiled.output.bootstrapTurboCacheSecret)
    ) {
      throw new Error("Expected a full stack");
    }
    const names = await resolveOutputs(compiled.output.dnsNameServers, upstream);
    const decoded = Schema.decodeUnknownResult(
      Schema.Record(Schema.String, Schema.Array(Schema.String)),
    )(names);
    expect(decoded.pipe(Result.getOrThrow)).toEqual(expectedNameServers);
  });

  test("points each apex and www at the reserved edge IP and configures CAA", async () => {
    const compiled = await compile(sampleProdConfig({ dnsZones: PROD_DNS_ZONES }));
    expect(compiled.resources["EdgeAddress"]).toBeDefined();
    for (const domain of PROD_DNS_ZONES) {
      const id = `DnsZone-${domain}`;
      const upstream = {
        [id]: { zoneName: "resolved-zone" },
        EdgeAddress: { address: "192.0.2.42" },
      };
      const expectedRecords = [
        { suffix: "ApexA", name: `${domain}.`, type: "A", rrdatas: ["192.0.2.42"] },
        { suffix: "WwwA", name: `www.${domain}.`, type: "A", rrdatas: ["192.0.2.42"] },
        {
          suffix: "ApexCaa",
          name: `${domain}.`,
          type: "CAA",
          rrdatas: ['0 issue "pki.goog"', '0 issue "letsencrypt.org"'],
        },
      ];
      for (const { suffix, ...record } of expectedRecords) {
        const resource = compiled.resources[`${id}-${suffix}`];
        expect(resource?.Type).toBe("GCP.DNS.ResourceRecordSet");
        expect(EffectRecord.keys(Output.upstreamAny(resource?.Props))).toEqual(
          record.type === "A" ? [id, "EdgeAddress"] : [id],
        );
        expect(await resolveOutputs(resource?.Props, upstream)).toEqual({
          managedZone: "resolved-zone",
          ttl: 300,
          ...record,
        });
      }
    }
  });

  test("wires Always-Free US inbound mail forwarder, write-only archive bucket, and kvitbit.com email DNS records", async () => {
    const mailEnv = {
      ...PROD_REQUIRED_ENV,
      KVITBIT_ENABLE_RESEND_SECRET: "false",
      KVITBIT_ENABLE_SMTP_SECRET: "true",
      KVITBIT_DNS_ZONES: Arr.join(PROD_DNS_ZONES, ","),
      KVITBIT_EDGE_DOMAINS: "kvitbit.cz,kvitbit.com",
      KVITBIT_MAIL_DOMAIN: "kvitbit.com",
      KVITBIT_MAIL_FORWARD_TO: "filkalny@gmail.com",
      KVITBIT_MAIL_ALIASES: "founder,ops,hello,support,billing,privacy,security,postmaster,abuse",
    };

    // Bootstrap (archive-only) mode before Resend secret is enabled
    const archiveOnlyConfig = await Effect.runPromise(
      loadStackConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: mailEnv }))),
      ),
    );
    expect(archiveOnlyConfig.mail?.relayMode).toBe("archive-only");
    expect(archiveOnlyConfig.mail?.region).toBe("us-east1");
    expect(archiveOnlyConfig.mail?.zone).toBe("us-east1-b");
    expect(archiveOnlyConfig.mail?.aliases).toHaveLength(9);

    const archiveCompiled = await compile(archiveOnlyConfig);
    expect(archiveCompiled.resources["KvitbitMailIngressSa"]?.Type).toBe("GCP.IAM.ServiceAccount");
    expect(archiveCompiled.resources["KvitbitMailArchive"]?.Type).toBe("GCP.Storage.Bucket");
    expect(archiveCompiled.resources["MailIngressArchiveWriter"]?.Props).toMatchObject({
      role: "roles/storage.objectCreator",
    });
    expect(archiveCompiled.resources["MailIngressResendSecretAccessor"]).toBeUndefined();
    expect(archiveCompiled.resources["KvitbitMailAddress"]?.Props).toMatchObject({
      region: "us-east1",
      addressType: "EXTERNAL",
      networkTier: "PREMIUM",
    });
    expect(
      Reflect.get(archiveCompiled.resources["KvitbitMailAddress"]?.Props ?? {}, "ipVersion"),
    ).toBeUndefined();
    expect(archiveCompiled.resources["KvitbitMailIngress"]?.Props).toMatchObject({
      zone: "us-east1-b",
      machineType: "e2-micro",
      bootDiskType: "pd-standard",
      diskSizeGb: 20,
      preemptible: false,
    });
    expect(archiveCompiled.resources["DnsZone-kvitbit.com-MailMxA"]?.Type).toBe(
      "GCP.DNS.ResourceRecordSet",
    );
    expect(archiveCompiled.resources["DnsZone-kvitbit.com-ApexMx"]?.Type).toBe(
      "GCP.DNS.ResourceRecordSet",
    );
    expect(archiveCompiled.resources["DnsZone-kvitbit.cz-ApexMx"]).toBeUndefined();

    // Steady-state Resend mode with DKIM/MX/SPF/DMARC DNS records
    const longDkim = `v=DKIM1; k=rsa; p=${Str.repeat(360)("B")}`;
    const resendConfig = await Effect.runPromise(
      loadStackConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                ...mailEnv,
                KVITBIT_ENABLE_RESEND_SECRET: "true",
                KVITBIT_MAIL_RESEND_DKIM_TXT: longDkim,
                KVITBIT_MAIL_RESEND_SEND_MX: "10 feedback-smtp.eu-west-1.amazonses.com",
                KVITBIT_MAIL_RESEND_SEND_SPF_TXT: "v=spf1 include:amazonses.com ~all",
                KVITBIT_MAIL_APEX_SPF_TXT: "v=spf1 -all",
                KVITBIT_MAIL_DMARC_TXT: "v=DMARC1; p=quarantine; rua=mailto:postmaster@kvitbit.com",
              },
            }),
          ),
        ),
      ),
    );
    expect(resendConfig.mail?.relayMode).toBe("resend");

    const resendCompiled = await compile(resendConfig);
    expect(resendCompiled.resources["MailIngressResendSecretAccessor"]?.Type).toBe(
      "GCP.IAM.Member",
    );
    expect(resendCompiled.resources["MailIngressResendSecretAccessor"]?.Props).toMatchObject({
      role: "roles/secretmanager.secretAccessor",
    });

    const upstream = {
      "DnsZone-kvitbit.com": { zoneName: "kvitbit-com-zone" },
      KvitbitMailAddress: { address: "34.138.1.2" },
    };
    expect(
      await resolveOutputs(
        resendCompiled.resources["DnsZone-kvitbit.com-MailMxA"]?.Props,
        upstream,
      ),
    ).toEqual({
      managedZone: "kvitbit-com-zone",
      name: "mx.kvitbit.com.",
      type: "A",
      ttl: 300,
      rrdatas: ["34.138.1.2"],
    });
    expect(
      await resolveOutputs(resendCompiled.resources["DnsZone-kvitbit.com-ApexMx"]?.Props, upstream),
    ).toEqual({
      managedZone: "kvitbit-com-zone",
      name: "kvitbit.com.",
      type: "MX",
      ttl: 300,
      rrdatas: ["10 mx.kvitbit.com."],
    });
    expect(
      await resolveOutputs(
        resendCompiled.resources["DnsZone-kvitbit.com-ResendSendMx"]?.Props,
        upstream,
      ),
    ).toEqual({
      managedZone: "kvitbit-com-zone",
      name: "send.kvitbit.com.",
      type: "MX",
      ttl: 300,
      rrdatas: ["10 feedback-smtp.eu-west-1.amazonses.com."],
    });
    const dkimPropsSchema = Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      rrdatas: Schema.Array(Schema.String),
    });
    const dkimResolved = Schema.decodeUnknownResult(dkimPropsSchema)(
      await resolveOutputs(
        resendCompiled.resources["DnsZone-kvitbit.com-ResendDkimTxt"]?.Props,
        upstream,
      ),
    ).pipe(Result.getOrThrow);
    expect(dkimResolved.name).toBe("resend._domainkey.kvitbit.com.");
    expect(dkimResolved.type).toBe("TXT");
    expect(dkimResolved.rrdatas[0]).toContain('" "');
  });

  test("rejects unsafe mail forwarder configurations (forwarding loops, catch-all aliases, missing zone)", async () => {
    const badLoop = await Fn.pipe(
      Effect.flip(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ...PROD_REQUIRED_ENV,
                  KVITBIT_DNS_ZONES: "kvitbit.com",
                  KVITBIT_MAIL_DOMAIN: "kvitbit.com",
                  KVITBIT_MAIL_FORWARD_TO: "ops@kvitbit.com",
                  KVITBIT_MAIL_ALIASES: "ops",
                },
              }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
    expect(badLoop).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_MAIL_FORWARD_TO" });

    const badWildcard = await Fn.pipe(
      Effect.flip(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ...PROD_REQUIRED_ENV,
                  KVITBIT_DNS_ZONES: "kvitbit.com",
                  KVITBIT_MAIL_DOMAIN: "kvitbit.com",
                  KVITBIT_MAIL_FORWARD_TO: "filkalny@gmail.com",
                  KVITBIT_MAIL_ALIASES: "*",
                },
              }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
    expect(badWildcard).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_MAIL_ALIASES",
    });

    const badSelfAlias = await Fn.pipe(
      Effect.flip(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ...PROD_REQUIRED_ENV,
                  KVITBIT_DNS_ZONES: "kvitbit.com",
                  KVITBIT_MAIL_DOMAIN: "kvitbit.com",
                  KVITBIT_MAIL_FORWARD_TO: "filkalny@gmail.com",
                  KVITBIT_MAIL_ALIASES: "ops,forwarder",
                },
              }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
    expect(badSelfAlias).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_MAIL_ALIASES",
    });

    const missingZone = await Fn.pipe(
      Effect.flip(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ...PROD_REQUIRED_ENV,
                  KVITBIT_DNS_ZONES: "kvitbit.cz",
                  KVITBIT_MAIL_DOMAIN: "kvitbit.com",
                  KVITBIT_MAIL_FORWARD_TO: "filkalny@gmail.com",
                  KVITBIT_MAIL_ALIASES: "ops",
                },
              }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
    expect(missingZone).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_MAIL_DOMAIN" });

    const emptyZones = await Fn.pipe(
      Effect.flip(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ...PROD_REQUIRED_ENV,
                  KVITBIT_MAIL_DOMAIN: "kvitbit.com",
                  KVITBIT_MAIL_FORWARD_TO: "filkalny@gmail.com",
                  KVITBIT_MAIL_ALIASES: "ops",
                },
              }),
            ),
          ),
        ),
      ),
      Effect.runPromise,
    );
    expect(emptyZones).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_MAIL_DOMAIN" });
  });
});

describe("Cloud Monitoring", () => {
  const compile = (config: KvitbitStackConfig) =>
    Effect.scoped(
      Stack.Stack(
        KVITBIT_STACK_NAME,
        { state: State.inMemoryState(), providers: Layer.empty },
        declareKvitbitStack(config).pipe(Effect.orDie),
      ),
    ).pipe(Effect.provideService(Stage, config.stage), Effect.runPromise);

  const load = (alertEmail?: string) => {
    const alertEnv = alertEmail === undefined ? {} : { KVITBIT_ALERT_EMAIL: alertEmail };
    return loadStackConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              ...PROD_REQUIRED_ENV,
              ...alertEnv,
            },
          }),
        ),
      ),
    );
  };

  const resolveOutputs = <Props>(props: Props, upstream: Readonly<Record<string, Schema.Json>>) =>
    Effect.runPromise(Output.evaluate(props, upstream).pipe(Effect.provide(State.inMemoryState())));

  test("loads a single alert recipient and treats unset or blank values as absent", async () => {
    expect((await Effect.runPromise(load())).alertEmail).toBeUndefined();
    expect((await Effect.runPromise(load("  "))).alertEmail).toBeUndefined();
    expect((await Effect.runPromise(load("  ops@kvitbit.com  "))).alertEmail).toBe(
      "ops@kvitbit.com",
    );
    for (const invalid of [
      "ops",
      "ops@no-domain",
      "Kvitbit <ops@kvitbit.com>",
      "ops@one.test,ops@two.test",
    ]) {
      expect(await Fn.pipe(Effect.flip(load(invalid)), Effect.runPromise)).toMatchObject({
        _tag: "InvalidStackConfig",
        field: "KVITBIT_ALERT_EMAIL",
      });
    }
  });

  test("enables the Monitoring API during foundation bootstrap and passes project and email through deployment", async () => {
    const config = sampleProdConfig({ bootstrapFoundation: true, imageDigest: "" });
    const { resources } = await compile(config);
    expect(resources["CloudMonitoringApi"]?.Type).toBe("GCP.ServiceUsage.ProjectService");
    expect(resources["CloudMonitoringApi"]?.Props).toEqual({
      project: config.projectId,
      service: "monitoring.googleapis.com",
    });
    expect(foundationResourceIds(config)).toContain("CloudMonitoringApi");
    expect(resources["MonitoringCloudRunErrors"]).toBeUndefined();
    expect(resources["MonitoringReadinessCheck"]).toBeUndefined();
    const server = serverPlainEnv({
      config: sampleProdConfig({ projectId: "custom-project" }),
      buckets: {
        blobsBucket: "blobs",
        mobileAssetsBucket: "mobile",
      },
    });
    expect(server).toContainEqual({ name: "GOOGLE_CLOUD_PROJECT", value: "custom-project" });
    const workflow = await Effect.runPromise(
      fixtureFileSystem.readFileString(
        fileURLToPath(new URL("../../../.github/workflows/deploy.yml", import.meta.url)),
      ),
    );
    expect(workflow).toMatch(kvitbitAlertEmailPattern);
  });

  test("uses the HTTPS origin or the first HTTPS edge domain and skips HTTP-only targets", async () => {
    const noEdge = { edge: undefined };
    const upstream = {
      CloudMonitoringApi: { state: "ENABLED" },
      KvitbitServer: { serviceId: "kvitbit-prod-server" },
      EdgeHttpsForwardingRule: { selfLink: "https://example.test/forwardingRule" },
    };
    const http = await compile(sampleProdConfig({ ...noEdge, appOrigin: "http://example.com" }));
    expect(http.resources["MonitoringReadinessCheck"]).toBeUndefined();
    expect(http.resources["MonitoringReadinessFailure"]).toBeUndefined();
    expect(http.resources["MonitoringCloudRunErrors"]).toBeUndefined();
    const emailOnly = await compile(
      sampleProdConfig({
        ...noEdge,
        appOrigin: "http://example.com",
        alertEmail: "ops@kvitbit.com",
      }),
    );
    expect(emailOnly.resources["MonitoringReadinessCheck"]).toBeUndefined();
    expect(emailOnly.resources["MonitoringCloudRunErrors"]).toBeDefined();

    const fallback = await compile(sampleProdConfig({ appOrigin: undefined }));
    expect(
      EffectRecord.keys(
        Output.upstreamAny(fallback.resources["MonitoringReadinessCheck"]?.Props),
      ).sort(Order.String),
    ).toEqual(["CloudMonitoringApi", "EdgeHttpsForwardingRule", "KvitbitServer"]);
    expect(
      await resolveOutputs(fallback.resources["MonitoringReadinessCheck"]?.Props, upstream),
    ).toMatchObject({ host: "kvitbit.cz", port: 443 });

    const direct = await compile(
      sampleProdConfig({ ...noEdge, appOrigin: "https://example.com:8443" }),
    );
    expect(
      await resolveOutputs(direct.resources["MonitoringReadinessCheck"]?.Props, upstream),
    ).toMatchObject({ project: "kvitbit-prod", host: "example.com", port: 8443, period: "60s" });
  });

  test("builds matching numerator and denominator aggregations and links the actual check and channel", async () => {
    const configured = await compile(sampleProdConfig({ alertEmail: "ops@kvitbit.com" }));
    const channel = "projects/kvitbit-prod/notificationChannels/123";
    const upstream = {
      CloudMonitoringApi: { state: "ENABLED" },
      KvitbitServer: { serviceId: "kvitbit-prod-server" },
      MonitoringEmail: { name: channel },
      MonitoringReadinessCheck: { resourceId: "kvitbit-ready-123" },
    };
    const denominatorFilter =
      'metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.label.service_name="kvitbit-prod-server"';
    const aggregations = [
      {
        alignmentPeriod: "300s",
        perSeriesAligner: "ALIGN_DELTA",
        crossSeriesReducer: "REDUCE_SUM",
      },
    ];
    expect(
      await resolveOutputs(configured.resources["MonitoringCloudRunErrors"]?.Props, upstream),
    ).toMatchObject({
      condition: {
        conditionThreshold: {
          denominatorFilter,
          filter: `${denominatorFilter} AND metric.label.response_code_class="5xx"`,
          aggregations,
          denominatorAggregations: aggregations,
          comparison: "COMPARISON_GT",
          thresholdValue: 0.05,
          duration: "0s",
        },
      },
      notificationChannels: [channel],
    });
    expect(
      EffectRecord.keys(
        Output.upstreamAny(configured.resources["MonitoringReadinessFailure"]?.Props),
      ).sort(Order.String),
    ).toEqual(["CloudMonitoringApi", "MonitoringEmail", "MonitoringReadinessCheck"]);
    expect(
      await resolveOutputs(configured.resources["MonitoringReadinessFailure"]?.Props, upstream),
    ).toMatchObject({
      condition: {
        conditionThreshold: {
          filter:
            'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.label.check_id="kvitbit-ready-123"',
        },
      },
      notificationChannels: [channel],
    });
    const unconfigured = await compile(sampleProdConfig());
    expect(unconfigured.resources["MonitoringEmail"]).toBeUndefined();
    for (const policy of ["MonitoringCloudRunErrors", "MonitoringReadinessFailure"]) {
      expect(await resolveOutputs(unconfigured.resources[policy]?.Props, upstream)).toMatchObject({
        notificationChannels: [],
      });
    }
  });
});

describe("Zero-Terraform enforcement", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");

  const collectFiles = async (dir: string): Promise<Array<string>> => {
    const out: Array<string> = [];
    for (const name of await Effect.runPromise(fixtureFileSystem.readDirectory(dir))) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      const real = await Effect.runPromise(fixtureFileSystem.realPath(full));
      const info = await Effect.runPromise(fixtureFileSystem.stat(full));
      if (info.type === "Directory" && full === real) {
        out.push(...(await collectFiles(full)));
      } else {
        out.push(full);
      }
    }
    return out;
  };

  test("contains zero .tf/.tfvars files and zero terraform CLI usage in infra/deploy artifacts", async () => {
    const infraFiles = await collectFiles(join(repoRoot, "infra"));
    const tfFiles = Arr.filter(infraFiles, (file) => tfTfvarsJsonPattern.test(file));
    expect(tfFiles).toEqual([]);

    const deployWorkflow = await Effect.runPromise(
      fixtureFileSystem.readFileString(join(repoRoot, ".github/workflows/deploy.yml")),
    );
    expect(Str.toLowerCase(deployWorkflow)).not.toContain("terraform");
    expect(Str.toLowerCase(deployWorkflow)).not.toContain("opentofu");
  });
});
