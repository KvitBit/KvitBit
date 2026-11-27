import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Secret } from "@alchemy.run/gcp/SecretManager";
import * as Apply from "alchemy/Apply";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { runnerPlainEnv, serverPlainEnv, serverSecretEnv } from "../src/env";
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

const SAMPLE_DIGEST = `sha256:${"a".repeat(64)}`;
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
      const error = await Effect.runPromise(
        Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider)))),
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
    `${"x".repeat(64)}.cz`,
    `${`${"x".repeat(63)}.`.repeat(4)}cz`,
  ])("rejects invalid DNS zone %s", async (zone) => {
    const provider = ConfigProvider.fromEnv({
      env: { ...PROD_REQUIRED_ENV, KVITBIT_DNS_ZONES: zone },
    });
    const error = await Effect.runPromise(
      Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider)))),
    );
    expect(error).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_DNS_ZONES" });
  });

  test("rejects DNS zones that leave no room for www when the edge is enabled", async () => {
    const domain = `${`${"x".repeat(63)}.`.repeat(3)}${"y".repeat(58)}.cz`;
    const error = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ dnsZones: [domain] }))),
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
    const secretIds = config.secrets.map((s) => s.secretId);
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
    const badDigest = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ imageDigest: "latest" }))),
    );
    expect(badDigest.field).toBe("imageDigest");

    const badZone = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ zone: "us-central1-a" }))),
    );
    expect(badZone.field).toBe("zone");

    const badRunners = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ runnerCount: 0 }))),
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
    const enabledIds = enabledConfig.secrets.map((s) => s.secretId);
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
    const disabledIds = disabledConfig.secrets.map((s) => s.secretId);
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
    const invalidError = await Effect.runPromise(
      Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(invalidProvider)))),
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
      ["63-octet email label", { KVITBIT_EMAIL_FROM: `a@${"b".repeat(63)}.org` }],
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
          await loadWithLayer(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { ...PROD_REQUIRED_ENV, ...extra } }),
            ),
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
        { KVITBIT_EMAIL_FROM: `a@${"b".repeat(64)}.org` },
        "emailFrom",
      ],
      [
        "64-char email TLD label",
        { KVITBIT_EMAIL_FROM: `a@example.${"c".repeat(64)}` },
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
      if (res._tag === "Failure") {
        expect(res.failure).toMatchObject({ _tag: "InvalidStackConfig", field: expectedField });
      }
    }

    // Bare ConfigProvider.fromEnv also rejects empty exact KVITBIT_ALLOW_LOCAL_BLOBS alone.
    const bareEmptyExact = await loadWithLayer(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { ...PROD_REQUIRED_ENV, KVITBIT_ALLOW_LOCAL_BLOBS: "" } }),
      ),
    );
    expect(bareEmptyExact._tag).toBe("Failure");
    if (bareEmptyExact._tag === "Failure") {
      expect(bareEmptyExact.failure).toMatchObject({
        _tag: "InvalidStackConfig",
        field: "KVITBIT_ALLOW_LOCAL_BLOBS",
      });
    }

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
      if (res._tag === "Failure") {
        expect(res.failure).toMatchObject({ _tag: "InvalidStackConfig", field: expectedField });
      }
    }
  });

  test("alchemy.run.ts stack entrypoint preserves CLI --env-file precedence and rejects forbidden keys from both file and shell", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-alchemy-envfile-"));
    try {
      // 1. Valid production shell + --env-file with forbidden KVITBIT_DISABLE_CUSTOM=true:
      // Alchemy CLI's provider (dotEnv over shell) flows into alchemy.run.ts without being replaced.
      const forbiddenFile = join(sandbox, "forbidden.env");
      writeFileSync(forbiddenFile, "KVITBIT_DISABLE_CUSTOM=true\n");
      const forbiddenCliProvider = ConfigProvider.orElse(
        ConfigProvider.fromDotEnvContents(readFileSync(forbiddenFile, "utf8")),
        ConfigProvider.fromEnv({ env: PROD_REQUIRED_ENV }),
      );
      const forbiddenRes = await Effect.runPromise(
        loadAlchemyStackConfig.pipe(
          Effect.provide(ConfigProvider.layer(forbiddenCliProvider)),
          Effect.result,
        ),
      );
      expect(forbiddenRes._tag).toBe("Failure");
      if (forbiddenRes._tag === "Failure") {
        expect(forbiddenRes.failure).toMatchObject({
          _tag: "InvalidStackConfig",
          field: "KVITBIT_DISABLE_CUSTOM",
        });
      }

      // 2. Valid production shell + --env-file overriding stage, stateBucket, origin, and emailMode:
      // confirms --env-file governs both state selection and stack declaration.
      const stagingFile = join(sandbox, "staging.env");
      writeFileSync(
        stagingFile,
        [
          "KVITBIT_STAGE=staging",
          "KVITBIT_ALCHEMY_STATE_BUCKET=custom-staging-state-bucket",
          "KVITBIT_APP_ORIGIN=https://staging.kvitbit.cz",
          "KVITBIT_EMAIL_MODE=capture",
          "KVITBIT_BOT_PROTECTION_MODE=none",
          "KVITBIT_ENABLE_RESEND_SECRET=false",
          "KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET=false",
        ].join("\n"),
      );
      const stagingCliProvider = ConfigProvider.orElse(
        ConfigProvider.fromDotEnvContents(readFileSync(stagingFile, "utf8")),
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
      writeFileSync(
        emptyExactFile,
        'KVITBIT_ALLOW_LOCAL_BLOBS=""\nKVITBIT_ALLOW_LOCAL_BLOBS_EXTRA=metadata\n',
      );
      const rawWithEnvFile = readAlchemyRawEnv(
        ["bun", "alchemy", "plan", "--env-file", emptyExactFile],
        PROD_REQUIRED_ENV,
        sandbox,
      );
      const emptyExactRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(
            Layer.merge(
              ConfigProvider.layer(
                ConfigProvider.orElse(
                  ConfigProvider.fromDotEnvContents(readFileSync(emptyExactFile, "utf8")),
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
      if (emptyExactRes._tag === "Failure") {
        expect(emptyExactRes.failure).toMatchObject({
          _tag: "InvalidStackConfig",
          field: "KVITBIT_ALLOW_LOCAL_BLOBS",
        });
      }

      // 4. Default .env fallback behind shell KVITBIT_DISABLE=metadata still rejects .env's KVITBIT_DISABLE_CUSTOM=true.
      writeFileSync(join(sandbox, ".env"), "KVITBIT_DISABLE_CUSTOM=true\n");
      const shellWithScalar = { ...PROD_REQUIRED_ENV, KVITBIT_DISABLE: "metadata" };
      const rawWithDotEnv = readAlchemyRawEnv(["bun", "alchemy", "plan"], shellWithScalar, sandbox);
      const dotEnvRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(
            Layer.merge(
              ConfigProvider.layer(
                ConfigProvider.orElse(
                  ConfigProvider.fromEnv({ env: shellWithScalar }),
                  ConfigProvider.fromDotEnvContents(readFileSync(join(sandbox, ".env"), "utf8")),
                ),
              ),
              Layer.succeed(StackEnv, rawWithDotEnv),
            ),
          ),
          Effect.result,
        ),
      );
      expect(dotEnvRes._tag).toBe("Failure");
      if (dotEnvRes._tag === "Failure") {
        expect(dotEnvRes.failure).toMatchObject({
          _tag: "InvalidStackConfig",
          field: "KVITBIT_DISABLE_CUSTOM",
        });
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
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

    const compiled = Effect.runPromise(Effect.scoped(compileBootstrap(populatedStateLayer)));
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
      read: () => Effect.succeed(undefined),
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
      await Effect.runPromise(
        Effect.result(assertTargetedSecretSelection(feedbackConfig, ["bun", "alchemy", "deploy"])),
      ),
    ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
    expect(
      await Effect.runPromise(
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
      ),
    ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
    expect(
      await Effect.runPromise(
        Effect.result(
          assertTargetedSecretSelection(feedbackConfig, [
            "bun",
            "alchemy",
            "deploy",
            "--include",
            fqn,
          ]),
        ),
      ),
    ).toMatchObject({ _tag: "Success" });
    expect(
      await Effect.runPromise(
        Effect.result(
          assertTargetedSecretSelection(feedbackConfig, [`--include=${feedbackSecretFqn("prod")}`]),
        ),
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
        expect(Object.keys(compiled.resources)).toEqual([fqn]);
        yield* Effect.gen(function* () {
          const plan = yield* Plan.make(compiled, { include: [fqn] });
          expect(Object.keys(plan.resources)).toEqual([fqn]);
          expect(plan.resources[fqn]?.action).toBe("create");
          expect(plan.deletions).toEqual({});
          yield* Apply.apply(plan);

          const store = yield* yield* State.State;
          expect((yield* store.list(target)).toSorted()).toEqual(
            [...Object.keys(existing), fqn].sort(),
          );
          expect(yield* store.get({ ...target, fqn })).toMatchObject({
            status: "created",
            resourceType: Secret.Type,
            attr: { secretId },
          });
          for (const [fqn, row] of Object.entries(existing)) {
            expect(yield* store.get({ ...target, fqn })).toEqual(row);
          }
          expect(yield* store.getOutput(target)).toEqual(existingOutput);
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
      read: () => Effect.succeed(undefined),
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
      await Effect.runPromise(
        Effect.result(assertTargetedSecretSelection(altchaConfig, ["bun", "alchemy", "deploy"])),
      ),
    ).toMatchObject({ _tag: "Failure", failure: expect.any(BootstrapSelectionError) });
    expect(
      await Effect.runPromise(
        Effect.result(
          assertTargetedSecretSelection(altchaConfig, [
            "bun",
            "alchemy",
            "deploy",
            "--include",
            fqn,
          ]),
        ),
      ),
    ).toMatchObject({ _tag: "Success" });

    await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* Stack.Stack(
          target.stack,
          { state, providers },
          declareKvitbitStack(altchaConfig).pipe(Effect.orDie),
        );
        expect(Object.keys(compiled.resources)).toEqual([fqn]);
        yield* Effect.gen(function* () {
          const plan = yield* Plan.make(compiled, { include: [fqn] });
          expect(Object.keys(plan.resources)).toEqual([fqn]);
          expect(plan.resources[fqn]?.action).toBe("create");
          expect(plan.deletions).toEqual({});
          yield* Apply.apply(plan);

          const store = yield* yield* State.State;
          expect((yield* store.list(target)).toSorted()).toEqual(
            [...Object.keys(existing), fqn].sort(),
          );
          expect(yield* store.get({ ...target, fqn })).toMatchObject({
            status: "created",
            resourceType: Secret.Type,
            attr: { secretId },
          });
          expect(yield* store.getOutput(target)).toEqual(existingOutput);
        }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
      }).pipe(Effect.provideService(Stage, target.stage), Effect.scoped),
    );
  });

  test.each([
    ["empty", []],
    ["foundation-only", ["KvitbitImages", "KvitbitBlobs", "EdgeTokenRouteExclusion"]],
  ] as const)("lists %s state under the stack's active lease", async (_kind, existingFqns) => {
    const lease = Symbol("stack state lease");
    let activeLease: symbol | undefined;
    const events: string[] = [];
    const state = Layer.effect(
      State.State,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
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
        );
        const memory = yield* State.InMemoryService();
        return Effect.succeed({
          ...memory,
          list: ({ stack, stage }) =>
            Effect.sync(() => {
              expect(activeLease).toBe(lease);
              expect({ stack, stage }).toEqual({ stack: KVITBIT_STACK_NAME, stage: "prod" });
              events.push("list");
              return existingFqns;
            }),
        } satisfies State.StateService);
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const compiled = yield* compileBootstrap(state);
          expect(Object.keys(compiled.resources).sort()).toEqual(
            [...foundationResourceIds(config)].sort(),
          );
          expect(activeLease).toBe(lease);
          expect(events).toEqual(["acquire", "list"]);
        }),
      ),
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

    await expect(Effect.runPromise(Effect.scoped(compileBootstrap(state)))).rejects.toBe(listError);
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
    const compiled = await Effect.runPromise(
      Effect.scoped(stack).pipe(Effect.provideService(Stage, "prod")),
    );
    expect(Object.keys(compiled.resources).sort()).toEqual(
      [...foundationResourceIds(dnsConfig)].sort(),
    );
    expect(compiled.resources.CloudDnsApi?.Props).toEqual({
      project: "kvitbit-prod",
      service: "dns.googleapis.com",
    });
    expect(Object.keys(compiled.resources).some((id) => id.startsWith("DnsZone-"))).toBe(false);
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
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-database-url");
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-runner-database-url-unpooled");
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-better-auth-secret");

    const grants = secretAccessorGrants(config);
    const mobileSigningGrants = grants.filter(
      (g) => g.secretId === "kvitbit-prod-mobile-updates-signing-key",
    );
    expect(mobileSigningGrants.map((g) => g.workload)).toEqual(["server"]);
    const altchaGrants = grants.filter((g) => g.secretId === "kvitbit-prod-altcha-hmac-key");
    expect(altchaGrants.map((g) => g.workload)).toEqual(["server"]);
    const serverEnvSecretNames = serverSecretEnv(config).map((s) => s.name);
    expect(serverEnvSecretNames).toContain("ALTCHA_HMAC_KEY");
    const runnerSecretNames = buildRunnerWorkerConfig(config).secrets.map(
      (s) => s.environmentVariable,
    );
    expect(runnerSecretNames).not.toContain("ALTCHA_HMAC_KEY");
    const dbGrants = grants.filter((g) => g.secretId === "kvitbit-prod-database-url");
    expect(dbGrants.map((g) => g.workload).sort()).toEqual(["runner", "server"]);
    const runnerUnpooledGrants = grants.filter(
      (g) => g.secretId === "kvitbit-prod-runner-database-url-unpooled",
    );
    expect(runnerUnpooledGrants.map((g) => g.workload)).toEqual(["runner"]);
  });

  test("constructs the full Alchemy stack with real Output proxies without coercion errors and wires explicit DAG dependencies", async () => {
    const config = sampleProdConfig({ edge: undefined });

    const compileHermetic = <A, E, R>(
      name: string,
      program: Effect.Effect<A, E, R>,
    ): Promise<Stack.CompiledStack<A, unknown>> => {
      const makeStack = Stack.make({
        name,
        state: State.inMemoryState(),
        providers: Layer.empty,
      }) as <Out>(
        eff: Effect.Effect<Out, E, R>,
      ) => Effect.Effect<Stack.CompiledStack<Out, unknown>, E, unknown>;

      return Effect.runPromise(
        Effect.scoped(makeStack(program)).pipe(
          Effect.provide(Layer.succeed(Stage, "prod")),
        ) as Effect.Effect<Stack.CompiledStack<A, unknown>, E, never>,
      );
    };

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

    const resourceIds = Object.keys(compiled.resources);
    // Token-route log exclusion is installed unconditionally even when edge is disabled
    expect(resourceIds).toContain("EdgeTokenRouteExclusion");

    const runner0 = compiled.resources.KvitbitRunner0;
    const serverRes = compiled.resources.KvitbitServer;
    expect(runner0).toBeDefined();
    expect(serverRes).toBeDefined();

    const runnerUpstreams = Object.keys(Output.upstreamAny(runner0?.Props));
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

    const serverUpstreams = Object.keys(Output.upstreamAny(serverRes?.Props));
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
    expect(Object.keys(compiledWithEdge.resources)).toContain("EdgeSecurityPolicy");
  });
});

describe("Pure-Alchemy Compute Engine runner pool (#908)", () => {
  test("declares custom VPC, private subnet with Cloud NAT, internal TCP 34431 firewall, and private COS instances", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);

    const vpc = networkProps(config);
    expect(vpc.autoCreateSubnetworks).toBe(false);

    const subnet = subnetworkProps(config, names.networkName);
    expect(subnet.privateIpGoogleAccess).toBe(true);
    expect(subnet.ipCidrRange).toBe("10.42.0.0/20");

    const router = routerProps(config, names.networkName);
    expect(router.nats?.[0]?.natIpAllocateOption).toBe("AUTO_ONLY");

    const fw = runnerFirewallProps(config, names.networkName);
    expect(fw.direction).toBe("INGRESS");
    expect(fw.allowed).toEqual([{ protocol: "tcp", ports: ["34431"] }]);
    expect(fw.sourceRanges).toEqual(["10.42.0.0/20"]);
    expect(fw.targetTags).toEqual([names.runnerTag]);

    const vm = runnerInstanceProps(config, 0, {
      network: names.networkName,
      subnetwork: names.subnetworkName,
    });
    expect(vm.sourceImage).toBe(COS_STABLE_IMAGE);
    expect(vm.associatePublicIp).toBe(false);
    expect(vm.zone).toBe("europe-west3-a");
    expect(vm.shieldedInstanceConfig?.enableSecureBoot).toBe(true);
    expect(vm.tags).toEqual([names.runnerTag]);
  });

  test("startup script configures COS host iptables, /bin/bash reconciler invocation (noexec-safe), systemd digest+config reconciliation, backoff retries, and S5 runner DB secrets", () => {
    const config = sampleProdConfig();
    const script = buildRunnerStartupScript();

    // Valid bash syntax
    const syntaxCheck = Bun.spawnSync(["bash", "-n"], {
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
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

    const workerConfig = buildRunnerWorkerConfig(config);
    const workerConfigSha = runnerWorkerConfigSha(workerConfig);
    expect(workerConfigSha).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(workerConfig.secrets.map((s) => s.secretId)).toEqual(
      expect.arrayContaining([
        "kvitbit-prod-database-url",
        "kvitbit-prod-runner-database-url-unpooled",
        "kvitbit-prod-better-auth-secret",
      ]),
    );

    const vm = runnerInstanceProps(config, 0, {
      network: "vpc",
      subnetwork: "subnet",
    });
    expect(vm.metadata?.["kvitbit-image-ref"]).toBe(imageReference(config));
    expect(vm.metadata?.["kvitbit-image-digest"]).toBe(config.imageDigest);
    expect(vm.metadata?.["kvitbit-worker-config"]).toBe(serializeRunnerWorkerConfig(workerConfig));
    expect(vm.metadata?.["kvitbit-worker-config-sha"]).toBe(workerConfigSha);
    expect(vm.metadata?.["enable-guest-attributes"]).toBe("TRUE");

    const runnerEnvNames = runnerPlainEnv(config, config.blobsBucket).map((e) => e.name);
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

  const makeRunnerSandbox = (sandbox: string) => {
    const config1 = sampleProdConfig({
      emailFrom: "Kvitbit <no-reply@kvitbit.cz>",
      secrets: defaultSecretBindings("prod", { enableResend: true, enableSmtp: false }),
    });
    const config2 = sampleProdConfig({
      emailFrom: "Billing <billing@kvitbit.cz>",
      secrets: defaultSecretBindings("prod", { enableResend: true, enableSmtp: true }),
    });

    const workerConfig1 = buildRunnerWorkerConfig(config1);
    const workerConfig2 = buildRunnerWorkerConfig(config2);
    const configJson1 = serializeRunnerWorkerConfig(workerConfig1);
    const configJson2 = serializeRunnerWorkerConfig(workerConfig2);
    const configSha1 = runnerWorkerConfigSha(workerConfig1);
    const configSha2 = runnerWorkerConfigSha(workerConfig2);
    expect(configSha1).not.toBe(configSha2);

    const startup = buildRunnerStartupScript();
    const match = startup.match(
      /cat <<'RECONCILE' > \/var\/lib\/kvitbit\/reconcile-worker\.sh\n([\s\S]*?)\nRECONCILE\n/,
    );
    expect(match?.[1]).toBeDefined();

    const binDir = join(sandbox, "bin");
    const runDir = join(sandbox, "run");
    const stateDir = join(sandbox, "state");
    const systemdDir = join(sandbox, "systemd");
    Bun.spawnSync(["mkdir", "-p", binDir, runDir, stateDir, systemdDir]);

    // Rewrite /run/kvitbit and /etc/systemd/system to sandboxed dirs for hermetic execution
    const reconcileScript = (match?.[1] ?? "")
      .replaceAll("/run/kvitbit", runDir)
      .replaceAll("/etc/systemd/system", systemdDir);
    const scriptPath = join(sandbox, "reconcile-worker.sh");
    writeFileSync(scriptPath, reconcileScript);
    // Do NOT set +x: proves /bin/bash execution works even on noexec filesystems
    chmodSync(scriptPath, 0o600);

    const digest1 = SAMPLE_DIGEST;
    const digest2 = `sha256:${"b".repeat(64)}`;
    const ref1 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest1}`;
    const ref2 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest2}`;
    const imageId1 = `sha256:${"c".repeat(64)}`;
    const imageId2 = `sha256:${"d".repeat(64)}`;
    writeFileSync(join(stateDir, "target-ref"), ref1);
    writeFileSync(join(stateDir, "target-digest"), digest1);
    writeFileSync(join(stateDir, "target-config"), configJson1);
    writeFileSync(join(stateDir, "target-config-sha"), configSha1);
    writeFileSync(join(stateDir, "attributes-etag"), "initial");
    writeFileSync(join(stateDir, "fail-once"), "1");
    writeFileSync(join(stateDir, "registry-ref"), ref1);
    writeFileSync(join(stateDir, "registry-image-id"), imageId1);

    // Stub sleep (no-op for fast retry test)
    writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "sleep"), 0o755);

    // Stub iptables (tracks whether rule is installed)
    writeFileSync(
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
    );
    chmodSync(join(binDir, "iptables"), 0o755);

    // Stub curl (simulates metadata, transient failure on first metadata call, Secret Manager, and guest attributes PUT)
    writeFileSync(
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
    );
    chmodSync(join(binDir, "curl"), 0o755);

    // Stub docker with a local image store enforcing --pull=never restart semantics.
    writeFileSync(
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
    );
    chmodSync(join(binDir, "docker"), 0o755);

    // Stub systemctl (activates target digest + config sha as running; enforces --pull=never)
    writeFileSync(
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
    );
    chmodSync(join(binDir, "systemctl"), 0o755);

    const env = { PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    const reconcile = () =>
      Bun.spawnSync(["/bin/bash", scriptPath], { env, stdout: "pipe", stderr: "pipe" });

    return {
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
    };
  };

  const withRunnerSandbox = (run: (fixture: ReturnType<typeof makeRunnerSandbox>) => void) => {
    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-reconcile-"));
    try {
      run(makeRunnerSandbox(sandbox));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  };

  test("reconcile replaces legacy workers, rolls out config and digest changes, and skips no-op ticks", () => {
    withRunnerSandbox(
      ({
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
        writeFileSync(join(stateDir, "legacy-image-ref"), ref1);
        writeFileSync(join(stateDir, "pulled-ref"), ref1);
        writeFileSync(join(stateDir, "pulled-repo-digest"), ref1);
        writeFileSync(join(stateDir, "pulled-image-id"), imageId1);
        writeFileSync(join(stateDir, "running-image-id"), imageId1);
        writeFileSync(join(stateDir, "running-digest"), digest1);
        writeFileSync(join(stateDir, "running-config-sha"), configSha1);
        writeFileSync(join(runDir, "worker.env"), "EMAIL_FROM=stale@example.invalid\n");

        // The initial reconcile survives a transient request failure and replaces the legacy worker.
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId1);
        expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest1);
        expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha1);
        expect(readFileSync(join(stateDir, "guest-active-target"), "utf8")).toBe(
          `${digest1}|${configSha1}`,
        );
        const env1 = readFileSync(join(runDir, "worker.env"), "utf8");
        expect(env1).toContain("DATABASE_URL_UNPOOLED=secret-val");
        expect(env1).toContain("EMAIL_FROM=Kvitbit <no-reply@kvitbit.cz>");
        expect(env1).not.toContain("KVITBIT_SMTP_URL=");
        expect(readFileSync(join(stateDir, "iptables-rule"), "utf8")).toContain("10.42.0.0/20");

        const logAfterFirst = readFileSync(join(stateDir, "log"), "utf8");
        expect(logAfterFirst).toContain("systemctl:start kvitbit-worker.service");

        // 2. Second reconcile with same digest AND same config is a no-op
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterFirst);

        writeFileSync(join(stateDir, "target-config-sha"), configSha2);
        writeFileSync(join(stateDir, "target-config"), configJson2);
        expect(reconcile().exitCode).toBe(0);
        const env2 = readFileSync(join(runDir, "worker.env"), "utf8");
        expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
        expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
        const logAfterConfigUpdate = readFileSync(join(stateDir, "log"), "utf8");

        // Image metadata updates must agree before the runner pulls anything.
        const guestWritesAfterConfigUpdate = readFileSync(join(stateDir, "guest-writes"), "utf8");
        const targetEnv2 = readFileSync(join(runDir, "worker-target.env"), "utf8");
        writeFileSync(join(stateDir, "target-ref"), ref2);
        expect(reconcile().exitCode).toBe(1);
        expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterConfigUpdate);

        // A successful pull still needs to report the requested registry digest.
        writeFileSync(join(stateDir, "target-digest"), digest2);
        writeFileSync(join(stateDir, "registry-image-id"), imageId2);
        expect(reconcile().exitCode).toBe(1);
        expect(readFileSync(join(stateDir, "running-digest"), "utf8")).toBe(digest1);
        expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId1);
        expect(readFileSync(join(stateDir, "guest-writes"), "utf8")).toBe(
          guestWritesAfterConfigUpdate,
        );
        expect(readFileSync(join(runDir, "worker.env"), "utf8")).toBe(env2);
        expect(readFileSync(join(runDir, "worker-target.env"), "utf8")).toBe(targetEnv2);

        // Simulate --rm worker exiting (5s systemd RestartSec window, no running container)
        // while a stale image is on disk and the replacement pull fails: stale image must be
        // pruned before pull, while worker-target.env's installed imageId1 survives so systemd
        // can restart kvitbit-worker with --pull=never.
        const staleImageId = `sha256:${"9".repeat(64)}`;
        writeFileSync(join(stateDir, "images"), `${staleImageId}\n${imageId1}\n`);
        rmSync(join(stateDir, "running-image-id"));
        writeFileSync(join(stateDir, "fail-pull"), "1");
        const logBeforeFailedPull = readFileSync(join(stateDir, "log"), "utf8");
        expect(reconcile().exitCode).toBe(1);
        const failedPullDelta = readFileSync(join(stateDir, "log"), "utf8")
          .slice(logBeforeFailedPull.length)
          .trim()
          .split("\n");
        const staleRmiIdx = failedPullDelta.indexOf(`docker:rmi:${staleImageId}`);
        const failedPullIdx = failedPullDelta.indexOf(`docker:pull:${ref2}`);
        expect(staleRmiIdx).toBeGreaterThanOrEqual(0);
        expect(failedPullIdx).toBeGreaterThan(staleRmiIdx);
        expect(failedPullDelta).not.toContain(`docker:rmi:${imageId1}`);
        const imagesAfterFailedPull = readFileSync(join(stateDir, "images"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        expect(imagesAfterFailedPull).toEqual([imageId1]);
        // Confirm systemd can still restart the installed worker with --pull=never.
        const restartCheck = Bun.spawnSync([
          join(binDir, "systemctl"),
          "start",
          "kvitbit-worker.service",
        ]);
        expect(restartCheck.exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId1);
        rmSync(join(stateDir, "fail-pull"));

        // Now allow the verified pull to succeed and inspect ONLY this reconcile's delta log.
        writeFileSync(join(stateDir, "registry-ref"), ref2);
        writeFileSync(join(stateDir, "images"), `${staleImageId}\n${imageId1}\n`);
        const logBeforeRollout = readFileSync(join(stateDir, "log"), "utf8");
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId2);
        expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest2);
        expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha2);
        expect(readFileSync(join(stateDir, "guest-active-target"), "utf8")).toBe(
          `${digest2}|${configSha2}`,
        );
        const rolloutDelta = readFileSync(join(stateDir, "log"), "utf8")
          .slice(logBeforeRollout.length)
          .trim()
          .split("\n");
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
        const imagesAfterRollout = readFileSync(join(stateDir, "images"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        expect(imagesAfterRollout).toEqual([imageId2]);
        expect(
          readFileSync(join(stateDir, "log"), "utf8")
            .trim()
            .split("\n")
            .filter((l) => l === "systemctl:start kvitbit-worker.service").length,
        ).toBe(4);
      },
    );
  });

  test("reconcile retries unavailable config without changing the running target, then converges on recovery", () => {
    withRunnerSandbox(
      ({ reconcile, runDir, stateDir, digest1, configSha1, configSha2, configJson2 }) => {
        expect(reconcile().exitCode).toBe(0);
        const env1 = readFileSync(join(runDir, "worker.env"), "utf8");
        const logAfterFirst = readFileSync(join(stateDir, "log"), "utf8");

        // A new config SHA can become visible while fetching its JSON still fails.
        const guestWrites = readFileSync(join(stateDir, "guest-writes"), "utf8");
        const configReads = readFileSync(join(stateDir, "config-reads"), "utf8");
        const targetEnv1 = readFileSync(join(runDir, "worker-target.env"), "utf8");
        writeFileSync(join(stateDir, "target-config-sha"), configSha2);
        rmSync(join(stateDir, "target-config"));
        expect(reconcile().exitCode).toBe(1);
        expect(readFileSync(join(stateDir, "config-reads"), "utf8")).toBe(
          configReads + "config fetch\n".repeat(6),
        );

        // The expected SHA covers every response byte, including any trailing newline.
        writeFileSync(join(stateDir, "target-config"), `${configJson2}\n`);
        expect(reconcile().exitCode).toBe(1);
        expect(readFileSync(join(stateDir, "running-config-sha"), "utf8")).toBe(configSha1);
        expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha1);
        expect(readFileSync(join(stateDir, "guest-writes"), "utf8")).toBe(guestWrites);
        expect(readFileSync(join(runDir, "worker.env"), "utf8")).toBe(env1);
        expect(readFileSync(join(runDir, "worker-target.env"), "utf8")).toBe(targetEnv1);
        expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterFirst);

        // The next tick applies the config-only rollout once its JSON is available.
        writeFileSync(join(stateDir, "target-config"), configJson2);
        writeFileSync(join(stateDir, "next-attributes-etag"), "changed-during-fetch");
        const readsBeforeRecovery = readFileSync(join(stateDir, "config-reads"), "utf8");
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "config-reads"), "utf8")).toBe(
          readsBeforeRecovery + "config fetch\n".repeat(2),
        );
        expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest1);
        expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha2);
        const env2 = readFileSync(join(runDir, "worker.env"), "utf8");
        expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
        expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
        expect(
          readFileSync(join(stateDir, "log"), "utf8")
            .split("\n")
            .filter((l) => l === "systemctl:start kvitbit-worker.service").length,
        ).toBe(2);
        const logAfterConfigUpdate = readFileSync(join(stateDir, "log"), "utf8");
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterConfigUpdate);
        expect(readFileSync(join(stateDir, "guest-active-target"), "utf8")).toBe(
          `${digest1}|${configSha2}`,
        );
      },
    );
  });

  test("deploy waits for the verified rollback after a worker acknowledgement fails", () => {
    withRunnerSandbox(
      ({ binDir, reconcile, stateDir, digest1, configSha1, configSha2, configJson2 }) => {
        const workflow = Bun.YAML.parse(
          readFileSync(resolve(import.meta.dir, "../../../.github/workflows/deploy.yml"), "utf8"),
        ) as { jobs: { deploy: { steps: { name?: string; run?: string }[] } } };
        const verify = workflow.jobs.deploy.steps.find(
          (step) => step.name === "Verify runner pool reconciled target digest and config",
        )?.run;
        if (verify === undefined) throw new Error("Expected the runner verification step");
        const gcloud = join(binDir, "gcloud");
        writeFileSync(
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
        );
        chmodSync(gcloud, 0o755);
        const verifyRollout = () =>
          Bun.spawnSync(["bash", "-c", verify], {
            env: {
              PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
              GCP_PROJECT_ID: "kvitbit-prod",
              GCP_ZONE: "europe-west3-a",
              KVITBIT_STAGE: "prod",
              TARGET_DIGEST: digest1,
            },
            stdout: "pipe",
            stderr: "pipe",
          });

        expect(reconcile().exitCode).toBe(0);
        const configJson1 = readFileSync(join(stateDir, "target-config"), "utf8");
        writeFileSync(join(stateDir, "target-config"), configJson2);
        writeFileSync(join(stateDir, "target-config-sha"), configSha2);
        writeFileSync(join(stateDir, "fail-active-target-once"), "");
        const changed = reconcile();
        expect(readFileSync(join(stateDir, "running-config-sha"), "utf8")).toBe(configSha2);

        writeFileSync(join(stateDir, "target-config"), configJson1);
        writeFileSync(join(stateDir, "target-config-sha"), configSha1);
        expect(verifyRollout().exitCode).toBe(1);
        expect(changed.exitCode).toBe(1);
        expect(readFileSync(join(stateDir, "guest-active-target"), "utf8")).toBe("pending");
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "running-config-sha"), "utf8")).toBe(configSha1);
        expect(verifyRollout().exitCode).toBe(0);

        // If invalidation fails, the current worker must remain running and acknowledged.
        writeFileSync(join(stateDir, "target-config"), configJson2);
        writeFileSync(join(stateDir, "target-config-sha"), configSha2);
        writeFileSync(join(stateDir, "fail-invalidation"), "");
        expect(reconcile().exitCode).toBe(1);
        expect(readFileSync(join(stateDir, "running-config-sha"), "utf8")).toBe(configSha1);
        expect(readFileSync(join(stateDir, "guest-active-target"), "utf8")).toBe(
          `${digest1}|${configSha1}`,
        );

        // A later tick can confirm a running target after an acknowledgement write failure.
        rmSync(join(stateDir, "fail-invalidation"));
        writeFileSync(join(stateDir, "fail-active-target-once"), "");
        expect(reconcile().exitCode).toBe(1);
        const log = readFileSync(join(stateDir, "log"), "utf8");
        expect(reconcile().exitCode).toBe(0);
        expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(log);
        expect(verifyRollout().exitCode).toBe(0);
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
    expect(secretDeclarations(config).map((entry) => entry.secretId)).toContain(secretId);
    expect(secretAccessorGrants(config).filter((grant) => grant.secretId === secretId)).toEqual([
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

    const service = serverServiceProps(config, {
      networkName: names.networkName,
      subnetworkName: names.subnetworkName,
      blobsBucketName: config.blobsBucket,
      mobileAssetsBucketName: config.mobileAssetsBucket,
    });
    const container = service.template?.containers?.[0];
    const env = container && "env" in container ? container.env : undefined;
    expect(env).toContainEqual({ name: "KVITBIT_FEEDBACK_GITHUB_REPO", value: "owner/feedback" });
    expect(env).toContainEqual({
      name: "KVITBIT_FEEDBACK_OWNER_EMAILS",
      value: "owner@example.com, admin@example.com",
    });
    expect(env).toContainEqual({
      name: "KVITBIT_FEEDBACK_GITHUB_TOKEN",
      valueSource: { secretKeyRef: { secret, version: "latest" } },
    });

    const runner = buildRunnerWorkerConfig(config);
    expect(runner.plainEnv.some((entry) => entry.name.startsWith("KVITBIT_FEEDBACK_"))).toBe(false);
    expect(runner.secrets.map((entry) => entry.secretId)).not.toContain(secretId);
  });

  test("wires Direct VPC egress, /healthz probes, cluster mode, and all shared env vars", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);
    const props = serverServiceProps(config, {
      networkName: names.networkName,
      subnetworkName: names.subnetworkName,
      blobsBucketName: config.blobsBucket,
      mobileAssetsBucketName: config.mobileAssetsBucket,
    });

    expect(props.location).toBe("europe-west3");
    expect(props.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(props.template?.vpcAccess?.egress).toBe("PRIVATE_RANGES_ONLY");
    expect(props.template?.vpcAccess?.networkInterfaces?.[0]).toEqual({
      network: names.networkName,
      subnetwork: names.subnetworkName,
    });

    const container = props.template?.containers?.[0];
    expect(container && "image" in container ? container.image : undefined).toBe(
      imageReference(config),
    );
    expect(
      container && "startupProbe" in container ? container.startupProbe?.httpGet?.path : null,
    ).toBe("/healthz");
    expect(
      container && "livenessProbe" in container ? container.livenessProbe?.httpGet?.path : null,
    ).toBe("/healthz");

    const plainNames = serverPlainEnv(config, {
      blobsBucket: config.blobsBucket,
      mobileAssetsBucket: config.mobileAssetsBucket,
    }).map((e) => e.name);
    const secretNames = serverSecretEnv(config).map((e) => e.name);
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

    const policy = edgeSecurityPolicyProps(config, edge);
    expect(policy.type).toBe("CLOUD_ARMOR");
    expect(policy.rules.some((r) => r.action === "throttle")).toBe(true);
    expect(policy.rules.some((r) => r.priority === 2147483647 && r.action === "allow")).toBe(true);

    const links = { backendGroup: "neg-link", securityPolicy: "policy-link" };
    const dyn = edgeDynamicBackendProps(config, links);
    expect(dyn.logConfig.enable).toBe(false);

    const stat = edgeStaticBackendProps(config, edge, links);
    expect("cdnPolicy" in stat && stat.cdnPolicy?.cacheMode).toBe("USE_ORIGIN_HEADERS");

    const urlMap = edgeUrlMapProps(config, edge, { dynamic: "dyn", static: "stat" });
    expect(urlMap.hostRules[0]?.hosts).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(urlMap.pathMatchers[0]?.pathRules[0]?.paths).toEqual([...edgeStaticAssetPaths]);

    expect(tokenRouteExclusionFilter).toContain("/i/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/invite/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/share/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/invitations/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/auth/magic-link/verify");

    // Behavioral regex check against real token-bearing and non-token URLs
    const regexMatch = tokenRouteExclusionFilter.match(/httpRequest\.requestUrl=~"([^"]+)"/);
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
    Effect.runPromise(
      Effect.scoped(
        Stack.Stack(
          KVITBIT_STACK_NAME,
          { state: State.inMemoryState(), providers: Layer.empty },
          declareKvitbitStack(config).pipe(Effect.orDie),
        ),
      ).pipe(Effect.provideService(Stage, config.stage)),
    );

  const resolveOutputs = (value: unknown, upstream: Record<string, unknown>) =>
    Effect.runPromise(Output.evaluate(value, upstream).pipe(Effect.provide(State.inMemoryState())));

  test.each(["prod", "staging"] as const)(
    "keeps DNS opt-in for %s even when the edge is configured",
    async (stage) => {
      const compiled = await compile(sampleProdConfig({ stage }));
      expect(compiled.resources.EdgeAddress).toBeDefined();
      expect(compiled.resources.CloudDnsApi).toBeUndefined();
      expect(Object.keys(compiled.resources).some((id) => id.startsWith("DnsZone-"))).toBe(false);
      expect(compiled.output).not.toHaveProperty("dnsNameServers");
    },
  );

  test("declares public zones and exports each zone's nameservers before edge setup", async () => {
    const compiled = await compile(sampleProdConfig({ dnsZones: PROD_DNS_ZONES, edge: undefined }));
    const api = compiled.resources.CloudDnsApi;
    expect(api?.Type).toBe("GCP.ServiceUsage.ProjectService");
    expect(api?.Props).toEqual({ project: "kvitbit-prod", service: "dns.googleapis.com" });
    expect(Object.keys(compiled.resources).filter((id) => id.startsWith("DnsZone-"))).toEqual(
      PROD_DNS_ZONES.map((domain) => `DnsZone-${domain}`),
    );

    const upstream: Record<string, unknown> = { CloudDnsApi: { state: "ENABLED" } };
    const expectedNameServers: Record<string, string[]> = {};
    for (const [index, domain] of PROD_DNS_ZONES.entries()) {
      const id = `DnsZone-${domain}`;
      const resource = compiled.resources[id];
      expect(resource?.Type).toBe("GCP.DNS.ManagedZone");
      expect(Object.keys(Output.upstreamAny(resource?.Props))).toEqual(["CloudDnsApi"]);
      expect(await resolveOutputs(resource?.Props, upstream)).toMatchObject({
        zoneName: expect.stringMatching(
          new RegExp(`^kvitbit-prod-${domain.replace(".", "-")}-[0-9a-f]{12}$`),
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
    expect(await resolveOutputs(compiled.output.dnsNameServers, upstream)).toEqual(
      expectedNameServers,
    );
  });

  test("points each apex and www at the reserved edge IP and configures CAA", async () => {
    const compiled = await compile(sampleProdConfig({ dnsZones: PROD_DNS_ZONES }));
    expect(compiled.resources.EdgeAddress).toBeDefined();
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
        expect(Object.keys(Output.upstreamAny(resource?.Props))).toEqual(
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
      KVITBIT_DNS_ZONES: PROD_DNS_ZONES.join(","),
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
    expect(archiveCompiled.resources.KvitbitMailIngressSa?.Type).toBe("GCP.IAM.ServiceAccount");
    expect(archiveCompiled.resources.KvitbitMailArchive?.Type).toBe("GCP.Storage.Bucket");
    expect(archiveCompiled.resources.MailIngressArchiveWriter?.Props).toMatchObject({
      role: "roles/storage.objectCreator",
    });
    expect(archiveCompiled.resources.MailIngressResendSecretAccessor).toBeUndefined();
    expect(archiveCompiled.resources.KvitbitMailAddress?.Props).toMatchObject({
      region: "us-east1",
      addressType: "EXTERNAL",
      networkTier: "PREMIUM",
    });
    expect(
      (archiveCompiled.resources.KvitbitMailAddress?.Props as Record<string, unknown> | undefined)
        ?.ipVersion,
    ).toBeUndefined();
    expect(archiveCompiled.resources.KvitbitMailIngress?.Props).toMatchObject({
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
    const longDkim = `v=DKIM1; k=rsa; p=${"B".repeat(360)}`;
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
    expect(resendCompiled.resources.MailIngressResendSecretAccessor?.Type).toBe("GCP.IAM.Member");
    expect(resendCompiled.resources.MailIngressResendSecretAccessor?.Props).toMatchObject({
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
    const dkimResolved = (await resolveOutputs(
      resendCompiled.resources["DnsZone-kvitbit.com-ResendDkimTxt"]?.Props,
      upstream,
    )) as { name: string; type: string; rrdatas: string[] };
    expect(dkimResolved.name).toBe("resend._domainkey.kvitbit.com.");
    expect(dkimResolved.type).toBe("TXT");
    expect(dkimResolved.rrdatas[0]).toContain('" "');
  });

  test("rejects unsafe mail forwarder configurations (forwarding loops, catch-all aliases, missing zone)", async () => {
    const badLoop = await Effect.runPromise(
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
    );
    expect(badLoop).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_MAIL_FORWARD_TO" });

    const badWildcard = await Effect.runPromise(
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
    );
    expect(badWildcard).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_MAIL_ALIASES",
    });

    const badSelfAlias = await Effect.runPromise(
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
    );
    expect(badSelfAlias).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_MAIL_ALIASES",
    });

    const missingZone = await Effect.runPromise(
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
    );
    expect(missingZone).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_MAIL_DOMAIN" });

    const emptyZones = await Effect.runPromise(
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
    );
    expect(emptyZones).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_MAIL_DOMAIN" });
  });
});

describe("Cloud Monitoring", () => {
  const compile = (config: KvitbitStackConfig) =>
    Effect.runPromise(
      Effect.scoped(
        Stack.Stack(
          KVITBIT_STACK_NAME,
          { state: State.inMemoryState(), providers: Layer.empty },
          declareKvitbitStack(config).pipe(Effect.orDie),
        ),
      ).pipe(Effect.provideService(Stage, config.stage)),
    );

  const load = (alertEmail?: string) =>
    loadStackConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              ...PROD_REQUIRED_ENV,
              ...(alertEmail === undefined ? {} : { KVITBIT_ALERT_EMAIL: alertEmail }),
            },
          }),
        ),
      ),
    );

  const resolveOutputs = (props: unknown, upstream: Record<string, unknown>) =>
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
      expect(await Effect.runPromise(Effect.flip(load(invalid)))).toMatchObject({
        _tag: "InvalidStackConfig",
        field: "KVITBIT_ALERT_EMAIL",
      });
    }
  });

  test("enables the Monitoring API during foundation bootstrap and passes project and email through deployment", async () => {
    const config = sampleProdConfig({ bootstrapFoundation: true, imageDigest: "" });
    const { resources } = await compile(config);
    expect(resources.CloudMonitoringApi?.Type).toBe("GCP.ServiceUsage.ProjectService");
    expect(resources.CloudMonitoringApi?.Props).toEqual({
      project: config.projectId,
      service: "monitoring.googleapis.com",
    });
    expect(foundationResourceIds(config)).toContain("CloudMonitoringApi");
    expect(resources.MonitoringCloudRunErrors).toBeUndefined();
    expect(resources.MonitoringReadinessCheck).toBeUndefined();
    const server = serverPlainEnv(sampleProdConfig({ projectId: "custom-project" }), {
      blobsBucket: "blobs",
      mobileAssetsBucket: "mobile",
    });
    expect(server).toContainEqual({ name: "GOOGLE_CLOUD_PROJECT", value: "custom-project" });
    const workflow = readFileSync(
      new URL("../../../.github/workflows/deploy.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toMatch(/KVITBIT_ALERT_EMAIL: \$\{\{ vars\.KVITBIT_ALERT_EMAIL \}\}/);
  });

  test("uses the HTTPS origin or the first HTTPS edge domain and skips HTTP-only targets", async () => {
    const noEdge = { edge: undefined };
    const upstream = {
      CloudMonitoringApi: { state: "ENABLED" },
      KvitbitServer: { serviceId: "kvitbit-prod-server" },
      EdgeHttpsForwardingRule: { selfLink: "https://example.test/forwardingRule" },
    };
    const http = await compile(sampleProdConfig({ ...noEdge, appOrigin: "http://example.com" }));
    expect(http.resources.MonitoringReadinessCheck).toBeUndefined();
    expect(http.resources.MonitoringReadinessFailure).toBeUndefined();
    expect(http.resources.MonitoringCloudRunErrors).toBeUndefined();
    const emailOnly = await compile(
      sampleProdConfig({
        ...noEdge,
        appOrigin: "http://example.com",
        alertEmail: "ops@kvitbit.com",
      }),
    );
    expect(emailOnly.resources.MonitoringReadinessCheck).toBeUndefined();
    expect(emailOnly.resources.MonitoringCloudRunErrors).toBeDefined();

    const fallback = await compile(sampleProdConfig({ appOrigin: undefined }));
    expect(
      Object.keys(Output.upstreamAny(fallback.resources.MonitoringReadinessCheck?.Props)).sort(),
    ).toEqual(["CloudMonitoringApi", "EdgeHttpsForwardingRule", "KvitbitServer"]);
    expect(
      await resolveOutputs(fallback.resources.MonitoringReadinessCheck?.Props, upstream),
    ).toMatchObject({ host: "kvitbit.cz", port: 443 });

    const direct = await compile(
      sampleProdConfig({ ...noEdge, appOrigin: "https://example.com:8443" }),
    );
    expect(
      await resolveOutputs(direct.resources.MonitoringReadinessCheck?.Props, upstream),
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
      await resolveOutputs(configured.resources.MonitoringCloudRunErrors?.Props, upstream),
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
      Object.keys(
        Output.upstreamAny(configured.resources.MonitoringReadinessFailure?.Props),
      ).sort(),
    ).toEqual(["CloudMonitoringApi", "MonitoringEmail", "MonitoringReadinessCheck"]);
    expect(
      await resolveOutputs(configured.resources.MonitoringReadinessFailure?.Props, upstream),
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
    expect(unconfigured.resources.MonitoringEmail).toBeUndefined();
    for (const policy of ["MonitoringCloudRunErrors", "MonitoringReadinessFailure"]) {
      expect(await resolveOutputs(unconfigured.resources[policy]?.Props, upstream)).toMatchObject({
        notificationChannels: [],
      });
    }
  });
});

describe("Zero-Terraform enforcement", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");

  const collectFiles = (dir: string): Array<string> => {
    const out: Array<string> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectFiles(full));
      } else {
        out.push(full);
      }
    }
    return out;
  };

  test("contains zero .tf/.tfvars files and zero terraform CLI usage in infra/deploy artifacts", () => {
    const infraFiles = collectFiles(join(repoRoot, "infra"));
    const tfFiles = infraFiles.filter((file) => /\.(tf|tfvars)(\.json)?$/.test(file));
    expect(tfFiles).toEqual([]);

    const deployWorkflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    expect(deployWorkflow.toLowerCase()).not.toContain("terraform");
    expect(deployWorkflow.toLowerCase()).not.toContain("opentofu");
  });
});
