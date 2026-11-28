import { createHash } from "node:crypto";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { KvitbitSecretBinding, KvitbitStackConfig, KvitbitWorkload } from "./config";
import { DEFAULT_POSTHOG_HOST, secretResourceName } from "./config";

export interface PlainEnvVar {
  readonly name: string;
  readonly value: string;
}

export interface SecretEnvVar {
  readonly name: string;
  readonly valueSource: {
    readonly secretKeyRef: {
      readonly secret: string;
      readonly version: string;
    };
  };
}

interface RunnerWorkerSecretSpec {
  readonly environmentVariable: string;
  readonly secretId: string;
  readonly version: string;
  readonly required: boolean;
}

export interface RunnerWorkerConfig {
  readonly version: 1;
  readonly projectId: string;
  readonly registryHost: string;
  readonly runnerCidr: string;
  readonly runnerPort: number;
  readonly plainEnv: ReadonlyArray<PlainEnvVar>;
  readonly secrets: ReadonlyArray<RunnerWorkerSecretSpec>;
}

const KVITBIT_IMAGE_PATHS = {
  webDir: "/app/public/web",
  pwaDir: "/app/public/app",
  blobDir: "/var/lib/kvitbit/blobs",
  mobileStorageDir: "/var/lib/kvitbit/mobile",
  chromiumPath: "/usr/bin/chromium",
} as const;

const secretBindingsForWorkload = ({
  config,
  workload,
}: {
  readonly config: KvitbitStackConfig;
  readonly workload: KvitbitWorkload;
}): ReadonlyArray<KvitbitSecretBinding> =>
  Arr.filter(config.secrets, (secret) => secret.consumers.includes(workload));

const kvitbitEnvForStage = (stage: KvitbitStackConfig["stage"]): "production" | "staging" =>
  stage === "prod" ? "production" : "staging";

const posthogPlainEnv = (config: KvitbitStackConfig): ReadonlyArray<PlainEnvVar> =>
  config.posthogKey === undefined
    ? []
    : [
        { name: "KVITBIT_POSTHOG_KEY", value: config.posthogKey },
        { name: "KVITBIT_POSTHOG_HOST", value: config.posthogHost ?? DEFAULT_POSTHOG_HOST },
      ];

export const serverPlainEnv = ({
  config,
  buckets,
}: {
  readonly config: KvitbitStackConfig;
  readonly buckets: {
    readonly blobsBucket: string;
    readonly mobileAssetsBucket: string;
  };
}): ReadonlyArray<PlainEnvVar> => {
  const blobDriver = config.blobDriver ?? "gcs";
  const vars: Array<PlainEnvVar> = [
    { name: "NODE_ENV", value: "production" },
    { name: "KVITBIT_ENV", value: kvitbitEnvForStage(config.stage) },
    { name: "HOST", value: "0.0.0.0" },
    { name: "GOOGLE_CLOUD_PROJECT", value: config.projectId },
    { name: "KVITBIT_RUNNER_MODE", value: "cluster" },
    { name: "KVITBIT_BLOB_DRIVER", value: blobDriver },
    { name: "KVITBIT_BLOB_DIR", value: KVITBIT_IMAGE_PATHS.blobDir },
    { name: "KVITBIT_BLOB_BUCKET", value: buckets.blobsBucket },
    { name: "KVITBIT_GCS_PROJECT", value: config.projectId },
    { name: "KVITBIT_WEB_DIR", value: KVITBIT_IMAGE_PATHS.webDir },
    { name: "KVITBIT_PWA_DIR", value: KVITBIT_IMAGE_PATHS.pwaDir },
    { name: "KVITBIT_CHROMIUM_PATH", value: KVITBIT_IMAGE_PATHS.chromiumPath },
    { name: "KVITBIT_TRUSTED_PROXY_HOPS", value: String(config.trustedProxyHops) },
    { name: "KVITBIT_SHARE_KEY_VERSION", value: String(config.shareKeyVersion) },
    { name: "KVITBIT_MOBILE_STORAGE_BUCKET", value: buckets.mobileAssetsBucket },
    { name: "KVITBIT_MOBILE_STORAGE_DIR", value: KVITBIT_IMAGE_PATHS.mobileStorageDir },
    ...posthogPlainEnv(config),
  ];

  if (config.appOrigin !== undefined) {
    vars.push({ name: "APP_ORIGIN", value: config.appOrigin });
  }
  if (config.emailMode !== undefined) {
    vars.push({ name: "KVITBIT_EMAIL_MODE", value: config.emailMode });
  }
  if (config.emailFrom !== undefined) {
    vars.push({ name: "EMAIL_FROM", value: config.emailFrom });
  }
  if (config.botProtectionMode !== undefined) {
    vars.push({ name: "KVITBIT_BOT_PROTECTION_MODE", value: config.botProtectionMode });
  }
  if (config.androidAssetlinksSha256 !== undefined) {
    vars.push({
      name: "KVITBIT_ANDROID_ASSETLINKS_SHA256",
      value: config.androidAssetlinksSha256,
    });
  }
  if (config.feedbackGitHubRepo !== undefined) {
    vars.push({ name: "KVITBIT_FEEDBACK_GITHUB_REPO", value: config.feedbackGitHubRepo });
  }
  if (config.feedbackOwnerEmails !== undefined) {
    vars.push({ name: "KVITBIT_FEEDBACK_OWNER_EMAILS", value: config.feedbackOwnerEmails });
  }

  return vars;
};

export const serverSecretEnv = (config: KvitbitStackConfig): ReadonlyArray<SecretEnvVar> =>
  Arr.map(secretBindingsForWorkload({ config, workload: "server" }), (secret) => ({
    name: secret.environmentVariable,
    valueSource: {
      secretKeyRef: {
        secret: secretResourceName({ projectId: config.projectId, secretId: secret.secretId }),
        version: secret.version,
      },
    },
  }));

export const runnerPlainEnv = ({
  config,
  blobsBucket,
}: {
  readonly config: KvitbitStackConfig;
  readonly blobsBucket: string;
}): ReadonlyArray<PlainEnvVar> => {
  const blobDriver = config.blobDriver ?? "gcs";
  const vars: Array<PlainEnvVar> = [
    { name: "NODE_ENV", value: "production" },
    { name: "KVITBIT_ENV", value: kvitbitEnvForStage(config.stage) },
    { name: "PORT", value: String(config.runnerPort) },
    { name: "LISTEN_HOST", value: "0.0.0.0" },
    { name: "KVITBIT_RUNNER_MODE", value: "cluster" },
    { name: "KVITBIT_BLOB_DRIVER", value: blobDriver },
    { name: "KVITBIT_BLOB_DIR", value: KVITBIT_IMAGE_PATHS.blobDir },
    { name: "KVITBIT_BLOB_BUCKET", value: blobsBucket },
    { name: "KVITBIT_GCS_PROJECT", value: config.projectId },
    { name: "KVITBIT_CHROMIUM_PATH", value: KVITBIT_IMAGE_PATHS.chromiumPath },
    { name: "KVITBIT_SHARE_KEY_VERSION", value: String(config.shareKeyVersion) },
    ...posthogPlainEnv(config),
  ];

  if (config.appOrigin !== undefined) {
    vars.push({ name: "APP_ORIGIN", value: config.appOrigin });
  }
  if (config.emailMode !== undefined) {
    vars.push({ name: "KVITBIT_EMAIL_MODE", value: config.emailMode });
  }
  if (config.emailFrom !== undefined) {
    vars.push({ name: "EMAIL_FROM", value: config.emailFrom });
  }

  return vars;
};

export const buildRunnerWorkerConfig = ({
  config,
  options,
}: {
  readonly config: KvitbitStackConfig;
  readonly options?: { readonly blobsBucket?: string | undefined };
}): RunnerWorkerConfig => {
  const blobsBucket = options?.blobsBucket ?? config.blobsBucket;
  return {
    version: 1,
    projectId: config.projectId,
    registryHost: `${config.region}-docker.pkg.dev`,
    runnerCidr: config.runnerCidr,
    runnerPort: config.runnerPort,
    plainEnv: runnerPlainEnv({ config, blobsBucket }),
    secrets: Arr.map(secretBindingsForWorkload({ config, workload: "runner" }), (secret) => ({
      environmentVariable: secret.environmentVariable,
      secretId: secret.secretId,
      version: secret.version,
      required: secret.required,
    })),
  };
};

const encodeWorkerConfig = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

export const serializeRunnerWorkerConfig = (workerConfig: RunnerWorkerConfig): string =>
  Result.getOrThrow(encodeWorkerConfig(workerConfig));

export const runnerWorkerConfigSha = (workerConfig: RunnerWorkerConfig): string => {
  const hash = createHash("sha256").update(serializeRunnerWorkerConfig(workerConfig)).digest("hex");
  return `sha256:${hash}`;
};
