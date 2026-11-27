import type { ServiceAccountProps } from "@alchemy.run/gcp/IAM";
import * as IAM from "@alchemy.run/gcp/IAM";
import type { ServiceProps } from "@alchemy.run/gcp/Run";
import * as Run from "@alchemy.run/gcp/Run";
import type { BucketProps } from "@alchemy.run/gcp/Storage";
import * as Storage from "@alchemy.run/gcp/Storage";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { KvitbitStackConfig, KvitbitTurboCacheConfig } from "../config";
import {
  KVITBIT_TURBO_CACHE_DEFAULTS,
  resourceNames,
  secretResourceName,
  serviceAccountEmail,
  stackLabels,
} from "../config";

export const turboCacheBucketProps = (
  config: KvitbitStackConfig,
  turboCache: KvitbitTurboCacheConfig,
): BucketProps => ({
  bucketName: turboCache.bucket,
  location: config.region.toUpperCase(),
  storageClass: "STANDARD",
  versioning: false,
  uniformBucketLevelAccess: true,
  forceDestroy: true,
  labels: {
    ...stackLabels(config),
    workload: "turbo-cache",
  },
});

export const turboCacheServiceAccountProps = (config: KvitbitStackConfig): ServiceAccountProps => ({
  project: config.projectId,
  accountId: resourceNames(config).turboCacheServiceAccountId,
  displayName: `Kvitbit ${config.stage} Turborepo remote cache`,
  description:
    "Least-privilege runtime identity for the self-hosted Turborepo remote cache Cloud Run service.",
});

export const turboCacheLifecycleJson = (ttlDays: number): string =>
  `${JSON.stringify(
    {
      rule: [
        {
          action: { type: "Delete" },
          condition: { age: ttlDays },
        },
      ],
    },
    null,
    2,
  )}\n`;

export interface TurboCacheServiceDeps {
  readonly bucketName: string;
  readonly serviceAccountEmail?: string;
}

export const turboCacheServiceProps = (
  config: KvitbitStackConfig,
  turboCache: KvitbitTurboCacheConfig,
  deps: TurboCacheServiceDeps,
): ServiceProps => {
  const names = resourceNames(config);
  const saEmail =
    deps.serviceAccountEmail ??
    serviceAccountEmail(config.projectId, names.turboCacheServiceAccountId);
  const tokenSecretId = `${names.prefix}-turbo-cache-token`;

  return {
    serviceId: names.turboCacheServiceId,
    location: config.region,
    description: `Kvitbit ${config.stage} self-hosted Turborepo remote cache backed by GCS.`,
    labels: {
      ...stackLabels(config),
      workload: "turbo-cache",
    },
    ingress: "INGRESS_TRAFFIC_ALL",
    template: {
      serviceAccount: saEmail,
      timeout: "120s",
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: turboCache.maxInstances,
      },
      containers: [
        {
          name: "turbo-cache",
          image: turboCache.image,
          ports: [{ containerPort: KVITBIT_TURBO_CACHE_DEFAULTS.port }],
          resources: {
            limits: {
              cpu: "1",
              memory: "512Mi",
            },
          },
          env: [
            { name: "STORAGE_PROVIDER", value: "google-cloud-storage" },
            { name: "STORAGE_PATH", value: deps.bucketName },
            { name: "GOOGLE_CLOUD_PROJECT", value: config.projectId },
            { name: "BODY_LIMIT", value: String(KVITBIT_TURBO_CACHE_DEFAULTS.bodyLimitBytes) },
            {
              name: "TURBO_TOKEN",
              valueSource: {
                secretKeyRef: {
                  secret: tokenSecretId,
                  version: "latest",
                },
              },
            },
          ],
          startupProbe: {
            tcpSocket: { port: KVITBIT_TURBO_CACHE_DEFAULTS.port },
            periodSeconds: 5,
            timeoutSeconds: 3,
            failureThreshold: 12,
          },
        },
      ],
    },
  };
};

const afterResources = <A>(
  value: Input<A>,
  dependencies: ReadonlyArray<unknown>,
): Output.Output<A> => {
  if (dependencies.length === 0) {
    return Output.asOutput(value as A);
  }
  return Output.all(
    Output.asOutput(value as A),
    ...dependencies.map((dep) => Output.asOutput(dep)),
  ).pipe(Output.map(([resolved]) => resolved as A));
};

export const declareTurboCache = Effect.fn("KvitbitStack.declareTurboCache")(function* (
  config: KvitbitStackConfig,
  turboCache: KvitbitTurboCacheConfig,
  deps: {
    readonly tokenSecretName?: Input<string> | undefined;
  },
) {
  const bucket = yield* Storage.Bucket(
    "KvitbitTurboCacheBucket",
    turboCacheBucketProps(config, turboCache),
  );
  const serviceAccount = yield* IAM.ServiceAccount(
    "KvitbitTurboCacheSa",
    turboCacheServiceAccountProps(config),
  );
  const bucketAdmin = yield* IAM.Member("TurboCacheBucketAdmin", {
    kind: "storage.bucket",
    name: bucket.bucketName,
    role: "roles/storage.objectAdmin",
    member: Output.interpolate`serviceAccount:${serviceAccount.email}`,
  });

  const tokenSecretId = `${resourceNames(config).prefix}-turbo-cache-token`;
  const tokenSecretAccess = yield* IAM.Member(`SecretAccess-${tokenSecretId}-turbo-cache`, {
    kind: "secretmanager.secret",
    name: deps.tokenSecretName ?? secretResourceName(config.projectId, tokenSecretId),
    role: "roles/secretmanager.secretAccessor",
    member: Output.interpolate`serviceAccount:${serviceAccount.email}`,
  });

  const baseProps = turboCacheServiceProps(config, turboCache, {
    bucketName: turboCache.bucket,
  });

  const service = yield* Run.Service("KvitbitTurboCache", {
    ...baseProps,
    template: {
      ...baseProps.template,
      serviceAccount: afterResources(serviceAccount.email, [
        bucketAdmin.member,
        tokenSecretAccess.member,
      ]),
    },
  });

  yield* IAM.Member("KvitbitTurboCachePublicInvoker", {
    kind: "run.service",
    name: service.name,
    role: "roles/run.invoker",
    member: "allUsers",
  });

  return {
    bucket: bucket.bucketName,
    serviceName: service.name,
    serviceUri: service.uri,
  };
});
