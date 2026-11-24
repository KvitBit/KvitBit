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
 * Container-Optimized OS startup + reconcile script for Kvitbit Effect Cluster runners (#908).
 *
 * Security & operational invariants:
 * - No secret values are embedded in VM metadata; secrets are fetched at boot and reconcile
 *   from Secret Manager using the runner's attached least-privilege service account and written
 *   atomically to a tmpfs env file (/run/kvitbit/worker.env, mode 0600).
 * - HOST is resolved dynamically from the GCE metadata server's internal IP so
 *   NodeClusterHttp registers the exact reachable VPC RunnerAddress (HOST:34431).
 * - Opens COS host iptables idempotently for the private runner subnet on TCP 34431.
 * - Installs a systemd reconcile timer that watches GCE instance metadata (`kvitbit-image-ref`
 *   and `kvitbit-image-digest`) so in-place metadata updates deterministically pull the new
 *   digest, restart `kvitbit-worker.service`, and publish `guest-attributes/kvitbit/active-digest`.
 * - Retries transient metadata, Secret Manager, and Artifact Registry failures with bounded
 *   exponential backoff, and installs systemd units before initial reconciliation.
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

install -d -m 0700 /var/lib/kvitbit /run/kvitbit

cat <<'RECONCILE' > /var/lib/kvitbit/reconcile-worker.sh
#!/bin/bash
set -euo pipefail

METADATA="http://metadata.google.internal/computeMetadata/v1"
HEADER="Metadata-Flavor: Google"
DEFAULT_IMAGE_REF=${shellQuote(imageRef)}
DEFAULT_IMAGE_DIGEST=${shellQuote(config.imageDigest)}
RUNNER_CIDR=${shellQuote(config.runnerCidr)}
RUNNER_PORT=${shellQuote(String(config.runnerPort))}

retry_with_backoff() {
  local max_attempts="$1"
  shift
  local attempt=1
  local delay=2
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      return 1
    fi
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    if [ "$delay" -gt 30 ]; then
      delay=30
    fi
  done
}

fetch_metadata() {
  local path="$1"
  curl -fsS --connect-timeout 5 --max-time 15 -H "$HEADER" "$METADATA/$path"
}

publish_active_digest() {
  local digest="$1"
  curl -fsS --connect-timeout 5 --max-time 15 -X PUT -H "$HEADER" --data "$digest" \
    "$METADATA/instance/guest-attributes/kvitbit/active-digest" >/dev/null 2>&1 || true
}

ensure_host_firewall() {
  if ! iptables -C INPUT -s "$RUNNER_CIDR" -p tcp --dport "$RUNNER_PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -s "$RUNNER_CIDR" -p tcp --dport "$RUNNER_PORT" -j ACCEPT
  fi
}

INTERNAL_IP="$(retry_with_backoff 8 fetch_metadata "instance/network-interfaces/0/ip")"
TOKEN_JSON="$(retry_with_backoff 8 fetch_metadata "instance/service-accounts/default/token")"
ACCESS_TOKEN="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')"

if [ -z "$INTERNAL_IP" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to resolve GCE internal IP or metadata access token" >&2
  exit 1
fi

TARGET_IMAGE_REF="$(fetch_metadata "instance/attributes/kvitbit-image-ref" 2>/dev/null || printf '%s' "$DEFAULT_IMAGE_REF")"
TARGET_IMAGE_DIGEST="$(fetch_metadata "instance/attributes/kvitbit-image-digest" 2>/dev/null || printf '%s' "$DEFAULT_IMAGE_DIGEST")"

if [ -z "$TARGET_IMAGE_REF" ] || [ -z "$TARGET_IMAGE_DIGEST" ]; then
  echo "Failed to resolve target worker image ref or digest" >&2
  exit 1
fi

ensure_host_firewall

RUNNING_STATE="$(docker inspect --format='{{.State.Running}}|{{index .Config.Labels "kvitbit.target_digest"}}' kvitbit-worker 2>/dev/null || true)"
if [ "$RUNNING_STATE" = "true|$TARGET_IMAGE_DIGEST" ]; then
  publish_active_digest "$TARGET_IMAGE_DIGEST"
  exit 0
fi

install -d -m 0700 /run/kvitbit
ENV_FILE="/run/kvitbit/worker.env"
ENV_TMP="/run/kvitbit/worker.env.tmp.$$"
TARGET_ENV_FILE="/run/kvitbit/worker-target.env"
umask 0177

{
  printf 'HOST=%s\\n' "$INTERNAL_IP"
${plainEnvLines}
} > "$ENV_TMP"

fetch_secret_once() {
  local url="$1"
  curl -fsS --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $ACCESS_TOKEN" "$url"
}

fetch_secret() {
  local env_name="$1"
  local secret_id="$2"
  local version="$3"
  local requirement="$4"
  local url="https://secretmanager.googleapis.com/v1/projects/${config.projectId}/secrets/\${secret_id}/versions/\${version}:access"
  local body
  if ! body="$(retry_with_backoff 6 fetch_secret_once "$url")"; then
    if [ "$requirement" = "required" ]; then
      echo "Required secret $secret_id could not be accessed" >&2
      rm -f "$ENV_TMP"
      exit 1
    fi
    return 0
  fi
  local encoded
  encoded="$(printf '%s' "$body" | tr -d '\\n' | sed -n 's/.*"data":[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  if [ -z "$encoded" ]; then
    if [ "$requirement" = "required" ]; then
      echo "Required secret $secret_id returned empty payload" >&2
      rm -f "$ENV_TMP"
      exit 1
    fi
    return 0
  fi
  local decoded
  decoded="$(printf '%s' "$encoded" | base64 -d)"
  printf '%s=%s\\n' "$env_name" "$decoded" >> "$ENV_TMP"
}

${secretFetchLines}

mv -f "$ENV_TMP" "$ENV_FILE"

export DOCKER_CONFIG="/run/kvitbit/docker"
install -d -m 0700 "$DOCKER_CONFIG"
docker_login() {
  printf '%s' "$ACCESS_TOKEN" | docker login -u oauth2accesstoken --password-stdin ${shellQuote(`https://${registryHost}`)}
}
retry_with_backoff 6 docker_login
retry_with_backoff 6 docker pull "$TARGET_IMAGE_REF"

{
  printf 'KVITBIT_WORKER_IMAGE=%s\\n' "$TARGET_IMAGE_REF"
  printf 'KVITBIT_WORKER_DIGEST=%s\\n' "$TARGET_IMAGE_DIGEST"
} > "$TARGET_ENV_FILE"

systemctl restart kvitbit-worker.service

for _ in 1 2 3 4 5 6; do
  CURRENT_STATE="$(docker inspect --format='{{.State.Running}}|{{index .Config.Labels "kvitbit.target_digest"}}' kvitbit-worker 2>/dev/null || true)"
  if [ "$CURRENT_STATE" = "true|$TARGET_IMAGE_DIGEST" ]; then
    publish_active_digest "$TARGET_IMAGE_DIGEST"
    exit 0
  fi
  sleep 2
done

echo "kvitbit-worker did not reach running state for digest $TARGET_IMAGE_DIGEST" >&2
exit 1
RECONCILE

chmod 0700 /var/lib/kvitbit/reconcile-worker.sh

cat <<'UNIT' > /etc/systemd/system/kvitbit-worker.service
[Unit]
Description=Kvitbit Effect Cluster Worker
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
EnvironmentFile=/run/kvitbit/worker-target.env
ExecStartPre=-/usr/bin/docker rm -f kvitbit-worker
ExecStart=/usr/bin/docker run --rm --name kvitbit-worker --label kvitbit.target_digest=\${KVITBIT_WORKER_DIGEST} --network host --shm-size=1g --env-file /run/kvitbit/worker.env \${KVITBIT_WORKER_IMAGE} worker
ExecStop=/usr/bin/docker stop -t 30 kvitbit-worker

[Install]
WantedBy=multi-user.target
UNIT

cat <<'RECONCILE_UNIT' > /etc/systemd/system/kvitbit-worker-reconcile.service
[Unit]
Description=Reconcile Kvitbit Effect Cluster Worker image and secrets from GCE metadata
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/var/lib/kvitbit/reconcile-worker.sh
RECONCILE_UNIT

cat <<'RECONCILE_TIMER' > /etc/systemd/system/kvitbit-worker-reconcile.timer
[Unit]
Description=Poll GCE metadata for Kvitbit worker digest updates

[Timer]
OnBootSec=15s
OnUnitActiveSec=15s
AccuracySec=5s
Unit=kvitbit-worker-reconcile.service

[Install]
WantedBy=timers.target
RECONCILE_TIMER

systemctl daemon-reload
systemctl enable kvitbit-worker.service
systemctl enable --now kvitbit-worker-reconcile.timer
/var/lib/kvitbit/reconcile-worker.sh
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
      "kvitbit-image-ref": imageReference(config),
      "kvitbit-image-digest": config.imageDigest,
      "enable-guest-attributes": "TRUE",
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

export const declareNetworkAndRunners = Effect.fn("KvitbitStack.declareNetworkAndRunners")(
  function* (
    config: KvitbitStackConfig,
    deps: {
      readonly runnerServiceAccountEmail: Input<string>;
      readonly blobsBucketName: string;
      readonly runnerDependencies?: ReadonlyArray<unknown>;
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

    const networkReadyDependencies = [
      subnetworkLink,
      router.routerName,
      firewall.firewallName,
    ] as const;

    const runnerServiceAccount = afterResources(deps.runnerServiceAccountEmail, [
      ...networkReadyDependencies,
      ...(deps.runnerDependencies ?? []),
    ]);

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
        serviceAccount: runnerServiceAccount,
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
      networkReadyDependencies,
      runnerNames: runners.map((runner) => runner.instanceName),
    };
  },
);
