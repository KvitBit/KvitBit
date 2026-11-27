/**
 * Tier 1 exhaustive finite-domain verification (`verify-deploy-config`, ADR-0005).
 *
 * Enumerates the full Cartesian product of environments/stages, deploy modes, service config
 * states, and explicit non-prod modes directly over the real TypeScript functions across:
 *   1. `apps/server` (`resolveKvitbitEnv`, `validateServerRuntimeEnv`, `makeEmailSenderLayer`,
 *      `makeBlobStorageLayer`, `MobileConfigLive`)
 *   2. `infra/alchemy` (`validateStackConfigSync`, `serverPlainEnv`, `serverSecretEnv`,
 *      `buildRunnerWorkerConfig`)
 *   3. `.github/workflows/deploy.yml` extracted preflight (`validateDeployPreflight`)
 *
 * Against an independent specification oracle, proving four invariants exhaustively within
 * the stated finite bounds:
 *   (a) zero broken `prod` boots or deploys;
 *   (b) zero non-prod modes / opt-outs accepted in `prod`;
 *   (c) explicit-only non-prod modes in `staging` / `preview`;
 *   (d) cross-layer soundness (`deploy.yml` preflight -> `infra/alchemy` -> `apps/server`
 *       server & worker boot validation).
 */
import { describe, expect, test } from "bun:test";
import { EmailSender } from "@kvitbit/domain/ports";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import {
  defaultSecretBindings,
  KVITBIT_PROD_DEFAULTS,
  type KvitbitEdgeConfig,
  type KvitbitStackConfig,
  loadStackConfig,
  validateStackConfigSync,
} from "../../../../infra/alchemy/src/config";
import {
  DEPLOY_MODES,
  DEPLOY_STAGES,
  type EmailMode as DeployEmailMode,
  REQUIRED_GCP_VARS,
  SECRET_FLAG_ENV_VARS,
  validateDeployPreflight,
} from "../../../../infra/alchemy/src/deploy-preflight";
import {
  buildRunnerWorkerConfig,
  serverPlainEnv,
  serverSecretEnv,
} from "../../../../infra/alchemy/src/env";
import {
  BLOB_DRIVERS,
  EMAIL_MODES,
  FORBIDDEN_OPT_OUT_ENV_VARS,
  KVITBIT_ENVS,
  type KvitbitEnv,
  loadBootRuntimeConfig,
  PROD_EMAIL_MODES,
  RESOLVED_EMAIL_MODES,
  resolveKvitbitEnv,
  SERVER_WORKLOADS,
  validateServerRuntimeEnv,
} from "../../src/config-contract";
import { MobileConfig, MobileConfigLive } from "../../src/http/mobile/config";
import { makeBlobStorageLayer } from "../../src/wiring/blob";
import { makeEmailSenderLayer } from "../../src/wiring/email";

// -----------------------------------------------------------------------------
// Independent specification oracles (written from Issue #31, never calling impl)

const SPEC_ENVS = ["production", "staging", "preview", "development", "test"] as const;
const SPEC_PROD_EMAIL_MODES = new Set(["resend", "smtp", "resend+smtp"]);
const SPEC_NON_PROD_EMAIL_MODES = new Set(["capture", "console"]);

type OriginCase =
  | "absent"
  | "https_public"
  | "http_public"
  | "http_localhost"
  | "https_localhost"
  | "https_localhost_dot"
  | "https_sub_localhost_dot"
  | "https_127"
  | "https_ipv6_loopback"
  | "https_ipv6_mapped_loopback"
  | "invalid_url";

const ORIGIN_VALUES: Readonly<Record<OriginCase, string | undefined>> = {
  absent: undefined,
  https_public: "https://kvitbit.cz",
  http_public: "http://kvitbit.cz",
  http_localhost: "http://localhost:8080",
  https_localhost: "https://localhost:8443",
  https_localhost_dot: "https://localhost.",
  https_sub_localhost_dot: "https://sub.localhost.",
  https_127: "https://127.0.0.1:8443",
  https_ipv6_loopback: "https://[::1]:8443",
  https_ipv6_mapped_loopback: "https://[::ffff:127.0.0.1]",
  invalid_url: "not-a-url",
};

const oracleOriginAccepted = (env: KvitbitEnv, origin: OriginCase): boolean => {
  if (origin === "invalid_url") return false;
  if (origin === "absent") return env === "development" || env === "test";
  if (env === "production") return origin === "https_public";
  return true;
};

type EmailModeCase =
  | "absent"
  | "resend"
  | "smtp"
  | "resend+smtp"
  | "capture"
  | "console"
  | "disabled"
  | "bogus";

type EmailSecretsCase =
  | "none"
  | "resend_only"
  | "smtp_valid"
  | "smtp_invalid"
  | "both_valid"
  | "both_smtp_invalid";

type EmailFromCase =
  | "absent"
  | "valid"
  | "invalid"
  | "invalid_double_dot"
  | "invalid_overlong_label";

const EMAIL_FROM_VALUES: Readonly<Record<EmailFromCase, string | undefined>> = {
  absent: undefined,
  valid: "Kvitbit <noreply@kvitbit.cz>",
  invalid: "invalid-from",
  invalid_double_dot: "a..b@example.org",
  invalid_overlong_label: `a@${"b".repeat(64)}.org`,
};

const isInvalidFromCase = (from: EmailFromCase): boolean =>
  from === "invalid" || from === "invalid_double_dot" || from === "invalid_overlong_label";

const oracleEmail = (
  env: KvitbitEnv,
  modeCase: EmailModeCase,
  secrets: EmailSecretsCase,
  from: EmailFromCase,
): { readonly ok: boolean; readonly expectedMode?: string } => {
  if (modeCase === "bogus" || modeCase === "disabled") return { ok: false };
  if (env === "production" && SPEC_NON_PROD_EMAIL_MODES.has(modeCase)) return { ok: false };

  const hasResend =
    secrets === "resend_only" || secrets === "both_valid" || secrets === "both_smtp_invalid";
  const hasSmtp =
    secrets === "smtp_valid" ||
    secrets === "smtp_invalid" ||
    secrets === "both_valid" ||
    secrets === "both_smtp_invalid";
  const smtpValid = secrets === "smtp_valid" || secrets === "both_valid";

  let effectiveMode: string;
  if (modeCase !== "absent") {
    effectiveMode = modeCase;
  } else if (env === "production" || env === "staging" || env === "preview") {
    if (hasResend && hasSmtp) effectiveMode = "resend+smtp";
    else if (hasResend) effectiveMode = "resend";
    else if (hasSmtp) effectiveMode = "smtp";
    else return { ok: false };
  } else if (env === "test") {
    effectiveMode = "capture";
  } else {
    effectiveMode = !hasResend && !hasSmtp ? "console" : "capture";
  }

  if (effectiveMode === "capture" || effectiveMode === "console") {
    return isInvalidFromCase(from) ? { ok: false } : { ok: true, expectedMode: effectiveMode };
  }

  if ((effectiveMode === "resend" || effectiveMode === "resend+smtp") && !hasResend) {
    return { ok: false };
  }
  if ((effectiveMode === "smtp" || effectiveMode === "resend+smtp") && (!hasSmtp || !smtpValid)) {
    return { ok: false };
  }

  if (isInvalidFromCase(from)) return { ok: false };
  if (from === "absent" && env !== "development" && env !== "test") return { ok: false };

  return { ok: true, expectedMode: effectiveMode };
};

type BlobDriverCase = "absent" | "gcs" | "local" | "bogus";
type BlobBucketCase = "absent" | "present";

const oracleBlob = (
  env: KvitbitEnv,
  driverCase: BlobDriverCase,
  bucketCase: BlobBucketCase,
): { readonly ok: boolean; readonly expectedDriver?: "gcs" | "local" } => {
  if (driverCase === "bogus") return { ok: false };
  let driver: "gcs" | "local";
  if (driverCase === "absent") {
    if (env === "development" || env === "test") driver = "local";
    else return { ok: false };
  } else {
    driver = driverCase;
  }
  if (env === "production" && driver !== "gcs") return { ok: false };
  if (driver === "gcs" && bucketCase === "absent") return { ok: false };
  return { ok: true, expectedDriver: driver };
};

const SAMPLE_DIGEST = `sha256:${"a".repeat(64)}`;
const VALID_EDGE: KvitbitEdgeConfig = {
  domains: ["kvitbit.cz", "kvitbit.app"],
  enableHttps: true,
  staticCdnEnabled: true,
  wafPreview: false,
  authRateLimitPerMinute: 60,
  restrictDirectIngress: true,
};
const DISABLED_HTTPS_EDGE: KvitbitEdgeConfig = {
  ...VALID_EDGE,
  enableHttps: false,
};

const materializeSecretValue = (envVar: string): string => {
  switch (envVar) {
    case "DATABASE_URL":
      return "postgres://app:synthetic@db.internal:5432/kvitbit";
    case "DATABASE_URL_UNPOOLED":
      return "postgres://app:synthetic@db-direct.internal:5432/kvitbit";
    case "BETTER_AUTH_SECRET":
      return "synthetic-auth-secret-32-chars-min";
    case "RESEND_API_KEY":
      return "re_synthetic_key_12345";
    case "KVITBIT_SMTP_URL":
      return "smtps://user:pass@smtp.example.cz:465";
    default:
      return "synthetic-secret-value";
  }
};

// -----------------------------------------------------------------------------
// 1. Domain size guards

describe("verify-deploy-config: finite domain size guards", () => {
  test("every enumerated config domain has the exact expected cardinality", () => {
    expect(KVITBIT_ENVS).toEqual(["production", "staging", "preview", "development", "test"]);
    expect(EMAIL_MODES).toEqual([
      "resend",
      "smtp",
      "resend+smtp",
      "capture",
      "console",
      "disabled",
    ]);
    expect(PROD_EMAIL_MODES).toEqual(["resend", "smtp", "resend+smtp"]);
    expect(RESOLVED_EMAIL_MODES).toEqual(["resend", "smtp", "resend+smtp", "capture", "console"]);
    expect(BLOB_DRIVERS).toEqual(["gcs", "local"]);
    expect(SERVER_WORKLOADS).toEqual(["server", "worker"]);
    expect(DEPLOY_STAGES).toEqual(["prod", "staging"]);
    expect(DEPLOY_MODES).toEqual(["normal", "bootstrap_foundation", "bootstrap_feedback_secret"]);
    expect(SECRET_FLAG_ENV_VARS.length).toBe(4);
    expect(REQUIRED_GCP_VARS.length).toBe(7);
    expect(FORBIDDEN_OPT_OUT_ENV_VARS.length).toBe(7);
  });
});

// -----------------------------------------------------------------------------
// 2. apps/server exhaustive checks

describe("verify-deploy-config: apps/server runtime contract", () => {
  test("resolveKvitbitEnv matches oracle on all 7 x 7 = 49 (KVITBIT_ENV x NODE_ENV) pairs", () => {
    const inputs: ReadonlyArray<string | undefined> = [undefined, ...SPEC_ENVS, "bogus"];
    let checked = 0;

    for (const kvitbitEnv of inputs) {
      for (const nodeEnv of inputs) {
        checked++;
        const actual = resolveKvitbitEnv({ kvitbitEnv, nodeEnv });
        const expected: KvitbitEnv | undefined =
          kvitbitEnv !== undefined
            ? (SPEC_ENVS as ReadonlyArray<string>).includes(kvitbitEnv)
              ? (kvitbitEnv as KvitbitEnv)
              : undefined
            : nodeEnv !== undefined
              ? (SPEC_ENVS as ReadonlyArray<string>).includes(nodeEnv)
                ? (nodeEnv as KvitbitEnv)
                : undefined
              : "development";

        if (expected === undefined) {
          expect(actual.ok, `KVITBIT_ENV=${kvitbitEnv} NODE_ENV=${nodeEnv}`).toBe(false);
        } else {
          expect(actual.ok, `KVITBIT_ENV=${kvitbitEnv} NODE_ENV=${nodeEnv}`).toBe(true);
          if (actual.ok) {
            expect(actual.value).toBe(expected);
          }
        }
      }
    }

    expect(checked).toBe(49);
  });

  test("validateServerRuntimeEnv matches oracle across full 295,680-state Cartesian product", () => {
    const envInputs: ReadonlyArray<{
      readonly label: string;
      readonly kvitbitEnv?: string;
      readonly nodeEnv?: string;
      readonly resolved: KvitbitEnv;
    }> = [
      {
        label: "KVITBIT_ENV=production",
        kvitbitEnv: "production",
        nodeEnv: "production",
        resolved: "production",
      },
      { label: "NODE_ENV=production (implicit)", nodeEnv: "production", resolved: "production" },
      {
        label: "KVITBIT_ENV=staging",
        kvitbitEnv: "staging",
        nodeEnv: "production",
        resolved: "staging",
      },
      {
        label: "KVITBIT_ENV=preview",
        kvitbitEnv: "preview",
        nodeEnv: "production",
        resolved: "preview",
      },
      { label: "KVITBIT_ENV=development", kvitbitEnv: "development", resolved: "development" },
      { label: "unset (default development)", resolved: "development" },
      { label: "KVITBIT_ENV=test", kvitbitEnv: "test", nodeEnv: "test", resolved: "test" },
    ];
    const origins: ReadonlyArray<OriginCase> = [
      "absent",
      "https_public",
      "http_public",
      "http_localhost",
      "https_localhost",
      "https_localhost_dot",
      "https_sub_localhost_dot",
      "https_127",
      "https_ipv6_loopback",
      "https_ipv6_mapped_loopback",
      "invalid_url",
    ];
    const emailModes: ReadonlyArray<EmailModeCase> = [
      "absent",
      "resend",
      "smtp",
      "resend+smtp",
      "capture",
      "console",
      "disabled",
      "bogus",
    ];
    const emailSecrets: ReadonlyArray<EmailSecretsCase> = [
      "none",
      "resend_only",
      "smtp_valid",
      "smtp_invalid",
      "both_valid",
      "both_smtp_invalid",
    ];
    const emailFroms: ReadonlyArray<EmailFromCase> = [
      "absent",
      "valid",
      "invalid",
      "invalid_double_dot",
      "invalid_overlong_label",
    ];
    const blobDrivers: ReadonlyArray<BlobDriverCase> = ["absent", "gcs", "local", "bogus"];
    const blobBuckets: ReadonlyArray<BlobBucketCase> = ["absent", "present"];

    let total = 0;
    let prodAccepted = 0;
    let stagingPreviewExplicitNonProdAccepted = 0;
    const failures: string[] = [];

    for (const workload of SERVER_WORKLOADS) {
      for (const envSpec of envInputs) {
        for (const origin of origins) {
          for (const emailMode of emailModes) {
            for (const secrets of emailSecrets) {
              for (const from of emailFroms) {
                for (const blobDriver of blobDrivers) {
                  for (const blobBucket of blobBuckets) {
                    total++;
                    const envMap: Record<string, string | undefined> = {
                      KVITBIT_ENV: envSpec.kvitbitEnv,
                      NODE_ENV: envSpec.nodeEnv,
                      DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
                      BETTER_AUTH_SECRET: "test-auth-secret",
                      APP_ORIGIN: ORIGIN_VALUES[origin],
                      KVITBIT_EMAIL_MODE: emailMode === "absent" ? undefined : emailMode,
                      EMAIL_FROM: EMAIL_FROM_VALUES[from],
                      RESEND_API_KEY:
                        secrets === "resend_only" ||
                        secrets === "both_valid" ||
                        secrets === "both_smtp_invalid"
                          ? "re_synthetic_key"
                          : undefined,
                      KVITBIT_SMTP_URL:
                        secrets === "smtp_valid" || secrets === "both_valid"
                          ? "smtps://user:pass@smtp.example.cz:465"
                          : secrets === "smtp_invalid" || secrets === "both_smtp_invalid"
                            ? "http://not-smtp.example.cz"
                            : undefined,
                      KVITBIT_BLOB_DRIVER: blobDriver === "absent" ? undefined : blobDriver,
                      KVITBIT_BLOB_BUCKET:
                        blobBucket === "present" ? "kvitbit-prod-blobs-prod" : undefined,
                    };

                    const actual = validateServerRuntimeEnv(envMap, workload);

                    const expOrigin = oracleOriginAccepted(envSpec.resolved, origin);
                    const expEmail = oracleEmail(envSpec.resolved, emailMode, secrets, from);
                    const expBlob = oracleBlob(envSpec.resolved, blobDriver, blobBucket);
                    const expOk = expOrigin && expEmail.ok && expBlob.ok;

                    if (actual.ok !== expOk) {
                      if (failures.length < 10) {
                        failures.push(
                          `${workload} ${envSpec.label} origin=${origin} emailMode=${emailMode} secrets=${secrets} from=${from} blob=${blobDriver}/${blobBucket}: expected ok=${expOk}, got ok=${actual.ok}${actual.ok ? "" : ` (${actual.error.message})`}`,
                        );
                      }
                      continue;
                    }

                    if (actual.ok) {
                      if (
                        actual.value.env !== envSpec.resolved ||
                        actual.value.email.mode !== expEmail.expectedMode ||
                        actual.value.blob.driver !== expBlob.expectedDriver
                      ) {
                        if (failures.length < 10) {
                          failures.push(
                            `resolved mismatch for ${workload} ${envSpec.label}: got (${actual.value.env}, ${actual.value.email.mode}, ${actual.value.blob.driver})`,
                          );
                        }
                      }

                      // Invariant (a) & (b): production never accepts broken config or non-prod modes.
                      if (envSpec.resolved === "production") {
                        prodAccepted++;
                        if (
                          !SPEC_PROD_EMAIL_MODES.has(actual.value.email.mode) ||
                          actual.value.blob.driver !== "gcs" ||
                          actual.value.blob.gcsBucket === undefined ||
                          !actual.value.appOrigin.startsWith("https://")
                        ) {
                          failures.push(`prod invariant violated: ${JSON.stringify(actual.value)}`);
                        }
                      }

                      // Invariant (c): staging/preview only accepts non-prod modes when explicitly set.
                      if (envSpec.resolved === "staging" || envSpec.resolved === "preview") {
                        const nonProdEmail = SPEC_NON_PROD_EMAIL_MODES.has(actual.value.email.mode);
                        const nonProdBlob = actual.value.blob.driver === "local";
                        if (nonProdEmail && emailMode !== actual.value.email.mode) {
                          failures.push(`implicit non-prod email in ${envSpec.resolved}`);
                        }
                        if (nonProdBlob && blobDriver !== "local") {
                          failures.push(`implicit local blob in ${envSpec.resolved}`);
                        }
                        if (nonProdEmail || nonProdBlob) {
                          stagingPreviewExplicitNonProdAccepted++;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(total).toBe(295_680);
    expect(prodAccepted).toBeGreaterThan(0);
    expect(stagingPreviewExplicitNonProdAccepted).toBeGreaterThan(0);
  }, 30_000);

  test("core DB/auth secrets and forbidden opt-out flags across pure validator AND live loadBootRuntimeConfig", async () => {
    const coreCases = [
      { label: "both", db: "postgres://a/b", unpooled: "postgres://a/b", auth: "secret" },
      { label: "db_only", db: "postgres://a/b", unpooled: undefined, auth: "secret" },
      { label: "unpooled_only", db: undefined, unpooled: "postgres://a/b", auth: "secret" },
      { label: "missing_auth", db: "postgres://a/b", unpooled: "postgres://a/b", auth: undefined },
      { label: "missing_db_both", db: undefined, unpooled: undefined, auth: "secret" },
    ] as const;

    let coreChecked = 0;
    for (const workload of SERVER_WORKLOADS) {
      for (const env of KVITBIT_ENVS) {
        for (const c of coreCases) {
          coreChecked++;
          const res = validateServerRuntimeEnv(
            {
              KVITBIT_ENV: env,
              DATABASE_URL: c.db,
              DATABASE_URL_UNPOOLED: c.unpooled,
              BETTER_AUTH_SECRET: c.auth,
              APP_ORIGIN: "https://kvitbit.cz",
              EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
              RESEND_API_KEY: "re_key",
              KVITBIT_BLOB_DRIVER: "gcs",
              KVITBIT_BLOB_BUCKET: "kvitbit-blobs",
            },
            workload,
          );
          const expectedOk =
            c.auth !== undefined &&
            (workload === "server"
              ? c.db !== undefined
              : c.db !== undefined || c.unpooled !== undefined);
          expect(res.ok, `${workload} ${env} ${c.label}`).toBe(expectedOk);
        }
      }
    }
    expect(coreChecked).toBe(50);

    const optOutKeys = [
      ...FORBIDDEN_OPT_OUT_ENV_VARS,
      "KVITBIT_DISABLE_CUSTOM",
      "KVITBIT_DISABLE_HTTP_2",
    ] as const;
    let optOutChecked = 0;
    let liveOptOutChecked = 0;
    let fallbackOptOutChecked = 0;
    for (const workload of SERVER_WORKLOADS) {
      for (const env of KVITBIT_ENVS) {
        for (const key of optOutKeys) {
          optOutChecked++;
          const baseEnvMap: Record<string, string> = {
            KVITBIT_ENV: env,
            DATABASE_URL: "postgres://a/b",
            BETTER_AUTH_SECRET: "secret",
            APP_ORIGIN: "https://kvitbit.cz",
            EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
            RESEND_API_KEY: "re_key",
            KVITBIT_BLOB_DRIVER: "gcs",
            KVITBIT_BLOB_BUCKET: "kvitbit-blobs",
          };
          const envMap: Record<string, string> = { ...baseEnvMap, [key]: "true" };
          const res = validateServerRuntimeEnv(envMap, workload);
          expect(res.ok, `pure ${workload} ${env} ${key}`).toBe(false);

          // Live Effect loader must reject every dynamic forbidden flag (including Array nodes).
          liveOptOutChecked++;
          const live = await Effect.runPromise(
            loadBootRuntimeConfig(workload).pipe(
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: envMap }))),
              Effect.result,
            ),
          );
          expect(live._tag, `live ${workload} ${env} ${key}`).toBe("Failure");

          // Composed fallback ConfigProvider (primary valid env + fallback forbidden flag) must also fail.
          fallbackOptOutChecked++;
          const composed = ConfigProvider.orElse(
            ConfigProvider.fromEnv({ env: baseEnvMap }),
            ConfigProvider.fromEnv({ env: { [key]: "true" } }),
          );
          const liveFallback = await Effect.runPromise(
            loadBootRuntimeConfig(workload).pipe(
              Effect.provide(ConfigProvider.layer(composed)),
              Effect.result,
            ),
          );
          expect(liveFallback._tag, `fallback ${workload} ${env} ${key}`).toBe("Failure");
        }
      }
    }
    expect(optOutChecked).toBe(90);
    expect(liveOptOutChecked).toBe(90);
    expect(fallbackOptOutChecked).toBe(90);

    // Upgrade preservation: NODE_ENV=production with empty KVITBIT_ENV and configured Resend stays in production (never capture).
    const upgradedEnv: Record<string, string> = {
      NODE_ENV: "production",
      KVITBIT_ENV: "",
      DATABASE_URL: "postgres://a/b",
      BETTER_AUTH_SECRET: "secret",
      APP_ORIGIN: "https://kvitbit.cz",
      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      RESEND_API_KEY: "re_key",
      KVITBIT_BLOB_DRIVER: "gcs",
      KVITBIT_BLOB_BUCKET: "kvitbit-blobs",
    };
    const upgraded = await Effect.runPromise(
      loadBootRuntimeConfig("server").pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: upgradedEnv }))),
      ),
    );
    expect(upgraded.env).toBe("production");
    expect(upgraded.email.mode).toBe("resend");

    // Boundary checks: RFC 1035 63-octet label & public IPv4-mapped IPv6 accepted; 64-octet TLD & [::ffff:0.0.0.0] rejected.
    expect(
      validateServerRuntimeEnv({ ...upgradedEnv, EMAIL_FROM: `a@${"b".repeat(63)}.org` }, "server")
        .ok,
    ).toBe(true);
    expect(
      validateServerRuntimeEnv(
        { ...upgradedEnv, APP_ORIGIN: "https://[::ffff:192.0.2.1]" },
        "server",
      ).ok,
    ).toBe(true);
    expect(
      validateServerRuntimeEnv(
        { ...upgradedEnv, EMAIL_FROM: `a@example.${"c".repeat(64)}` },
        "server",
      ).ok,
    ).toBe(false);
    expect(
      validateServerRuntimeEnv({ ...upgradedEnv, APP_ORIGIN: "https://[::ffff:0.0.0.0]" }, "server")
        .ok,
    ).toBe(false);
  }, 30_000);

  test("real Effect layers (makeEmailSenderLayer, makeBlobStorageLayer, MobileConfigLive) match oracle", async () => {
    // 1. makeEmailSenderLayer: 5 envs x 7 modes x 4 secrets x 2 froms = 280 real layer builds
    const emailModes: ReadonlyArray<EmailModeCase> = [
      "absent",
      "resend",
      "smtp",
      "resend+smtp",
      "capture",
      "console",
      "disabled",
    ];
    const secretsCases: ReadonlyArray<EmailSecretsCase> = [
      "none",
      "resend_only",
      "smtp_valid",
      "both_valid",
    ];
    const fromCases: ReadonlyArray<EmailFromCase> = ["absent", "valid"];

    let emailLayersChecked = 0;
    for (const env of KVITBIT_ENVS) {
      for (const modeCase of emailModes) {
        for (const secrets of secretsCases) {
          for (const fromCase of fromCases) {
            emailLayersChecked++;
            const layer = makeEmailSenderLayer(
              {
                mode: modeCase === "absent" ? undefined : modeCase,
                from: fromCase === "valid" ? "Kvitbit <noreply@kvitbit.cz>" : undefined,
                resendApiKey:
                  secrets === "resend_only" || secrets === "both_valid"
                    ? Option.some(Redacted.make("re_synthetic_key"))
                    : Option.none(),
                smtpUrl:
                  secrets === "smtp_valid" || secrets === "both_valid"
                    ? Option.some(Redacted.make("smtps://user:pass@smtp.example.cz:465"))
                    : Option.none(),
              },
              env,
            );
            const expected = oracleEmail(env, modeCase, secrets, fromCase);
            const built = await Effect.runPromiseExit(Layer.build(layer).pipe(Effect.scoped));
            expect(
              built._tag === "Success",
              `makeEmailSenderLayer ${env} ${modeCase} ${secrets} ${fromCase}`,
            ).toBe(expected.ok);

            if (
              built._tag === "Success" &&
              (expected.expectedMode === "capture" || expected.expectedMode === "console")
            ) {
              const sent = await Effect.runPromise(
                Effect.flatMap(EmailSender, (sender) =>
                  sender.send(
                    {
                      to: ["u@example.cz"],
                      replyTo: "noreply@kvitbit.cz",
                      subject: "Verify",
                      html: "<p>ok</p>",
                      text: "ok",
                      attachments: [],
                      tags: {},
                    },
                    { idempotencyKey: "verify-k1" },
                  ),
                ).pipe(Effect.provide(layer), Effect.result),
              );
              expect(sent._tag).toBe("Success");
              if (sent._tag === "Success") {
                expect(sent.success.provider).toBe(expected.expectedMode);
              }
            }
          }
        }
      }
    }
    expect(emailLayersChecked).toBe(280);

    // 2. makeBlobStorageLayer: 5 envs x 2 drivers x 2 bucket states = 20 real layer builds
    let blobLayersChecked = 0;
    for (const env of KVITBIT_ENVS) {
      for (const driver of BLOB_DRIVERS) {
        for (const hasBucket of [false, true] as const) {
          blobLayersChecked++;
          const layer = makeBlobStorageLayer(
            {
              driver,
              localDir: "/tmp/kvitbit-verify-blobs",
              gcsBucket: hasBucket ? Option.some("kvitbit-blobs") : Option.none(),
              gcsProject: Option.none(),
            },
            env,
          );
          const expected = oracleBlob(env, driver, hasBucket ? "present" : "absent");
          const built = await Effect.runPromiseExit(Layer.build(layer).pipe(Effect.scoped));
          expect(
            built._tag === "Success",
            `makeBlobStorageLayer ${env} ${driver} bucket=${hasBucket}`,
          ).toBe(expected.ok);
        }
      }
    }
    expect(blobLayersChecked).toBe(20);

    // 3. MobileConfigLive: 5 envs x 4 origins x 2 mobileBucket x 2 mobileDir (incl. image default) x 3 blobDriver x 2 blobBucket = 480 runs
    const mobileOrigins: ReadonlyArray<OriginCase> = [
      "absent",
      "https_public",
      "http_localhost",
      "invalid_url",
    ];
    let mobileChecked = 0;
    for (const env of KVITBIT_ENVS) {
      for (const origin of mobileOrigins) {
        for (const hasMobileBucket of [false, true] as const) {
          for (const hasMobileDir of [false, true] as const) {
            for (const blobDriver of ["absent", "gcs", "local"] as const) {
              for (const hasBlobBucket of [false, true] as const) {
                mobileChecked++;
                const rawEnv: Record<string, string> = { KVITBIT_ENV: env };
                const originVal = ORIGIN_VALUES[origin];
                if (originVal !== undefined) rawEnv.APP_ORIGIN = originVal;
                if (hasMobileBucket) rawEnv.KVITBIT_MOBILE_STORAGE_BUCKET = "mobile-bucket";
                if (hasMobileDir) rawEnv.KVITBIT_MOBILE_STORAGE_DIR = "/var/lib/kvitbit/mobile";
                if (blobDriver !== "absent") rawEnv.KVITBIT_BLOB_DRIVER = blobDriver;
                if (hasBlobBucket) rawEnv.KVITBIT_BLOB_BUCKET = "blob-bucket";

                const res = await Effect.runPromise(
                  Effect.gen(function* () {
                    return yield* MobileConfig;
                  }).pipe(
                    Effect.provide(MobileConfigLive),
                    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: rawEnv }))),
                    Effect.result,
                  ),
                );

                const originOk = oracleOriginAccepted(env, origin);
                let expectedTag: "gcs" | "local" | undefined;
                if (env === "production") {
                  if (blobDriver === "local") expectedTag = undefined;
                  else if (hasMobileBucket) expectedTag = "gcs";
                  else expectedTag = blobDriver === "gcs" && hasBlobBucket ? "gcs" : undefined;
                } else if (env === "staging" || env === "preview") {
                  if (hasMobileBucket) expectedTag = "gcs";
                  else if (blobDriver === "gcs") expectedTag = hasBlobBucket ? "gcs" : undefined;
                  else if (blobDriver === "local") expectedTag = "local";
                  else expectedTag = undefined;
                } else {
                  if (hasMobileBucket) expectedTag = "gcs";
                  else if (hasMobileDir) expectedTag = "local";
                  else if (blobDriver === "gcs") expectedTag = hasBlobBucket ? "gcs" : undefined;
                  else if (blobDriver === "local") expectedTag = "local";
                  else if (hasBlobBucket) expectedTag = "gcs";
                  else expectedTag = "local";
                }

                const expOk = originOk && expectedTag !== undefined;
                expect(
                  res._tag === "Success",
                  `MobileConfigLive ${env} origin=${origin} mobileBucket=${hasMobileBucket} mobileDir=${hasMobileDir} blob=${blobDriver}/${hasBlobBucket}`,
                ).toBe(expOk);
                if (res._tag === "Success" && expectedTag !== undefined) {
                  expect(res.success.storage._tag).toBe(expectedTag);
                }
              }
            }
          }
        }
      }
    }
    expect(mobileChecked).toBe(480);
  }, 30_000);
});

// -----------------------------------------------------------------------------
// 3. infra/alchemy exhaustive checks + cross-layer soundness (Alchemy -> server)

describe("verify-deploy-config: infra/alchemy stack validation & cross-layer soundness", () => {
  test("validateStackConfigSync matches oracle across all 215,040 states and proves cross-layer soundness to apps/server", () => {
    const deployModeCases = [
      { label: "normal", bootstrapFoundation: false, bootstrapFeedbackSecret: false },
      { label: "bootstrap_foundation", bootstrapFoundation: true, bootstrapFeedbackSecret: false },
      {
        label: "bootstrap_feedback_secret",
        bootstrapFoundation: false,
        bootstrapFeedbackSecret: true,
      },
      { label: "both_bootstraps", bootstrapFoundation: true, bootstrapFeedbackSecret: true },
    ] as const;
    const originCases: ReadonlyArray<OriginCase> = [
      "absent",
      "https_public",
      "http_public",
      "https_localhost",
      "https_localhost_dot",
      "https_ipv6_mapped_loopback",
      "http_localhost",
      "invalid_url",
    ];
    const emailModeCases: ReadonlyArray<DeployEmailMode | "absent"> = [
      "absent",
      "resend",
      "smtp",
      "resend+smtp",
      "capture",
      "console",
      "disabled",
    ];
    const secretCases = [
      { label: "none", enableResend: false, enableSmtp: false },
      { label: "resend", enableResend: true, enableSmtp: false },
      { label: "smtp", enableResend: false, enableSmtp: true },
      { label: "both", enableResend: true, enableSmtp: true },
    ] as const;
    const fromCases: ReadonlyArray<EmailFromCase> = [
      "absent",
      "valid",
      "invalid",
      "invalid_double_dot",
      "invalid_overlong_label",
    ];
    const edgeCases = [
      { label: "none", edge: undefined },
      { label: "valid_https", edge: VALID_EDGE },
      { label: "https_disabled", edge: DISABLED_HTTPS_EDGE },
    ] as const;

    let total = 0;
    let prodNormalAccepted = 0;
    let stagingNormalAccepted = 0;
    let crossLayerVerified = 0;
    const failures: string[] = [];

    for (const stage of DEPLOY_STAGES) {
      for (const deployMode of deployModeCases) {
        for (const origin of originCases) {
          for (const emailMode of emailModeCases) {
            for (const secrets of secretCases) {
              for (const from of fromCases) {
                for (const blobDriver of BLOB_DRIVERS) {
                  for (const hasBlobBucket of [true, false] as const) {
                    for (const edgeCase of edgeCases) {
                      for (const enableFeedback of [false, true] as const) {
                        total++;
                        const config: KvitbitStackConfig = {
                          stage,
                          bootstrapFoundation: deployMode.bootstrapFoundation,
                          bootstrapFeedbackSecret: deployMode.bootstrapFeedbackSecret,
                          projectId: KVITBIT_PROD_DEFAULTS.projectId,
                          projectNumber: KVITBIT_PROD_DEFAULTS.projectNumber,
                          region: KVITBIT_PROD_DEFAULTS.region,
                          zone: KVITBIT_PROD_DEFAULTS.zone,
                          stateBucket: KVITBIT_PROD_DEFAULTS.stateBucket,
                          artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
                          imageName: KVITBIT_PROD_DEFAULTS.imageName,
                          imageDigest: deployMode.bootstrapFoundation ? "" : SAMPLE_DIGEST,
                          blobDriver,
                          blobsBucket: hasBlobBucket ? `kvitbit-${stage}-blobs` : "",
                          mobileAssetsBucket: `kvitbit-${stage}-mobile`,
                          runnerCount: 2,
                          runnerMachineType: KVITBIT_PROD_DEFAULTS.runnerMachineType,
                          runnerPort: KVITBIT_PROD_DEFAULTS.runnerPort,
                          runnerCidr: KVITBIT_PROD_DEFAULTS.runnerCidr,
                          serverMinInstances: 0,
                          serverMaxInstances: 10,
                          appOrigin: ORIGIN_VALUES[origin],
                          emailMode: emailMode === "absent" ? undefined : emailMode,
                          emailFrom: EMAIL_FROM_VALUES[from],
                          trustedProxyHops: edgeCase.edge !== undefined ? 2 : 1,
                          shareKeyVersion: 1,
                          androidAssetlinksSha256: undefined,
                          feedbackGitHubRepo: undefined,
                          feedbackOwnerEmails: undefined,
                          secrets: defaultSecretBindings(stage, {
                            enableResend: secrets.enableResend,
                            enableSmtp: secrets.enableSmtp,
                            enableFeedbackGitHubToken: enableFeedback,
                          }),
                          dnsZones: [],
                          edge: edgeCase.edge,
                        };

                        // Independent Alchemy specification oracle
                        let expOk = true;
                        if (deployMode.bootstrapFoundation && deployMode.bootstrapFeedbackSecret) {
                          expOk = false;
                        } else if (emailMode === "disabled") {
                          expOk = false;
                        } else if (
                          stage === "prod" &&
                          (blobDriver !== "gcs" ||
                            (emailMode !== "absent" && !SPEC_PROD_EMAIL_MODES.has(emailMode)))
                        ) {
                          expOk = false;
                        } else if (deployMode.bootstrapFeedbackSecret) {
                          expOk = enableFeedback;
                        } else if (deployMode.bootstrapFoundation) {
                          expOk = true;
                        } else {
                          // Normal deploy
                          if (blobDriver === "gcs" && !hasBlobBucket) expOk = false;
                          if (stage === "prod") {
                            if (origin !== "https_public") expOk = false;
                            if (edgeCase.label !== "valid_https") expOk = false;
                            if (from !== "valid") expOk = false;
                            if (!secrets.enableResend && !secrets.enableSmtp) expOk = false;
                            if (
                              (emailMode === "resend" || emailMode === "resend+smtp") &&
                              !secrets.enableResend
                            ) {
                              expOk = false;
                            }
                            if (
                              (emailMode === "smtp" || emailMode === "resend+smtp") &&
                              !secrets.enableSmtp
                            ) {
                              expOk = false;
                            }
                          } else {
                            // staging normal deploy
                            if (origin === "absent" || origin === "invalid_url") expOk = false;
                            const isNonProdEmail =
                              emailMode === "capture" || emailMode === "console";
                            if (isNonProdEmail) {
                              if (isInvalidFromCase(from)) expOk = false;
                            } else {
                              if (from !== "valid") expOk = false;
                              if (
                                emailMode === "absent" &&
                                !secrets.enableResend &&
                                !secrets.enableSmtp
                              ) {
                                expOk = false;
                              }
                              if (
                                (emailMode === "resend" || emailMode === "resend+smtp") &&
                                !secrets.enableResend
                              ) {
                                expOk = false;
                              }
                              if (
                                (emailMode === "smtp" || emailMode === "resend+smtp") &&
                                !secrets.enableSmtp
                              ) {
                                expOk = false;
                              }
                            }
                          }
                        }

                        const actual = validateStackConfigSync(config);
                        if (actual.ok !== expOk) {
                          if (failures.length < 10) {
                            failures.push(
                              `alchemy ${stage} ${deployMode.label} origin=${origin} emailMode=${emailMode} secrets=${secrets.label} from=${from} blob=${blobDriver}/${hasBlobBucket} edge=${edgeCase.label} fb=${enableFeedback}: expected=${expOk}, got=${actual.ok}${actual.ok ? "" : ` (${actual.error.message})`}`,
                            );
                          }
                          continue;
                        }

                        // Invariant (d): Cross-layer soundness for every accepted normal deploy
                        if (
                          actual.ok &&
                          !deployMode.bootstrapFoundation &&
                          !deployMode.bootstrapFeedbackSecret
                        ) {
                          if (stage === "prod") prodNormalAccepted++;
                          else stagingNormalAccepted++;
                          crossLayerVerified++;

                          const serverEnvMap: Record<string, string> = {};
                          for (const v of serverPlainEnv(config, {
                            blobsBucket: config.blobsBucket,
                            mobileAssetsBucket: config.mobileAssetsBucket,
                          })) {
                            serverEnvMap[v.name] = v.value;
                          }
                          for (const s of serverSecretEnv(config)) {
                            serverEnvMap[s.name] = materializeSecretValue(s.name);
                          }

                          const serverCheck = validateServerRuntimeEnv(serverEnvMap, "server");
                          if (!serverCheck.ok) {
                            if (failures.length < 10) {
                              failures.push(
                                `cross-layer server failure for ${stage} emailMode=${emailMode} secrets=${secrets.label}: ${serverCheck.error.message}`,
                              );
                            }
                          } else if (stage === "prod") {
                            if (
                              serverCheck.value.env !== "production" ||
                              !SPEC_PROD_EMAIL_MODES.has(serverCheck.value.email.mode) ||
                              serverCheck.value.blob.driver !== "gcs"
                            ) {
                              failures.push(
                                `cross-layer prod server weakened: ${JSON.stringify(serverCheck.value)}`,
                              );
                            }
                          }

                          const runnerConfig = buildRunnerWorkerConfig(config);
                          const runnerEnvMap: Record<string, string> = {};
                          for (const v of runnerConfig.plainEnv) {
                            runnerEnvMap[v.name] = v.value;
                          }
                          for (const s of runnerConfig.secrets) {
                            if (
                              stage === "prod" &&
                              (s.environmentVariable === "RESEND_API_KEY" ||
                                s.environmentVariable === "KVITBIT_SMTP_URL") &&
                              !s.required
                            ) {
                              failures.push(
                                `runner secret ${s.environmentVariable} must be required in prod`,
                              );
                            }
                            runnerEnvMap[s.environmentVariable] = materializeSecretValue(
                              s.environmentVariable,
                            );
                          }

                          const workerCheck = validateServerRuntimeEnv(runnerEnvMap, "worker");
                          if (!workerCheck.ok) {
                            if (failures.length < 10) {
                              failures.push(
                                `cross-layer worker failure for ${stage} emailMode=${emailMode} secrets=${secrets.label}: ${workerCheck.error.message}`,
                              );
                            }
                          } else if (stage === "prod") {
                            if (
                              workerCheck.value.env !== "production" ||
                              !SPEC_PROD_EMAIL_MODES.has(workerCheck.value.email.mode) ||
                              workerCheck.value.blob.driver !== "gcs"
                            ) {
                              failures.push(
                                `cross-layer prod worker weakened: ${JSON.stringify(workerCheck.value)}`,
                              );
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(total).toBe(215_040);
    expect(prodNormalAccepted).toBeGreaterThan(0);
    expect(stagingNormalAccepted).toBeGreaterThan(0);
    expect(crossLayerVerified).toBe(prodNormalAccepted + stagingNormalAccepted);
  }, 30_000);

  test("rejects missing core secret consumers and dynamic forbidden flags in live loadStackConfig", async () => {
    const baseProd = (secrets: KvitbitStackConfig["secrets"]): KvitbitStackConfig => ({
      stage: "prod",
      bootstrapFoundation: false,
      bootstrapFeedbackSecret: false,
      projectId: KVITBIT_PROD_DEFAULTS.projectId,
      projectNumber: KVITBIT_PROD_DEFAULTS.projectNumber,
      region: KVITBIT_PROD_DEFAULTS.region,
      zone: KVITBIT_PROD_DEFAULTS.zone,
      stateBucket: KVITBIT_PROD_DEFAULTS.stateBucket,
      artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
      imageName: KVITBIT_PROD_DEFAULTS.imageName,
      imageDigest: SAMPLE_DIGEST,
      blobDriver: "gcs",
      blobsBucket: "kvitbit-prod-blobs",
      mobileAssetsBucket: "kvitbit-prod-mobile",
      runnerCount: 2,
      runnerMachineType: KVITBIT_PROD_DEFAULTS.runnerMachineType,
      runnerPort: KVITBIT_PROD_DEFAULTS.runnerPort,
      runnerCidr: KVITBIT_PROD_DEFAULTS.runnerCidr,
      serverMinInstances: 0,
      serverMaxInstances: 10,
      appOrigin: "https://kvitbit.cz",
      emailMode: undefined,
      emailFrom: "Kvitbit <noreply@kvitbit.cz>",
      trustedProxyHops: 2,
      shareKeyVersion: 1,
      androidAssetlinksSha256: undefined,
      feedbackGitHubRepo: undefined,
      feedbackOwnerEmails: undefined,
      secrets,
      dnsZones: [],
      edge: VALID_EDGE,
    });

    const full = defaultSecretBindings("prod", { enableResend: true });
    expect(validateStackConfigSync(baseProd(full)).ok).toBe(true);

    // Dropping DATABASE_URL, BETTER_AUTH_SECRET, or runner-side RESEND_API_KEY must fail.
    expect(
      validateStackConfigSync(
        baseProd(full.filter((s) => s.environmentVariable !== "DATABASE_URL")),
      ).ok,
    ).toBe(false);
    expect(
      validateStackConfigSync(
        baseProd(full.filter((s) => s.environmentVariable !== "BETTER_AUTH_SECRET")),
      ).ok,
    ).toBe(false);
    expect(
      validateStackConfigSync(
        baseProd(
          full.map((s) =>
            s.environmentVariable === "RESEND_API_KEY" ? { ...s, consumers: ["server"] } : s,
          ),
        ),
      ).ok,
    ).toBe(false);

    // Live Alchemy loader rejects every forbidden flag dynamically (direct, Array node, and composed fallback ConfigProvider).
    const baseStackEnv = {
      KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
      KVITBIT_APP_ORIGIN: "https://kvitbit.cz",
      KVITBIT_EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      KVITBIT_EDGE_DOMAINS: "kvitbit.cz",
      KVITBIT_ENABLE_RESEND_SECRET: "true",
    };
    for (const key of [
      ...FORBIDDEN_OPT_OUT_ENV_VARS,
      "KVITBIT_DISABLE_CUSTOM",
      "KVITBIT_DISABLE_HTTP_2",
    ] as const) {
      const live = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { ...baseStackEnv, [key]: "true" } }),
            ),
          ),
          Effect.result,
        ),
      );
      expect(live._tag, `loadStackConfig direct ${key}`).toBe("Failure");

      const fallback = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.orElse(
                ConfigProvider.fromEnv({ env: baseStackEnv }),
                ConfigProvider.fromEnv({ env: { [key]: "true" } }),
              ),
            ),
          ),
          Effect.result,
        ),
      );
      expect(fallback._tag, `loadStackConfig fallback ${key}`).toBe("Failure");
    }
  });
});

// -----------------------------------------------------------------------------
// 4. deploy.yml extracted preflight exhaustive checks + 3-layer soundness

describe("verify-deploy-config: deploy.yml preflight & 3-layer soundness", () => {
  const BASE_GCP_ENV = {
    GCP_PROJECT_ID: "kvitbit-prod",
    GCP_PROJECT_NUMBER: "449188423567",
    GCP_REGION: "europe-west3",
    GCP_ZONE: "europe-west3-a",
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      "projects/449188423567/locations/global/workloadIdentityPools/gh/providers/gh",
    GCP_DEPLOYER_SERVICE_ACCOUNT: "deployer@kvitbit-prod.iam.gserviceaccount.com",
    ALCHEMY_STATE_BUCKET: "alchemy-state-kvitbit-prod",
  } as const;

  test("validateDeployPreflight matches oracle across all 423,360 states and proves 3-layer soundness", () => {
    const deployModes = [
      { label: "normal", foundation: "false", feedback: "false" },
      { label: "bootstrap_foundation", foundation: "true", feedback: "false" },
      { label: "bootstrap_feedback_secret", foundation: "false", feedback: "true" },
      { label: "both", foundation: "true", feedback: "true" },
    ] as const;
    const originCases: ReadonlyArray<OriginCase> = [
      "absent",
      "https_public",
      "http_public",
      "https_localhost",
      "https_localhost_dot",
      "https_ipv6_mapped_loopback",
      "invalid_url",
    ];
    const emailModeCases: ReadonlyArray<DeployEmailMode | "absent"> = [
      "absent",
      "resend",
      "smtp",
      "resend+smtp",
      "capture",
      "console",
      "disabled",
    ];
    const secretCases = [
      { label: "none", resend: "false", smtp: "false" },
      { label: "resend", resend: "true", smtp: "false" },
      { label: "smtp", resend: "false", smtp: "true" },
      { label: "both", resend: "true", smtp: "true" },
    ] as const;
    const fromCases: ReadonlyArray<EmailFromCase> = [
      "absent",
      "valid",
      "invalid",
      "invalid_double_dot",
      "invalid_overlong_label",
    ];
    const edgeCases = [
      { label: "absent", raw: undefined },
      { label: "valid", raw: "kvitbit.cz, kvitbit.app" },
      { label: "invalid", raw: "*.kvitbit.cz" },
    ] as const;
    const blobDriverCases = ["absent", "gcs", "local"] as const;
    const kvitbitEnvCases = ["absent", "production", "staging"] as const;

    let total = 0;
    let prodNormalAccepted = 0;
    const failures: string[] = [];

    for (const stage of DEPLOY_STAGES) {
      for (const mode of deployModes) {
        for (const origin of originCases) {
          for (const emailMode of emailModeCases) {
            for (const secrets of secretCases) {
              for (const from of fromCases) {
                for (const edge of edgeCases) {
                  for (const blobDriver of blobDriverCases) {
                    for (const kvitbitEnv of kvitbitEnvCases) {
                      for (const feedbackEnabled of [false, true] as const) {
                        total++;
                        const env: Record<string, string | undefined> = {
                          ...BASE_GCP_ENV,
                          KVITBIT_STAGE: stage,
                          BOOTSTRAP_FOUNDATION: mode.foundation,
                          BOOTSTRAP_FEEDBACK_SECRET: mode.feedback,
                          KVITBIT_ENABLE_RESEND_SECRET: secrets.resend,
                          KVITBIT_ENABLE_SMTP_SECRET: secrets.smtp,
                          KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "false",
                          KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: feedbackEnabled
                            ? "true"
                            : "false",
                          APP_ORIGIN: ORIGIN_VALUES[origin],
                          EMAIL_FROM: EMAIL_FROM_VALUES[from],
                          KVITBIT_EDGE_DOMAINS: edge.raw,
                          KVITBIT_EMAIL_MODE: emailMode === "absent" ? undefined : emailMode,
                          KVITBIT_BLOB_DRIVER: blobDriver === "absent" ? undefined : blobDriver,
                          KVITBIT_ENV: kvitbitEnv === "absent" ? undefined : kvitbitEnv,
                        };

                        // Independent deploy.yml preflight specification oracle
                        let expOk = true;
                        if (stage !== "prod") expOk = false;
                        else if (mode.label === "both") expOk = false;
                        else if (kvitbitEnv !== "absent" && kvitbitEnv !== "production") {
                          expOk = false;
                        } else if (
                          emailMode !== "absent" &&
                          !SPEC_PROD_EMAIL_MODES.has(emailMode)
                        ) {
                          expOk = false;
                        } else if (blobDriver !== "absent" && blobDriver !== "gcs") {
                          expOk = false;
                        } else if (mode.label === "bootstrap_feedback_secret") {
                          expOk = feedbackEnabled;
                        } else if (mode.label === "bootstrap_foundation") {
                          expOk = true;
                        } else {
                          if (origin !== "https_public") expOk = false;
                          if (from !== "valid") expOk = false;
                          if (edge.label !== "valid") expOk = false;
                          const hasR = secrets.resend === "true";
                          const hasS = secrets.smtp === "true";
                          if (!hasR && !hasS) expOk = false;
                          if ((emailMode === "resend" || emailMode === "resend+smtp") && !hasR) {
                            expOk = false;
                          }
                          if ((emailMode === "smtp" || emailMode === "resend+smtp") && !hasS) {
                            expOk = false;
                          }
                        }

                        const actual = validateDeployPreflight(env);
                        if (actual.ok !== expOk) {
                          if (failures.length < 10) {
                            failures.push(
                              `preflight ${stage} ${mode.label} origin=${origin} emailMode=${emailMode} secrets=${secrets.label} from=${from} edge=${edge.label} blob=${blobDriver} kvEnv=${kvitbitEnv} fb=${feedbackEnabled}: expected=${expOk}, got=${actual.ok}${actual.ok ? "" : ` (${actual.message})`}`,
                            );
                          }
                          continue;
                        }

                        // End-to-end 3-layer soundness: every normal prod preflight pass
                        // produces a valid Alchemy stack config and valid server+worker env maps.
                        if (actual.ok && actual.deployMode === "normal") {
                          prodNormalAccepted++;
                          const stackConfig: KvitbitStackConfig = {
                            stage: "prod",
                            bootstrapFoundation: false,
                            bootstrapFeedbackSecret: false,
                            projectId: BASE_GCP_ENV.GCP_PROJECT_ID,
                            projectNumber: BASE_GCP_ENV.GCP_PROJECT_NUMBER,
                            region: BASE_GCP_ENV.GCP_REGION,
                            zone: BASE_GCP_ENV.GCP_ZONE,
                            stateBucket: BASE_GCP_ENV.ALCHEMY_STATE_BUCKET,
                            artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
                            imageName: KVITBIT_PROD_DEFAULTS.imageName,
                            imageDigest: SAMPLE_DIGEST,
                            blobDriver: "gcs",
                            blobsBucket: "kvitbit-prod-blobs-prod",
                            mobileAssetsBucket: "kvitbit-prod-mobile-prod",
                            runnerCount: 2,
                            runnerMachineType: KVITBIT_PROD_DEFAULTS.runnerMachineType,
                            runnerPort: KVITBIT_PROD_DEFAULTS.runnerPort,
                            runnerCidr: KVITBIT_PROD_DEFAULTS.runnerCidr,
                            serverMinInstances: 0,
                            serverMaxInstances: 10,
                            appOrigin: ORIGIN_VALUES[origin],
                            emailMode: emailMode === "absent" ? undefined : emailMode,
                            emailFrom: env.EMAIL_FROM,
                            trustedProxyHops: 2,
                            shareKeyVersion: 1,
                            androidAssetlinksSha256: undefined,
                            feedbackGitHubRepo: undefined,
                            feedbackOwnerEmails: undefined,
                            secrets: defaultSecretBindings("prod", {
                              enableResend: actual.normalizedBooleans.KVITBIT_ENABLE_RESEND_SECRET,
                              enableSmtp: actual.normalizedBooleans.KVITBIT_ENABLE_SMTP_SECRET,
                              enableMobileSigningKey:
                                actual.normalizedBooleans.KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET,
                              enableFeedbackGitHubToken:
                                actual.normalizedBooleans
                                  .KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET,
                            }),
                            dnsZones: [],
                            edge: VALID_EDGE,
                          };

                          const stackRes = validateStackConfigSync(stackConfig);
                          if (!stackRes.ok) {
                            failures.push(
                              `3-layer gap (preflight->alchemy): ${stackRes.error.message}`,
                            );
                            continue;
                          }

                          const serverEnv: Record<string, string> = {};
                          for (const v of serverPlainEnv(stackConfig, {
                            blobsBucket: stackConfig.blobsBucket,
                            mobileAssetsBucket: stackConfig.mobileAssetsBucket,
                          })) {
                            serverEnv[v.name] = v.value;
                          }
                          for (const s of serverSecretEnv(stackConfig)) {
                            serverEnv[s.name] = materializeSecretValue(s.name);
                          }
                          const serverRes = validateServerRuntimeEnv(serverEnv, "server");
                          if (!serverRes.ok) {
                            failures.push(
                              `3-layer gap (preflight->server): ${serverRes.error.message}`,
                            );
                          }

                          const workerCfg = buildRunnerWorkerConfig(stackConfig);
                          const workerEnv: Record<string, string> = {};
                          for (const v of workerCfg.plainEnv) workerEnv[v.name] = v.value;
                          for (const s of workerCfg.secrets) {
                            workerEnv[s.environmentVariable] = materializeSecretValue(
                              s.environmentVariable,
                            );
                          }
                          const workerRes = validateServerRuntimeEnv(workerEnv, "worker");
                          if (!workerRes.ok) {
                            failures.push(
                              `3-layer gap (preflight->worker): ${workerRes.error.message}`,
                            );
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(total).toBe(423_360);
    expect(prodNormalAccepted).toBeGreaterThan(0);
  }, 30_000);

  test("preflight exhaustively verifies GCP repo vars, boolean normalization, and opt-out rejection", () => {
    const validNormal = {
      ...BASE_GCP_ENV,
      KVITBIT_STAGE: "prod",
      BOOTSTRAP_FOUNDATION: "false",
      BOOTSTRAP_FEEDBACK_SECRET: "false",
      APP_ORIGIN: "https://kvitbit.cz",
      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      KVITBIT_EDGE_DOMAINS: "kvitbit.cz",
      KVITBIT_ENABLE_RESEND_SECRET: "true",
    };
    expect(validateDeployPreflight(validNormal).ok).toBe(true);

    // Every required GCP var missing must fail.
    for (const varName of REQUIRED_GCP_VARS) {
      expect(validateDeployPreflight({ ...validNormal, [varName]: "" }).ok, varName).toBe(false);
    }
    expect(validateDeployPreflight({ ...validNormal, GCP_PROJECT_NUMBER: "abc" }).ok).toBe(false);
    expect(validateDeployPreflight({ ...validNormal, GCP_ZONE: "us-central1-a" }).ok).toBe(false);
    expect(
      validateDeployPreflight({
        ...validNormal,
        GCP_DEPLOYER_SERVICE_ACCOUNT: "deployer@other-proj.iam.gserviceaccount.com",
      }).ok,
    ).toBe(false);

    // Boolean normalization for all 4 flags across all 12 test tokens = 48 checks.
    const boolTokens: ReadonlyArray<readonly [string, boolean | "invalid"]> = [
      ["", false],
      ["false", false],
      ["0", false],
      ["no", false],
      ["off", false],
      [" OFF ", false],
      ["true", true],
      ["1", true],
      ["yes", true],
      ["on", true],
      [" YeS ", true],
      ["maybe", "invalid"],
    ];
    let boolChecks = 0;
    for (const flag of SECRET_FLAG_ENV_VARS) {
      for (const [raw, expected] of boolTokens) {
        boolChecks++;
        const res = validateDeployPreflight({
          ...validNormal,
          BOOTSTRAP_FOUNDATION: "true",
          [flag]: raw,
        });
        if (expected === "invalid") {
          expect(res.ok, `${flag}=${raw}`).toBe(false);
        } else {
          expect(res.ok, `${flag}=${raw}`).toBe(true);
          if (res.ok) {
            expect(res.normalizedBooleans[flag]).toBe(expected);
          }
        }
      }
    }
    expect(boolChecks).toBe(48);

    // Every forbidden opt-out flag fails in prod preflight — both directly and via KVITBIT_REPO_VARS_JSON.
    for (const optOut of [
      ...FORBIDDEN_OPT_OUT_ENV_VARS,
      "KVITBIT_PREVIEW_DISABLE_CUSTOM",
      "KVITBIT_DISABLE_HTTP_2",
    ]) {
      expect(validateDeployPreflight({ ...validNormal, [optOut]: "true" }).ok, optOut).toBe(false);
      expect(
        validateDeployPreflight({
          ...validNormal,
          KVITBIT_REPO_VARS_JSON: JSON.stringify({ [optOut]: "true" }),
        }).ok,
        `repo_vars ${optOut}`,
      ).toBe(false);
    }
    expect(validateDeployPreflight({ ...validNormal, KVITBIT_REPO_VARS_JSON: "not-json" }).ok).toBe(
      false,
    );
    expect(validateDeployPreflight({ ...validNormal, KVITBIT_REPO_VARS_JSON: "[]" }).ok).toBe(
      false,
    );
  });
});
