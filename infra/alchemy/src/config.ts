import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type BlobDriver,
  type EmailMode,
  FORBIDDEN_OPT_OUT_ENV_VARS,
  findForbiddenOptOutFlag,
  isBlobDriver,
  isEmailMode,
  isForbiddenOptOutKey,
  isProdEmailMode,
  isValidDomain,
  isValidEmailFrom,
  parseCsvDomainList,
  parseOptionalBoolean,
  validateOriginUrl,
} from "./deploy-preflight";

export type { BlobDriver, EmailMode };

export type KvitbitStage = "prod" | "staging";

export type KvitbitWorkload = "server" | "runner";

export interface KvitbitSecretBinding {
  readonly environmentVariable: string;
  readonly secretId: string;
  readonly version: string;
  readonly required: boolean;
  readonly consumers: ReadonlyArray<KvitbitWorkload>;
}

export interface KvitbitEdgeConfig {
  readonly domains: ReadonlyArray<string>;
  readonly enableHttps: boolean;
  readonly staticCdnEnabled: boolean;
  readonly wafPreview: boolean;
  readonly authRateLimitPerMinute: number;
  readonly restrictDirectIngress: boolean;
}

export interface KvitbitStackConfig {
  readonly stage: KvitbitStage;
  readonly bootstrapFoundation: boolean;
  readonly bootstrapFeedbackSecret?: boolean | undefined;
  readonly projectId: string;
  readonly projectNumber: string;
  readonly region: string;
  readonly zone: string;
  readonly stateBucket: string;
  readonly artifactRepositoryId: string;
  readonly imageName: string;
  readonly imageDigest: string;
  readonly blobDriver?: BlobDriver | undefined;
  readonly blobsBucket: string;
  readonly mobileAssetsBucket: string;
  readonly runnerCount: number;
  readonly runnerMachineType: string;
  readonly runnerPort: number;
  readonly runnerCidr: string;
  readonly serverMinInstances: number;
  readonly serverMaxInstances: number;
  readonly appOrigin: string | undefined;
  readonly emailMode?: EmailMode | undefined;
  readonly emailFrom: string | undefined;
  readonly trustedProxyHops: number;
  readonly shareKeyVersion: number;
  readonly androidAssetlinksSha256: string | undefined;
  readonly feedbackGitHubRepo: string | undefined;
  readonly feedbackOwnerEmails: string | undefined;
  readonly secrets: ReadonlyArray<KvitbitSecretBinding>;
  readonly dnsZones: ReadonlyArray<string>;
  readonly edge: KvitbitEdgeConfig | undefined;
}

export class InvalidStackConfig extends Data.TaggedError("InvalidStackConfig")<{
  readonly field: string;
  readonly reason: string;
}> {
  override get message() {
    return `Invalid stack config (${this.field}): ${this.reason}`;
  }
}

export const KVITBIT_PROD_DEFAULTS = {
  stage: "prod" as const,
  projectId: "kvitbit-prod",
  projectNumber: "449188423567",
  region: "europe-west3",
  zone: "europe-west3-a",
  stateBucket: "alchemy-state-kvitbit-prod",
  artifactRepositoryId: "kvitbit",
  imageName: "kvitbit",
  runnerCount: 2,
  runnerMachineType: "e2-standard-2",
  runnerPort: 34431,
  runnerCidr: "10.42.0.0/20",
  serverMinInstances: 0,
  serverMaxInstances: 10,
  shareKeyVersion: 1,
} as const;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const defaultSecretBindings = (
  stage: KvitbitStage,
  options?: {
    readonly enableResend?: boolean;
    readonly enableSmtp?: boolean;
    readonly enableMobileSigningKey?: boolean;
    readonly enableFeedbackGitHubToken?: boolean;
  },
): ReadonlyArray<KvitbitSecretBinding> => {
  const prefix = `kvitbit-${stage}`;
  const bindings: Array<KvitbitSecretBinding> = [
    {
      environmentVariable: "DATABASE_URL",
      secretId: `${prefix}-database-url`,
      version: "latest",
      required: true,
      consumers: ["server", "runner"],
    },
    {
      environmentVariable: "DATABASE_URL_UNPOOLED",
      secretId: `${prefix}-runner-database-url-unpooled`,
      version: "latest",
      required: true,
      consumers: ["runner"],
    },
    {
      environmentVariable: "BETTER_AUTH_SECRET",
      secretId: `${prefix}-better-auth-secret`,
      version: "latest",
      required: true,
      consumers: ["server", "runner"],
    },
  ];

  if (options?.enableResend ?? false) {
    bindings.push({
      environmentVariable: "RESEND_API_KEY",
      secretId: `${prefix}-resend-api-key`,
      version: "latest",
      required: true,
      consumers: ["server", "runner"],
    });
  }

  if (options?.enableSmtp ?? false) {
    bindings.push({
      environmentVariable: "KVITBIT_SMTP_URL",
      secretId: `${prefix}-smtp-url`,
      version: "latest",
      required: true,
      consumers: ["server", "runner"],
    });
  }

  if (options?.enableMobileSigningKey ?? false) {
    bindings.push({
      environmentVariable: "KVITBIT_MOBILE_UPDATES_SIGNING_KEY",
      secretId: `${prefix}-mobile-updates-signing-key`,
      version: "latest",
      required: false,
      consumers: ["server"],
    });
  }

  if (options?.enableFeedbackGitHubToken ?? false) {
    bindings.push({
      environmentVariable: "KVITBIT_FEEDBACK_GITHUB_TOKEN",
      secretId: `${prefix}-feedback-github-token`,
      version: "latest",
      required: false,
      consumers: ["server"],
    });
  }

  return bindings;
};

export const resourceNames = (config: KvitbitStackConfig) => {
  const prefix = `kvitbit-${config.stage}`;
  return {
    prefix,
    serverServiceId: `${prefix}-server`,
    serverServiceAccountId: `${prefix}-server`,
    runnerServiceAccountId: `${prefix}-runner`,
    networkName: `${prefix}-vpc`,
    subnetworkName: `${prefix}-runners`,
    routerName: `${prefix}-router`,
    natName: `${prefix}-nat`,
    runnerFirewallName: `${prefix}-allow-runner-cluster`,
    runnerTag: `${prefix}-runner`,
    runnerInstanceName: (index: number) => `${prefix}-runner-${index}`,
  };
};

export const serviceAccountEmail = (projectId: string, accountId: string) =>
  `${accountId}@${projectId}.iam.gserviceaccount.com`;

export const secretResourceName = (projectId: string, secretId: string) =>
  `projects/${projectId}/secrets/${secretId}`;

export const imageReference = (config: KvitbitStackConfig) =>
  `${config.region}-docker.pkg.dev/${config.projectId}/${config.artifactRepositoryId}/${config.imageName}@${config.imageDigest}`;

export const stackLabels = (config: KvitbitStackConfig): Record<string, string> => ({
  app: "kvitbit",
  stage: config.stage,
  "managed-by": "alchemy",
});

export type StackConfigValidationResult =
  | { readonly ok: true; readonly value: KvitbitStackConfig }
  | { readonly ok: false; readonly error: InvalidStackConfig };

const hasSecret = (
  config: KvitbitStackConfig,
  environmentVariable: string,
  requiredConsumers?: ReadonlyArray<KvitbitWorkload>,
): boolean =>
  config.secrets.some(
    (secret) =>
      secret.environmentVariable === environmentVariable &&
      (requiredConsumers === undefined ||
        requiredConsumers.every((workload) => secret.consumers.includes(workload))),
  );

const failStack = (field: string, reason: string): StackConfigValidationResult => ({
  ok: false,
  error: new InvalidStackConfig({ field, reason }),
});

/** Pure synchronous stack validator backing `validateStackConfig` and Tier 1 exhaustive checks. */
export const validateStackConfigSync = (
  config: KvitbitStackConfig,
): StackConfigValidationResult => {
  const bootstrapFeedbackSecret = config.bootstrapFeedbackSecret ?? false;
  const blobDriver: BlobDriver = config.blobDriver ?? "gcs";

  if (config.projectId.trim().length === 0) {
    return failStack("projectId", "must be non-empty");
  }
  if (!/^\d+$/.test(config.projectNumber)) {
    return failStack("projectNumber", "must be a numeric GCP project number");
  }
  if (!config.zone.startsWith(`${config.region}-`)) {
    return failStack("zone", `zone '${config.zone}' must be inside region '${config.region}'`);
  }
  if (config.bootstrapFoundation && bootstrapFeedbackSecret) {
    return failStack(
      "bootstrapFeedbackSecret",
      "cannot set both bootstrapFoundation and bootstrapFeedbackSecret",
    );
  }
  if (!config.bootstrapFoundation && !DIGEST_PATTERN.test(config.imageDigest)) {
    return failStack(
      "imageDigest",
      `must be an immutable sha256 digest (got '${config.imageDigest}')`,
    );
  }
  if (!Number.isInteger(config.runnerCount) || config.runnerCount < 1 || config.runnerCount > 10) {
    return failStack("runnerCount", "must be an integer between 1 and 10");
  }
  if (config.runnerPort !== 34431) {
    return failStack("runnerPort", "must be 34431 per settled Effect Cluster runner contract");
  }
  if (
    !Number.isInteger(config.serverMinInstances) ||
    config.serverMinInstances < 0 ||
    !Number.isInteger(config.serverMaxInstances) ||
    config.serverMaxInstances < Math.max(1, config.serverMinInstances)
  ) {
    return failStack("serverMaxInstances", "must be >= max(1, serverMinInstances)");
  }

  for (const domain of config.dnsZones) {
    if (!isValidDomain(domain)) {
      return failStack("KVITBIT_DNS_ZONES", `invalid domain '${domain}'`);
    }
    if (config.edge !== undefined && !config.bootstrapFoundation && `www.${domain}`.length > 253) {
      return failStack("KVITBIT_DNS_ZONES", `'www.${domain}' exceeds the DNS name length limit`);
    }
  }

  if (config.edge !== undefined) {
    if (config.edge.enableHttps && config.edge.domains.length === 0) {
      return failStack("edge.domains", "HTTPS edge requires at least one domain");
    }
    for (const domain of config.edge.domains) {
      if (!isValidDomain(domain)) {
        return failStack("edge.domains", `invalid domain '${domain}'`);
      }
    }
  }

  // Typed-mode checks apply in all deploy modes (zero opt-outs allowed in prod, no disabled stub).
  if (!isBlobDriver(blobDriver)) {
    return failStack("blobDriver", `must be 'gcs' or 'local' (got '${String(blobDriver)}')`);
  }
  if (config.stage === "prod" && blobDriver !== "gcs") {
    return failStack(
      "blobDriver",
      `non-production blob driver '${blobDriver}' is forbidden when stage='prod'`,
    );
  }
  if (config.emailMode !== undefined) {
    if (!isEmailMode(config.emailMode)) {
      return failStack("emailMode", `invalid email mode '${String(config.emailMode)}'`);
    }
    if (config.emailMode === "disabled") {
      return failStack(
        "emailMode",
        "emailMode='disabled' is forbidden; configure a real email provider or capture/console in staging",
      );
    }
    if (config.stage === "prod" && !isProdEmailMode(config.emailMode)) {
      return failStack(
        "emailMode",
        `non-production email mode '${config.emailMode}' is forbidden when stage='prod'`,
      );
    }
  }

  if (bootstrapFeedbackSecret) {
    if (!hasSecret(config, "KVITBIT_FEEDBACK_GITHUB_TOKEN")) {
      return failStack(
        "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
        "bootstrapFeedbackSecret requires the KVITBIT_FEEDBACK_GITHUB_TOKEN secret binding",
      );
    }
    return { ok: true, value: config };
  }

  if (config.bootstrapFoundation) {
    return { ok: true, value: config };
  }

  // Workload deploy validation (skipping only during bootstrapFoundation / bootstrapFeedbackSecret).
  if (!hasSecret(config, "DATABASE_URL", ["server"])) {
    return failStack("secrets", "server workload requires DATABASE_URL secret binding");
  }
  if (
    !hasSecret(config, "DATABASE_URL", ["runner"]) &&
    !hasSecret(config, "DATABASE_URL_UNPOOLED", ["runner"])
  ) {
    return failStack(
      "secrets",
      "runner workload requires DATABASE_URL or DATABASE_URL_UNPOOLED secret binding",
    );
  }
  if (!hasSecret(config, "BETTER_AUTH_SECRET", ["server", "runner"])) {
    return failStack(
      "secrets",
      "server and runner workloads both require BETTER_AUTH_SECRET secret binding",
    );
  }
  if (blobDriver === "gcs" && config.blobsBucket.trim().length === 0) {
    return failStack("blobsBucket", "must be non-empty when blobDriver='gcs'");
  }
  if (config.stage === "prod" && config.mobileAssetsBucket.trim().length === 0) {
    return failStack("mobileAssetsBucket", "must be non-empty when stage='prod'");
  }

  const originCheck = validateOriginUrl(config.appOrigin, {
    requireHttpsNonLocalhost: config.stage === "prod",
  });
  if (!originCheck.ok) {
    return failStack("appOrigin", originCheck.reason);
  }

  const hasResend = hasSecret(config, "RESEND_API_KEY", ["server", "runner"]);
  const hasSmtp = hasSecret(config, "KVITBIT_SMTP_URL", ["server", "runner"]);

  if (config.stage === "prod") {
    if (config.edge === undefined || !config.edge.enableHttps || config.edge.domains.length === 0) {
      return failStack(
        "edge",
        "stage='prod' requires HTTPS edge with at least one domain (KVITBIT_EDGE_DOMAINS)",
      );
    }
    if (!isValidEmailFrom(config.emailFrom)) {
      return failStack(
        "emailFrom",
        "stage='prod' requires an explicit valid emailFrom address (KVITBIT_EMAIL_FROM)",
      );
    }
    if (!hasResend && !hasSmtp) {
      return failStack(
        "secrets",
        "stage='prod' requires at least one email secret enabled (RESEND_API_KEY and/or KVITBIT_SMTP_URL)",
      );
    }
    if ((config.emailMode === "resend" || config.emailMode === "resend+smtp") && !hasResend) {
      return failStack(
        "secrets",
        `emailMode='${config.emailMode}' requires the RESEND_API_KEY secret binding`,
      );
    }
    if ((config.emailMode === "smtp" || config.emailMode === "resend+smtp") && !hasSmtp) {
      return failStack(
        "secrets",
        `emailMode='${config.emailMode}' requires the KVITBIT_SMTP_URL secret binding`,
      );
    }
    return { ok: true, value: config };
  }

  // Staging normal deploy: fail fast unless explicit non-prod emailMode ('capture' | 'console').
  const isNonProdEmailMode = config.emailMode === "capture" || config.emailMode === "console";
  if (isNonProdEmailMode) {
    if (config.emailFrom !== undefined && !isValidEmailFrom(config.emailFrom)) {
      return failStack("emailFrom", `invalid emailFrom address '${config.emailFrom}'`);
    }
    return { ok: true, value: config };
  }

  if (!isValidEmailFrom(config.emailFrom)) {
    return failStack(
      "emailFrom",
      "stage='staging' requires an explicit valid emailFrom unless emailMode is 'capture' or 'console'",
    );
  }
  if (config.emailMode === undefined && !hasResend && !hasSmtp) {
    return failStack(
      "secrets",
      "stage='staging' requires RESEND_API_KEY and/or KVITBIT_SMTP_URL unless KVITBIT_EMAIL_MODE=capture or console is explicitly set",
    );
  }
  if ((config.emailMode === "resend" || config.emailMode === "resend+smtp") && !hasResend) {
    return failStack(
      "secrets",
      `emailMode='${config.emailMode}' requires the RESEND_API_KEY secret binding`,
    );
  }
  if ((config.emailMode === "smtp" || config.emailMode === "resend+smtp") && !hasSmtp) {
    return failStack(
      "secrets",
      `emailMode='${config.emailMode}' requires the KVITBIT_SMTP_URL secret binding`,
    );
  }

  return { ok: true, value: config };
};

export const validateStackConfig = (
  config: KvitbitStackConfig,
): Effect.Effect<KvitbitStackConfig, InvalidStackConfig> =>
  Effect.suspend(() => {
    const result = validateStackConfigSync(config);
    return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
  });

const optionalNonEmptyString = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
    Config.map(Option.getOrUndefined),
  );

const optionalBoolean = (
  name: string,
  defaultValue: boolean,
): Effect.Effect<boolean, Config.ConfigError | InvalidStackConfig> =>
  Effect.gen(function* () {
    const raw = yield* optionalNonEmptyString(name);
    const parsed = parseOptionalBoolean(raw, defaultValue);
    if (!parsed.ok) {
      return yield* new InvalidStackConfig({
        field: name,
        reason: parsed.reason,
      });
    }
    return parsed.value;
  });

const optionalInt = (
  name: string,
  defaultValue: number,
): Effect.Effect<number, Config.ConfigError | InvalidStackConfig> =>
  Effect.gen(function* () {
    const raw = yield* optionalNonEmptyString(name);
    if (raw === undefined) {
      return defaultValue;
    }
    if (!/^-?\d+$/.test(raw)) {
      return yield* new InvalidStackConfig({
        field: name,
        reason: `expected integer, got '${raw}'`,
      });
    }
    return Number.parseInt(raw, 10);
  });

const MAX_ARRAY_DIRECT_SCAN = 4096;

const FORBIDDEN_PROVIDER_PROBE_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  [],
  ["KVITBIT", "DISABLE"],
  ["KVITBIT", "PREVIEW"],
  ["KVITBIT", "PREVIEW", "DISABLE"],
  ["KVITBIT", "ALLOW"],
  ["KVITBIT", "ALLOW", "LOCAL"],
  ["KVITBIT", "ALLOW", "LOCAL", "BLOBS"],
];

const collectKvitbitProviderSubtree = (
  provider: ConfigProvider.ConfigProvider,
  path: ReadonlyArray<string | number>,
  visited: Set<string>,
): Effect.Effect<Array<readonly [string, string]>, Config.ConfigError> =>
  Effect.gen(function* () {
    const pathKey = path.map(String).join("\0");
    if (visited.has(pathKey)) return [];
    visited.add(pathKey);

    const node = yield* provider
      .load(path)
      .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
    if (node === undefined) return [];
    const entries: Array<readonly [string, string]> = [];
    if (node._tag === "Value") {
      if (path.length > 0) {
        entries.push([path.map(String).join("_"), node.value]);
      }
      return entries;
    }
    if (node._tag === "Record") {
      if (node.value !== undefined && path.length > 0) {
        entries.push([path.map(String).join("_"), node.value]);
      }
      for (const key of node.keys) {
        if (path.length === 0 && key !== "KVITBIT" && !key.startsWith("KVITBIT_")) {
          continue;
        }
        const childPath = [...path, key];
        const nested = yield* collectKvitbitProviderSubtree(provider, childPath, visited);
        entries.push(...nested);
        const childName = childPath.map(String).join("_");
        if (nested.length === 0 && isForbiddenOptOutKey(childName)) {
          entries.push([childName, ""]);
        }
      }
      return entries;
    }
    if (node._tag === "Array") {
      if (node.value !== undefined && path.length > 0) {
        entries.push([path.map(String).join("_"), node.value]);
      }
      const arrayEntries: Array<readonly [string, string]> = [];
      const limit = Math.min(node.length, MAX_ARRAY_DIRECT_SCAN);
      for (let index = 0; index < limit; index++) {
        const nested = yield* collectKvitbitProviderSubtree(provider, [...path, index], visited);
        arrayEntries.push(...nested);
      }
      entries.push(...arrayEntries);
      if (node.length > 0 && arrayEntries.length === 0) {
        const lastName = [...path, node.length - 1].map(String).join("_");
        if (isForbiddenOptOutKey(lastName)) {
          entries.push([lastName, ""]);
        }
      }
    }
    return entries;
  });

const collectKvitbitProviderEnv = (
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<Array<readonly [string, string]>, Config.ConfigError> =>
  Effect.gen(function* () {
    const visited = new Set<string>();
    const entries: Array<readonly [string, string]> = [];
    for (const rootPath of FORBIDDEN_PROVIDER_PROBE_PATHS) {
      const found = yield* collectKvitbitProviderSubtree(provider, rootPath, visited);
      entries.push(...found);
    }
    return entries;
  });

export const loadStackConfig: Effect.Effect<
  KvitbitStackConfig,
  Config.ConfigError | InvalidStackConfig
> = Effect.gen(function* () {
  const stageRaw = yield* Config.String("KVITBIT_STAGE").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.stage),
  );
  if (stageRaw !== "prod" && stageRaw !== "staging") {
    return yield* new InvalidStackConfig({
      field: "KVITBIT_STAGE",
      reason: `expected 'prod' or 'staging', got '${stageRaw}'`,
    });
  }
  const stage: KvitbitStage = stageRaw;

  const provider = yield* ConfigProvider.ConfigProvider;
  const kvitbitEntries = yield* collectKvitbitProviderEnv(provider);
  const dynamicMap: Record<string, string | undefined> = Object.fromEntries(kvitbitEntries);
  for (const forbidden of FORBIDDEN_OPT_OUT_ENV_VARS) {
    const direct = yield* optionalNonEmptyString(forbidden);
    if (direct !== undefined) {
      dynamicMap[forbidden] = direct;
    }
  }
  const forbiddenFlag = findForbiddenOptOutFlag(dynamicMap);
  if (forbiddenFlag !== undefined) {
    return yield* new InvalidStackConfig({
      field: forbiddenFlag,
      reason: `boolean opt-out flag ${forbiddenFlag} is forbidden; use typed mode variables in staging only`,
    });
  }

  const kvitbitEnvRaw = yield* optionalNonEmptyString("KVITBIT_ENV");
  const expectedKvitbitEnv = stage === "prod" ? "production" : "staging";
  if (kvitbitEnvRaw !== undefined && kvitbitEnvRaw !== expectedKvitbitEnv) {
    return yield* new InvalidStackConfig({
      field: "KVITBIT_ENV",
      reason: `KVITBIT_ENV='${kvitbitEnvRaw}' conflicts with KVITBIT_STAGE='${stage}' (expected '${expectedKvitbitEnv}')`,
    });
  }

  const bootstrapFoundation = yield* optionalBoolean("KVITBIT_BOOTSTRAP_FOUNDATION", false);
  const bootstrapFeedbackSecret = yield* optionalBoolean(
    "KVITBIT_BOOTSTRAP_FEEDBACK_SECRET",
    false,
  );

  const projectId = yield* Config.String("KVITBIT_GCP_PROJECT_ID").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.projectId),
  );
  const projectNumber = yield* Config.String("KVITBIT_GCP_PROJECT_NUMBER").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.projectNumber),
  );
  const region = yield* Config.String("KVITBIT_GCP_REGION").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.region),
  );
  const zone = yield* Config.String("KVITBIT_GCP_ZONE").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.zone),
  );
  const stateBucket = yield* Config.String("KVITBIT_ALCHEMY_STATE_BUCKET").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.stateBucket),
  );
  const imageDigest = bootstrapFoundation
    ? ((yield* optionalNonEmptyString("KVITBIT_IMAGE_DIGEST")) ?? "")
    : yield* Config.String("KVITBIT_IMAGE_DIGEST");
  const runnerCount = yield* optionalInt("KVITBIT_RUNNER_COUNT", KVITBIT_PROD_DEFAULTS.runnerCount);
  const runnerMachineType = yield* Config.String("KVITBIT_RUNNER_MACHINE_TYPE").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.runnerMachineType),
  );
  const serverMinInstances = yield* optionalInt(
    "KVITBIT_SERVER_MIN_INSTANCES",
    KVITBIT_PROD_DEFAULTS.serverMinInstances,
  );
  const serverMaxInstances = yield* optionalInt(
    "KVITBIT_SERVER_MAX_INSTANCES",
    KVITBIT_PROD_DEFAULTS.serverMaxInstances,
  );
  const appOrigin = yield* optionalNonEmptyString("KVITBIT_APP_ORIGIN");
  const emailFrom = yield* optionalNonEmptyString("KVITBIT_EMAIL_FROM");

  const emailModeRaw = yield* optionalNonEmptyString("KVITBIT_EMAIL_MODE");
  if (emailModeRaw !== undefined && !isEmailMode(emailModeRaw)) {
    return yield* new InvalidStackConfig({
      field: "KVITBIT_EMAIL_MODE",
      reason: `unsupported KVITBIT_EMAIL_MODE '${emailModeRaw}'`,
    });
  }
  const emailMode: EmailMode | undefined = emailModeRaw;

  const blobDriverRaw = yield* optionalNonEmptyString("KVITBIT_BLOB_DRIVER");
  if (blobDriverRaw !== undefined && !isBlobDriver(blobDriverRaw)) {
    return yield* new InvalidStackConfig({
      field: "KVITBIT_BLOB_DRIVER",
      reason: `unsupported KVITBIT_BLOB_DRIVER '${blobDriverRaw}'`,
    });
  }
  const blobDriver: BlobDriver = blobDriverRaw ?? "gcs";

  const androidAssetlinksSha256 = yield* optionalNonEmptyString(
    "KVITBIT_ANDROID_ASSETLINKS_SHA256",
  );
  const feedbackGitHubRepo = yield* optionalNonEmptyString("KVITBIT_FEEDBACK_GITHUB_REPO");
  const feedbackOwnerEmails = yield* optionalNonEmptyString("KVITBIT_FEEDBACK_OWNER_EMAILS");
  const shareKeyVersion = yield* optionalInt(
    "KVITBIT_SHARE_KEY_VERSION",
    KVITBIT_PROD_DEFAULTS.shareKeyVersion,
  );

  const edgeDomainsRaw = yield* optionalNonEmptyString("KVITBIT_EDGE_DOMAINS");
  const edgeDomains = parseCsvDomainList(edgeDomainsRaw);
  const dnsZonesRaw = yield* optionalNonEmptyString("KVITBIT_DNS_ZONES");
  const dnsZones = [
    ...new Set(parseCsvDomainList(dnsZonesRaw).map((domain) => domain.replace(/\.$/, ""))),
  ];
  const edgeWafPreview = yield* optionalBoolean("KVITBIT_EDGE_WAF_PREVIEW", false);
  const edgeStaticCdnEnabled = yield* optionalBoolean("KVITBIT_EDGE_STATIC_CDN", true);
  // Default to restricting direct Cloud Run ingress when Cloud Armor edge is enabled.
  const edgeRestrictDirectIngress = yield* optionalBoolean(
    "KVITBIT_EDGE_RESTRICT_DIRECT_INGRESS",
    true,
  );

  const edge: KvitbitEdgeConfig | undefined =
    edgeDomains.length > 0
      ? {
          domains: edgeDomains,
          enableHttps: true,
          staticCdnEnabled: edgeStaticCdnEnabled,
          wafPreview: edgeWafPreview,
          authRateLimitPerMinute: 60,
          restrictDirectIngress: edgeRestrictDirectIngress,
        }
      : undefined;

  const trustedProxyHops = yield* optionalInt(
    "KVITBIT_TRUSTED_PROXY_HOPS",
    edge !== undefined ? 2 : 1,
  );

  const enableResend = yield* optionalBoolean("KVITBIT_ENABLE_RESEND_SECRET", false);
  const enableSmtp = yield* optionalBoolean("KVITBIT_ENABLE_SMTP_SECRET", false);
  const enableMobileSigningKey = yield* optionalBoolean(
    "KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET",
    false,
  );
  const enableFeedbackGitHubToken = yield* optionalBoolean(
    "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
    false,
  );

  const blobsBucket = yield* Config.String("KVITBIT_BLOB_BUCKET").pipe(
    Config.withDefault(`${projectId}-blobs-${stage}`),
  );
  const mobileAssetsBucket = yield* Config.String("KVITBIT_MOBILE_STORAGE_BUCKET").pipe(
    Config.withDefault(`${projectId}-mobile-${stage}`),
  );

  return yield* validateStackConfig({
    stage,
    bootstrapFoundation,
    bootstrapFeedbackSecret,
    projectId,
    projectNumber,
    region,
    zone,
    stateBucket,
    artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
    imageName: KVITBIT_PROD_DEFAULTS.imageName,
    imageDigest,
    blobDriver,
    blobsBucket,
    mobileAssetsBucket,
    runnerCount,
    runnerMachineType,
    runnerPort: KVITBIT_PROD_DEFAULTS.runnerPort,
    runnerCidr: KVITBIT_PROD_DEFAULTS.runnerCidr,
    serverMinInstances,
    serverMaxInstances,
    appOrigin,
    emailMode,
    emailFrom,
    trustedProxyHops,
    shareKeyVersion,
    androidAssetlinksSha256,
    feedbackGitHubRepo,
    feedbackOwnerEmails,
    secrets: defaultSecretBindings(stage, {
      enableResend,
      enableSmtp,
      enableMobileSigningKey,
      enableFeedbackGitHubToken,
    }),
    dnsZones,
    edge,
  });
});
