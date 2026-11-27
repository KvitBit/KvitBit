// Alchemy resource names and instance props need a synchronous SHA-256. Effect Digest is asynchronous.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import type {
  FirewallProps,
  InstanceProps,
  NetworkProps,
  RouterProps,
  SubnetworkProps,
} from "@alchemy.run/gcp/Compute";
import * as Compute from "@alchemy.run/gcp/Compute";
import type * as Output from "alchemy/Output";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { KvitbitStackConfig } from "../config";
import { imageReference, resourceNames, serviceAccountEmail, stackLabels } from "../config";
import { type PlainEnvVar, runnerPlainEnv, secretBindingsForWorkload } from "../env";
import { afterResources, declaredLink } from "./provider-inputs";

export const COS_STABLE_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";

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

export const networkProps = (config: KvitbitStackConfig): NetworkProps => ({
  networkName: resourceNames(config).networkName,
  description: `Kvitbit ${config.stage} VPC for Cloud Run Direct VPC egress and Effect Cluster runners.`,
  autoCreateSubnetworks: false,
  routingMode: "REGIONAL",
});

export const subnetworkProps = ({
  config,
  network,
}: {
  readonly config: KvitbitStackConfig;
  readonly network: string;
}): SubnetworkProps => ({
  subnetworkName: resourceNames(config).subnetworkName,
  region: config.region,
  network,
  ipCidrRange: config.runnerCidr,
  privateIpGoogleAccess: true,
  description: `Kvitbit ${config.stage} private subnet for Effect Cluster runners and Cloud Run Direct VPC egress.`,
});

export const routerProps = ({
  config,
  network,
}: {
  readonly config: KvitbitStackConfig;
  readonly network: string;
}): RouterProps => ({
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

export const runnerFirewallProps = ({
  config,
  network,
}: {
  readonly config: KvitbitStackConfig;
  readonly network: string;
}): FirewallProps => {
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
 * - COS mounts /var/lib/kvitbit noexec, so the reconcile unit invokes the script through Bash.
 *   Startup and the timer both start that unit, which serializes reconciliations.
 * - Installs a systemd reconcile timer that watches GCE instance metadata (`kvitbit-image-ref`,
 *   `kvitbit-image-digest`, `kvitbit-worker-config`, and `kvitbit-worker-config-sha`) so in-place
 *   metadata updates deterministically reconcile env, secrets, firewall, unit, and container
 *   whenever either the image digest or the worker config SHA changes. Deploy verifies their
 *   combined value in `guest-attributes/kvitbit/active-target`.
 * - Retries transient metadata, Secret Manager, and Artifact Registry failures with bounded
 *   exponential backoff, and installs systemd units before initial reconciliation.
 */
export const buildRunnerStartupScript = (): string => `#!/bin/bash
set -euo pipefail

install -d -m 0700 /var/lib/kvitbit /run/kvitbit

cat <<'RECONCILE' > /var/lib/kvitbit/reconcile-worker.sh
#!/bin/bash
set -euo pipefail

METADATA="http://metadata.google.internal/computeMetadata/v1"
HEADER="Metadata-Flavor: Google"

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
  shift
  curl -fsS --connect-timeout 5 --max-time 15 -H "$HEADER" "$@" "$METADATA/$path"
}

fetch_attributes_etag() {
  fetch_metadata "instance/attributes/?recursive=true" --dump-header - --output /dev/null |
    awk 'tolower($1) == "etag:" { sub(/\\r$/, "", $2); print $2 }'
}

fetch_target() {
  local etag confirmed_etag config_hash

  # The recursive attributes ETag covers all four keys in the target.
  etag="$(fetch_attributes_etag)" || return 1
  [ -n "$etag" ] || return 1
  TARGET_IMAGE_DIGEST="$(fetch_metadata "instance/attributes/kvitbit-image-digest")" || return 1
  TARGET_CONFIG_SHA="$(fetch_metadata "instance/attributes/kvitbit-worker-config-sha")" || return 1
  TARGET_IMAGE_REF="$(fetch_metadata "instance/attributes/kvitbit-image-ref")" || return 1
  fetch_metadata "instance/attributes/kvitbit-worker-config" > "$CONFIG_FILE" || return 1
  confirmed_etag="$(fetch_attributes_etag)" || return 1

  [ "$etag" = "$confirmed_etag" ] || return 1
  [[ "$TARGET_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  [[ "$TARGET_IMAGE_REF" == ?*@"$TARGET_IMAGE_DIGEST" ]] || return 1

  # Hash the response body as fetched. Command substitution would strip trailing newlines.
  config_hash="$(sha256sum < "$CONFIG_FILE")" || return 1
  [[ -s "$CONFIG_FILE" && "$TARGET_CONFIG_SHA" == "sha256:\${config_hash%% *}" ]]
}

verified_image_id() {
  local image_info image_id
  image_info="$(docker image inspect --format='{{println .Id}}{{range .RepoDigests}}{{println .}}{{end}}' -- "$TARGET_IMAGE_REF")" || return 1
  read -r image_id <<< "$image_info"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  grep -Fxq -- "$TARGET_IMAGE_REF" <<< "$image_info" || return 1
  printf '%s\\n' "$image_id"
}

worker_is_running() {
  local image_id="$1"
  local state
  # Config.Image records the argument passed at launch, so legacy workers must reconcile once.
  state="$(docker inspect --type container --format='{{.State.Running}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "kvitbit.target_digest"}}|{{index .Config.Labels "kvitbit.target_config_sha"}}' kvitbit-worker 2>/dev/null)" || return 1
  [[ "$state" == "true|$image_id|$image_id|$TARGET_IMAGE_DIGEST|$TARGET_CONFIG_SHA" ]]
}

publish_guest_attribute() {
  local key="$1"
  local value="$2"
  curl -fsS --connect-timeout 5 --max-time 15 -X PUT -H "$HEADER" --data "$value" \
    "$METADATA/instance/guest-attributes/kvitbit/$key" >/dev/null 2>&1
}

publish_active_state() {
  local digest="$1"
  local config_sha="$2"
  if ! publish_guest_attribute "active-target" "$digest|$config_sha"; then
    echo "Failed to publish verified worker target" >&2
    return 1
  fi
  publish_guest_attribute "active-digest" "$digest" || true
  publish_guest_attribute "active-config-sha" "$config_sha" || true
}

parse_worker_config() {
  awk '
    function json_str(line,    out, i, c, n) {
      sub(/^[^:]*:[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*,?[[:space:]]*$/, "", line)
      out = ""
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (c == "\\\\" && i < n) {
          i++
          c = substr(line, i, 1)
          if (c == "n") out = out "\\n"
          else if (c == "t") out = out "\\t"
          else if (c == "r") out = out "\\r"
          else out = out c
        } else {
          out = out c
        }
      }
      return out
    }
    function json_scalar(line) {
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/[[:space:]]*,?[[:space:]]*$/, "", line)
      return line
    }
    BEGIN { section = "top" }
    /^  "plainEnv": \\[\\],?$/ { section = "top"; next }
    /^  "plainEnv": \\[$/ { section = "plainEnv"; next }
    /^  "secrets": \\[\\],?$/ { section = "top"; next }
    /^  "secrets": \\[$/ { section = "secrets"; next }
    /^  \\],?$/ { section = "top"; next }
    section == "top" && /^  "projectId":/ { printf "META\\tprojectId\\t%s\\n", json_str($0); next }
    section == "top" && /^  "registryHost":/ { printf "META\\tregistryHost\\t%s\\n", json_str($0); next }
    section == "top" && /^  "runnerCidr":/ { printf "META\\trunnerCidr\\t%s\\n", json_str($0); next }
    section == "top" && /^  "runnerPort":/ { printf "META\\trunnerPort\\t%s\\n", json_scalar($0); next }
    section == "plainEnv" && /^      "name":/ { env_name = json_str($0); next }
    section == "plainEnv" && /^      "value":/ { printf "ENV\\t%s\\t%s\\n", env_name, json_str($0); next }
    section == "secrets" && /^      "environmentVariable":/ { sec_env = json_str($0); next }
    section == "secrets" && /^      "secretId":/ { sec_id = json_str($0); next }
    section == "secrets" && /^      "version":/ { sec_ver = json_str($0); next }
    section == "secrets" && /^      "required":/ {
      req = (json_scalar($0) == "true") ? "required" : "optional"
      printf "SECRET\\t%s\\t%s\\t%s\\t%s\\n", sec_env, sec_id, sec_ver, req
      next
    }
  '
}

ensure_host_firewall() {
  local cidr="$1"
  local port="$2"
  if ! iptables -C INPUT -s "$cidr" -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -s "$cidr" -p tcp --dport "$port" -j ACCEPT
  fi
}

ensure_worker_unit() {
  local unit_path="/etc/systemd/system/kvitbit-worker.service"
  local unit_tmp="/run/kvitbit/kvitbit-worker.service.tmp.$$"
  cat <<'WORKER_UNIT' > "$unit_tmp"
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
ExecStart=/usr/bin/docker run --pull=never --rm --name kvitbit-worker --label kvitbit.target_digest=\${KVITBIT_WORKER_DIGEST} --label kvitbit.target_config_sha=\${KVITBIT_WORKER_CONFIG_SHA} --network host --shm-size=1g --env-file /run/kvitbit/worker.env \${KVITBIT_WORKER_IMAGE} worker
ExecStop=/usr/bin/docker stop -t 30 kvitbit-worker

[Install]
WantedBy=multi-user.target
WORKER_UNIT
  if [ -d /etc/systemd/system ]; then
    if [ ! -f "$unit_path" ] || ! cmp -s "$unit_tmp" "$unit_path"; then
      mv -f "$unit_tmp" "$unit_path"
      systemctl daemon-reload
    else
      rm -f "$unit_tmp"
    fi
  else
    rm -f "$unit_tmp"
  fi
}

install -d -m 0700 /run/kvitbit
CONFIG_FILE="$(mktemp /run/kvitbit/worker-config.XXXXXX)"
ENV_FILE="/run/kvitbit/worker.env"
ENV_TMP="/run/kvitbit/worker.env.tmp.$$"
TARGET_ENV_FILE="/run/kvitbit/worker-target.env"
TARGET_ENV_TMP="/run/kvitbit/worker-target.env.tmp.$$"
trap 'rm -f "$CONFIG_FILE" "$ENV_TMP" "$TARGET_ENV_TMP"' EXIT

if ! retry_with_backoff 6 fetch_target; then
  echo "Failed to fetch consistent worker image and config metadata" >&2
  exit 1
fi

PARSED_CONFIG="$(parse_worker_config < "$CONFIG_FILE")"
PROJECT_ID=""
REGISTRY_HOST=""
RUNNER_CIDR=""
RUNNER_PORT=""

while IFS=$'\\t' read -r kind col1 col2 col3 col4; do
  if [ "$kind" = "META" ]; then
    case "$col1" in
      projectId) PROJECT_ID="$col2" ;;
      registryHost) REGISTRY_HOST="$col2" ;;
      runnerCidr) RUNNER_CIDR="$col2" ;;
      runnerPort) RUNNER_PORT="$col2" ;;
    esac
  fi
done <<EOF_META
$PARSED_CONFIG
EOF_META

if [ -z "$PROJECT_ID" ] || [ -z "$REGISTRY_HOST" ] || [ -z "$RUNNER_CIDR" ] || [ -z "$RUNNER_PORT" ]; then
  echo "Parsed worker config is missing required metadata fields" >&2
  exit 1
fi

ensure_host_firewall "$RUNNER_CIDR" "$RUNNER_PORT"

if VERIFIED_IMAGE_ID="$(verified_image_id 2>/dev/null)" && worker_is_running "$VERIFIED_IMAGE_ID"; then
  publish_active_state "$TARGET_IMAGE_DIGEST" "$TARGET_CONFIG_SHA"
  exit 0
fi

INTERNAL_IP="$(retry_with_backoff 8 fetch_metadata "instance/network-interfaces/0/ip")"
TOKEN_JSON="$(retry_with_backoff 8 fetch_metadata "instance/service-accounts/default/token")"
ACCESS_TOKEN="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')"

if [ -z "$INTERNAL_IP" ] || [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to resolve GCE internal IP or metadata access token" >&2
  exit 1
fi

export DOCKER_CONFIG="/run/kvitbit/docker"
install -d -m 0700 "$DOCKER_CONFIG"
docker_login() {
  printf '%s' "$ACCESS_TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY_HOST"
}
pull_verified_image() {
  docker pull -- "$TARGET_IMAGE_REF" || return 1
  VERIFIED_IMAGE_ID="$(verified_image_id)"
}
retry_with_backoff 6 docker_login
if ! retry_with_backoff 6 pull_verified_image; then
  echo "Failed to pull and verify worker image $TARGET_IMAGE_REF" >&2
  exit 1
fi

umask 0177

printf 'HOST=%s\\n' "$INTERNAL_IP" > "$ENV_TMP"

fetch_secret_once() {
  local url="$1"
  curl -fsS --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $ACCESS_TOKEN" "$url"
}

fetch_secret() {
  local env_name="$1"
  local secret_id="$2"
  local version="$3"
  local requirement="$4"
  local url="https://secretmanager.googleapis.com/v1/projects/\${PROJECT_ID}/secrets/\${secret_id}/versions/\${version}:access"
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

while IFS=$'\\t' read -r kind col1 col2 col3 col4; do
  if [ "$kind" = "ENV" ]; then
    printf '%s=%s\\n' "$col1" "$col2" >> "$ENV_TMP"
  elif [ "$kind" = "SECRET" ]; then
    fetch_secret "$col1" "$col2" "$col3" "$col4"
  fi
done <<EOF_VARS
$PARSED_CONFIG
EOF_VARS

{
  printf 'KVITBIT_WORKER_IMAGE=%s\\n' "$VERIFIED_IMAGE_ID"
  printf 'KVITBIT_WORKER_DIGEST=%s\\n' "$TARGET_IMAGE_DIGEST"
  printf 'KVITBIT_WORKER_CONFIG_SHA=%s\\n' "$TARGET_CONFIG_SHA"
} > "$TARGET_ENV_TMP"

# A rollback must never read the previous target after its worker has stopped.
if ! publish_guest_attribute "active-target" "pending"; then
  echo "Failed to invalidate previous worker target" >&2
  exit 1
fi
ensure_worker_unit
# A systemd auto-restart must never see env and labels from different targets.
systemctl stop kvitbit-worker.service
mv -f "$ENV_TMP" "$ENV_FILE"
mv -f "$TARGET_ENV_TMP" "$TARGET_ENV_FILE"
systemctl start kvitbit-worker.service

for _ in 1 2 3 4 5 6; do
  if worker_is_running "$VERIFIED_IMAGE_ID"; then
    publish_active_state "$TARGET_IMAGE_DIGEST" "$TARGET_CONFIG_SHA"
    exit 0
  fi
  sleep 2
done

echo "kvitbit-worker did not reach running state for digest $TARGET_IMAGE_DIGEST and config $TARGET_CONFIG_SHA" >&2
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
ExecStart=/usr/bin/docker run --pull=never --rm --name kvitbit-worker --label kvitbit.target_digest=\${KVITBIT_WORKER_DIGEST} --label kvitbit.target_config_sha=\${KVITBIT_WORKER_CONFIG_SHA} --network host --shm-size=1g --env-file /run/kvitbit/worker.env \${KVITBIT_WORKER_IMAGE} worker
ExecStop=/usr/bin/docker stop -t 30 kvitbit-worker

[Install]
WantedBy=multi-user.target
UNIT

cat <<'RECONCILE_UNIT' > /etc/systemd/system/kvitbit-worker-reconcile.service
[Unit]
Description=Reconcile Kvitbit Effect Cluster Worker image and config from GCE metadata
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash /var/lib/kvitbit/reconcile-worker.sh
RECONCILE_UNIT

cat <<'RECONCILE_TIMER' > /etc/systemd/system/kvitbit-worker-reconcile.timer
[Unit]
Description=Poll GCE metadata for Kvitbit worker image and config updates

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
systemctl start kvitbit-worker-reconcile.service
`;

export const runnerInstanceProps = ({
  config,
  index,
  deps,
}: {
  readonly config: KvitbitStackConfig;
  readonly index: number;
  readonly deps: {
    readonly network: string;
    readonly subnetwork: string;
    readonly blobsBucket?: string;
    readonly serviceAccountEmail?: string;
    readonly startupScript?: string;
    readonly workerConfig?: RunnerWorkerConfig;
  };
}): InstanceProps => {
  const names = resourceNames(config);
  const workerConfig =
    deps.workerConfig ??
    buildRunnerWorkerConfig({ config, options: { blobsBucket: deps.blobsBucket } });
  const workerConfigJson = serializeRunnerWorkerConfig(workerConfig);
  const workerConfigSha = runnerWorkerConfigSha(workerConfig);
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
      serviceAccountEmail({ projectId: config.projectId, accountId: names.runnerServiceAccountId }),
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    shieldedInstanceConfig: {
      enableSecureBoot: true,
      enableVtpm: true,
      enableIntegrityMonitoring: true,
    },
    metadata: {
      "startup-script": deps.startupScript ?? buildRunnerStartupScript(),
      "kvitbit-image-ref": imageReference(config),
      "kvitbit-image-digest": config.imageDigest,
      "kvitbit-worker-config": workerConfigJson,
      "kvitbit-worker-config-sha": workerConfigSha,
      "enable-guest-attributes": "TRUE",
      "enable-oslogin": "TRUE",
    },
  };
};

export const declareNetworkAndRunners = Effect.fn("KvitbitStack.declareNetworkAndRunners")(
  function* (
    config: KvitbitStackConfig,
    deps: {
      readonly runnerServiceAccountEmail: string | Output.Output<string>;
      readonly blobsBucketName: string;
      readonly runnerDependencies?: ReadonlyArray<unknown>;
    },
  ) {
    const network = yield* Compute.Network("KvitbitVpc", networkProps(config));
    const networkLink = network.selfLink.pipe(declaredLink("KvitbitVpc"));
    const subnetwork = yield* Compute.Subnetwork("KvitbitRunnerSubnet", {
      ...subnetworkProps({ config, network: "" }),
      network: networkLink,
    });
    const subnetworkLink = subnetwork.selfLink.pipe(declaredLink("KvitbitRunnerSubnet"));
    const router = yield* Compute.Router("KvitbitRouter", {
      ...routerProps({ config, network: "" }),
      network: networkLink,
    });
    const firewall = yield* Compute.Firewall("KvitbitRunnerClusterIngress", {
      ...runnerFirewallProps({ config, network: "" }),
      network: networkLink,
    });

    const workerConfig = buildRunnerWorkerConfig({
      config,
      options: {
        blobsBucket: deps.blobsBucketName,
      },
    });
    const workerConfigSha = runnerWorkerConfigSha(workerConfig);
    const startupScript = buildRunnerStartupScript();

    const networkReadyDependencies = [
      subnetworkLink,
      router.routerName,
      firewall.firewallName,
    ] as const;

    const runnerServiceAccount = afterResources([
      ...networkReadyDependencies,
      ...(deps.runnerDependencies ?? []),
    ])(deps.runnerServiceAccountEmail);

    const runners: Array<Compute.Instance> = [];
    for (let index = 0; index < config.runnerCount; index += 1) {
      const base = runnerInstanceProps({
        config,
        index,
        deps: {
          network: "",
          subnetwork: "",
          blobsBucket: deps.blobsBucketName,
          startupScript,
          workerConfig,
        },
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
      runnerNames: Arr.map(runners, (runner) => runner.instanceName),
      runnerConfigSha: workerConfigSha,
    };
  },
);
