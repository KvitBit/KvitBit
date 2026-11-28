import * as Fn from "effect/Function";
import * as EffectRecord from "effect/Record";
import { NoQueriesSqlLive } from "./no-queries-sql";
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
import { BotProtection } from "@kvitbit/adapters/altcha";
import { EmailSender } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  composeStackEnvLayers,
  defaultSecretBindings,
  KVITBIT_PROD_DEFAULTS,
  type KvitbitEdgeConfig,
  type KvitbitStackConfig,
  loadStackConfig,
  makeStackEnvLayer,
  validateStackConfigSync,
} from "../../../../infra/alchemy/src/config";
import {
  BOT_PROTECTION_MODES as DEPLOY_BOT_PROTECTION_MODES,
  DEPLOY_MODES,
  PROD_BOT_PROTECTION_MODES as DEPLOY_PROD_BOT_PROTECTION_MODES,
  DEPLOY_STAGES,
  type BotProtectionMode as DeployBotProtectionMode,
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
import { BotProtectionLive } from "../../src/app";
import {
  BLOB_DRIVERS,
  BOT_PROTECTION_MODES,
  composeRuntimeEnvLayers,
  EMAIL_MODES,
  FORBIDDEN_OPT_OUT_ENV_VARS,
  KVITBIT_ENVS,
  type KvitbitEnv,
  loadBootRuntimeConfig,
  loadBotProtectionConfig,
  makeRuntimeEnvLayer,
  PROD_BOT_PROTECTION_MODES,
  PROD_EMAIL_MODES,
  RESOLVED_BOT_PROTECTION_MODES,
  RESOLVED_EMAIL_MODES,
  resolveBotProtectionConfig,
  resolveKvitbitEnv,
  SERVER_WORKLOADS,
  validateServerRuntimeEnv,
} from "../../src/config-contract";
import { HttpConfig, HttpConfigLive } from "../../src/http/config";
import { MobileConfig, MobileConfigLive } from "../../src/http/mobile/config";
import { makeBlobStorageLayer } from "../../src/wiring/blob";
import { makeEmailSenderLayer } from "../../src/wiring/email";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

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
  invalid_overlong_label: `a@${Str.repeat(64)("b")}.org`,
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
    effectiveMode = !(hasResend || hasSmtp) ? "console" : "capture";
  }

  if (effectiveMode === "capture" || effectiveMode === "console") {
    return isInvalidFromCase(from) ? { ok: false } : { ok: true, expectedMode: effectiveMode };
  }

  if ((effectiveMode === "resend" || effectiveMode === "resend+smtp") && !hasResend) {
    return { ok: false };
  }
  if ((effectiveMode === "smtp" || effectiveMode === "resend+smtp") && !(hasSmtp && smtpValid)) {
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

type BotModeCase = "absent" | "altcha" | "none" | "disabled" | "bogus";
type AltchaKeyCase = "absent" | "whitespace" | "present";

const ALTCHA_KEY_VALUES: Readonly<Record<AltchaKeyCase, string | undefined>> = {
  absent: undefined,
  whitespace: "   ",
  present: "synthetic-altcha-hmac-key",
};

const oracleBotProtection = (
  env: KvitbitEnv,
  workload: "server" | "worker",
  modeCase: BotModeCase,
  keyCase: AltchaKeyCase,
): { readonly ok: boolean; readonly expectedMode?: "altcha" | "none" } => {
  if (modeCase === "bogus" || modeCase === "disabled") return { ok: false };
  if (env === "production" && modeCase === "none") return { ok: false };
  if (workload === "worker") return { ok: true };

  const hasKey = keyCase === "present";
  if (env === "production") {
    return hasKey ? { ok: true, expectedMode: "altcha" } : { ok: false };
  }
  if (env === "staging" || env === "preview") {
    if (modeCase === "none") return { ok: true, expectedMode: "none" };
    return hasKey ? { ok: true, expectedMode: "altcha" } : { ok: false };
  }
  // development / test
  if (modeCase === "none") return { ok: true, expectedMode: "none" };
  if (modeCase === "altcha") return hasKey ? { ok: true, expectedMode: "altcha" } : { ok: false };
  return hasKey ? { ok: true, expectedMode: "altcha" } : { ok: true, expectedMode: "none" };
};

const SAMPLE_DIGEST = `sha256:${Str.repeat(64)("a")}`;
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
    case "ALTCHA_HMAC_KEY":
      return "synthetic-altcha-hmac-key-32-chars";
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
    expect(BOT_PROTECTION_MODES).toEqual(["altcha", "none", "disabled"]);
    expect(PROD_BOT_PROTECTION_MODES).toEqual(["altcha"]);
    expect(RESOLVED_BOT_PROTECTION_MODES).toEqual(["altcha", "none"]);
    expect(DEPLOY_BOT_PROTECTION_MODES).toEqual(["altcha", "none", "disabled"]);
    expect(DEPLOY_PROD_BOT_PROTECTION_MODES).toEqual(["altcha"]);
    expect(SERVER_WORKLOADS).toEqual(["server", "worker"]);
    expect(DEPLOY_STAGES).toEqual(["prod", "staging"]);
    expect(DEPLOY_MODES).toEqual([
      "normal",
      "bootstrap_foundation",
      "bootstrap_feedback_secret",
      "bootstrap_altcha_secret",
      "bootstrap_resend_secret",
      "bootstrap_turbo_cache_secret",
    ]);
    expect(SECRET_FLAG_ENV_VARS.length).toBe(6);
    expect(REQUIRED_GCP_VARS.length).toBe(7);
    expect(FORBIDDEN_OPT_OUT_ENV_VARS.length).toBe(9);
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
            ? Schema.is(Schema.Literals(SPEC_ENVS))(kvitbitEnv)
              ? kvitbitEnv
              : undefined
            : nodeEnv !== undefined
              ? Schema.is(Schema.Literals(SPEC_ENVS))(nodeEnv)
                ? nodeEnv
                : undefined
              : "development";

        expect(actual.ok, `KVITBIT_ENV=${kvitbitEnv} NODE_ENV=${nodeEnv}`).toBe(
          expected !== undefined,
        );
        expect(actual.ok ? actual.value : undefined).toBe(expected);
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
                    const envMap = {
                      KVITBIT_ENV: envSpec.kvitbitEnv,
                      NODE_ENV: envSpec.nodeEnv,
                      DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
                      BETTER_AUTH_SECRET: "test-auth-secret",
                      ALTCHA_HMAC_KEY: "synthetic-altcha-hmac-key",
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
                    } satisfies Record<string, string | undefined>;

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
                        (actual.value.env !== envSpec.resolved ||
                          actual.value.email.mode !== expEmail.expectedMode ||
                          actual.value.blob.driver !== expBlob.expectedDriver) &&
                        failures.length < 10
                      ) {
                        failures.push(
                          `resolved mismatch for ${workload} ${envSpec.label}: got (${actual.value.env}, ${actual.value.email.mode}, ${actual.value.blob.driver})`,
                        );
                      }

                      // Invariant (a) & (b): production never accepts broken config or non-prod modes.
                      if (envSpec.resolved === "production") {
                        prodAccepted++;
                        if (
                          !SPEC_PROD_EMAIL_MODES.has(actual.value.email.mode) ||
                          actual.value.blob.driver !== "gcs" ||
                          actual.value.blob.gcsBucket === undefined ||
                          !Str.startsWith("https://")(actual.value.appOrigin) ||
                          (workload === "server" &&
                            actual.value.botProtection?.mode !== "altcha") ||
                          (workload === "worker" && actual.value.botProtection !== undefined)
                        ) {
                          failures.push(`prod invariant violated: ${encodeJson(actual.value)}`);
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

  test("bot protection (resolveBotProtectionConfig, validateServerRuntimeEnv, BotProtectionLive, HttpConfigLive) matches oracle across all 990 states", async () => {
    const botModes: ReadonlyArray<BotModeCase> = ["absent", "altcha", "none", "disabled", "bogus"];
    const keyCases: ReadonlyArray<AltchaKeyCase> = ["absent", "whitespace", "present"];

    // 1. Direct resolveBotProtectionConfig: 5 envs x 5 modes x 3 key states = 75 states.
    let directChecked = 0;
    for (const env of KVITBIT_ENVS) {
      for (const mode of botModes) {
        for (const keyCase of keyCases) {
          directChecked++;
          const actual = resolveBotProtectionConfig(env, {
            mode: mode === "absent" ? undefined : mode,
            hmacKey: ALTCHA_KEY_VALUES[keyCase],
          });
          const expected = oracleBotProtection(env, "server", mode, keyCase);
          expect(actual.ok, `resolveBotProtectionConfig ${env} ${mode} ${keyCase}`).toBe(
            expected.ok,
          );
          expect(actual.ok ? actual.value.mode : undefined).toBe(expected.expectedMode);
        }
      }
    }
    expect(directChecked).toBe(75);

    // 2. Full validateServerRuntimeEnv bot-protection product:
    // 2 workloads x 7 env inputs x 5 bot modes x 3 key states x 2 email configs x 2 blob configs = 840 states.
    const envInputs: ReadonlyArray<{
      readonly label: string;
      readonly kvitbitEnv?: string;
      readonly nodeEnv?: string;
      readonly resolved: KvitbitEnv;
    }> = [
      { label: "KVITBIT_ENV=production", kvitbitEnv: "production", resolved: "production" },
      { label: "NODE_ENV=production", nodeEnv: "production", resolved: "production" },
      { label: "KVITBIT_ENV=staging", kvitbitEnv: "staging", resolved: "staging" },
      { label: "KVITBIT_ENV=preview", kvitbitEnv: "preview", resolved: "preview" },
      { label: "KVITBIT_ENV=development", kvitbitEnv: "development", resolved: "development" },
      { label: "unset (development)", resolved: "development" },
      { label: "KVITBIT_ENV=test", kvitbitEnv: "test", nodeEnv: "test", resolved: "test" },
    ];
    let runtimeChecked = 0;
    for (const workload of SERVER_WORKLOADS) {
      for (const envSpec of envInputs) {
        for (const mode of botModes) {
          for (const keyCase of keyCases) {
            for (const emailProfile of ["prod_resend", "explicit_capture"] as const) {
              for (const blobProfile of ["gcs", "local"] as const) {
                runtimeChecked++;
                const envMap = {
                  KVITBIT_ENV: envSpec.kvitbitEnv,
                  NODE_ENV: envSpec.nodeEnv,
                  DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
                  BETTER_AUTH_SECRET: "test-auth-secret",
                  APP_ORIGIN: "https://kvitbit.cz",
                  EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
                  RESEND_API_KEY: emailProfile === "prod_resend" ? "re_synthetic_key" : undefined,
                  KVITBIT_EMAIL_MODE: emailProfile === "explicit_capture" ? "capture" : undefined,
                  KVITBIT_BLOB_DRIVER: blobProfile,
                  KVITBIT_BLOB_BUCKET: blobProfile === "gcs" ? "kvitbit-blobs" : undefined,
                  KVITBIT_BOT_PROTECTION_MODE: mode === "absent" ? undefined : mode,
                  ALTCHA_HMAC_KEY: ALTCHA_KEY_VALUES[keyCase],
                } satisfies Record<string, string | undefined>;
                const actual = validateServerRuntimeEnv(envMap, workload);
                const expEmailOk =
                  emailProfile === "prod_resend" || envSpec.resolved !== "production";
                const expBlobOk = blobProfile === "gcs" || envSpec.resolved !== "production";
                const expBot = oracleBotProtection(envSpec.resolved, workload, mode, keyCase);
                const expOk = expEmailOk && expBlobOk && expBot.ok;
                expect(
                  actual.ok,
                  `bot runtime ${workload} ${envSpec.label} mode=${mode} key=${keyCase} email=${emailProfile} blob=${blobProfile}`,
                ).toBe(expOk);
                const actualBot = actual.ok ? actual.value.botProtection : undefined;
                const expectedMode =
                  expOk && workload === "server" ? expBot.expectedMode : undefined;
                expect(actualBot?.mode).toBe(expectedMode);
                const productionServer =
                  expOk && workload === "server" && envSpec.resolved === "production";
                expect(productionServer ? actualBot?.mode : undefined).toBe(
                  productionServer ? "altcha" : undefined,
                );
                expect(productionServer ? actualBot?.hmacKey : undefined).toBe(
                  productionServer ? "synthetic-altcha-hmac-key" : undefined,
                );
              }
            }
          }
        }
      }
    }
    expect(runtimeChecked).toBe(840);

    // 3. Live Effect layer parity (HttpConfigLive + loadBotProtectionConfig + BotProtectionLive):
    // 5 envs x 5 modes x 3 key states = 75 live checks.
    let liveChecked = 0;
    for (const env of KVITBIT_ENVS) {
      for (const mode of botModes) {
        for (const keyCase of keyCases) {
          liveChecked++;
          const rawEnv = {
            KVITBIT_ENV: env,
            DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
            BETTER_AUTH_SECRET: "test-auth-secret",
            APP_ORIGIN: "https://kvitbit.cz",
            KVITBIT_BOT_PROTECTION_MODE: mode === "absent" ? undefined : mode,
            ALTCHA_HMAC_KEY: ALTCHA_KEY_VALUES[keyCase],
          } satisfies Record<string, string | undefined>;
          const envLayer = makeRuntimeEnvLayer(rawEnv);
          const expected = oracleBotProtection(env, "server", mode, keyCase);

          const httpRes = await Effect.runPromise(
            Effect.map(HttpConfig, (cfg) => cfg.botProtection).pipe(
              Effect.provide(HttpConfigLive.pipe(Layer.provideMerge(envLayer))),
              Effect.result,
            ),
          );
          const cfgRes = await Effect.runPromise(
            loadBotProtectionConfig.pipe(Effect.provide(envLayer), Effect.result),
          );
          expect(httpRes._tag === "Success", `HttpConfigLive ${env} ${mode} ${keyCase}`).toBe(
            expected.ok,
          );
          expect(
            cfgRes._tag === "Success",
            `loadBotProtectionConfig ${env} ${mode} ${keyCase}`,
          ).toBe(expected.ok);
          expect(httpRes._tag === "Success" ? httpRes.success : undefined).toBe(
            expected.expectedMode,
          );
          expect(cfgRes._tag === "Success" ? cfgRes.success.mode : undefined).toBe(
            expected.expectedMode,
          );
          const testChallenge = !expected.ok || expected.expectedMode === "none";
          const challenge = testChallenge
            ? await Effect.runPromise(
                BotProtection.pipe(
                  Effect.flatMap((bp) => bp.issue("sign_up")),
                  Effect.provide(
                    BotProtectionLive.pipe(
                      Layer.provide(NoQueriesSqlLive),
                      Layer.provideMerge(envLayer),
                    ),
                  ),
                  Effect.result,
                ),
              )
            : undefined;
          expect(challenge?._tag, `BotProtectionLive ${env} ${mode} ${keyCase}`).toBe(
            !testChallenge ? undefined : expected.ok ? "Success" : "Failure",
          );
          expect(
            challenge?._tag === "Success" ? challenge.success.parameters.algorithm : undefined,
          ).toBe(expected.expectedMode === "none" ? "NONE" : undefined);
        }
      }
    }
    expect(liveChecked).toBe(75);
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
              ALTCHA_HMAC_KEY: "synthetic-altcha-hmac-key",
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
          const baseEnvMap = {
            KVITBIT_ENV: env,
            DATABASE_URL: "postgres://a/b",
            BETTER_AUTH_SECRET: "secret",
            ALTCHA_HMAC_KEY: "synthetic-altcha-hmac-key",
            APP_ORIGIN: "https://kvitbit.cz",
            EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
            RESEND_API_KEY: "re_key",
            KVITBIT_BLOB_DRIVER: "gcs",
            KVITBIT_BLOB_BUCKET: "kvitbit-blobs",
          } satisfies Record<string, string>;
          const envMap = { ...baseEnvMap, [key]: "true" } satisfies Record<string, string>;
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
    expect(optOutChecked).toBe(110);
    expect(liveOptOutChecked).toBe(110);
    expect(fallbackOptOutChecked).toBe(110);

    // Upgrade preservation: NODE_ENV=production with empty KVITBIT_ENV and configured Resend stays in production (never capture).
    const upgradedEnv = {
      NODE_ENV: "production",
      KVITBIT_ENV: "",
      DATABASE_URL: "postgres://a/b",
      BETTER_AUTH_SECRET: "secret",
      ALTCHA_HMAC_KEY: "synthetic-altcha-hmac-key",
      APP_ORIGIN: "https://kvitbit.cz",
      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      RESEND_API_KEY: "re_key",
      KVITBIT_BLOB_DRIVER: "gcs",
      KVITBIT_BLOB_BUCKET: "kvitbit-blobs",
    } satisfies Record<string, string>;
    const upgraded = await Effect.runPromise(
      loadBootRuntimeConfig("server").pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: upgradedEnv }))),
      ),
    );
    expect(upgraded.env).toBe("production");
    expect(upgraded.email.mode).toBe("resend");

    // Boundary checks: RFC 1035 63-octet label & public IPv4-mapped IPv6 accepted; 64-octet TLD & [::ffff:0.0.0.0] rejected.
    expect(
      validateServerRuntimeEnv(
        { ...upgradedEnv, EMAIL_FROM: `a@${Str.repeat(63)("b")}.org` },
        "server",
      ).ok,
    ).toBe(true);
    expect(
      validateServerRuntimeEnv(
        { ...upgradedEnv, APP_ORIGIN: "https://[::ffff:192.0.2.1]" },
        "server",
      ).ok,
    ).toBe(true);
    expect(
      validateServerRuntimeEnv(
        { ...upgradedEnv, EMAIL_FROM: `a@example.${Str.repeat(64)("c")}` },
        "server",
      ).ok,
    ).toBe(false);
    expect(
      validateServerRuntimeEnv({ ...upgradedEnv, APP_ORIGIN: "https://[::ffff:0.0.0.0]" }, "server")
        .ok,
    ).toBe(false);

    // Live-loader checks for composed primary+fallback key preservation, exact-key presence, and sparse Array gaps.
    for (const workload of SERVER_WORKLOADS) {
      // Permitted scalar/empty KVITBIT_DISABLE (no trailing underscore) succeeds alone.
      for (const [label, extra] of [
        ["scalar KVITBIT_DISABLE=metadata alone", { KVITBIT_DISABLE: "metadata" }],
        ["empty KVITBIT_DISABLE alone", { KVITBIT_DISABLE: "" }],
      ] as const) {
        expect(validateServerRuntimeEnv({ ...upgradedEnv, ...extra }, workload).ok).toBe(true);
        const permittedRes = await Effect.runPromise(
          loadBootRuntimeConfig(workload).pipe(
            Effect.provide(makeRuntimeEnvLayer({ ...upgradedEnv, ...extra })),
            Effect.result,
          ),
        );
        expect(permittedRes._tag, `${workload} ${label}`).toBe("Success");
      }

      const siblingMasked = await Effect.runPromise(
        loadBootRuntimeConfig(workload).pipe(
          Effect.provide(
            composeRuntimeEnvLayers(
              { ...upgradedEnv, KVITBIT_DISABLE_OTHER: "" },
              { KVITBIT_DISABLE_CUSTOM: "true" },
            ),
          ),
          Effect.result,
        ),
      );
      expect(siblingMasked._tag, `${workload} empty primary sibling + fallback`).toBe("Failure");
      if (siblingMasked._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(String(siblingMasked.failure)).toContain(
        "Invalid runtime config (KVITBIT_DISABLE_CUSTOM):",
      );

      const scalarMasked = await Effect.runPromise(
        loadBootRuntimeConfig(workload).pipe(
          Effect.provide(
            composeRuntimeEnvLayers(
              { ...upgradedEnv, KVITBIT_DISABLE: "metadata" },
              { KVITBIT_DISABLE_CUSTOM: "true" },
            ),
          ),
          Effect.result,
        ),
      );
      expect(scalarMasked._tag, `${workload} scalar primary KVITBIT_DISABLE + fallback`).toBe(
        "Failure",
      );
      if (scalarMasked._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(String(scalarMasked.failure)).toContain(
        "Invalid runtime config (KVITBIT_DISABLE_CUSTOM):",
      );

      // Exact-key KVITBIT_ALLOW_LOCAL_BLOBS presence is strictly rejected with and without longer neighbors,
      // while the longer neighbor alone succeeds.
      for (const [label, extraEnv, expectedTag] of [
        ["empty exact alone", { KVITBIT_ALLOW_LOCAL_BLOBS: "" }, "Failure"],
        [
          "empty exact + EXTRA",
          { KVITBIT_ALLOW_LOCAL_BLOBS: "", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
          "Failure",
        ],
        ["only EXTRA empty", { KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "" }, "Success"],
        [
          "non-empty exact + EXTRA",
          { KVITBIT_ALLOW_LOCAL_BLOBS: "true", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
          "Failure",
        ],
      ] as const) {
        const flatRes = validateServerRuntimeEnv({ ...upgradedEnv, ...extraEnv }, workload);
        expect(flatRes.ok, `flat ${workload} ${label}`).toBe(expectedTag === "Success");
        const liveRes = await Effect.runPromise(
          loadBootRuntimeConfig(workload).pipe(
            Effect.provide(makeRuntimeEnvLayer({ ...upgradedEnv, ...extraEnv })),
            Effect.result,
          ),
        );
        expect(liveRes._tag, `live ${workload} ${label}`).toBe(expectedTag);
        const exactMarker = "Invalid runtime config (KVITBIT_ALLOW_LOCAL_BLOBS):";
        expect(
          liveRes._tag === "Failure" && Str.includes(exactMarker)(String(liveRes.failure)),
        ).toBe(expectedTag === "Failure");
      }

      for (const [label, sparseExtra, expectedKey] of [
        [
          "sparse 1200/3000",
          { KVITBIT_DISABLE_HTTP_1200: "true", KVITBIT_DISABLE_HTTP_3000: "" },
          "KVITBIT_DISABLE_HTTP_1200",
        ],
        [
          "sparse 5000/10000",
          { KVITBIT_DISABLE_HTTP_5000: "true", KVITBIT_DISABLE_HTTP_10000: "" },
          "KVITBIT_DISABLE_HTTP_5000",
        ],
      ] as const) {
        const sparseRes = await Effect.runPromise(
          loadBootRuntimeConfig(workload).pipe(
            Effect.provide(makeRuntimeEnvLayer({ ...upgradedEnv, ...sparseExtra })),
            Effect.result,
          ),
        );
        expect(sparseRes._tag, `${workload} ${label}`).toBe("Failure");
        if (sparseRes._tag !== "Failure") throw new Error("Expected the asserted result");
        expect(String(sparseRes.failure)).toContain(`Invalid runtime config (${expectedKey}):`);
      }
    }
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
            const built = await Layer.build(layer).pipe(Effect.scoped, Effect.runPromiseExit);
            expect(
              built._tag === "Success",
              `makeEmailSenderLayer ${env} ${modeCase} ${secrets} ${fromCase}`,
            ).toBe(expected.ok);

            const localProvider =
              expected.ok &&
              (expected.expectedMode === "capture" || expected.expectedMode === "console")
                ? expected.expectedMode
                : undefined;
            const sent =
              localProvider === undefined
                ? undefined
                : await Effect.runPromise(
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
            expect(sent?._tag).toBe(localProvider === undefined ? undefined : "Success");
            expect(sent?._tag === "Success" ? sent.success.provider : undefined).toBe(
              localProvider,
            );
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
          const built = await Layer.build(layer).pipe(Effect.scoped, Effect.runPromiseExit);
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
                const rawEnv = EffectRecord.singleton<string, string>("KVITBIT_ENV", env);
                const originVal = ORIGIN_VALUES[origin];
                if (originVal !== undefined) rawEnv["APP_ORIGIN"] = originVal;
                if (hasMobileBucket) rawEnv["KVITBIT_MOBILE_STORAGE_BUCKET"] = "mobile-bucket";
                if (hasMobileDir) rawEnv["KVITBIT_MOBILE_STORAGE_DIR"] = "/var/lib/kvitbit/mobile";
                if (blobDriver !== "absent") rawEnv["KVITBIT_BLOB_DRIVER"] = blobDriver;
                if (hasBlobBucket) rawEnv["KVITBIT_BLOB_BUCKET"] = "blob-bucket";

                const res = await Effect.runPromise(
                  MobileConfig.pipe(
                    Effect.provide(
                      MobileConfigLive.pipe(
                        Layer.provideMerge(
                          ConfigProvider.layer(ConfigProvider.fromEnv({ env: rawEnv })),
                        ),
                      ),
                    ),
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
                } else if (hasMobileBucket) expectedTag = "gcs";
                else if (hasMobileDir) expectedTag = "local";
                else if (blobDriver === "gcs") expectedTag = hasBlobBucket ? "gcs" : undefined;
                else if (blobDriver === "local") expectedTag = "local";
                else if (hasBlobBucket) expectedTag = "gcs";
                else expectedTag = "local";

                const expOk = originOk && expectedTag !== undefined;
                expect(
                  res._tag === "Success",
                  `MobileConfigLive ${env} origin=${origin} mobileBucket=${hasMobileBucket} mobileDir=${hasMobileDir} blob=${blobDriver}/${hasBlobBucket}`,
                ).toBe(expOk);
                expect(res._tag === "Success" ? res.success.storage._tag : undefined).toBe(
                  expOk ? expectedTag : undefined,
                );
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
                            enableAltchaHmacKey: true,
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
                            if (!(secrets.enableResend || secrets.enableSmtp)) expOk = false;
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
                          for (const v of serverPlainEnv({
                            config,
                            buckets: {
                              blobsBucket: config.blobsBucket,
                              mobileAssetsBucket: config.mobileAssetsBucket,
                            },
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
                          } else if (
                            stage === "prod" &&
                            (serverCheck.value.env !== "production" ||
                              !SPEC_PROD_EMAIL_MODES.has(serverCheck.value.email.mode) ||
                              serverCheck.value.blob.driver !== "gcs" ||
                              serverCheck.value.botProtection?.mode !== "altcha")
                          ) {
                            failures.push(
                              `cross-layer prod server weakened: ${encodeJson(serverCheck.value)}`,
                            );
                          }

                          const runnerConfig = buildRunnerWorkerConfig({ config });
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
                          } else if (
                            stage === "prod" &&
                            (workerCheck.value.env !== "production" ||
                              !SPEC_PROD_EMAIL_MODES.has(workerCheck.value.email.mode) ||
                              workerCheck.value.blob.driver !== "gcs")
                          ) {
                            failures.push(
                              `cross-layer prod worker weakened: ${encodeJson(workerCheck.value)}`,
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
    expect(total).toBe(215_040);
    expect(prodNormalAccepted).toBeGreaterThan(0);
    expect(stagingNormalAccepted).toBeGreaterThan(0);
    expect(crossLayerVerified).toBe(prodNormalAccepted + stagingNormalAccepted);
  }, 30_000);

  test("validateStackConfigSync exhaustively verifies bot protection & all bootstrap modes across 3,712 states with cross-layer server+worker soundness", () => {
    const deployModeCases = [
      {
        label: "normal",
        bootstrapFoundation: false,
        bootstrapFeedbackSecret: false,
        bootstrapAltchaSecret: false,
      },
      {
        label: "bootstrap_foundation",
        bootstrapFoundation: true,
        bootstrapFeedbackSecret: false,
        bootstrapAltchaSecret: false,
      },
      {
        label: "bootstrap_feedback_secret",
        bootstrapFoundation: false,
        bootstrapFeedbackSecret: true,
        bootstrapAltchaSecret: false,
      },
      {
        label: "bootstrap_altcha_secret",
        bootstrapFoundation: false,
        bootstrapFeedbackSecret: false,
        bootstrapAltchaSecret: true,
      },
      {
        label: "conflict_foundation_feedback",
        bootstrapFoundation: true,
        bootstrapFeedbackSecret: true,
        bootstrapAltchaSecret: false,
      },
      {
        label: "conflict_foundation_altcha",
        bootstrapFoundation: true,
        bootstrapFeedbackSecret: false,
        bootstrapAltchaSecret: true,
      },
      {
        label: "conflict_feedback_altcha",
        bootstrapFoundation: false,
        bootstrapFeedbackSecret: true,
        bootstrapAltchaSecret: true,
      },
    ] as const;
    const botModes: ReadonlyArray<DeployBotProtectionMode | "absent"> = [
      "absent",
      "altcha",
      "none",
      "disabled",
    ];
    const emailModes: ReadonlyArray<DeployEmailMode | "absent"> = ["absent", "resend", "capture"];

    let total = 0;
    let normalVerified = 0;
    const failures: string[] = [];

    for (const stage of DEPLOY_STAGES) {
      for (const deployMode of deployModeCases) {
        for (const botMode of botModes) {
          for (const enableAltcha of [false, true] as const) {
            for (const enableFeedback of [false, true] as const) {
              for (const emailMode of emailModes) {
                for (const enableResend of [false, true] as const) {
                  for (const blobDriver of BLOB_DRIVERS) {
                    total++;
                    const config: KvitbitStackConfig = {
                      stage,
                      bootstrapFoundation: deployMode.bootstrapFoundation,
                      bootstrapFeedbackSecret: deployMode.bootstrapFeedbackSecret,
                      bootstrapAltchaSecret: deployMode.bootstrapAltchaSecret,
                      projectId: KVITBIT_PROD_DEFAULTS.projectId,
                      projectNumber: KVITBIT_PROD_DEFAULTS.projectNumber,
                      region: KVITBIT_PROD_DEFAULTS.region,
                      zone: KVITBIT_PROD_DEFAULTS.zone,
                      stateBucket: KVITBIT_PROD_DEFAULTS.stateBucket,
                      artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
                      imageName: KVITBIT_PROD_DEFAULTS.imageName,
                      imageDigest: deployMode.bootstrapFoundation ? "" : SAMPLE_DIGEST,
                      blobDriver,
                      blobsBucket: `kvitbit-${stage}-blobs`,
                      mobileAssetsBucket: `kvitbit-${stage}-mobile`,
                      runnerCount: 2,
                      runnerMachineType: KVITBIT_PROD_DEFAULTS.runnerMachineType,
                      runnerPort: KVITBIT_PROD_DEFAULTS.runnerPort,
                      runnerCidr: KVITBIT_PROD_DEFAULTS.runnerCidr,
                      serverMinInstances: 0,
                      serverMaxInstances: 10,
                      appOrigin: "https://kvitbit.cz",
                      emailMode: emailMode === "absent" ? undefined : emailMode,
                      emailFrom: "Kvitbit <noreply@kvitbit.cz>",
                      botProtectionMode: botMode === "absent" ? undefined : botMode,
                      trustedProxyHops: 2,
                      shareKeyVersion: 1,
                      androidAssetlinksSha256: undefined,
                      feedbackGitHubRepo: undefined,
                      feedbackOwnerEmails: undefined,
                      secrets: defaultSecretBindings(stage, {
                        enableResend,
                        enableFeedbackGitHubToken: enableFeedback,
                        enableAltchaHmacKey: enableAltcha,
                      }),
                      dnsZones: [],
                      edge: VALID_EDGE,
                    };

                    // Independent oracle
                    let expOk = true;
                    const activeBootstraps = Arr.filter(
                      [
                        deployMode.bootstrapFoundation,
                        deployMode.bootstrapFeedbackSecret,
                        deployMode.bootstrapAltchaSecret,
                      ],
                      Boolean,
                    ).length;
                    if (activeBootstraps > 1) {
                      expOk = false;
                    } else if (botMode === "disabled") {
                      expOk = false;
                    } else if (
                      stage === "prod" &&
                      (blobDriver !== "gcs" ||
                        emailMode === "capture" ||
                        (botMode !== "absent" && botMode !== "altcha"))
                    ) {
                      expOk = false;
                    } else if (deployMode.bootstrapFeedbackSecret) {
                      expOk = enableFeedback;
                    } else if (deployMode.bootstrapAltchaSecret) {
                      expOk = enableAltcha;
                    } else if (deployMode.bootstrapFoundation) {
                      expOk = true;
                    } else {
                      // Normal deploy
                      if (stage === "prod") {
                        if (!(enableResend && enableAltcha)) expOk = false;
                      } else {
                        if (botMode !== "none" && !enableAltcha) expOk = false;
                        if (emailMode !== "capture" && !enableResend) expOk = false;
                      }
                    }

                    const actual = validateStackConfigSync(config);
                    if (actual.ok !== expOk) {
                      if (failures.length < 10) {
                        failures.push(
                          `alchemy-bot ${stage} ${deployMode.label} bot=${botMode} altcha=${enableAltcha} fb=${enableFeedback} email=${emailMode} resend=${enableResend} blob=${blobDriver}: expected=${expOk}, got=${actual.ok}${actual.ok ? "" : ` (${actual.error.message})`}`,
                        );
                      }
                      continue;
                    }

                    if (actual.ok && activeBootstraps === 0) {
                      normalVerified++;
                      const serverEnvMap: Record<string, string> = {};
                      for (const v of serverPlainEnv({
                        config,
                        buckets: {
                          blobsBucket: config.blobsBucket,
                          mobileAssetsBucket: config.mobileAssetsBucket,
                        },
                      })) {
                        serverEnvMap[v.name] = v.value;
                      }
                      for (const s of serverSecretEnv(config)) {
                        serverEnvMap[s.name] = materializeSecretValue(s.name);
                      }
                      const serverCheck = validateServerRuntimeEnv(serverEnvMap, "server");
                      if (!serverCheck.ok) {
                        failures.push(
                          `alchemy-bot->server gap (${stage} bot=${botMode} altcha=${enableAltcha}): ${serverCheck.error.message}`,
                        );
                      } else if (
                        stage === "prod" &&
                        serverCheck.value.botProtection?.mode !== "altcha"
                      ) {
                        failures.push("prod server botProtection not altcha");
                      }

                      const runnerCfg = buildRunnerWorkerConfig({ config });
                      if (
                        Arr.some(
                          runnerCfg.secrets,
                          (s) => s.environmentVariable === "ALTCHA_HMAC_KEY",
                        )
                      ) {
                        failures.push("ALTCHA_HMAC_KEY must not be injected into runner workload");
                      }
                      const runnerEnvMap: Record<string, string> = {};
                      for (const v of runnerCfg.plainEnv) runnerEnvMap[v.name] = v.value;
                      for (const s of runnerCfg.secrets) {
                        runnerEnvMap[s.environmentVariable] = materializeSecretValue(
                          s.environmentVariable,
                        );
                      }
                      const workerCheck = validateServerRuntimeEnv(runnerEnvMap, "worker");
                      if (!workerCheck.ok) {
                        failures.push(
                          `alchemy-bot->worker gap (${stage} bot=${botMode} altcha=${enableAltcha}): ${workerCheck.error.message}`,
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

    expect(failures).toEqual([]);
    expect(total).toBe(2_688);
    expect(normalVerified).toBeGreaterThan(0);

    // Exhaustive 2^5 bootstrap-flag combinations x 2 stages x 2^4 targeted secret flags = 1,024 states.
    let bootstrapMatrixChecked = 0;
    const bootstrapFailures: string[] = [];
    for (const stage of DEPLOY_STAGES) {
      for (let mask = 0; mask < 32; mask++) {
        const bootstrapFoundation = (mask & 1) !== 0;
        const bootstrapFeedbackSecret = (mask & 2) !== 0;
        const bootstrapAltchaSecret = (mask & 4) !== 0;
        const bootstrapResendSecret = (mask & 8) !== 0;
        const bootstrapTurboCacheSecret = (mask & 16) !== 0;
        const activeCount =
          Number(bootstrapFoundation) +
          Number(bootstrapFeedbackSecret) +
          Number(bootstrapAltchaSecret) +
          Number(bootstrapResendSecret) +
          Number(bootstrapTurboCacheSecret);

        for (let secretMask = 0; secretMask < 16; secretMask++) {
          const enableFeedback = (secretMask & 1) !== 0;
          const enableAltcha = (secretMask & 2) !== 0;
          const enableResend = (secretMask & 4) !== 0;
          const enableTurboCache = (secretMask & 8) !== 0;
          bootstrapMatrixChecked++;

          const config: KvitbitStackConfig = {
            stage,
            bootstrapFoundation,
            bootstrapFeedbackSecret,
            bootstrapAltchaSecret,
            bootstrapResendSecret,
            bootstrapTurboCacheSecret,
            projectId: KVITBIT_PROD_DEFAULTS.projectId,
            projectNumber: KVITBIT_PROD_DEFAULTS.projectNumber,
            region: KVITBIT_PROD_DEFAULTS.region,
            zone: KVITBIT_PROD_DEFAULTS.zone,
            stateBucket: KVITBIT_PROD_DEFAULTS.stateBucket,
            artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
            imageName: KVITBIT_PROD_DEFAULTS.imageName,
            imageDigest: bootstrapFoundation ? "" : SAMPLE_DIGEST,
            blobDriver: "gcs",
            blobsBucket: `kvitbit-${stage}-blobs`,
            mobileAssetsBucket: `kvitbit-${stage}-mobile`,
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
            secrets: defaultSecretBindings(stage, {
              enableResend,
              enableFeedbackGitHubToken: enableFeedback,
              enableAltchaHmacKey: enableAltcha,
              enableTurboCache,
            }),
            dnsZones: [],
            edge: VALID_EDGE,
          };

          let expOk: boolean;
          if (activeCount > 1) expOk = false;
          else if (bootstrapFeedbackSecret) expOk = enableFeedback;
          else if (bootstrapAltchaSecret) expOk = enableAltcha;
          else if (bootstrapResendSecret) expOk = enableResend;
          else if (bootstrapTurboCacheSecret) expOk = enableTurboCache;
          else if (bootstrapFoundation) expOk = true;
          else expOk = enableResend && enableAltcha;

          const actual = validateStackConfigSync(config);
          if (actual.ok !== expOk && bootstrapFailures.length < 10) {
            bootstrapFailures.push(
              `alchemy-bootstrap ${stage} mask=${mask} secretMask=${secretMask}: expected=${expOk}, got=${actual.ok}${actual.ok ? "" : ` (${actual.error.message})`}`,
            );
          }
        }
      }
    }
    expect(bootstrapFailures).toEqual([]);
    expect(bootstrapMatrixChecked).toBe(1_024);
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

    const full = defaultSecretBindings("prod", { enableResend: true, enableAltchaHmacKey: true });
    expect(validateStackConfigSync(baseProd(full)).ok).toBe(true);

    // Dropping DATABASE_URL, BETTER_AUTH_SECRET, ALTCHA_HMAC_KEY, or runner-side RESEND_API_KEY must fail.
    expect(
      validateStackConfigSync(
        baseProd(Arr.filter(full, (s) => s.environmentVariable !== "DATABASE_URL")),
      ).ok,
    ).toBe(false);
    expect(
      validateStackConfigSync(
        baseProd(Arr.filter(full, (s) => s.environmentVariable !== "BETTER_AUTH_SECRET")),
      ).ok,
    ).toBe(false);
    expect(
      validateStackConfigSync(
        baseProd(Arr.filter(full, (s) => s.environmentVariable !== "ALTCHA_HMAC_KEY")),
      ).ok,
    ).toBe(false);
    expect(
      validateStackConfigSync(
        baseProd(
          Arr.map(full, (s) =>
            s.environmentVariable === "ALTCHA_HMAC_KEY" ? { ...s, consumers: ["runner"] } : s,
          ),
        ),
      ).ok,
    ).toBe(false);
    expect(
      validateStackConfigSync(
        baseProd(
          Arr.map(full, (s) =>
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
      KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "true",
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

    // Permitted scalar/empty KVITBIT_DISABLE (no trailing underscore) succeeds alone in loadStackConfig.
    for (const [label, extra] of [
      ["scalar KVITBIT_DISABLE=metadata alone", { KVITBIT_DISABLE: "metadata" }],
      ["empty KVITBIT_DISABLE alone", { KVITBIT_DISABLE: "" }],
    ] as const) {
      const permittedRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(makeStackEnvLayer({ ...baseStackEnv, ...extra })),
          Effect.result,
        ),
      );
      expect(permittedRes._tag, `loadStackConfig ${label}`).toBe("Success");
    }

    // Composed primary+fallback key preservation, exact-key presence, and sparse Array gaps in live loadStackConfig.
    const stackSiblingMasked = await Effect.runPromise(
      loadStackConfig.pipe(
        Effect.provide(
          composeStackEnvLayers(
            { ...baseStackEnv, KVITBIT_DISABLE_OTHER: "" },
            { KVITBIT_DISABLE_CUSTOM: "true" },
          ),
        ),
        Effect.result,
      ),
    );
    expect(stackSiblingMasked._tag, "loadStackConfig empty primary sibling + fallback").toBe(
      "Failure",
    );
    if (stackSiblingMasked._tag !== "Failure") throw new Error("Expected the asserted result");
    expect(stackSiblingMasked.failure).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_DISABLE_CUSTOM",
    });

    const stackScalarMasked = await Effect.runPromise(
      loadStackConfig.pipe(
        Effect.provide(
          composeStackEnvLayers(
            { ...baseStackEnv, KVITBIT_DISABLE: "metadata" },
            { KVITBIT_DISABLE_CUSTOM: "true" },
          ),
        ),
        Effect.result,
      ),
    );
    expect(
      stackScalarMasked._tag,
      "loadStackConfig scalar primary KVITBIT_DISABLE + fallback",
    ).toBe("Failure");
    if (stackScalarMasked._tag !== "Failure") throw new Error("Expected the asserted result");
    expect(stackScalarMasked.failure).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_DISABLE_CUSTOM",
    });

    for (const [label, extraEnv, expectedTag] of [
      ["empty exact alone", { KVITBIT_ALLOW_LOCAL_BLOBS: "" }, "Failure"],
      [
        "empty exact + EXTRA",
        { KVITBIT_ALLOW_LOCAL_BLOBS: "", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
        "Failure",
      ],
      ["only EXTRA empty", { KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "" }, "Success"],
      [
        "non-empty exact + EXTRA",
        { KVITBIT_ALLOW_LOCAL_BLOBS: "true", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
        "Failure",
      ],
    ] as const) {
      const exactRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(makeStackEnvLayer({ ...baseStackEnv, ...extraEnv })),
          Effect.result,
        ),
      );
      expect(exactRes._tag, `loadStackConfig ${label}`).toBe(expectedTag);
      const error = exactRes._tag === "Failure" ? exactRes.failure : null;
      expect(
        error === null
          ? null
          : { _tag: error._tag, field: "field" in error ? error.field : undefined },
      ).toEqual(
        expectedTag === "Failure"
          ? { _tag: "InvalidStackConfig", field: "KVITBIT_ALLOW_LOCAL_BLOBS" }
          : null,
      );
    }

    for (const [label, sparseExtra, expectedField] of [
      [
        "sparse 1200/3000",
        { KVITBIT_DISABLE_HTTP_1200: "true", KVITBIT_DISABLE_HTTP_3000: "" },
        "KVITBIT_DISABLE_HTTP_1200",
      ],
      [
        "sparse 5000/10000",
        { KVITBIT_DISABLE_HTTP_5000: "true", KVITBIT_DISABLE_HTTP_10000: "" },
        "KVITBIT_DISABLE_HTTP_5000",
      ],
    ] as const) {
      const sparseRes = await Effect.runPromise(
        loadStackConfig.pipe(
          Effect.provide(makeStackEnvLayer({ ...baseStackEnv, ...sparseExtra })),
          Effect.result,
        ),
      );
      expect(sparseRes._tag, `loadStackConfig ${label}`).toBe("Failure");
      if (sparseRes._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(sparseRes.failure).toMatchObject({
        _tag: "InvalidStackConfig",
        field: expectedField,
      });
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
                        const env = {
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
                          KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "true",
                          APP_ORIGIN: ORIGIN_VALUES[origin],
                          EMAIL_FROM: EMAIL_FROM_VALUES[from],
                          KVITBIT_EDGE_DOMAINS: edge.raw,
                          KVITBIT_EMAIL_MODE: emailMode === "absent" ? undefined : emailMode,
                          KVITBIT_BLOB_DRIVER: blobDriver === "absent" ? undefined : blobDriver,
                          KVITBIT_ENV: kvitbitEnv === "absent" ? undefined : kvitbitEnv,
                        } satisfies Record<string, string | undefined>;

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
                          if (!(hasR || hasS)) expOk = false;
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
                            emailFrom: env["EMAIL_FROM"],
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
                              enableAltchaHmacKey:
                                actual.normalizedBooleans.KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET,
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
                          for (const v of serverPlainEnv({
                            config: stackConfig,
                            buckets: {
                              blobsBucket: stackConfig.blobsBucket,
                              mobileAssetsBucket: stackConfig.mobileAssetsBucket,
                            },
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

                          const workerCfg = buildRunnerWorkerConfig({ config: stackConfig });
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

  test("validateDeployPreflight exhaustively verifies bot protection & all bootstrap modes across 4,384 states with 3-layer soundness", () => {
    const deployModes = [
      { label: "normal", foundation: "false", feedback: "false", altcha: "false" },
      { label: "bootstrap_foundation", foundation: "true", feedback: "false", altcha: "false" },
      {
        label: "bootstrap_feedback_secret",
        foundation: "false",
        feedback: "true",
        altcha: "false",
      },
      { label: "bootstrap_altcha_secret", foundation: "false", feedback: "false", altcha: "true" },
      {
        label: "conflict_foundation_feedback",
        foundation: "true",
        feedback: "true",
        altcha: "false",
      },
      {
        label: "conflict_foundation_altcha",
        foundation: "true",
        feedback: "false",
        altcha: "true",
      },
      {
        label: "conflict_feedback_altcha",
        foundation: "false",
        feedback: "true",
        altcha: "true",
      },
    ] as const;
    const botModes: ReadonlyArray<BotModeCase> = ["absent", "altcha", "none", "disabled", "bogus"];
    const emailModes: ReadonlyArray<DeployEmailMode | "absent"> = ["absent", "resend", "capture"];
    const origins: ReadonlyArray<OriginCase> = ["https_public", "http_public"];

    let total = 0;
    let normalAccepted = 0;
    const failures: string[] = [];

    for (const stage of DEPLOY_STAGES) {
      for (const mode of deployModes) {
        for (const botMode of botModes) {
          for (const altchaEnabled of [false, true] as const) {
            for (const feedbackEnabled of [false, true] as const) {
              for (const emailMode of emailModes) {
                for (const resendEnabled of [false, true] as const) {
                  for (const origin of origins) {
                    total++;
                    const env = {
                      ...BASE_GCP_ENV,
                      KVITBIT_STAGE: stage,
                      BOOTSTRAP_FOUNDATION: mode.foundation,
                      BOOTSTRAP_FEEDBACK_SECRET: mode.feedback,
                      BOOTSTRAP_ALTCHA_SECRET: mode.altcha,
                      KVITBIT_ENABLE_RESEND_SECRET: resendEnabled ? "true" : "false",
                      KVITBIT_ENABLE_SMTP_SECRET: "false",
                      KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "false",
                      KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: feedbackEnabled
                        ? "true"
                        : "false",
                      KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: altchaEnabled ? "true" : "false",
                      APP_ORIGIN: ORIGIN_VALUES[origin],
                      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
                      KVITBIT_EDGE_DOMAINS: "kvitbit.cz, kvitbit.app",
                      KVITBIT_EMAIL_MODE: emailMode === "absent" ? undefined : emailMode,
                      KVITBIT_BOT_PROTECTION_MODE: botMode === "absent" ? undefined : botMode,
                    } satisfies Record<string, string | undefined>;

                    const activeBootstraps = Arr.filter(
                      [
                        mode.foundation === "true",
                        mode.feedback === "true",
                        mode.altcha === "true",
                      ],
                      Boolean,
                    ).length;

                    let expOk = true;
                    if (stage !== "prod") expOk = false;
                    else if (activeBootstraps > 1) expOk = false;
                    else if (emailMode === "capture") expOk = false;
                    else if (botMode !== "absent" && botMode !== "altcha") expOk = false;
                    else if (mode.label === "bootstrap_feedback_secret") expOk = feedbackEnabled;
                    else if (mode.label === "bootstrap_altcha_secret") expOk = altchaEnabled;
                    else if (mode.label === "bootstrap_foundation") expOk = true;
                    else {
                      if (origin !== "https_public") expOk = false;
                      if (!(resendEnabled && altchaEnabled)) expOk = false;
                    }

                    const actual = validateDeployPreflight(env);
                    if (actual.ok !== expOk) {
                      if (failures.length < 10) {
                        failures.push(
                          `preflight-bot ${stage} ${mode.label} bot=${botMode} altcha=${altchaEnabled} fb=${feedbackEnabled} email=${emailMode} resend=${resendEnabled} origin=${origin}: expected=${expOk}, got=${actual.ok}${actual.ok ? "" : ` (${actual.message})`}`,
                        );
                      }
                      continue;
                    }

                    if (actual.ok && actual.deployMode === "normal") {
                      normalAccepted++;
                      const stackConfig: KvitbitStackConfig = {
                        stage: "prod",
                        bootstrapFoundation: false,
                        bootstrapFeedbackSecret: false,
                        bootstrapAltchaSecret: false,
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
                        emailFrom: env["EMAIL_FROM"],
                        botProtectionMode: Schema.is(Schema.Literals(["altcha", "none"]))(botMode)
                          ? botMode
                          : undefined,
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
                            actual.normalizedBooleans.KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET,
                          enableAltchaHmacKey:
                            actual.normalizedBooleans.KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET,
                        }),
                        dnsZones: [],
                        edge: VALID_EDGE,
                      };
                      const stackRes = validateStackConfigSync(stackConfig);
                      if (!stackRes.ok) {
                        failures.push(
                          `3-layer bot gap (preflight->alchemy): ${stackRes.error.message}`,
                        );
                        continue;
                      }
                      const serverEnv: Record<string, string> = {};
                      for (const v of serverPlainEnv({
                        config: stackConfig,
                        buckets: {
                          blobsBucket: stackConfig.blobsBucket,
                          mobileAssetsBucket: stackConfig.mobileAssetsBucket,
                        },
                      })) {
                        serverEnv[v.name] = v.value;
                      }
                      for (const s of serverSecretEnv(stackConfig)) {
                        serverEnv[s.name] = materializeSecretValue(s.name);
                      }
                      const serverRes = validateServerRuntimeEnv(serverEnv, "server");
                      if (!serverRes.ok || serverRes.value.botProtection?.mode !== "altcha") {
                        failures.push(
                          `3-layer bot gap (preflight->server): ${serverRes.ok ? serverRes.value.botProtection?.mode : serverRes.error.message}`,
                        );
                      }
                      const workerCfg = buildRunnerWorkerConfig({ config: stackConfig });
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
                          `3-layer bot gap (preflight->worker): ${workerRes.error.message}`,
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

    expect(failures).toEqual([]);
    expect(total).toBe(3_360);
    expect(normalAccepted).toBeGreaterThan(0);

    // Exhaustive 2^5 bootstrap-flag combinations x 2 stages x 2^4 targeted secret flags = 1,024 states.
    let bootstrapMatrixChecked = 0;
    const bootstrapFailures: string[] = [];
    for (const stage of DEPLOY_STAGES) {
      for (let mask = 0; mask < 32; mask++) {
        const bootstrapFoundation = (mask & 1) !== 0;
        const bootstrapFeedbackSecret = (mask & 2) !== 0;
        const bootstrapAltchaSecret = (mask & 4) !== 0;
        const bootstrapResendSecret = (mask & 8) !== 0;
        const bootstrapTurboCacheSecret = (mask & 16) !== 0;
        const activeCount =
          Number(bootstrapFoundation) +
          Number(bootstrapFeedbackSecret) +
          Number(bootstrapAltchaSecret) +
          Number(bootstrapResendSecret) +
          Number(bootstrapTurboCacheSecret);

        for (let secretMask = 0; secretMask < 16; secretMask++) {
          const enableFeedback = (secretMask & 1) !== 0;
          const enableAltcha = (secretMask & 2) !== 0;
          const enableResend = (secretMask & 4) !== 0;
          const enableTurboCache = (secretMask & 8) !== 0;
          bootstrapMatrixChecked++;

          const env = {
            ...BASE_GCP_ENV,
            KVITBIT_STAGE: stage,
            BOOTSTRAP_FOUNDATION: bootstrapFoundation ? "true" : "false",
            BOOTSTRAP_FEEDBACK_SECRET: bootstrapFeedbackSecret ? "true" : "false",
            BOOTSTRAP_ALTCHA_SECRET: bootstrapAltchaSecret ? "true" : "false",
            BOOTSTRAP_RESEND_SECRET: bootstrapResendSecret ? "true" : "false",
            BOOTSTRAP_TURBO_CACHE_SECRET: bootstrapTurboCacheSecret ? "true" : "false",
            KVITBIT_ENABLE_RESEND_SECRET: enableResend ? "true" : "false",
            KVITBIT_ENABLE_SMTP_SECRET: "false",
            KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "false",
            KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: enableFeedback ? "true" : "false",
            KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: enableAltcha ? "true" : "false",
            KVITBIT_ENABLE_TURBO_CACHE: enableTurboCache ? "true" : "false",
            APP_ORIGIN: "https://kvitbit.cz",
            EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
            KVITBIT_EDGE_DOMAINS: "kvitbit.cz, kvitbit.app",
          } satisfies Record<string, string | undefined>;

          let expOk: boolean;
          if (stage !== "prod") expOk = false;
          else if (activeCount > 1) expOk = false;
          else if (bootstrapFeedbackSecret) expOk = enableFeedback;
          else if (bootstrapAltchaSecret) expOk = enableAltcha;
          else if (bootstrapResendSecret) expOk = enableResend;
          else if (bootstrapTurboCacheSecret) expOk = enableTurboCache;
          else if (bootstrapFoundation) expOk = true;
          else expOk = enableResend && enableAltcha;

          const actual = validateDeployPreflight(env);
          if (actual.ok !== expOk && bootstrapFailures.length < 10) {
            bootstrapFailures.push(
              `preflight-bootstrap ${stage} mask=${mask} secretMask=${secretMask}: expected=${expOk}, got=${actual.ok}${actual.ok ? "" : ` (${actual.message})`}`,
            );
          }
        }
      }
    }
    expect(bootstrapFailures).toEqual([]);
    expect(bootstrapMatrixChecked).toBe(1_024);
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
      KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "true",
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

    // Boolean normalization for all 6 flags across all 12 test tokens = 72 checks.
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
        expect(res.ok, `${flag}=${raw}`).toBe(expected !== "invalid");
        expect(res.ok ? res.normalizedBooleans[flag] : undefined).toBe(
          expected === "invalid" ? undefined : expected,
        );
      }
    }
    expect(boolChecks).toBe(72);

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
          KVITBIT_REPO_VARS_JSON: encodeJson({ [optOut]: "true" }),
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
