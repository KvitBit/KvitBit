import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const NUMERIC_LABEL = /^\d+$/;
const integer = /^-?\d+$/;
const trailingDot = /\.$/;

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
  readonly projectId: string;
  readonly projectNumber: string;
  readonly region: string;
  readonly zone: string;
  readonly stateBucket: string;
  readonly artifactRepositoryId: string;
  readonly imageName: string;
  readonly imageDigest: string;
  readonly blobsBucket: string;
  readonly mobileAssetsBucket: string;
  readonly runnerCount: number;
  readonly runnerMachineType: string;
  readonly runnerPort: number;
  readonly runnerCidr: string;
  readonly serverMinInstances: number;
  readonly serverMaxInstances: number;
  readonly appOrigin: string | undefined;
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

export class InvalidStackConfig extends Schema.TaggedError<
  InvalidStackConfig,
  { readonly brand: unique symbol }
>()("InvalidStackConfig", {
  field: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid stack config (${this.field}): ${this.reason}`;
  }
}

export const KVITBIT_PROD_DEFAULTS = {
  stage: "prod" as const,
  projectId: "kvitbit-prod",
  projectNumber: String(449_188_423_567),
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
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const defaultSecretBindings = ({
  stage,
  options,
}: {
  readonly stage: KvitbitStage;
  readonly options?: {
    readonly enableResend?: boolean;
    readonly enableSmtp?: boolean;
    readonly enableMobileSigningKey?: boolean;
    readonly enableFeedbackGitHubToken?: boolean;
  };
}): ReadonlyArray<KvitbitSecretBinding> => {
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
      required: false,
      consumers: ["server", "runner"],
    });
  }

  if (options?.enableSmtp ?? false) {
    bindings.push({
      environmentVariable: "KVITBIT_SMTP_URL",
      secretId: `${prefix}-smtp-url`,
      version: "latest",
      required: false,
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

export const serviceAccountEmail = ({
  projectId,
  accountId,
}: {
  readonly projectId: string;
  readonly accountId: string;
}) => `${accountId}@${projectId}.iam.gserviceaccount.com`;

export const secretResourceName = ({
  projectId,
  secretId,
}: {
  readonly projectId: string;
  readonly secretId: string;
}) => `projects/${projectId}/secrets/${secretId}`;

export const imageReference = (config: KvitbitStackConfig) =>
  `${config.region}-docker.pkg.dev/${config.projectId}/${config.artifactRepositoryId}/${config.imageName}@${config.imageDigest}`;

export const stackLabels = (config: KvitbitStackConfig): Record<string, string> => ({
  app: "kvitbit",
  stage: config.stage,
  "managed-by": "alchemy",
});

export const validateStackConfig = (
  config: KvitbitStackConfig,
): Effect.Effect<KvitbitStackConfig, InvalidStackConfig> =>
  Effect.gen(function* () {
    if (Str.trim(config.projectId).length === 0) {
      return yield* InvalidStackConfig.make({
        field: "projectId",
        reason: "must be non-empty",
      });
    }
    if (!NUMERIC_LABEL.test(config.projectNumber)) {
      return yield* InvalidStackConfig.make({
        field: "projectNumber",
        reason: "must be a numeric GCP project number",
      });
    }
    if (!Str.startsWith(`${config.region}-`)(config.zone)) {
      return yield* InvalidStackConfig.make({
        field: "zone",
        reason: `zone '${config.zone}' must be inside region '${config.region}'`,
      });
    }
    if (!(config.bootstrapFoundation || DIGEST_PATTERN.test(config.imageDigest))) {
      return yield* InvalidStackConfig.make({
        field: "imageDigest",
        reason: `must be an immutable sha256 digest (got '${config.imageDigest}')`,
      });
    }
    if (
      !Number.isInteger(config.runnerCount) ||
      config.runnerCount < 1 ||
      config.runnerCount > 10
    ) {
      return yield* InvalidStackConfig.make({
        field: "runnerCount",
        reason: "must be an integer between 1 and 10",
      });
    }
    if (config.runnerPort !== 34431) {
      return yield* InvalidStackConfig.make({
        field: "runnerPort",
        reason: "must be 34431 per settled Effect Cluster runner contract",
      });
    }
    if (
      !Number.isInteger(config.serverMinInstances) ||
      config.serverMinInstances < 0 ||
      !Number.isInteger(config.serverMaxInstances) ||
      config.serverMaxInstances < Math.max(1, config.serverMinInstances)
    ) {
      return yield* InvalidStackConfig.make({
        field: "serverMaxInstances",
        reason: "must be >= max(1, serverMinInstances)",
      });
    }
    for (const domain of config.dnsZones) {
      const labels = Str.split(".")(domain);
      if (
        !DOMAIN_PATTERN.test(domain) ||
        domain.length > 253 ||
        NUMERIC_LABEL.test(labels.at(-1) ?? "") ||
        Arr.some(labels, (label) => label.length > 63)
      ) {
        return yield* InvalidStackConfig.make({
          field: "KVITBIT_DNS_ZONES",
          reason: `invalid domain '${domain}'`,
        });
      }
      if (
        config.edge !== undefined &&
        !config.bootstrapFoundation &&
        `www.${domain}`.length > 253
      ) {
        return yield* InvalidStackConfig.make({
          field: "KVITBIT_DNS_ZONES",
          reason: `'www.${domain}' exceeds the DNS name length limit`,
        });
      }
    }
    if (config.edge !== undefined) {
      if (config.edge.enableHttps && config.edge.domains.length === 0) {
        return yield* InvalidStackConfig.make({
          field: "edge.domains",
          reason: "HTTPS edge requires at least one domain",
        });
      }
      for (const domain of config.edge.domains) {
        if (!DOMAIN_PATTERN.test(domain)) {
          return yield* InvalidStackConfig.make({
            field: "edge.domains",
            reason: `invalid domain '${domain}'`,
          });
        }
      }
    }
    return config;
  });

const optionalNonEmptyString = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(
      Option.flatMap((value) => {
        const trimmed = Str.trim(value);
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
    if (raw === undefined) {
      return defaultValue;
    }
    const normalized = Str.toLowerCase(raw);
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
    return yield* InvalidStackConfig.make({
      field: name,
      reason: `expected boolean ('true'/'1'/'yes'/'on' or 'false'/'0'/'no'/'off'), got '${raw}'`,
    });
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
    if (!integer.test(raw)) {
      return yield* InvalidStackConfig.make({
        field: name,
        reason: `expected integer, got '${raw}'`,
      });
    }
    return Number.parseInt(raw, 10);
  });

const parseCsvList = (raw: string | undefined): ReadonlyArray<string> =>
  raw === undefined
    ? []
    : Arr.filter(
        Arr.map(Str.split(",")(raw), (part) => Str.toLowerCase(Str.trim(part))),
        (part) => part.length > 0,
      );

export const loadStackConfig: Effect.Effect<
  KvitbitStackConfig,
  Config.ConfigError | InvalidStackConfig
> = Effect.gen(function* () {
  const stageRaw = yield* Config.String("KVITBIT_STAGE").pipe(
    Config.withDefault(KVITBIT_PROD_DEFAULTS.stage),
  );
  if (stageRaw !== "prod" && stageRaw !== "staging") {
    return yield* InvalidStackConfig.make({
      field: "KVITBIT_STAGE",
      reason: `expected 'prod' or 'staging', got '${stageRaw}'`,
    });
  }
  const stage: KvitbitStage = stageRaw;
  const bootstrapFoundation = yield* optionalBoolean("KVITBIT_BOOTSTRAP_FOUNDATION", false);

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
  const edgeDomains = parseCsvList(edgeDomainsRaw);
  const dnsZonesRaw = yield* optionalNonEmptyString("KVITBIT_DNS_ZONES");
  const dnsZones = [
    ...new Set(
      Arr.map(parseCsvList(dnsZonesRaw), (domain) => Str.replace(trailingDot, "")(domain)),
    ),
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
    projectId,
    projectNumber,
    region,
    zone,
    stateBucket,
    artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
    imageName: KVITBIT_PROD_DEFAULTS.imageName,
    imageDigest,
    blobsBucket,
    mobileAssetsBucket,
    runnerCount,
    runnerMachineType,
    runnerPort: KVITBIT_PROD_DEFAULTS.runnerPort,
    runnerCidr: KVITBIT_PROD_DEFAULTS.runnerCidr,
    serverMinInstances,
    serverMaxInstances,
    appOrigin,
    emailFrom,
    trustedProxyHops,
    shareKeyVersion,
    androidAssetlinksSha256,
    feedbackGitHubRepo,
    feedbackOwnerEmails,
    secrets: defaultSecretBindings({
      stage,
      options: {
        enableResend,
        enableSmtp,
        enableMobileSigningKey,
        enableFeedbackGitHubToken,
      },
    }),
    dnsZones,
    edge,
  });
});
