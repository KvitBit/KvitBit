import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Output from "alchemy/Output";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  defaultSecretBindings,
  imageReference,
  KVITBIT_PROD_DEFAULTS,
  type KvitbitStackConfig,
  loadStackConfig,
  resourceNames,
  validateStackConfig,
} from "../src/config";
import { runnerPlainEnv, serverPlainEnv, serverSecretEnv } from "../src/env";
import {
  declareKvitbitEdge,
  declareTokenRouteLogExclusion,
  edgeDynamicBackendProps,
  edgeObjectNames,
  edgeSecurityPolicyProps,
  edgeStaticAssetPaths,
  edgeStaticBackendProps,
  edgeUrlMapProps,
  tokenRouteExclusionFilter,
  tokenRoutePatterns,
} from "../src/resources/edge";
import {
  artifactRepositoryProps,
  blobsBucketProps,
  declareFoundation,
  mobileAssetsBucketProps,
  secretAccessorGrants,
  secretDeclarations,
} from "../src/resources/foundation";
import {
  buildRunnerStartupScript,
  COS_STABLE_IMAGE,
  declareNetworkAndRunners,
  networkProps,
  routerProps,
  runnerFirewallProps,
  runnerInstanceProps,
  subnetworkProps,
} from "../src/resources/network";
import { declareServerService, serverServiceProps } from "../src/resources/server";

const SAMPLE_DIGEST = `sha256:${"a".repeat(64)}`;

const sampleProdConfig = (overrides: Partial<KvitbitStackConfig> = {}): KvitbitStackConfig => ({
  stage: "prod",
  bootstrapFoundation: false,
  projectId: KVITBIT_PROD_DEFAULTS.projectId,
  projectNumber: KVITBIT_PROD_DEFAULTS.projectNumber,
  region: KVITBIT_PROD_DEFAULTS.region,
  zone: KVITBIT_PROD_DEFAULTS.zone,
  stateBucket: KVITBIT_PROD_DEFAULTS.stateBucket,
  artifactRepositoryId: KVITBIT_PROD_DEFAULTS.artifactRepositoryId,
  imageName: KVITBIT_PROD_DEFAULTS.imageName,
  imageDigest: SAMPLE_DIGEST,
  blobsBucket: "kvitbit-prod-blobs-prod",
  mobileAssetsBucket: "kvitbit-prod-mobile-prod",
  runnerCount: 2,
  runnerMachineType: "e2-standard-2",
  runnerPort: 34431,
  runnerCidr: "10.42.0.0/20",
  serverMinInstances: 0,
  serverMaxInstances: 10,
  appOrigin: "https://kvitbit.cz",
  emailFrom: "Kvitbit <no-reply@kvitbit.cz>",
  trustedProxyHops: 2,
  shareKeyVersion: 1,
  androidAssetlinksSha256: "AA:BB:CC",
  secrets: defaultSecretBindings("prod", {
    enableResend: true,
    enableSmtp: true,
    enableMobileSigningKey: true,
  }),
  edge: {
    domains: ["kvitbit.cz", "kvitbit.app"],
    enableHttps: true,
    staticCdnEnabled: true,
    wafPreview: false,
    authRateLimitPerMinute: 60,
    restrictDirectIngress: true,
  },
  ...overrides,
});

describe("Kvitbit Alchemy stack config", () => {
  test("loads kvitbit-prod defaults from ConfigProvider", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.stage).toBe("prod");
    expect(config.projectId).toBe("kvitbit-prod");
    expect(config.projectNumber).toBe("449188423567");
    expect(config.region).toBe("europe-west3");
    expect(config.zone).toBe("europe-west3-a");
    expect(config.stateBucket).toBe("alchemy-state-kvitbit-prod");
    expect(config.runnerPort).toBe(34431);
    expect(config.trustedProxyHops).toBe(1);
    expect(config.edge).toBeUndefined();
    expect(imageReference(config)).toBe(
      `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${SAMPLE_DIGEST}`,
    );
  });

  test("enables HTTPS edge, restricts direct Cloud Run ingress by default, and bumps trustedProxyHops when KVITBIT_EDGE_DOMAINS is set", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_EDGE_DOMAINS: "kvitbit.cz, kvitbit.app",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.edge?.domains).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(config.edge?.enableHttps).toBe(true);
    expect(config.edge?.restrictDirectIngress).toBe(true);
    expect(config.trustedProxyHops).toBe(2);
  });

  test("handles empty GitHub Actions vars, optional secret flags, and bootstrapFoundation mode", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_BOOTSTRAP_FOUNDATION: "true",
        KVITBIT_RUNNER_COUNT: "",
        KVITBIT_ENABLE_RESEND_SECRET: "true",
        KVITBIT_ENABLE_SMTP_SECRET: "",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "true",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.bootstrapFoundation).toBe(true);
    expect(config.imageDigest).toBe("");
    expect(config.runnerCount).toBe(KVITBIT_PROD_DEFAULTS.runnerCount);
    const secretIds = config.secrets.map((s) => s.secretId);
    expect(secretIds).toContain("kvitbit-prod-database-url");
    expect(secretIds).toContain("kvitbit-prod-runner-database-url-unpooled");
    expect(secretIds).toContain("kvitbit-prod-resend-api-key");
    expect(secretIds).toContain("kvitbit-prod-mobile-updates-signing-key");
    expect(secretIds).not.toContain("kvitbit-prod-smtp-url");
  });

  test("rejects mutable image tags, cross-region zones, and out-of-range runnerCount", async () => {
    const badDigest = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ imageDigest: "latest" }))),
    );
    expect(badDigest.field).toBe("imageDigest");

    const badZone = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ zone: "us-central1-a" }))),
    );
    expect(badZone.field).toBe("zone");

    const badRunners = await Effect.runPromise(
      Effect.flip(validateStackConfig(sampleProdConfig({ runnerCount: 0 }))),
    );
    expect(badRunners.field).toBe("runnerCount");
  });
});

describe("Foundation resources", () => {
  test("configures immutable Artifact Registry, private versioned GCS buckets, and least-privilege secret grants", () => {
    const config = sampleProdConfig();
    const repo = artifactRepositoryProps(config);
    expect(repo.location).toBe("europe-west3");
    expect(repo.format).toBe("DOCKER");
    expect(repo.dockerConfig?.immutableTags).toBe(true);

    const blobs = blobsBucketProps(config);
    expect(blobs.uniformBucketLevelAccess).toBe(true);
    expect(blobs.versioning).toBe(true);
    expect(blobs.forceDestroy).toBe(false);

    const mobile = mobileAssetsBucketProps(config);
    expect(mobile.uniformBucketLevelAccess).toBe(true);
    expect(mobile.versioning).toBe(true);
    expect(mobile.forceDestroy).toBe(false);

    const secrets = secretDeclarations(config);
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-database-url");
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-runner-database-url-unpooled");
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-better-auth-secret");

    const grants = secretAccessorGrants(config);
    const mobileSigningGrants = grants.filter(
      (g) => g.secretId === "kvitbit-prod-mobile-updates-signing-key",
    );
    expect(mobileSigningGrants.map((g) => g.workload)).toEqual(["server"]);
    const dbGrants = grants.filter((g) => g.secretId === "kvitbit-prod-database-url");
    expect(dbGrants.map((g) => g.workload).sort()).toEqual(["runner", "server"]);
    const runnerUnpooledGrants = grants.filter(
      (g) => g.secretId === "kvitbit-prod-runner-database-url-unpooled",
    );
    expect(runnerUnpooledGrants.map((g) => g.workload)).toEqual(["runner"]);
  });

  test("constructs the full Alchemy stack with real Output proxies without coercion errors and wires explicit DAG dependencies", async () => {
    const config = sampleProdConfig({ edge: undefined });

    const compileHermetic = <A, E, R>(
      name: string,
      program: Effect.Effect<A, E, R>,
    ): Promise<Stack.CompiledStack<A, unknown>> => {
      const makeStack = Stack.make({
        name,
        state: State.inMemoryState(),
        providers: Layer.empty,
      }) as <Out>(
        eff: Effect.Effect<Out, E, R>,
      ) => Effect.Effect<Stack.CompiledStack<Out, unknown>, E, unknown>;

      return Effect.runPromise(
        Effect.scoped(makeStack(program)).pipe(
          Effect.provide(Layer.succeed(Stage, "prod")),
        ) as Effect.Effect<Stack.CompiledStack<A, unknown>, E, never>,
      );
    };

    const compiled = await compileHermetic(
      "KvitbitTest",
      Effect.gen(function* () {
        const foundation = yield* declareFoundation(config);
        const tokenRouteExclusion = yield* declareTokenRouteLogExclusion(config);
        const network = yield* declareNetworkAndRunners(config, {
          runnerServiceAccountEmail: foundation.runnerServiceAccountEmail,
          blobsBucketName: config.blobsBucket,
          runnerDependencies: foundation.runnerDependencies,
        });
        const server = yield* declareServerService(config, {
          networkName: network.networkName,
          subnetworkName: network.subnetworkName,
          blobsBucketName: config.blobsBucket,
          mobileAssetsBucketName: config.mobileAssetsBucket,
          serverServiceAccountEmail: foundation.serverServiceAccountEmail,
          serverDependencies: [
            ...foundation.serverDependencies,
            ...network.networkReadyDependencies,
          ],
        });
        return { foundation, tokenRouteExclusion, network, server };
      }),
    );

    const resourceIds = Object.keys(compiled.resources);
    // Token-route log exclusion is installed unconditionally even when edge is disabled
    expect(resourceIds).toContain("EdgeTokenRouteExclusion");

    const runner0 = compiled.resources.KvitbitRunner0;
    const serverRes = compiled.resources.KvitbitServer;
    expect(runner0).toBeDefined();
    expect(serverRes).toBeDefined();

    const runnerUpstreams = Object.keys(Output.upstreamAny(runner0?.Props));
    expect(runnerUpstreams).toEqual(
      expect.arrayContaining([
        "KvitbitRunnerSubnet",
        "KvitbitRouter",
        "KvitbitRunnerClusterIngress",
        "RunnerBlobsAdmin",
        "RunnerArtifactReader",
        "SecretAccess-kvitbit-prod-database-url-runner",
        "SecretAccess-kvitbit-prod-runner-database-url-unpooled-runner",
        "SecretAccess-kvitbit-prod-better-auth-secret-runner",
      ]),
    );

    const serverUpstreams = Object.keys(Output.upstreamAny(serverRes?.Props));
    expect(serverUpstreams).toEqual(
      expect.arrayContaining([
        "KvitbitRunnerSubnet",
        "KvitbitRouter",
        "KvitbitRunnerClusterIngress",
        "ServerBlobsAdmin",
        "ServerMobileAssetsViewer",
        "SecretAccess-kvitbit-prod-database-url-server",
        "SecretAccess-kvitbit-prod-better-auth-secret-server",
      ]),
    );
    expect(serverUpstreams).not.toContain(
      "SecretAccess-kvitbit-prod-runner-database-url-unpooled-server",
    );

    // Also verify edge construction with real Outputs produces zero coercion exceptions
    const edgeConfig = sampleProdConfig();
    const compiledWithEdge = await compileHermetic(
      "KvitbitEdgeTest",
      Effect.gen(function* () {
        const foundation = yield* declareFoundation(edgeConfig);
        const network = yield* declareNetworkAndRunners(edgeConfig, {
          runnerServiceAccountEmail: foundation.runnerServiceAccountEmail,
          blobsBucketName: edgeConfig.blobsBucket,
          runnerDependencies: foundation.runnerDependencies,
        });
        const server = yield* declareServerService(edgeConfig, {
          networkName: network.networkName,
          subnetworkName: network.subnetworkName,
          blobsBucketName: edgeConfig.blobsBucket,
          mobileAssetsBucketName: edgeConfig.mobileAssetsBucket,
          serverServiceAccountEmail: foundation.serverServiceAccountEmail,
          serverDependencies: [
            ...foundation.serverDependencies,
            ...network.networkReadyDependencies,
          ],
        });
        const edge =
          edgeConfig.edge === undefined
            ? undefined
            : yield* declareKvitbitEdge(edgeConfig, edgeConfig.edge, server.serviceId);
        return { edge };
      }),
    );
    expect(Object.keys(compiledWithEdge.resources)).toContain("EdgeSecurityPolicy");
  });
});

describe("Pure-Alchemy Compute Engine runner pool (#908)", () => {
  test("declares custom VPC, private subnet with Cloud NAT, internal TCP 34431 firewall, and private COS instances", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);

    const vpc = networkProps(config);
    expect(vpc.autoCreateSubnetworks).toBe(false);

    const subnet = subnetworkProps(config, names.networkName);
    expect(subnet.privateIpGoogleAccess).toBe(true);
    expect(subnet.ipCidrRange).toBe("10.42.0.0/20");

    const router = routerProps(config, names.networkName);
    expect(router.nats?.[0]?.natIpAllocateOption).toBe("AUTO_ONLY");

    const fw = runnerFirewallProps(config, names.networkName);
    expect(fw.direction).toBe("INGRESS");
    expect(fw.allowed).toEqual([{ protocol: "tcp", ports: ["34431"] }]);
    expect(fw.sourceRanges).toEqual(["10.42.0.0/20"]);
    expect(fw.targetTags).toEqual([names.runnerTag]);

    const vm = runnerInstanceProps(config, 0, {
      network: names.networkName,
      subnetwork: names.subnetworkName,
    });
    expect(vm.sourceImage).toBe(COS_STABLE_IMAGE);
    expect(vm.associatePublicIp).toBe(false);
    expect(vm.zone).toBe("europe-west3-a");
    expect(vm.shieldedInstanceConfig?.enableSecureBoot).toBe(true);
    expect(vm.tags).toEqual([names.runnerTag]);
  });

  test("startup script configures COS host iptables, systemd digest reconciliation, backoff retries, and S5 runner DB secrets", () => {
    const config = sampleProdConfig();
    const script = buildRunnerStartupScript(config);

    // Valid bash syntax
    const syntaxCheck = Bun.spawnSync(["bash", "-n"], {
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(syntaxCheck.exitCode).toBe(0);

    expect(script).toContain("network-interfaces/0/ip");
    expect(script).toContain(
      'iptables -C INPUT -s "$RUNNER_CIDR" -p tcp --dport "$RUNNER_PORT" -j ACCEPT',
    );
    expect(script).toContain(
      'iptables -I INPUT -s "$RUNNER_CIDR" -p tcp --dport "$RUNNER_PORT" -j ACCEPT',
    );
    expect(script).toContain("kvitbit-worker-reconcile.timer");
    expect(script).toContain("instance/attributes/kvitbit-image-ref");
    expect(script).toContain("instance/attributes/kvitbit-image-digest");
    expect(script).toContain("guest-attributes/kvitbit/active-digest");
    expect(script).toContain("retry_with_backoff");
    expect(script).toContain("secretmanager.googleapis.com/v1/projects/kvitbit-prod/secrets/");
    expect(script).toContain("fetch_secret 'DATABASE_URL' 'kvitbit-prod-database-url'");
    expect(script).toContain(
      "fetch_secret 'DATABASE_URL_UNPOOLED' 'kvitbit-prod-runner-database-url-unpooled'",
    );
    expect(script).toContain("fetch_secret 'BETTER_AUTH_SECRET' 'kvitbit-prod-better-auth-secret'");
    expect(script).toContain("'KVITBIT_RUNNER_MODE' 'cluster'");
    expect(script).toContain("'KVITBIT_BLOB_DRIVER' 'gcs'");
    expect(script).toContain("'KVITBIT_CHROMIUM_PATH' '/usr/bin/chromium'");
    expect(script).toContain("'PORT' '34431'");

    const vm = runnerInstanceProps(config, 0, {
      network: "vpc",
      subnetwork: "subnet",
    });
    expect(vm.metadata?.["kvitbit-image-ref"]).toBe(imageReference(config));
    expect(vm.metadata?.["kvitbit-image-digest"]).toBe(config.imageDigest);
    expect(vm.metadata?.["enable-guest-attributes"]).toBe("TRUE");

    const runnerEnvNames = runnerPlainEnv(config, config.blobsBucket).map((e) => e.name);
    expect(runnerEnvNames).toEqual(
      expect.arrayContaining([
        "PORT",
        "LISTEN_HOST",
        "KVITBIT_RUNNER_MODE",
        "KVITBIT_BLOB_DRIVER",
        "KVITBIT_BLOB_BUCKET",
        "KVITBIT_GCS_PROJECT",
        "KVITBIT_CHROMIUM_PATH",
        "APP_ORIGIN",
        "EMAIL_FROM",
      ]),
    );
  });

  test("reconcile script rolls out new digest, skips no-op ticks, opens iptables idempotently, and retries transient failures", () => {
    const config = sampleProdConfig();
    const startup = buildRunnerStartupScript(config);
    const match = startup.match(
      /cat <<'RECONCILE' > \/var\/lib\/kvitbit\/reconcile-worker\.sh\n([\s\S]*?)\nRECONCILE\n/,
    );
    expect(match?.[1]).toBeDefined();

    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-reconcile-"));
    try {
      const binDir = join(sandbox, "bin");
      const runDir = join(sandbox, "run");
      const stateDir = join(sandbox, "state");
      Bun.spawnSync(["mkdir", "-p", binDir, runDir, stateDir]);

      // Rewrite /run/kvitbit to sandboxed runDir for hermetic execution
      const reconcileScript = (match?.[1] ?? "").replaceAll("/run/kvitbit", runDir);
      const scriptPath = join(sandbox, "reconcile-worker.sh");
      writeFileSync(scriptPath, reconcileScript);
      chmodSync(scriptPath, 0o755);

      const digest1 = SAMPLE_DIGEST;
      const digest2 = `sha256:${"b".repeat(64)}`;
      const ref1 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest1}`;
      const ref2 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest2}`;
      writeFileSync(join(stateDir, "target-ref"), ref1);
      writeFileSync(join(stateDir, "target-digest"), digest1);
      writeFileSync(join(stateDir, "fail-once"), "1");

      // Stub sleep (no-op for fast retry test)
      writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "sleep"), 0o755);

      // Stub iptables (tracks whether rule is installed)
      writeFileSync(
        join(binDir, "iptables"),
        `#!/bin/sh
set -eu
RULE_FILE="${stateDir}/iptables-rule"
if [ "$1" = "-C" ]; then
  [ -f "$RULE_FILE" ]
  exit $?
elif [ "$1" = "-I" ]; then
  echo "$*" > "$RULE_FILE"
  echo "iptables:$*" >> "${stateDir}/log"
  exit 0
fi
exit 1
`,
      );
      chmodSync(join(binDir, "iptables"), 0o755);

      // Stub curl (simulates metadata, transient failure on first metadata call, Secret Manager, and guest attributes PUT)
      writeFileSync(
        join(binDir, "curl"),
        `#!/bin/sh
set -eu
URL=""
DATA=""
METHOD="GET"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) METHOD="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    -H|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) URL="$1"; shift ;;
  esac
done

if [ "$METHOD" = "PUT" ]; then
  printf '%s' "$DATA" > "${stateDir}/guest-active-digest"
  exit 0
fi

case "$URL" in
  *"network-interfaces/0/ip")
    if [ -f "${stateDir}/fail-once" ]; then
      rm -f "${stateDir}/fail-once"
      exit 22
    fi
    printf '10.42.0.10'
    ;;
  *"service-accounts/default/token")
    printf '{"access_token":"tok-123","expires_in":3600}'
    ;;
  *"attributes/kvitbit-image-ref")
    cat "${stateDir}/target-ref"
    ;;
  *"attributes/kvitbit-image-digest")
    cat "${stateDir}/target-digest"
    ;;
  *"secretmanager.googleapis.com"*)
    SECRET_VAL="$(printf '%s' "secret-val" | base64 | tr -d '\\n')"
    printf '{"payload":{"data":"%s"}}' "$SECRET_VAL"
    ;;
  *)
    exit 1
    ;;
esac
`,
      );
      chmodSync(join(binDir, "curl"), 0o755);

      // Stub docker
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/sh
set -eu
case "$1" in
  inspect)
    if [ -f "${stateDir}/running-digest" ]; then
      printf 'true|%s' "$(cat "${stateDir}/running-digest")"
    fi
    ;;
  login)
    cat >/dev/null
    echo "docker:login" >> "${stateDir}/log"
    ;;
  pull)
    echo "docker:pull:$2" >> "${stateDir}/log"
    ;;
esac
`,
      );
      chmodSync(join(binDir, "docker"), 0o755);

      // Stub systemctl (activates target digest as running)
      writeFileSync(
        join(binDir, "systemctl"),
        `#!/bin/sh
set -eu
echo "systemctl:$*" >> "${stateDir}/log"
. "${runDir}/worker-target.env"
printf '%s' "$KVITBIT_WORKER_DIGEST" > "${stateDir}/running-digest"
`,
      );
      chmodSync(join(binDir, "systemctl"), 0o755);

      const env = { PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` };

      // 1. Initial boot reconcile (survives transient metadata failure, installs iptables, pulls & starts digest1)
      const first = Bun.spawnSync(["bash", scriptPath], { env, stdout: "pipe", stderr: "pipe" });
      expect(first.exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest1);
      expect(readFileSync(join(runDir, "worker.env"), "utf8")).toContain(
        "DATABASE_URL_UNPOOLED=secret-val",
      );
      expect(readFileSync(join(stateDir, "iptables-rule"), "utf8")).toContain("10.42.0.0/20");

      const logAfterFirst = readFileSync(join(stateDir, "log"), "utf8");
      expect(logAfterFirst).toContain("systemctl:restart kvitbit-worker.service");

      // 2. Second reconcile with same digest is a no-op (no restart, no duplicate iptables insert)
      const second = Bun.spawnSync(["bash", scriptPath], { env, stdout: "pipe", stderr: "pipe" });
      expect(second.exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterFirst);

      // 3. Metadata digest update triggers pull + restart + updated guest-attribute publication
      writeFileSync(join(stateDir, "target-ref"), ref2);
      writeFileSync(join(stateDir, "target-digest"), digest2);
      const third = Bun.spawnSync(["bash", scriptPath], { env, stdout: "pipe", stderr: "pipe" });
      expect(third.exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest2);
      const logAfterThird = readFileSync(join(stateDir, "log"), "utf8");
      expect(logAfterThird).toContain(`docker:pull:${ref2}`);
      expect(
        logAfterThird.split("\n").filter((l) => l === "systemctl:restart kvitbit-worker.service")
          .length,
      ).toBe(2);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("Cloud Run server service", () => {
  test("wires Direct VPC egress, /healthz probes, cluster mode, and all shared env vars", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);
    const props = serverServiceProps(config, {
      networkName: names.networkName,
      subnetworkName: names.subnetworkName,
      blobsBucketName: config.blobsBucket,
      mobileAssetsBucketName: config.mobileAssetsBucket,
    });

    expect(props.location).toBe("europe-west3");
    expect(props.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(props.template?.vpcAccess?.egress).toBe("PRIVATE_RANGES_ONLY");
    expect(props.template?.vpcAccess?.networkInterfaces?.[0]).toEqual({
      network: names.networkName,
      subnetwork: names.subnetworkName,
    });

    const container = props.template?.containers?.[0];
    expect(container && "image" in container ? container.image : undefined).toBe(
      imageReference(config),
    );
    expect(
      container && "startupProbe" in container ? container.startupProbe?.httpGet?.path : null,
    ).toBe("/healthz");
    expect(
      container && "livenessProbe" in container ? container.livenessProbe?.httpGet?.path : null,
    ).toBe("/healthz");

    const plainNames = serverPlainEnv(config, {
      blobsBucket: config.blobsBucket,
      mobileAssetsBucket: config.mobileAssetsBucket,
    }).map((e) => e.name);
    const secretNames = serverSecretEnv(config).map((e) => e.name);

    for (const required of [
      "KVITBIT_RUNNER_MODE",
      "KVITBIT_BLOB_DRIVER",
      "KVITBIT_BLOB_DIR",
      "KVITBIT_BLOB_BUCKET",
      "KVITBIT_GCS_PROJECT",
      "KVITBIT_WEB_DIR",
      "KVITBIT_PWA_DIR",
      "KVITBIT_CHROMIUM_PATH",
      "APP_ORIGIN",
      "EMAIL_FROM",
      "KVITBIT_TRUSTED_PROXY_HOPS",
      "KVITBIT_SHARE_KEY_VERSION",
      "KVITBIT_MOBILE_STORAGE_BUCKET",
      "KVITBIT_MOBILE_STORAGE_DIR",
      "KVITBIT_ANDROID_ASSETLINKS_SHA256",
    ]) {
      expect(plainNames).toContain(required);
    }

    for (const requiredSecret of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "RESEND_API_KEY",
      "KVITBIT_SMTP_URL",
      "KVITBIT_MOBILE_UPDATES_SIGNING_KEY",
    ]) {
      expect(secretNames).toContain(requiredSecret);
    }
    // S5: Cloud Run server never receives runner direct-connection credentials
    expect(secretNames).not.toContain("DATABASE_URL_UNPOOLED");
  });
});

describe("Pure-Alchemy Edge (Cloud Armor + Cloud CDN + Token Log Exclusion)", () => {
  test("wires WAF, /api/auth/ throttling, static CDN, and token-route log exclusion", () => {
    const config = sampleProdConfig();
    const edge = config.edge;
    if (edge === undefined) {
      throw new Error("expected edge config");
    }

    const names = edgeObjectNames(config);
    expect(names.securityPolicy).toBe("kvitbit-prod-edge-armor");

    const policy = edgeSecurityPolicyProps(config, edge);
    expect(policy.type).toBe("CLOUD_ARMOR");
    expect(policy.rules.some((r) => r.action === "throttle")).toBe(true);
    expect(policy.rules.some((r) => r.priority === 2147483647 && r.action === "allow")).toBe(true);

    const links = { backendGroup: "neg-link", securityPolicy: "policy-link" };
    const dyn = edgeDynamicBackendProps(config, links);
    expect(dyn.logConfig.enable).toBe(false);

    const stat = edgeStaticBackendProps(config, edge, links);
    expect("cdnPolicy" in stat && stat.cdnPolicy?.cacheMode).toBe("USE_ORIGIN_HEADERS");

    const urlMap = edgeUrlMapProps(config, edge, { dynamic: "dyn", static: "stat" });
    expect(urlMap.hostRules[0]?.hosts).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(urlMap.pathMatchers[0]?.pathRules[0]?.paths).toEqual([...edgeStaticAssetPaths]);

    expect(tokenRouteExclusionFilter).toContain("/i/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/invite/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/share/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/invitations/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/auth/magic-link/verify");

    // Behavioral regex check against real token-bearing and non-token URLs
    const regexMatch = tokenRouteExclusionFilter.match(/httpRequest\.requestUrl=~"([^"]+)"/);
    expect(regexMatch?.[1]).toBeDefined();
    const pattern = new RegExp(regexMatch?.[1] ?? "");

    for (const url of [
      "https://kvitbit.cz/i/tok123",
      "https://kvitbit.cz/i/tok123?download=1",
      "https://kvitbit.cz/invite/inv456",
      "https://kvitbit.cz/api/v1/share/tok123",
      "https://kvitbit.cz/api/v1/share/tok123/pdf",
      "https://kvitbit.cz/api/v1/invitations/inv456",
      "https://kvitbit.cz/api/v1/invitations/inv456/accept",
      "https://kvitbit.cz/api/auth/magic-link/verify?token=secret",
      "https://kvitbit.cz/api/auth/reset-password/reset789",
      "https://kvitbit.cz/app/auth/callback?code=abc",
    ]) {
      expect(pattern.test(url)).toBe(true);
    }

    for (const url of [
      "https://kvitbit.cz/healthz",
      "https://kvitbit.cz/readyz",
      "https://kvitbit.cz/api/v1/documents",
      "https://kvitbit.cz/api/v1/share",
      "https://kvitbit.cz/api/v1/invitations",
    ]) {
      expect(pattern.test(url)).toBe(false);
    }
    expect(tokenRoutePatterns.length).toBeGreaterThanOrEqual(7);
  });
});

describe("Zero-Terraform enforcement", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");

  const collectFiles = (dir: string): Array<string> => {
    const out: Array<string> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectFiles(full));
      } else {
        out.push(full);
      }
    }
    return out;
  };

  test("contains zero .tf/.tfvars files and zero terraform CLI usage in infra/deploy artifacts", () => {
    const infraFiles = collectFiles(join(repoRoot, "infra"));
    const tfFiles = infraFiles.filter((file) => /\.(tf|tfvars)(\.json)?$/.test(file));
    expect(tfFiles).toEqual([]);

    const deployWorkflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    expect(deployWorkflow.toLowerCase()).not.toContain("terraform");
    expect(deployWorkflow.toLowerCase()).not.toContain("opentofu");
  });
});
