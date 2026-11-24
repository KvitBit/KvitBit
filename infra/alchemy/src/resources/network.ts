import type {
  FirewallProps,
  InstanceProps,
  NetworkProps,
  RouterProps,
  SubnetworkProps,
} from "@alchemy.run/gcp/Compute";
import * as Compute from "@alchemy.run/gcp/Compute";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { KvitbitStackConfig } from "../config";
import { imageReference, resourceNames, serviceAccountEmail, stackLabels } from "../config";
import { runnerPlainEnv, secretBindingsForWorkload } from "../env";

export const COS_STABLE_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";

export const networkProps = (config: KvitbitStackConfig): NetworkProps => ({
  networkName: resourceNames(config).networkName,
  description: `Kvitbit ${config.stage} VPC for Cloud Run Direct VPC egress and Effect Cluster runners.`,
  autoCreateSubnetworks: false,
  routingMode: "REGIONAL",
});

export const subnetworkProps = (config: KvitbitStackConfig, network: string): SubnetworkProps => ({
  subnetworkName: resourceNames(config).subnetworkName,
  region: config.region,
  network,
  ipCidrRange: config.runnerCidr,
  privateIpGoogleAccess: true,
  description: `Kvitbit ${config.stage} private subnet for Effect Cluster runners and Cloud Run Direct VPC egress.`,
});

export const routerProps = (config: KvitbitStackConfig, network: string): RouterProps => ({
  routerName: resourceNames(config).routerName,
  region: config.region,
  network,
  description: `Kvitbit ${config.stage} Cloud Router + Cloud NAT for private-IP runner egress (Neon, Resend, ARES, CNB).`,
  nats: [
    {
      name: resourceNames(config).natName,
      natIpAllocateOption: "AUTO_ONLY",
      sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
    },
  ],
});

export const runnerFirewallProps = (config: KvitbitStackConfig, network: string): FirewallProps => {
  const names = resourceNames(config);
  return {
    firewallName: names.runnerFirewallName,
    network,
    description: `Allow internal Effect Cluster RPC traffic (TCP ${config.runnerPort}) from VPC subnet / Cloud Run Direct VPC egress to Kvitbit runners.`,
    direction: "INGRESS",
    priority: 1000,
    allowed: [{ protocol: "tcp", ports: [String(config.runnerPort)] }],
    sourceRanges: [config.runnerCidr],
    targetTags: [names.runnerTag],
  };
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Container-Optimized OS startup script for Kvitbit Effect Cluster runners (#908).
 *
 * Security invariants:
 * - No secret values are embedded in VM metadata; secrets are fetched at boot
 *   from Secret Manager using the runner's attached least-privilege service account
 *   and written to a tmpfs env file (/run/kvitbit/worker.env, mode 0600).
 * - HOST is resolved dynamically from the GCE metadata server's internal IP so
 *   NodeClusterHttp registers the exact reachable VPC RunnerAddress (HOST:34431).
 */
export const buildRunnerStartupScript = (
  config: KvitbitStackConfig,
  options?: {
    readonly blobsBucket?: string;
    readonly imageRef?: string;
  },
): string => {
  const blobsBucket = options?.blobsBucket ?? config.blobsBucket;
  const imageRef = options?.imageRef ?? imageReference(config);
  const registryHost = `${config.region}-docker.pkg.dev`;
  const plainEnv = runnerPlainEnv(config, blobsBucket);
  const runnerSecrets = secretBindingsForWorkload(config, "runner");

  const plainEnvLines = plainEnv
    .map((entry) => `  printf '%s=%s\\n' ${shellQuote(entry.name)} ${shellQuote(entry.value)}`)
    .join("\n");

  const secretFetchLines = runnerSecrets
    .map(
      (secret) =>
        `fetch_secret ${shellQuote(secret.environmentVariable)} ${shellQuote(secret.secretId)} ${shellQuote(secret.version)} ${secret.required ? "required" : "optional"}`,
    )
    .join("\n");

  return `#!/bin/bash
set -euo pipefail

METADATA="http://metadata.google.internal/computeMetadata/v1"
HEADER="Metadata-Flavor: Google"

INTERNAL_IP="$(curl -fsS -H "$HEADER" "$METADATA/instance/network-interfaces/0/ip")"
ACCESS_TOKEN="$(curl -fsS -H "$HEADER" "$METADATA/instance/service-accounts/default/token" | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')"

if [ -z "$INTERNAL_IP" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to resolve GCE internal IP or metadata access token" >&2
  exit 1
fi

install -d -m 0700 /run/kvitbit
ENV_FILE="/run/kvitbit/worker.env"
umask 0177

{
  printf 'HOST=%s\\n' "$INTERNAL_IP"
${plainEnvLines}
} > "$ENV_FILE"

fetch_secret() {
  local env_name="$1"
  local secret_id="$2"
  local version="$3"
  local requirement="$4"
  local url="https://secretmanager.googleapis.com/v1/projects/${config.projectId}/secrets/\${secret_id}/versions/\${version}:access"
  local body
  if ! body="$(curl -fsS -H "Authorization: Bearer $ACCESS_TOKEN" "$url")"; then
    if [ "$requirement" = "required" ]; then
      echo "Required secret $secret_id could not be accessed" >&2
      exit 1
    fi
    return 0
  fi
  local encoded
  encoded="$(printf '%s' "$body" | tr -d '\\n' | sed -n 's/.*"data":[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  if [ -z "$encoded" ]; then
    if [ "$requirement" = "required" ]; then
      echo "Required secret $secret_id returned empty payload" >&2
      exit 1
    fi
    return 0
  fi
  local decoded
  decoded="$(printf '%s' "$encoded" | base64 -d)"
  printf '%s=%s\\n' "$env_name" "$decoded" >> "$ENV_FILE"
}

${secretFetchLines}

export DOCKER_CONFIG="/run/kvitbit/docker"
install -d -m 0700 "$DOCKER_CONFIG"
printf '%s' "$ACCESS_TOKEN" | docker login -u oauth2accesstoken --password-stdin ${shellQuote(`https://${registryHost}`)}
docker pull ${shellQuote(imageRef)}

cat <<'UNIT' > /etc/systemd/system/kvitbit-worker.service
[Unit]
Description=Kvitbit Effect Cluster Worker
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f kvitbit-worker
ExecStart=/usr/bin/docker run --rm --name kvitbit-worker --network host --shm-size=1g --env-file /run/kvitbit/worker.env ${imageRef} worker
ExecStop=/usr/bin/docker stop -t 30 kvitbit-worker

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now kvitbit-worker.service
`;
};

export const runnerInstanceProps = (
  config: KvitbitStackConfig,
  index: number,
  deps: {
    readonly network: string;
    readonly subnetwork: string;
    readonly serviceAccountEmail?: string;
    readonly startupScript?: string;
  },
): InstanceProps => {
  const names = resourceNames(config);
  return {
    instanceName: names.runnerInstanceName(index),
    zone: config.zone,
    machineType: config.runnerMachineType,
    description: `Kvitbit ${config.stage} Effect Cluster runner #${index} (worker.ts + Chromium PDF rendering).`,
    labels: {
      ...stackLabels(config),
      workload: "runner",
      "runner-index": String(index),
    },
    tags: [names.runnerTag],
    sourceImage: COS_STABLE_IMAGE,
    diskSizeGb: 30,
    bootDiskType: "pd-balanced",
    network: deps.network,
    subnetwork: deps.subnetwork,
    associatePublicIp: false,
    automaticRestart: true,
    serviceAccount:
      deps.serviceAccountEmail ??
      serviceAccountEmail(config.projectId, names.runnerServiceAccountId),
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    shieldedInstanceConfig: {
      enableSecureBoot: true,
      enableVtpm: true,
      enableIntegrityMonitoring: true,
    },
    metadata: {
      "startup-script": deps.startupScript ?? buildRunnerStartupScript(config),
      "enable-oslogin": "TRUE",
    },
  };
};

const declaredLink = (resource: string) =>
  Output.map((link: string | undefined) => {
    if (link === undefined) {
      throw new Error(`${resource} reported no self link`);
    }
    return link;
  });

export const declareNetworkAndRunners = Effect.fn("KvitbitStack.declareNetworkAndRunners")(
  function* (
    config: KvitbitStackConfig,
    deps: {
      readonly runnerServiceAccountEmail: Input<string>;
      readonly blobsBucketName: string;
    },
  ) {
    const network = yield* Compute.Network("KvitbitVpc", networkProps(config));
    const networkLink = network.selfLink.pipe(declaredLink("KvitbitVpc"));
    const subnetwork = yield* Compute.Subnetwork("KvitbitRunnerSubnet", {
      ...subnetworkProps(config, ""),
      network: networkLink,
    });
    const subnetworkLink = subnetwork.selfLink.pipe(declaredLink("KvitbitRunnerSubnet"));
    const router = yield* Compute.Router("KvitbitRouter", {
      ...routerProps(config, ""),
      network: networkLink,
    });
    const firewall = yield* Compute.Firewall("KvitbitRunnerClusterIngress", {
      ...runnerFirewallProps(config, ""),
      network: networkLink,
    });

    const startupScript = buildRunnerStartupScript(config, {
      blobsBucket: deps.blobsBucketName,
    });

    const runners: Array<Compute.Instance> = [];
    for (let index = 0; index < config.runnerCount; index += 1) {
      const base = runnerInstanceProps(config, index, {
        network: "",
        subnetwork: "",
        startupScript,
      });
      const instance = yield* Compute.Instance(`KvitbitRunner${index}`, {
        ...base,
        network: networkLink,
        subnetwork: subnetworkLink,
        serviceAccount: deps.runnerServiceAccountEmail,
      });
      runners.push(instance);
    }

    return {
      networkName: network.networkName,
      networkSelfLink: network.selfLink,
      subnetworkName: subnetwork.subnetworkName,
      subnetworkSelfLink: subnetwork.selfLink,
      routerName: router.routerName,
      firewallName: firewall.firewallName,
      runnerNames: runners.map((runner) => runner.instanceName),
    };
  },
);
