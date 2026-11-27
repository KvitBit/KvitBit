import type { KvitbitSecretBinding, KvitbitStackConfig, KvitbitWorkload } from "./config";
import { secretResourceName } from "./config";

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

export type CloudRunEnvVar = PlainEnvVar | SecretEnvVar;

export const KVITBIT_IMAGE_PATHS = {
  webDir: "/app/public/web",
  pwaDir: "/app/public/app",
  blobDir: "/var/lib/kvitbit/blobs",
  mobileStorageDir: "/var/lib/kvitbit/mobile",
  chromiumPath: "/usr/bin/chromium",
} as const;

export const secretBindingsForWorkload = (
  config: KvitbitStackConfig,
  workload: KvitbitWorkload,
): ReadonlyArray<KvitbitSecretBinding> =>
  config.secrets.filter((secret) => secret.consumers.includes(workload));

export const serverPlainEnv = (
  config: KvitbitStackConfig,
  buckets: {
    readonly blobsBucket: string;
    readonly mobileAssetsBucket: string;
  },
): ReadonlyArray<PlainEnvVar> => {
  const vars: Array<PlainEnvVar> = [
    { name: "NODE_ENV", value: "production" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "GOOGLE_CLOUD_PROJECT", value: config.projectId },
    { name: "KVITBIT_RUNNER_MODE", value: "cluster" },
    { name: "KVITBIT_BLOB_DRIVER", value: "gcs" },
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
  ];

  if (config.appOrigin !== undefined) {
    vars.push({ name: "APP_ORIGIN", value: config.appOrigin });
  }
  if (config.emailFrom !== undefined) {
    vars.push({ name: "EMAIL_FROM", value: config.emailFrom });
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
  secretBindingsForWorkload(config, "server").map((secret) => ({
    name: secret.environmentVariable,
    valueSource: {
      secretKeyRef: {
        secret: secretResourceName(config.projectId, secret.secretId),
        version: secret.version,
      },
    },
  }));

export const runnerPlainEnv = (
  config: KvitbitStackConfig,
  blobsBucket: string,
): ReadonlyArray<PlainEnvVar> => {
  const vars: Array<PlainEnvVar> = [
    { name: "NODE_ENV", value: "production" },
    { name: "PORT", value: String(config.runnerPort) },
    { name: "LISTEN_HOST", value: "0.0.0.0" },
    { name: "KVITBIT_RUNNER_MODE", value: "cluster" },
    { name: "KVITBIT_BLOB_DRIVER", value: "gcs" },
    { name: "KVITBIT_BLOB_DIR", value: KVITBIT_IMAGE_PATHS.blobDir },
    { name: "KVITBIT_BLOB_BUCKET", value: blobsBucket },
    { name: "KVITBIT_GCS_PROJECT", value: config.projectId },
    { name: "KVITBIT_CHROMIUM_PATH", value: KVITBIT_IMAGE_PATHS.chromiumPath },
    { name: "KVITBIT_SHARE_KEY_VERSION", value: String(config.shareKeyVersion) },
  ];

  if (config.appOrigin !== undefined) {
    vars.push({ name: "APP_ORIGIN", value: config.appOrigin });
  }
  if (config.emailFrom !== undefined) {
    vars.push({ name: "EMAIL_FROM", value: config.emailFrom });
  }

  return vars;
};
