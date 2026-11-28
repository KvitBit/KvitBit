import * as IAM from "@alchemy.run/gcp/IAM";
import type { ServiceProps } from "@alchemy.run/gcp/Run";
import * as Run from "@alchemy.run/gcp/Run";
import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { KvitbitStackConfig } from "../config";
import { imageReference, resourceNames, serviceAccountEmail, stackLabels } from "../config";
import { serverPlainEnv, serverSecretEnv } from "../env";
import { afterResources } from "./provider-inputs";

export interface ServerServiceDeps {
  readonly networkName: string;
  readonly subnetworkName: string;
  readonly blobsBucketName: string;
  readonly mobileAssetsBucketName: string;
  readonly serviceAccountEmail?: string;
}

export const serverServiceProps = ({
  config,
  deps,
}: {
  readonly config: KvitbitStackConfig;
  readonly deps: ServerServiceDeps;
}): ServiceProps => {
  const names = resourceNames(config);
  const saEmail =
    deps.serviceAccountEmail ??
    serviceAccountEmail({ projectId: config.projectId, accountId: names.serverServiceAccountId });

  return {
    serviceId: names.serverServiceId,
    location: config.region,
    description: `Kvitbit ${config.stage} HTTP API, Foldkit web, /mcp, and /app/ PWA server (Effect Cluster sharding client).`,
    labels: {
      ...stackLabels(config),
      workload: "server",
    },
    ingress:
      config.edge?.restrictDirectIngress === true
        ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
        : "INGRESS_TRAFFIC_ALL",
    template: {
      serviceAccount: saEmail,
      timeout: "300s",
      scaling: {
        minInstanceCount: config.serverMinInstances,
        maxInstanceCount: config.serverMaxInstances,
      },
      vpcAccess: {
        networkInterfaces: [
          {
            network: deps.networkName,
            subnetwork: deps.subnetworkName,
          },
        ],
        egress: "PRIVATE_RANGES_ONLY",
      },
      containers: [
        {
          name: "kvitbit",
          image: imageReference(config),
          args: ["server"],
          ports: [{ containerPort: 8080 }],
          resources: {
            limits: {
              cpu: "2",
              memory: "2Gi",
            },
          },
          env: [
            ...serverPlainEnv({
              config,
              buckets: {
                blobsBucket: deps.blobsBucketName,
                mobileAssetsBucket: deps.mobileAssetsBucketName,
              },
            }),
            ...serverSecretEnv(config),
          ],
          startupProbe: {
            httpGet: { path: "/healthz", port: 8080 },
            periodSeconds: 5,
            timeoutSeconds: 3,
            failureThreshold: 12,
          },
          livenessProbe: {
            httpGet: { path: "/healthz", port: 8080 },
            periodSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 3,
          },
        },
      ],
    },
  };
};

export const declareServerService = Effect.fn("KvitbitStack.declareServerService")(function* (
  config: KvitbitStackConfig,
  deps: {
    readonly networkName: Input<string>;
    readonly subnetworkName: Input<string>;
    readonly blobsBucketName: string;
    readonly mobileAssetsBucketName: string;
    readonly serverServiceAccountEmail: string | Output.Output<string>;
    readonly serverDependencies?: ReadonlyArray<unknown>;
  },
) {
  const baseProps = serverServiceProps({
    config,
    deps: {
      networkName: resourceNames(config).networkName,
      subnetworkName: resourceNames(config).subnetworkName,
      blobsBucketName: deps.blobsBucketName,
      mobileAssetsBucketName: deps.mobileAssetsBucketName,
    },
  });

  const serviceAccount = afterResources(deps.serverDependencies ?? [])(
    deps.serverServiceAccountEmail,
  );

  const service = yield* Run.Service("KvitbitServer", {
    ...baseProps,
    template: {
      ...baseProps.template,
      serviceAccount,
      vpcAccess: {
        networkInterfaces: [
          {
            network: deps.networkName,
            subnetwork: deps.subnetworkName,
          },
        ],
        egress: "PRIVATE_RANGES_ONLY",
      },
    },
  });

  yield* IAM.Member("KvitbitServerPublicInvoker", {
    kind: "run.service",
    name: service.name,
    role: "roles/run.invoker",
    member: "allUsers",
  });

  return {
    serviceName: service.name,
    serviceId: service.serviceId,
    serviceUri: service.uri,
  };
});
