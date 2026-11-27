import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type {
  AddressProps,
  FirewallProps,
  InstanceProps,
  SubnetworkProps,
} from "@alchemy.run/gcp/Compute";
import * as Compute from "@alchemy.run/gcp/Compute";
import type { ServiceAccountProps } from "@alchemy.run/gcp/IAM";
import * as IAM from "@alchemy.run/gcp/IAM";
import type { BucketProps } from "@alchemy.run/gcp/Storage";
import * as Storage from "@alchemy.run/gcp/Storage";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { KvitbitMailConfig, KvitbitStackConfig } from "../config";
import { resourceNames, secretResourceName, serviceAccountEmail, stackLabels } from "../config";
import { COS_STABLE_IMAGE } from "./network";

export class MailBundleError extends Data.TaggedError("MailBundleError")<{
  readonly reason: string;
}> {
  override get message() {
    return `Failed to bundle mail-forwarder Effect script: ${this.reason}`;
  }
}

/**
 * Immutable linux/amd64 digest for `oven/bun:1.4.2-slim` used by the Always-Free
 * US `e2-micro` inbound mail forwarder VM (avoids pulling the full Chromium app image
 * across regions from europe-west3).
 */
export const MAIL_FORWARDER_BUN_IMAGE_DIGEST =
  "sha256:debbe76858f2e398d2937c1eceeb82c571ac1fcd78aadf00e9634578ac2b5ef7";

export const MAIL_FORWARDER_BUN_IMAGE_REF = `oven/bun@${MAIL_FORWARDER_BUN_IMAGE_DIGEST}`;

export const MAIL_FORWARDER_INTERNAL_PORT = 2525;
export const MAIL_FORWARDER_HEALTH_PORT = 8081;

export interface MailForwarderRuntimeConfig {
  readonly version: 1;
  readonly projectId: string;
  readonly mxHost: string;
  readonly domain: string;
  readonly forwardTo: string;
  readonly forwardFrom: string;
  readonly aliases: ReadonlyArray<string>;
  readonly archiveBucket: string;
  readonly relayMode: "archive-only" | "resend";
  readonly smtpPort: number;
  readonly healthPort: number;
  readonly resendSecretId: string | undefined;
}

export const buildMailForwarderConfig = (
  config: KvitbitStackConfig,
  mail: KvitbitMailConfig,
): MailForwarderRuntimeConfig => ({
  version: 1,
  projectId: config.projectId,
  mxHost: mail.mxHost,
  domain: mail.domain,
  forwardTo: mail.forwardTo,
  forwardFrom: mail.forwardFrom,
  aliases: mail.aliases,
  archiveBucket: mail.archiveBucket,
  relayMode: mail.relayMode,
  smtpPort: MAIL_FORWARDER_INTERNAL_PORT,
  healthPort: MAIL_FORWARDER_HEALTH_PORT,
  resendSecretId:
    mail.relayMode === "resend" ? `${resourceNames(config).prefix}-resend-api-key` : undefined,
});

export const serializeMailForwarderConfig = (runtimeConfig: MailForwarderRuntimeConfig): string =>
  JSON.stringify(runtimeConfig, null, 2);

export const sha256Prefixed = (content: string): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

let cachedBundle: { readonly scriptB64Gz: string; readonly sha: string } | undefined;

export const bundleMailForwarderScript: Effect.Effect<
  { readonly scriptB64Gz: string; readonly sha: string },
  MailBundleError
> = Effect.gen(function* () {
  if (cachedBundle !== undefined) return cachedBundle;
  const entrypoint = resolve(import.meta.dir, "../mail-forwarder/server.ts");
  const buildResult = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [entrypoint],
        target: "bun",
        format: "esm",
        minify: true,
        sourcemap: "none",
      }),
    catch: (error) =>
      new MailBundleError({
        reason: error instanceof Error ? error.message : String(error),
      }),
  });
  const output = buildResult.outputs[0];
  if (!buildResult.success || output === undefined) {
    const messages = buildResult.logs.map((log) => log.message).join("; ");
    return yield* new MailBundleError({ reason: messages || "no output" });
  }
  const script = yield* Effect.tryPromise({
    try: () => output.text(),
    catch: (error) =>
      new MailBundleError({
        reason: error instanceof Error ? error.message : String(error),
      }),
  });
  const gz = gzipSync(Buffer.from(script, "utf8"), { level: 9 });
  // Normalize gzip header mtime (bytes 4..7) and OS byte (byte 9) for byte-level determinism.
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 3;
  const scriptB64Gz = gz.toString("base64");
  const sha = sha256Prefixed(script);
  cachedBundle = { scriptB64Gz, sha };
  return cachedBundle;
});

export const mailServiceAccountProps = (config: KvitbitStackConfig): ServiceAccountProps => ({
  project: config.projectId,
  accountId: resourceNames(config).mailServiceAccountId,
  displayName: `Kvitbit ${config.stage} inbound mail forwarder`,
  description:
    "Least-privilege runtime identity for the Kvitbit Always-Free inbound SMTP forwarder VM.",
});

export const mailArchiveBucketProps = (
  config: KvitbitStackConfig,
  mail: KvitbitMailConfig,
): BucketProps => ({
  bucketName: mail.archiveBucket,
  location: mail.region.toUpperCase(),
  storageClass: "STANDARD",
  versioning: false,
  uniformBucketLevelAccess: true,
  forceDestroy: false,
  labels: {
    ...stackLabels(config),
    workload: "mail-ingress",
  },
});

export const mailSubnetworkProps = (
  config: KvitbitStackConfig,
  mail: KvitbitMailConfig,
  network: string,
): SubnetworkProps => ({
  subnetworkName: resourceNames(config).mailSubnetworkName,
  region: mail.region,
  network,
  ipCidrRange: mail.cidr,
  privateIpGoogleAccess: true,
  description: `Kvitbit ${config.stage} subnet in ${mail.region} for the Always-Free inbound mail forwarder.`,
});

export const mailAddressProps = (
  config: KvitbitStackConfig,
  mail: KvitbitMailConfig,
): AddressProps => ({
  addressName: resourceNames(config).mailAddressName,
  region: mail.region,
  addressType: "EXTERNAL",
  ipVersion: "IPV4",
  networkTier: "PREMIUM",
  description: `Static external IPv4 for ${mail.mxHost} inbound SMTP (billed per GCP VPC external IPv4 tariff).`,
  labels: {
    ...stackLabels(config),
    workload: "mail-ingress",
  },
});

export const mailFirewallProps = (config: KvitbitStackConfig, network: string): FirewallProps => {
  const names = resourceNames(config);
  return {
    firewallName: names.mailFirewallName,
    network,
    description: "Allow public inbound SMTP (TCP 25) to the Kvitbit inbound mail forwarder.",
    direction: "INGRESS",
    priority: 1000,
    allowed: [{ protocol: "tcp", ports: ["25"] }],
    sourceRanges: ["0.0.0.0/0"],
    targetTags: [names.mailTag],
  };
};

/**
 * Container-Optimized OS startup + reconcile script for the Kvitbit inbound mail forwarder.
 *
 * Security & operational invariants:
 * - Zero secrets in VM metadata: `RESEND_API_KEY` is fetched from Secret Manager only in
 *   `resend` mode and written atomically to tmpfs (`/run/kvitbit-mail/mail.env`, mode 0600).
 * - Host iptables redirects external TCP 25 -> local TCP 2525 while preserving real sender
 *   source IPs; the container runs unprivileged (`--user 1000:1000 --cap-drop=ALL --read-only
 *   --security-opt=no-new-privileges:true`).
 * - Generates a P-256 ECDSA opportunistic STARTTLS certificate on boot if missing.
 * - COS mounts `/var/lib/kvitbit-mail` noexec, so systemd runs the reconciler via `/bin/bash`.
 * - Verifies ETag consistency and SHA-256 hashes of config and bundled script before rollout,
 *   and publishes `guest-attributes/kvitbit/mail-active-target` only after `/healthz` passes.
 */
export const buildMailForwarderStartupScript = (): string => `#!/bin/bash
set -euo pipefail

install -d -m 0755 /var/lib/kvitbit-mail /var/lib/kvitbit-mail/tls
install -d -m 0700 /run/kvitbit-mail

cat <<'RECONCILE' > /var/lib/kvitbit-mail/reconcile-mail.sh
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
  local etag confirmed_etag config_hash script_hash
  etag="$(fetch_attributes_etag)" || return 1
  [ -n "$etag" ] || return 1
  TARGET_IMAGE_DIGEST="$(fetch_metadata "instance/attributes/kvitbit-mail-image-digest")" || return 1
  TARGET_IMAGE_REF="$(fetch_metadata "instance/attributes/kvitbit-mail-image-ref")" || return 1
  TARGET_CONFIG_SHA="$(fetch_metadata "instance/attributes/kvitbit-mail-config-sha")" || return 1
  TARGET_SCRIPT_SHA="$(fetch_metadata "instance/attributes/kvitbit-mail-script-sha")" || return 1
  fetch_metadata "instance/attributes/kvitbit-mail-config" > "$CONFIG_FILE" || return 1
  fetch_metadata "instance/attributes/kvitbit-mail-script-b64gz" | base64 -d | gunzip > "$SCRIPT_TMP" || return 1
  confirmed_etag="$(fetch_attributes_etag)" || return 1

  [ "$etag" = "$confirmed_etag" ] || return 1
  [[ "$TARGET_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  [[ "$TARGET_IMAGE_REF" == ?*@"$TARGET_IMAGE_DIGEST" ]] || return 1

  config_hash="$(sha256sum < "$CONFIG_FILE")" || return 1
  script_hash="$(sha256sum < "$SCRIPT_TMP")" || return 1
  [[ -s "$CONFIG_FILE" && "$TARGET_CONFIG_SHA" == "sha256:\${config_hash%% *}" ]] || return 1
  [[ -s "$SCRIPT_TMP" && "$TARGET_SCRIPT_SHA" == "sha256:\${script_hash%% *}" ]]
}

normalize_image_ref() {
  local ref="$1"
  ref="\${ref#index.docker.io/library/}"
  ref="\${ref#index.docker.io/}"
  ref="\${ref#docker.io/library/}"
  ref="\${ref#docker.io/}"
  printf '%s\\n' "$ref"
}

verified_image_id() {
  local image_info image_id expected_ref line
  image_info="$(docker image inspect --format='{{println .Id}}{{range .RepoDigests}}{{println .}}{{end}}' -- "$TARGET_IMAGE_REF")" || return 1
  read -r image_id <<< "$image_info"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  expected_ref="$(normalize_image_ref "$TARGET_IMAGE_REF")"
  while IFS= read -r line; do
    if [ -n "$line" ] && [ "$(normalize_image_ref "$line")" = "$expected_ref" ]; then
      printf '%s\\n' "$image_id"
      return 0
    fi
  done <<< "$(tail -n +2 <<< "$image_info")"
  return 1
}

forwarder_is_running() {
  local image_id="$1"
  local state
  state="$(docker inspect --type container --format='{{.State.Running}}|{{.Image}}|{{index .Config.Labels "kvitbit.mail_digest"}}|{{index .Config.Labels "kvitbit.mail_config_sha"}}|{{index .Config.Labels "kvitbit.mail_script_sha"}}' kvitbit-mail-forwarder 2>/dev/null)" || return 1
  [[ "$state" == "true|$image_id|$TARGET_IMAGE_DIGEST|$TARGET_CONFIG_SHA|$TARGET_SCRIPT_SHA" ]]
}

publish_guest_attribute() {
  local key="$1"
  local value="$2"
  curl -fsS --connect-timeout 5 --max-time 15 -X PUT -H "$HEADER" --data "$value" \
    "$METADATA/instance/guest-attributes/kvitbit/$key" >/dev/null 2>&1
}

ensure_host_firewall() {
  local smtp_port="$1"
  if ! iptables -C INPUT -p tcp --dport 25 -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport 25 -j ACCEPT
  fi
  if ! iptables -C INPUT -p tcp --dport "$smtp_port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport "$smtp_port" -j ACCEPT
  fi
  if ! iptables -t nat -C PREROUTING -p tcp --dport 25 -j REDIRECT --to-port "$smtp_port" 2>/dev/null; then
    iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port "$smtp_port"
  fi
}

ensure_tls_cert() {
  local mx_host="$1"
  local cert="\${STATE_DIR}/tls/cert.pem"
  local key="\${STATE_DIR}/tls/key.pem"
  if [ -s "$cert" ] && [ -s "$key" ]; then
    chown 1000:1000 "$cert" "$key"
    chmod 0644 "$cert"
    chmod 0600 "$key"
    return 0
  fi
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$key" -out "$cert" -days 3650 -nodes \
    -subj "/CN=\${mx_host}" -addext "subjectAltName=DNS:\${mx_host}"
  chown 1000:1000 "$cert" "$key"
  chmod 0644 "$cert"
  chmod 0600 "$key"
}

parse_mail_config() {
  awk '
    function json_str(line) {
      sub(/^[^:]*:[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*,?[[:space:]]*$/, "", line)
      return line
    }
    function json_scalar(line) {
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/[[:space:]]*,?[[:space:]]*$/, "", line)
      return line
    }
    BEGIN { in_aliases = 0; aliases = "" }
    /^  "aliases": \\[$/ { in_aliases = 1; next }
    in_aliases == 1 && /^  \\],?$/ { in_aliases = 0; printf "aliases\\t%s\\n", aliases; next }
    in_aliases == 1 {
      val = $0
      sub(/^[[:space:]]*"/, "", val)
      sub(/"[[:space:]]*,?[[:space:]]*$/, "", val)
      if (val != "") {
        aliases = (aliases == "" ? val : aliases "," val)
      }
      next
    }
    /^  "projectId":/ { printf "projectId\\t%s\\n", json_str($0); next }
    /^  "mxHost":/ { printf "mxHost\\t%s\\n", json_str($0); next }
    /^  "domain":/ { printf "domain\\t%s\\n", json_str($0); next }
    /^  "forwardTo":/ { printf "forwardTo\\t%s\\n", json_str($0); next }
    /^  "forwardFrom":/ { printf "forwardFrom\\t%s\\n", json_str($0); next }
    /^  "archiveBucket":/ { printf "archiveBucket\\t%s\\n", json_str($0); next }
    /^  "relayMode":/ { printf "relayMode\\t%s\\n", json_str($0); next }
    /^  "smtpPort":/ { printf "smtpPort\\t%s\\n", json_scalar($0); next }
    /^  "healthPort":/ { printf "healthPort\\t%s\\n", json_scalar($0); next }
    /^  "resendSecretId":/ { printf "resendSecretId\\t%s\\n", json_str($0); next }
  '
}

STATE_DIR="\${KVITBIT_MAIL_STATE_DIR:-/var/lib/kvitbit-mail}"
RUN_DIR="\${KVITBIT_MAIL_RUN_DIR:-/run/kvitbit-mail}"
install -d -m 0755 "$STATE_DIR" "\${STATE_DIR}/tls"
install -d -m 0700 "$RUN_DIR"

CONFIG_FILE="$(mktemp "\${RUN_DIR}/config.XXXXXX")"
SCRIPT_TMP="$(mktemp "\${RUN_DIR}/script.XXXXXX")"
SCRIPT_FILE="\${STATE_DIR}/mail-forwarder.mjs"
ENV_FILE="\${RUN_DIR}/mail.env"
ENV_TMP="\${RUN_DIR}/mail.env.tmp.$$"
TARGET_ENV_FILE="\${RUN_DIR}/mail-target.env"
TARGET_ENV_TMP="\${RUN_DIR}/mail-target.env.tmp.$$"
trap 'rm -f "$CONFIG_FILE" "$SCRIPT_TMP" "$ENV_TMP" "$TARGET_ENV_TMP"' EXIT

if ! retry_with_backoff 6 fetch_target; then
  echo "Failed to fetch consistent mail forwarder metadata" >&2
  exit 1
fi

PARSED="$(parse_mail_config < "$CONFIG_FILE")"
PROJECT_ID=""
MX_HOST=""
MAIL_DOMAIN=""
FORWARD_TO=""
FORWARD_FROM=""
ARCHIVE_BUCKET=""
RELAY_MODE=""
ALIASES=""
SMTP_PORT="2525"
HEALTH_PORT="8081"
RESEND_SECRET_ID=""

while IFS=$'\\t' read -r k v; do
  case "$k" in
    projectId) PROJECT_ID="$v" ;;
    mxHost) MX_HOST="$v" ;;
    domain) MAIL_DOMAIN="$v" ;;
    forwardTo) FORWARD_TO="$v" ;;
    forwardFrom) FORWARD_FROM="$v" ;;
    archiveBucket) ARCHIVE_BUCKET="$v" ;;
    relayMode) RELAY_MODE="$v" ;;
    aliases) ALIASES="$v" ;;
    smtpPort) SMTP_PORT="$v" ;;
    healthPort) HEALTH_PORT="$v" ;;
    resendSecretId) RESEND_SECRET_ID="$v" ;;
  esac
done <<EOF_CFG
$PARSED
EOF_CFG

if [ -z "$PROJECT_ID" ] || [ -z "$MX_HOST" ] || [ -z "$MAIL_DOMAIN" ] || [ -z "$FORWARD_TO" ] || [ -z "$ARCHIVE_BUCKET" ] || [ -z "$ALIASES" ]; then
  echo "Parsed mail forwarder config is missing required fields" >&2
  exit 1
fi

ensure_host_firewall "$SMTP_PORT"
ensure_tls_cert "$MX_HOST"

if VERIFIED_IMAGE_ID="$(verified_image_id 2>/dev/null)" && forwarder_is_running "$VERIFIED_IMAGE_ID" && curl -fsS --max-time 3 "http://127.0.0.1:\${HEALTH_PORT}/healthz" >/dev/null 2>&1; then
  publish_guest_attribute "mail-active-target" "$TARGET_IMAGE_DIGEST|$TARGET_CONFIG_SHA|$TARGET_SCRIPT_SHA" || true
  exit 0
fi

pull_verified_image() {
  docker pull -- "$TARGET_IMAGE_REF" || return 1
  VERIFIED_IMAGE_ID="$(verified_image_id)"
}
if ! VERIFIED_IMAGE_ID="$(verified_image_id 2>/dev/null)"; then
  if ! retry_with_backoff 6 pull_verified_image; then
    echo "Failed to pull and verify mail forwarder image $TARGET_IMAGE_REF" >&2
    exit 1
  fi
fi

chmod 0644 "$SCRIPT_TMP"
mv -f "$SCRIPT_TMP" "$SCRIPT_FILE"

umask 0177
{
  printf 'KVITBIT_MAIL_DOMAIN=%s\\n' "$MAIL_DOMAIN"
  printf 'KVITBIT_MAIL_MX_HOST=%s\\n' "$MX_HOST"
  printf 'KVITBIT_MAIL_FORWARD_TO=%s\\n' "$FORWARD_TO"
  printf 'KVITBIT_MAIL_FORWARD_FROM=%s\\n' "$FORWARD_FROM"
  printf 'KVITBIT_MAIL_ALIASES=%s\\n' "$ALIASES"
  printf 'KVITBIT_MAIL_ARCHIVE_BUCKET=%s\\n' "$ARCHIVE_BUCKET"
  printf 'KVITBIT_MAIL_RELAY_MODE=%s\\n' "$RELAY_MODE"
  printf 'KVITBIT_MAIL_PORT=%s\\n' "$SMTP_PORT"
  printf 'KVITBIT_MAIL_HEALTH_PORT=%s\\n' "$HEALTH_PORT"
  printf 'KVITBIT_MAIL_TLS_CERT_PATH=/app/tls/cert.pem\\n'
  printf 'KVITBIT_MAIL_TLS_KEY_PATH=/app/tls/key.pem\\n'
} > "$ENV_TMP"

if [ "$RELAY_MODE" = "resend" ]; then
  if [ -z "$RESEND_SECRET_ID" ]; then
    echo "relayMode=resend requires resendSecretId" >&2
    exit 1
  fi
  TOKEN_JSON="$(retry_with_backoff 8 fetch_metadata "instance/service-accounts/default/token")"
  ACCESS_TOKEN="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')"
  [ -n "$ACCESS_TOKEN" ] || { echo "Failed to resolve GCE access token" >&2; exit 1; }
  SECRET_URL="https://secretmanager.googleapis.com/v1/projects/\${PROJECT_ID}/secrets/\${RESEND_SECRET_ID}/versions/latest:access"
  fetch_secret_once() {
    curl -fsS --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $ACCESS_TOKEN" "$SECRET_URL"
  }
  SECRET_BODY="$(retry_with_backoff 6 fetch_secret_once)"
  SECRET_B64="$(printf '%s' "$SECRET_BODY" | tr -d '\\n' | sed -n 's/.*"data":[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
  [ -n "$SECRET_B64" ] || { echo "Empty Resend API key secret payload" >&2; exit 1; }
  RESEND_KEY="$(printf '%s' "$SECRET_B64" | base64 -d)"
  printf 'RESEND_API_KEY=%s\\n' "$RESEND_KEY" >> "$ENV_TMP"
fi

{
  printf 'KVITBIT_MAIL_IMAGE=%s\\n' "$VERIFIED_IMAGE_ID"
  printf 'KVITBIT_MAIL_DIGEST=%s\\n' "$TARGET_IMAGE_DIGEST"
  printf 'KVITBIT_MAIL_CONFIG_SHA=%s\\n' "$TARGET_CONFIG_SHA"
  printf 'KVITBIT_MAIL_SCRIPT_SHA=%s\\n' "$TARGET_SCRIPT_SHA"
} > "$TARGET_ENV_TMP"

publish_guest_attribute "mail-active-target" "pending" || true
systemctl stop kvitbit-mail-forwarder.service || true
mv -f "$ENV_TMP" "$ENV_FILE"
mv -f "$TARGET_ENV_TMP" "$TARGET_ENV_FILE"
systemctl start kvitbit-mail-forwarder.service

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if forwarder_is_running "$VERIFIED_IMAGE_ID" && curl -fsS --max-time 3 "http://127.0.0.1:\${HEALTH_PORT}/healthz" >/dev/null 2>&1; then
    publish_guest_attribute "mail-active-target" "$TARGET_IMAGE_DIGEST|$TARGET_CONFIG_SHA|$TARGET_SCRIPT_SHA"
    exit 0
  fi
  sleep 2
done

echo "kvitbit-mail-forwarder did not become healthy" >&2
exit 1
RECONCILE

chmod 0700 /var/lib/kvitbit-mail/reconcile-mail.sh

cat <<'UNIT' > /etc/systemd/system/kvitbit-mail-forwarder.service
[Unit]
Description=Kvitbit Inbound Mail Forwarder
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
EnvironmentFile=/run/kvitbit-mail/mail-target.env
ExecStartPre=-/usr/bin/docker rm -f kvitbit-mail-forwarder
ExecStart=/usr/bin/docker run --pull=never --rm --name kvitbit-mail-forwarder --label kvitbit.mail_digest=\${KVITBIT_MAIL_DIGEST} --label kvitbit.mail_config_sha=\${KVITBIT_MAIL_CONFIG_SHA} --label kvitbit.mail_script_sha=\${KVITBIT_MAIL_SCRIPT_SHA} --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --tmpfs /tmp:size=64m --user 1000:1000 --network host -v /var/lib/kvitbit-mail/mail-forwarder.mjs:/app/mail-forwarder.mjs:ro -v /var/lib/kvitbit-mail/tls:/app/tls:ro --env-file /run/kvitbit-mail/mail.env \${KVITBIT_MAIL_IMAGE} bun /app/mail-forwarder.mjs
ExecStop=/usr/bin/docker stop -t 15 kvitbit-mail-forwarder

[Install]
WantedBy=multi-user.target
UNIT

cat <<'RECONCILE_UNIT' > /etc/systemd/system/kvitbit-mail-reconcile.service
[Unit]
Description=Reconcile Kvitbit Inbound Mail Forwarder from GCE metadata
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash /var/lib/kvitbit-mail/reconcile-mail.sh
RECONCILE_UNIT

cat <<'RECONCILE_TIMER' > /etc/systemd/system/kvitbit-mail-reconcile.timer
[Unit]
Description=Poll GCE metadata for Kvitbit mail forwarder config and script updates

[Timer]
OnBootSec=15s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=kvitbit-mail-reconcile.service

[Install]
WantedBy=timers.target
RECONCILE_TIMER

systemctl daemon-reload
systemctl enable kvitbit-mail-forwarder.service
systemctl enable --now kvitbit-mail-reconcile.timer
systemctl start kvitbit-mail-reconcile.service
`;

export const mailInstanceProps = (
  config: KvitbitStackConfig,
  mail: KvitbitMailConfig,
  deps: {
    readonly network: string;
    readonly subnetwork: string;
    readonly natIP: string;
    readonly serviceAccountEmail?: string;
    readonly scriptB64Gz: string;
    readonly scriptSha: string;
    readonly startupScript?: string;
  },
): InstanceProps => {
  const names = resourceNames(config);
  const runtimeConfig = buildMailForwarderConfig(config, mail);
  const runtimeConfigJson = serializeMailForwarderConfig(runtimeConfig);
  const runtimeConfigSha = sha256Prefixed(runtimeConfigJson);
  return {
    instanceName: names.mailInstanceName,
    zone: mail.zone,
    machineType: "e2-micro",
    description: `Kvitbit ${config.stage} inbound SMTP forwarder for ${mail.domain} (US e2-micro compute + pd-standard disk; external IPv4 billed per GCP VPC tariff).`,
    labels: {
      ...stackLabels(config),
      workload: "mail-ingress",
    },
    tags: [names.mailTag],
    sourceImage: COS_STABLE_IMAGE,
    diskSizeGb: 20,
    bootDiskType: "pd-standard",
    preemptible: false,
    network: deps.network,
    subnetwork: deps.subnetwork,
    natIP: deps.natIP,
    automaticRestart: true,
    serviceAccount:
      deps.serviceAccountEmail ?? serviceAccountEmail(config.projectId, names.mailServiceAccountId),
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    shieldedInstanceConfig: {
      enableSecureBoot: true,
      enableVtpm: true,
      enableIntegrityMonitoring: true,
    },
    metadata: {
      "startup-script": deps.startupScript ?? buildMailForwarderStartupScript(),
      "kvitbit-mail-image-ref": MAIL_FORWARDER_BUN_IMAGE_REF,
      "kvitbit-mail-image-digest": MAIL_FORWARDER_BUN_IMAGE_DIGEST,
      "kvitbit-mail-config": runtimeConfigJson,
      "kvitbit-mail-config-sha": runtimeConfigSha,
      "kvitbit-mail-script-b64gz": deps.scriptB64Gz,
      "kvitbit-mail-script-sha": deps.scriptSha,
      "enable-guest-attributes": "TRUE",
      "enable-oslogin": "TRUE",
    },
  };
};

const declaredString = (resource: string, field: string) =>
  Output.map((value: string | undefined) => {
    if (value === undefined || value.length === 0) {
      throw new Error(`${resource} reported no ${field}`);
    }
    return value;
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

export const declareMailForwarder = Effect.fn("KvitbitStack.declareMailForwarder")(function* (
  config: KvitbitStackConfig,
  mail: KvitbitMailConfig,
  deps: {
    readonly networkSelfLink: Output.Output<string | undefined>;
    readonly resendSecretName: Output.Output<string> | undefined;
  },
) {
  const bundle = yield* bundleMailForwarderScript;
  const networkLink = deps.networkSelfLink.pipe(declaredString("KvitbitVpc", "selfLink"));

  const mailSa = yield* IAM.ServiceAccount("KvitbitMailIngressSa", mailServiceAccountProps(config));
  const archiveBucket = yield* Storage.Bucket(
    "KvitbitMailArchive",
    mailArchiveBucketProps(config, mail),
  );

  // Write-only objectCreator on the archive bucket: compromised VM cannot read/delete old mail.
  const archiveWriter = yield* IAM.Member("MailIngressArchiveWriter", {
    kind: "storage.bucket",
    name: archiveBucket.bucketName,
    role: "roles/storage.objectCreator",
    member: Output.interpolate`serviceAccount:${mailSa.email}`,
  });

  const resendSecretAccessor =
    mail.relayMode === "resend"
      ? yield* IAM.Member("MailIngressResendSecretAccessor", {
          kind: "secretmanager.secret",
          name:
            deps.resendSecretName ??
            secretResourceName(config.projectId, `${resourceNames(config).prefix}-resend-api-key`),
          role: "roles/secretmanager.secretAccessor",
          member: Output.interpolate`serviceAccount:${mailSa.email}`,
        })
      : undefined;

  const subnetwork = yield* Compute.Subnetwork("KvitbitMailSubnet", {
    ...mailSubnetworkProps(config, mail, ""),
    network: networkLink,
  });
  const subnetworkLink = subnetwork.selfLink.pipe(declaredString("KvitbitMailSubnet", "selfLink"));

  const address = yield* Compute.Address("KvitbitMailAddress", mailAddressProps(config, mail));
  const resolvedIp = address.address.pipe(declaredString("KvitbitMailAddress", "address"));

  const firewall = yield* Compute.Firewall("KvitbitMailSmtpIngress", {
    ...mailFirewallProps(config, ""),
    network: networkLink,
  });

  const mailServiceAccount = afterResources(mailSa.email, [
    subnetworkLink,
    firewall.firewallName,
    archiveWriter.member,
    ...(resendSecretAccessor ? [resendSecretAccessor.member] : []),
  ]);

  const baseInstance = mailInstanceProps(config, mail, {
    network: "",
    subnetwork: "",
    natIP: "",
    scriptB64Gz: bundle.scriptB64Gz,
    scriptSha: bundle.sha,
  });

  const instance = yield* Compute.Instance("KvitbitMailIngress", {
    ...baseInstance,
    network: networkLink,
    subnetwork: subnetworkLink,
    natIP: resolvedIp,
    serviceAccount: mailServiceAccount,
  });

  return {
    instanceName: instance.instanceName,
    zone: mail.zone,
    mxHost: mail.mxHost,
    mailIpAddress: address.address,
    archiveBucket: archiveBucket.bucketName,
    relayMode: mail.relayMode,
    configSha: baseInstance.metadata?.["kvitbit-mail-config-sha"] ?? "",
    scriptSha: bundle.sha,
  };
});
