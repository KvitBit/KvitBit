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
  assertBootstrapSafeState,
  BootstrapPopulatedStateError,
  declareKvitbitStack,
  foundationResourceIds,
  KVITBIT_STACK_NAME,
} from "../src/bootstrap";
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
  buildRunnerWorkerConfig,
  COS_STABLE_IMAGE,
  declareNetworkAndRunners,
  networkProps,
  routerProps,
  runnerFirewallProps,
  runnerInstanceProps,
  runnerWorkerConfigSha,
  serializeRunnerWorkerConfig,
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

  test("normalizes optional secret boolean flags case-insensitively (true/1/yes/on, false/0/no/off) and rejects invalid values", async () => {
    const enabledProvider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_ENABLE_RESEND_SECRET: "YES",
        KVITBIT_ENABLE_SMTP_SECRET: "1",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "On",
      },
    });
    const enabledConfig = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(enabledProvider))),
    );
    const enabledIds = enabledConfig.secrets.map((s) => s.secretId);
    expect(enabledIds).toContain("kvitbit-prod-resend-api-key");
    expect(enabledIds).toContain("kvitbit-prod-smtp-url");
    expect(enabledIds).toContain("kvitbit-prod-mobile-updates-signing-key");

    const disabledProvider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_ENABLE_RESEND_SECRET: "OFF",
        KVITBIT_ENABLE_SMTP_SECRET: "0",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "No",
      },
    });
    const disabledConfig = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(disabledProvider))),
    );
    const disabledIds = disabledConfig.secrets.map((s) => s.secretId);
    expect(disabledIds).not.toContain("kvitbit-prod-resend-api-key");
    expect(disabledIds).not.toContain("kvitbit-prod-smtp-url");
    expect(disabledIds).not.toContain("kvitbit-prod-mobile-updates-signing-key");

    const invalidProvider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_ENABLE_RESEND_SECRET: "maybe",
      },
    });
    const invalidError = await Effect.runPromise(
      Effect.flip(loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(invalidProvider)))),
    );
    expect(invalidError._tag).toBe("InvalidStackConfig");
  });
});

describe("Bootstrap state safety guard", () => {
  const makeFakeResourceState = (logicalId: string) =>
    ({
      kind: "resource",
      status: "created",
      logicalId,
      fqn: logicalId,
      resourceType: "Test",
      props: {},
      attr: {},
    }) as unknown as NonNullable<Parameters<typeof State.inMemoryState>[0]>[string][string][string];

  test("hard-fails bootstrapFoundation when state already contains non-foundation production workloads", async () => {
    const config = sampleProdConfig({ bootstrapFoundation: true, imageDigest: "" });
    const populatedStateLayer = State.inMemoryState({
      [KVITBIT_STACK_NAME]: {
        prod: {
          KvitbitImages: makeFakeResourceState("KvitbitImages"),
          KvitbitVpc: makeFakeResourceState("KvitbitVpc"),
          KvitbitRunner0: makeFakeResourceState("KvitbitRunner0"),
          KvitbitServer: makeFakeResourceState("KvitbitServer"),
        },
      },
    });

    const stateService = await Effect.runPromise(
      Effect.gen(function* () {
        const stateEffect = yield* State.State;
        return yield* stateEffect;
      }).pipe(Effect.provide(populatedStateLayer)),
    );

    const err = await Effect.runPromise(
      Effect.flip(
        assertBootstrapSafeState({
          stackName: KVITBIT_STACK_NAME,
          stage: "prod",
          allowedFoundationIds: foundationResourceIds(config),
          state: stateService,
        }),
      ),
    );
    expect(err).toBeInstanceOf(BootstrapPopulatedStateError);
    if (err instanceof BootstrapPopulatedStateError) {
      expect(err.unexpectedResources).toEqual(["KvitbitRunner0", "KvitbitServer", "KvitbitVpc"]);
    }

    // Running the stack program itself fails BEFORE returning any foundation-only resource set
    const makeStack = Stack.make({
      name: KVITBIT_STACK_NAME,
      state: populatedStateLayer,
      providers: Layer.empty,
    }) as <Out>(
      eff: Effect.Effect<Out, unknown, unknown>,
    ) => Effect.Effect<Stack.CompiledStack<Out, unknown>, unknown, unknown>;

    const stackErr = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          makeStack(
            declareKvitbitStack(config, {
              stackName: KVITBIT_STACK_NAME,
              inspectState: Effect.succeed(stateService),
            }),
          ),
        ),
      ).pipe(Effect.provide(Layer.succeed(Stage, "prod"))) as Effect.Effect<
        unknown,
        unknown,
        never
      >,
    );
    expect(stackErr).toBeInstanceOf(BootstrapPopulatedStateError);
  });

  test("allows bootstrapFoundation on empty or foundation-only state and declares exact foundation resource IDs", async () => {
    const config = sampleProdConfig({ bootstrapFoundation: true, imageDigest: "" });
    const foundationOnlyStateLayer = State.inMemoryState({
      [KVITBIT_STACK_NAME]: {
        prod: {
          KvitbitImages: makeFakeResourceState("KvitbitImages"),
          KvitbitBlobs: makeFakeResourceState("KvitbitBlobs"),
          EdgeTokenRouteExclusion: makeFakeResourceState("EdgeTokenRouteExclusion"),
        },
      },
    });
    const stateService = await Effect.runPromise(
      Effect.gen(function* () {
        const stateEffect = yield* State.State;
        return yield* stateEffect;
      }).pipe(Effect.provide(foundationOnlyStateLayer)),
    );

    const makeStack = Stack.make({
      name: KVITBIT_STACK_NAME,
      state: foundationOnlyStateLayer,
      providers: Layer.empty,
    }) as <Out>(
      eff: Effect.Effect<Out, unknown, unknown>,
    ) => Effect.Effect<Stack.CompiledStack<Out, unknown>, unknown, unknown>;

    const compiled = await Effect.runPromise(
      Effect.scoped(
        makeStack(
          declareKvitbitStack(config, {
            stackName: KVITBIT_STACK_NAME,
            inspectState: Effect.succeed(stateService),
          }),
        ),
      ).pipe(Effect.provide(Layer.succeed(Stage, "prod"))) as Effect.Effect<
        Stack.CompiledStack<unknown, unknown>,
        unknown,
        never
      >,
    );

    const declaredIds = new Set(Object.keys(compiled.resources));
    expect([...declaredIds].sort()).toEqual([...foundationResourceIds(config)].sort());
    expect(declaredIds.has("KvitbitServer")).toBe(false);
    expect(declaredIds.has("KvitbitRunner0")).toBe(false);
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

  test("startup script configures COS host iptables, /bin/bash reconciler invocation (noexec-safe), systemd digest+config reconciliation, backoff retries, and S5 runner DB secrets", () => {
    const config = sampleProdConfig();
    const script = buildRunnerStartupScript();

    // Valid bash syntax
    const syntaxCheck = Bun.spawnSync(["bash", "-n"], {
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(syntaxCheck.exitCode).toBe(0);

    // Boot and timer start the same unit. Bash makes the script usable on a noexec mount.
    expect(script).toContain("ExecStart=/bin/bash /var/lib/kvitbit/reconcile-worker.sh");
    expect(script).toContain("\nsystemctl start kvitbit-worker-reconcile.service\n");
    expect(script).toContain("\nUnit=kvitbit-worker-reconcile.service\n");
    expect(script).not.toContain("ExecStart=/var/lib/kvitbit/reconcile-worker.sh");
    expect(script).not.toContain("\n/var/lib/kvitbit/reconcile-worker.sh\n");

    expect(script).toContain("network-interfaces/0/ip");
    expect(script).toContain('iptables -C INPUT -s "$cidr" -p tcp --dport "$port" -j ACCEPT');
    expect(script).toContain('iptables -I INPUT -s "$cidr" -p tcp --dport "$port" -j ACCEPT');
    expect(script).toContain("kvitbit-worker-reconcile.timer");
    expect(script).toContain("instance/attributes/kvitbit-image-ref");
    expect(script).toContain("instance/attributes/kvitbit-image-digest");
    expect(script).toContain("instance/attributes/kvitbit-worker-config");
    expect(script).toContain("instance/attributes/kvitbit-worker-config-sha");
    expect(script).toContain('publish_guest_attribute "active-digest"');
    expect(script).toContain('publish_guest_attribute "active-config-sha"');
    expect(script).toContain("retry_with_backoff");
    expect(script).toContain("secretmanager.googleapis.com/v1/projects/");

    const workerConfig = buildRunnerWorkerConfig(config);
    const workerConfigSha = runnerWorkerConfigSha(workerConfig);
    expect(workerConfigSha).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(workerConfig.secrets.map((s) => s.secretId)).toEqual(
      expect.arrayContaining([
        "kvitbit-prod-database-url",
        "kvitbit-prod-runner-database-url-unpooled",
        "kvitbit-prod-better-auth-secret",
      ]),
    );

    const vm = runnerInstanceProps(config, 0, {
      network: "vpc",
      subnetwork: "subnet",
    });
    expect(vm.metadata?.["kvitbit-image-ref"]).toBe(imageReference(config));
    expect(vm.metadata?.["kvitbit-image-digest"]).toBe(config.imageDigest);
    expect(vm.metadata?.["kvitbit-worker-config"]).toBe(serializeRunnerWorkerConfig(workerConfig));
    expect(vm.metadata?.["kvitbit-worker-config-sha"]).toBe(workerConfigSha);
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

  test("reconcile script rolls out config-only updates and digest updates, skips no-op ticks, opens iptables idempotently, and retries transient failures", () => {
    const config1 = sampleProdConfig({
      emailFrom: "Kvitbit <no-reply@kvitbit.cz>",
      secrets: defaultSecretBindings("prod", { enableResend: true, enableSmtp: false }),
    });
    const config2 = sampleProdConfig({
      emailFrom: "Billing <billing@kvitbit.cz>",
      secrets: defaultSecretBindings("prod", { enableResend: true, enableSmtp: true }),
    });

    const workerConfig1 = buildRunnerWorkerConfig(config1);
    const workerConfig2 = buildRunnerWorkerConfig(config2);
    const configJson1 = serializeRunnerWorkerConfig(workerConfig1);
    const configJson2 = serializeRunnerWorkerConfig(workerConfig2);
    const configSha1 = runnerWorkerConfigSha(workerConfig1);
    const configSha2 = runnerWorkerConfigSha(workerConfig2);
    expect(configSha1).not.toBe(configSha2);

    const startup = buildRunnerStartupScript();
    const match = startup.match(
      /cat <<'RECONCILE' > \/var\/lib\/kvitbit\/reconcile-worker\.sh\n([\s\S]*?)\nRECONCILE\n/,
    );
    expect(match?.[1]).toBeDefined();

    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-reconcile-"));
    try {
      const binDir = join(sandbox, "bin");
      const runDir = join(sandbox, "run");
      const stateDir = join(sandbox, "state");
      const systemdDir = join(sandbox, "systemd");
      Bun.spawnSync(["mkdir", "-p", binDir, runDir, stateDir, systemdDir]);

      // Rewrite /run/kvitbit and /etc/systemd/system to sandboxed dirs for hermetic execution
      const reconcileScript = (match?.[1] ?? "")
        .replaceAll("/run/kvitbit", runDir)
        .replaceAll("/etc/systemd/system", systemdDir);
      const scriptPath = join(sandbox, "reconcile-worker.sh");
      writeFileSync(scriptPath, reconcileScript);
      // Do NOT set +x: proves /bin/bash execution works even on noexec filesystems
      chmodSync(scriptPath, 0o600);

      const digest1 = SAMPLE_DIGEST;
      const digest2 = `sha256:${"b".repeat(64)}`;
      const ref1 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest1}`;
      const ref2 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest2}`;
      const imageId1 = `sha256:${"c".repeat(64)}`;
      const imageId2 = `sha256:${"d".repeat(64)}`;
      writeFileSync(join(stateDir, "target-ref"), ref1);
      writeFileSync(join(stateDir, "target-digest"), digest1);
      writeFileSync(join(stateDir, "target-config"), configJson1);
      writeFileSync(join(stateDir, "target-config-sha"), configSha1);
      writeFileSync(join(stateDir, "attributes-etag"), "initial");
      writeFileSync(join(stateDir, "fail-once"), "1");
      writeFileSync(join(stateDir, "registry-ref"), ref1);
      writeFileSync(join(stateDir, "registry-image-id"), imageId1);

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
    -H|--connect-timeout|--max-time|--dump-header|--output) shift 2 ;;
    -*) shift ;;
    *) URL="$1"; shift ;;
  esac
done

if [ "$METHOD" = "PUT" ]; then
  printf '%s %s\\n' "$URL" "$DATA" >> "${stateDir}/guest-writes"
  case "$URL" in
    *"guest-attributes/kvitbit/active-digest")
      printf '%s' "$DATA" > "${stateDir}/guest-active-digest"
      ;;
    *"guest-attributes/kvitbit/active-config-sha")
      printf '%s' "$DATA" > "${stateDir}/guest-active-config-sha"
      ;;
  esac
  exit 0
fi

case "$URL" in
  *"instance/attributes/?recursive=true")
    printf 'HTTP/1.1 200 OK\\r\\nETag: %s\\r\\n\\r\\n' "$(cat "${stateDir}/attributes-etag")"
    ;;
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
  *"attributes/kvitbit-worker-config-sha")
    cat "${stateDir}/target-config-sha"
    ;;
  *"attributes/kvitbit-worker-config")
    echo "config fetch" >> "${stateDir}/config-reads"
    cat "${stateDir}/target-config"
    if [ -f "${stateDir}/next-attributes-etag" ]; then
      mv "${stateDir}/next-attributes-etag" "${stateDir}/attributes-etag"
    fi
    ;;
  *"secretmanager.googleapis.com"*"kvitbit-prod-smtp-url"*)
    SECRET_VAL="$(printf '%s' "smtps://mailer.example:465" | base64 | tr -d '\\n')"
    printf '{"payload":{"data":"%s"}}' "$SECRET_VAL"
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
    [ -f "${stateDir}/running-image-id" ] || exit 1
    image_id="$(cat "${stateDir}/running-image-id")"
    printf 'true|%s|%s|%s|%s' "$image_id" "$image_id" "$(cat "${stateDir}/running-digest")" "$(cat "${stateDir}/running-config-sha")"
    ;;
  login)
    cat >/dev/null
    echo "docker:login" >> "${stateDir}/log"
    ;;
  pull)
    [ "$2" = "--" ] || exit 1
    echo "docker:pull:$3" >> "${stateDir}/log"
    printf '%s' "$3" > "${stateDir}/pulled-ref"
    cp "${stateDir}/registry-image-id" "${stateDir}/pulled-image-id"
    cp "${stateDir}/registry-ref" "${stateDir}/pulled-repo-digest"
    ;;
  image)
    [ "$2" = "inspect" ] && [ -f "${stateDir}/pulled-ref" ] || exit 1
    [ "$5" = "$(cat "${stateDir}/pulled-ref")" ] || exit 1
    printf '%s\\n%s\\n' "$(cat "${stateDir}/pulled-image-id")" "$(cat "${stateDir}/pulled-repo-digest")"
    ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(join(binDir, "docker"), 0o755);

      // Stub systemctl (activates target digest + config sha as running)
      writeFileSync(
        join(binDir, "systemctl"),
        `#!/bin/sh
set -eu
echo "systemctl:$*" >> "${stateDir}/log"
if [ "$1" = "stop" ]; then
  rm -f "${stateDir}/running-image-id" "${stateDir}/running-digest" "${stateDir}/running-config-sha"
fi
if [ "$1" = "start" ]; then
  . "${runDir}/worker-target.env"
  grep -Fq 'docker run --pull=never ' "${systemdDir}/kvitbit-worker.service"
  [ "$KVITBIT_WORKER_IMAGE" = "$(cat "${stateDir}/pulled-image-id")" ]
  printf '%s' "$KVITBIT_WORKER_IMAGE" > "${stateDir}/running-image-id"
  printf '%s' "$KVITBIT_WORKER_DIGEST" > "${stateDir}/running-digest"
  printf '%s' "$KVITBIT_WORKER_CONFIG_SHA" > "${stateDir}/running-config-sha"
fi
`,
      );
      chmodSync(join(binDir, "systemctl"), 0o755);

      const env = { PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
      const reconcile = () =>
        Bun.spawnSync(["/bin/bash", scriptPath], { env, stdout: "pipe", stderr: "pipe" });

      // 1. Initial boot reconcile (survives transient metadata failure, installs iptables, starts digest1 + configSha1)
      expect(reconcile().exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId1);
      expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest1);
      expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha1);
      const env1 = readFileSync(join(runDir, "worker.env"), "utf8");
      expect(env1).toContain("DATABASE_URL_UNPOOLED=secret-val");
      expect(env1).toContain("EMAIL_FROM=Kvitbit <no-reply@kvitbit.cz>");
      expect(env1).not.toContain("KVITBIT_SMTP_URL=");
      expect(readFileSync(join(stateDir, "iptables-rule"), "utf8")).toContain("10.42.0.0/20");

      const logAfterFirst = readFileSync(join(stateDir, "log"), "utf8");
      expect(logAfterFirst).toContain("systemctl:start kvitbit-worker.service");

      // 2. Second reconcile with same digest AND same config is a no-op
      expect(reconcile().exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterFirst);

      // A new config SHA can become visible while fetching its JSON still fails.
      const guestWrites = readFileSync(join(stateDir, "guest-writes"), "utf8");
      const configReads = readFileSync(join(stateDir, "config-reads"), "utf8");
      const targetEnv1 = readFileSync(join(runDir, "worker-target.env"), "utf8");
      writeFileSync(join(stateDir, "target-config-sha"), configSha2);
      rmSync(join(stateDir, "target-config"));
      expect(reconcile().exitCode).toBe(1);
      expect(readFileSync(join(stateDir, "config-reads"), "utf8")).toBe(
        configReads + "config fetch\n".repeat(6),
      );

      // The expected SHA covers every response byte, including any trailing newline.
      writeFileSync(join(stateDir, "target-config"), `${configJson2}\n`);
      expect(reconcile().exitCode).toBe(1);
      expect(readFileSync(join(stateDir, "running-config-sha"), "utf8")).toBe(configSha1);
      expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha1);
      expect(readFileSync(join(stateDir, "guest-writes"), "utf8")).toBe(guestWrites);
      expect(readFileSync(join(runDir, "worker.env"), "utf8")).toBe(env1);
      expect(readFileSync(join(runDir, "worker-target.env"), "utf8")).toBe(targetEnv1);
      expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterFirst);

      // The next tick applies the config-only rollout once its JSON is available.
      writeFileSync(join(stateDir, "target-config"), configJson2);
      writeFileSync(join(stateDir, "next-attributes-etag"), "changed-during-fetch");
      const readsBeforeRecovery = readFileSync(join(stateDir, "config-reads"), "utf8");
      expect(reconcile().exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "config-reads"), "utf8")).toBe(
        readsBeforeRecovery + "config fetch\n".repeat(2),
      );
      expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest1);
      expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha2);
      const env2 = readFileSync(join(runDir, "worker.env"), "utf8");
      expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
      expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
      expect(
        readFileSync(join(stateDir, "log"), "utf8")
          .split("\n")
          .filter((l) => l === "systemctl:start kvitbit-worker.service").length,
      ).toBe(2);

      // Image metadata updates must agree before the runner pulls anything.
      const logAfterConfigUpdate = readFileSync(join(stateDir, "log"), "utf8");
      const guestWritesAfterConfigUpdate = readFileSync(join(stateDir, "guest-writes"), "utf8");
      const targetEnv2 = readFileSync(join(runDir, "worker-target.env"), "utf8");
      writeFileSync(join(stateDir, "target-ref"), ref2);
      expect(reconcile().exitCode).toBe(1);
      expect(readFileSync(join(stateDir, "log"), "utf8")).toBe(logAfterConfigUpdate);

      // A successful pull still needs to report the requested registry digest.
      writeFileSync(join(stateDir, "target-digest"), digest2);
      writeFileSync(join(stateDir, "registry-image-id"), imageId2);
      expect(reconcile().exitCode).toBe(1);
      expect(readFileSync(join(stateDir, "running-digest"), "utf8")).toBe(digest1);
      expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId1);
      expect(readFileSync(join(stateDir, "guest-writes"), "utf8")).toBe(
        guestWritesAfterConfigUpdate,
      );
      expect(readFileSync(join(runDir, "worker.env"), "utf8")).toBe(env2);
      expect(readFileSync(join(runDir, "worker-target.env"), "utf8")).toBe(targetEnv2);

      writeFileSync(join(stateDir, "registry-ref"), ref2);
      expect(reconcile().exitCode).toBe(0);
      expect(readFileSync(join(stateDir, "running-image-id"), "utf8")).toBe(imageId2);
      expect(readFileSync(join(stateDir, "guest-active-digest"), "utf8")).toBe(digest2);
      expect(readFileSync(join(stateDir, "guest-active-config-sha"), "utf8")).toBe(configSha2);
      const logAfterFourth = readFileSync(join(stateDir, "log"), "utf8");
      expect(logAfterFourth).toContain(`docker:pull:${ref2}`);
      expect(
        logAfterFourth.split("\n").filter((l) => l === "systemctl:start kvitbit-worker.service")
          .length,
      ).toBe(3);
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
