import { describe, expect, test } from "bun:test";
import { Credentials as GcpCredentials } from "@alchemy.run/gcp/Credentials";
import { Providers as GcpProviders } from "@alchemy.run/gcp/Providers";
import { Secret } from "@alchemy.run/gcp/SecretManager";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Apply from "alchemy/Apply";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
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
import { EdgeBackendServiceProvider } from "../src/resources/edge-backend-service";
import { EdgeSecurityPolicyProvider } from "../src/resources/edge-security-policy";
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
import { parseDeployWorkflow } from "./deploy-workflow";
import { runCommand, runSerial, systemPath } from "./process-fixture";

const fs = await FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer), Effect.runPromise);
const { join, resolve } = Path.Path.pipe(Effect.provide(Path.layer), Effect.runSync);
const sha256Digest = /^sha256:[a-f0-9]{64}$/;
const logFilterPattern = /httpRequest\.requestUrl=~"([^"]+)"/;
const terraformFile = /\.(tf|tfvars)(\.json)?$/;
const reconcileScriptPattern =
  /cat <<'RECONCILE' > \/var\/lib\/kvitbit\/reconcile-worker\.sh\n([\s\S]*?)\nRECONCILE\n/;
const SAMPLE_DIGEST = `sha256:${Str.repeat(64)("a")}`;
const PROD_DNS_ZONES = ["kvitbit.cz", "kvitbit.app", "kvitbit.com", "kvitbit.eu", "kvitbit.dev"];

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
  feedbackGitHubRepo: undefined,
  feedbackOwnerEmails: undefined,
  secrets: defaultSecretBindings({
    stage: "prod",
    options: {
      enableResend: true,
      enableSmtp: true,
      enableMobileSigningKey: true,
    },
  }),
  dnsZones: [],
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
    expect(config.projectNumber).toBe(String(449_188_423_567));
    expect(config.region).toBe("europe-west3");
    expect(config.zone).toBe("europe-west3-a");
    expect(config.stateBucket).toBe("alchemy-state-kvitbit-prod");
    expect(config.runnerPort).toBe(34431);
    expect(config.trustedProxyHops).toBe(1);
    expect(config.edge).toBeUndefined();
    expect(config.dnsZones).toEqual([]);
    expect(imageReference(config)).toBe(
      `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${SAMPLE_DIGEST}`,
    );
  });

  test("loads and normalizes the configured DNS zone apexes without enabling the edge", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_DNS_ZONES:
          " Kvitbit.cz., kvitbit.APP, kvitbit.com, kvitbit.eu, kvitbit.dev, kvitbit.cz ",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.dnsZones).toEqual(PROD_DNS_ZONES);
    expect(config.edge).toBeUndefined();
  });

  test.each([
    "*.kvitbit.cz",
    "https://kvitbit.cz",
    "kvitbit.cz/path",
    "kvitbit.cz..",
    "single-label",
    "-kvitbit.cz",
    "192.0.2.1",
    `${Str.repeat(64)("x")}.cz`,
    `${Str.repeat(4)(`${Str.repeat(63)("x")}.`)}cz`,
  ])("rejects invalid DNS zone %s", async (zone) => {
    const provider = ConfigProvider.fromEnv({
      env: { KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST, KVITBIT_DNS_ZONES: zone },
    });
    const error = await loadStackConfig.pipe(
      Effect.provide(ConfigProvider.layer(provider)),
      Effect.flip,
      Effect.runPromise,
    );
    expect(error).toMatchObject({ _tag: "InvalidStackConfig", field: "KVITBIT_DNS_ZONES" });
  });

  test("rejects DNS zones that leave no room for www when the edge is enabled", async () => {
    const domain = `${Str.repeat(3)(`${Str.repeat(63)("x")}.`)}${Str.repeat(58)("y")}.cz`;
    const error = await validateStackConfig(sampleProdConfig({ dnsZones: [domain] })).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error.field).toBe("KVITBIT_DNS_ZONES");
    expect(error.reason).toContain("www");
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
        KVITBIT_DNS_ZONES: "",
        KVITBIT_RUNNER_COUNT: "",
        KVITBIT_ENABLE_RESEND_SECRET: "true",
        KVITBIT_ENABLE_SMTP_SECRET: "",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "true",
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: " ",
        KVITBIT_FEEDBACK_GITHUB_REPO: "",
        KVITBIT_FEEDBACK_OWNER_EMAILS: " ",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    expect(config.bootstrapFoundation).toBe(true);
    expect(config.imageDigest).toBe("");
    expect(config.dnsZones).toEqual([]);
    expect(config.runnerCount).toBe(KVITBIT_PROD_DEFAULTS.runnerCount);
    const secretIds = Arr.map(config.secrets, (s) => s.secretId);
    expect(secretIds).toContain("kvitbit-prod-database-url");
    expect(secretIds).toContain("kvitbit-prod-runner-database-url-unpooled");
    expect(secretIds).toContain("kvitbit-prod-resend-api-key");
    expect(secretIds).toContain("kvitbit-prod-mobile-updates-signing-key");
    expect(secretIds).not.toContain("kvitbit-prod-smtp-url");
    expect(secretIds).not.toContain("kvitbit-prod-feedback-github-token");
    expect(config.feedbackGitHubRepo).toBeUndefined();
    expect(config.feedbackOwnerEmails).toBeUndefined();
  });

  test("rejects mutable image tags, cross-region zones, and out-of-range runnerCount", async () => {
    const badDigest = await validateStackConfig(sampleProdConfig({ imageDigest: "latest" })).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(badDigest.field).toBe("imageDigest");

    const badZone = await validateStackConfig(sampleProdConfig({ zone: "us-central1-a" })).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(badZone.field).toBe("zone");

    const badRunners = await validateStackConfig(sampleProdConfig({ runnerCount: 0 })).pipe(
      Effect.flip,
      Effect.runPromise,
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
    const enabledIds = Arr.map(enabledConfig.secrets, (s) => s.secretId);
    expect(enabledIds).toContain("kvitbit-prod-resend-api-key");
    expect(enabledIds).toContain("kvitbit-prod-smtp-url");
    expect(enabledIds).toContain("kvitbit-prod-mobile-updates-signing-key");

    const disabledProvider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_ENABLE_RESEND_SECRET: "OFF",
        KVITBIT_ENABLE_SMTP_SECRET: "0",
        KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "No",
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: "OFF",
      },
    });
    const disabledConfig = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(disabledProvider))),
    );
    const disabledIds = Arr.map(disabledConfig.secrets, (s) => s.secretId);
    expect(disabledIds).not.toContain("kvitbit-prod-resend-api-key");
    expect(disabledIds).not.toContain("kvitbit-prod-smtp-url");
    expect(disabledIds).not.toContain("kvitbit-prod-mobile-updates-signing-key");
    expect(disabledIds).not.toContain("kvitbit-prod-feedback-github-token");

    const invalidProvider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: "maybe",
      },
    });
    const invalidError = await loadStackConfig.pipe(
      Effect.provide(ConfigProvider.layer(invalidProvider)),
      Effect.flip,
      Effect.runPromise,
    );
    expect(invalidError).toMatchObject({
      _tag: "InvalidStackConfig",
      field: "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
    });
  });
});

describe("Bootstrap state safety guard", () => {
  const config = sampleProdConfig({ bootstrapFoundation: true, imageDigest: "" });
  const compileBootstrap = (state: Layer.Layer<State.State>) =>
    Stack.Stack(
      KVITBIT_STACK_NAME,
      { state, providers: Layer.empty },
      declareKvitbitStack(config).pipe(Effect.orDie),
    ).pipe(Effect.provideService(Stage, "prod"));

  const makeFakeResourceState = (logicalId: string) =>
    ({
      kind: "resource",
      status: "created",
      logicalId,
      fqn: logicalId,
      resourceType: "Test",
      namespace: undefined,
      instanceId: logicalId,
      providerVersion: 0,
      downstream: [],
      bindings: [],
      props: {},
      attr: {},
    }) satisfies State.CreatedResourceState;

  test("hard-fails bootstrapFoundation when state already contains non-foundation production workloads", async () => {
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

    const compiled = populatedStateLayer.pipe(compileBootstrap, Effect.scoped, Effect.runPromise);
    await expect(compiled).rejects.toBeInstanceOf(BootstrapPopulatedStateError);
    await expect(compiled).rejects.toMatchObject({
      stackName: KVITBIT_STACK_NAME,
      stage: "prod",
      unexpectedResources: ["KvitbitRunner0", "KvitbitServer", "KvitbitVpc"],
    });
  });

  test("selected feedback secret bootstrap adds only the container to populated state", async () => {
    const target = { stack: KVITBIT_STACK_NAME, stage: "prod" };
    const secretId = "kvitbit-prod-feedback-github-token";
    const fqn = `Secret-${secretId}`;
    const existing = {
      KvitbitImages: makeFakeResourceState("KvitbitImages"),
      KvitbitVpc: makeFakeResourceState("KvitbitVpc"),
      KvitbitRunner0: makeFakeResourceState("KvitbitRunner0"),
      KvitbitServer: makeFakeResourceState("KvitbitServer"),
    };
    const existingOutput = { serverService: "kvitbit-prod-server", repository: "kvitbit" };
    const state = State.inMemoryState(
      { [target.stack]: { [target.stage]: { ...existing } } },
      { [target.stack]: { [target.stage]: existingOutput } },
    );
    const providers = Provider.succeed(Secret, {
      read: () => Effect.undefined,
      reconcile: ({ news }) => {
        expect(news.secretId).toBe(secretId);
        return Effect.succeed({
          name: `projects/kvitbit-prod/secrets/${secretId}`,
          secretId,
          project: "kvitbit-prod",
          labels: {},
          annotations: {},
          replication: { automatic: {} },
          expireTime: undefined,
          createTime: undefined,
          etag: undefined,
          topics: [],
          rotation: undefined,
          versionAliases: {},
          versionDestroyTtl: undefined,
        });
      },
      delete: () => Effect.die("Unexpected secret deletion"),
    });
    const feedbackConfig = sampleProdConfig({
      secrets: defaultSecretBindings({
        stage: "prod",
        options: { enableFeedbackGitHubToken: true },
      }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* Stack.Stack(
          target.stack,
          { state, providers },
          declareKvitbitStack(feedbackConfig).pipe(Effect.orDie),
        );
        yield* Effect.gen(function* () {
          const plan = yield* Plan.make(compiled, { include: [fqn] });
          expect(Record.keys(plan.resources)).toEqual([fqn]);
          expect(plan.resources[fqn]?.action).toBe("create");
          expect(plan.deletions).toEqual({});
          yield* Apply.apply(plan);

          const store = yield* yield* State.State;
          const value_1 = yield* store.list(target);
          expect(Arr.sort(value_1, Order.String)).toEqual(
            Arr.sort([...Record.keys(existing), fqn], Order.String),
          );
          const value_2 = yield* store.get({ ...target, fqn });
          expect(value_2).toMatchObject({
            status: "created",
            resourceType: Secret.Type,
            attr: { secretId },
          });
          for (const [existingFqn, row] of Record.toEntries(existing)) {
            const value_3 = yield* store.get({ ...target, fqn: existingFqn });
            expect(value_3).toEqual(row);
          }
          const value_4 = yield* store.getOutput(target);
          expect(value_4).toEqual(existingOutput);
        }).pipe(Effect.provideContext(compiled.services), Effect.provide(state));
      }).pipe(Effect.provideService(Stage, target.stage), Effect.scoped),
    );
  });

  test.each([
    ["empty", []],
    ["foundation-only", ["KvitbitImages", "KvitbitBlobs", "EdgeTokenRouteExclusion"]],
  ] as const)("lists %s state under the stack's active lease", async (_kind, existingFqns) => {
    const lease = Symbol("stack state lease");
    let activeLease: symbol | undefined;
    const events: string[] = [];
    const state = Layer.effect(
      State.State,
      Effect.acquireRelease(
        Effect.sync(() => {
          expect(activeLease).toBeUndefined();
          activeLease = lease;
          events.push("acquire");
        }),
        () =>
          Effect.sync(() => {
            activeLease = undefined;
            events.push("release");
          }),
      ).pipe(
        Effect.andThen(State.InMemoryService()),
        Effect.map((memory) =>
          Effect.succeed({
            ...memory,
            list: ({ stack, stage }) =>
              Effect.sync(() => {
                expect(activeLease).toBe(lease);
                expect({ stack, stage }).toEqual({ stack: KVITBIT_STACK_NAME, stage: "prod" });
                events.push("list");
                return existingFqns;
              }),
          } satisfies State.StateService),
        ),
      ),
    );

    await Effect.gen(function* () {
      const compiled = yield* compileBootstrap(state);
      expect(Arr.sort(Record.keys(compiled.resources), Order.String)).toEqual(
        Arr.sort(foundationResourceIds(config), Order.String),
      );
      expect(activeLease).toBe(lease);
      expect(events).toEqual(["acquire", "list"]);
    }).pipe(Effect.scoped, Effect.runPromise);
    expect(events).toEqual(["acquire", "list", "release"]);
    expect(activeLease).toBeUndefined();
  });

  test("aborts bootstrap when listing state fails", async () => {
    const listError = new State.StateStoreError({ message: "state listing failed" });
    const state = Layer.succeed(
      State.State,
      State.InMemoryService().pipe(Effect.map((memory) => ({ ...memory, list: () => listError }))),
    );

    const result = state.pipe(compileBootstrap, Effect.scoped, Effect.runPromise);
    await expect(result).rejects.toBe(listError);
  });

  test("bootstraps the Cloud DNS API without declaring zones, including on retry", async () => {
    const dnsConfig = { ...config, dnsZones: PROD_DNS_ZONES };
    const state = State.inMemoryState({
      [KVITBIT_STACK_NAME]: { prod: { CloudDnsApi: makeFakeResourceState("CloudDnsApi") } },
    });
    const stack = Stack.Stack(
      KVITBIT_STACK_NAME,
      { state, providers: Layer.empty },
      declareKvitbitStack(dnsConfig).pipe(Effect.orDie),
    );
    const compiled = await stack.pipe(
      Effect.scoped,
      Effect.provideService(Stage, "prod"),
      Effect.runPromise,
    );
    expect(Arr.sort(Record.keys(compiled.resources), Order.String)).toEqual(
      Arr.sort(foundationResourceIds(dnsConfig), Order.String),
    );
    expect(compiled.resources["CloudDnsApi"]?.Props).toEqual({
      project: "kvitbit-prod",
      service: "dns.googleapis.com",
    });
    expect(Arr.some(Record.keys(compiled.resources), (id) => Str.startsWith("DnsZone-")(id))).toBe(
      false,
    );
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
    expect(Arr.map(secrets, (s) => s.secretId)).toContain("kvitbit-prod-database-url");
    expect(Arr.map(secrets, (s) => s.secretId)).toContain(
      "kvitbit-prod-runner-database-url-unpooled",
    );
    expect(Arr.map(secrets, (s) => s.secretId)).toContain("kvitbit-prod-better-auth-secret");

    const grants = secretAccessorGrants(config);
    const mobileSigningGrants = Arr.filter(
      grants,
      (g) => g.secretId === "kvitbit-prod-mobile-updates-signing-key",
    );
    expect(Arr.map(mobileSigningGrants, (g) => g.workload)).toEqual(["server"]);
    const dbGrants = Arr.filter(grants, (g) => g.secretId === "kvitbit-prod-database-url");
    expect(
      Arr.sort(
        Arr.map(dbGrants, (g) => g.workload),
        Order.String,
      ),
    ).toEqual(["runner", "server"]);
    const runnerUnpooledGrants = Arr.filter(
      grants,
      (g) => g.secretId === "kvitbit-prod-runner-database-url-unpooled",
    );
    expect(Arr.map(runnerUnpooledGrants, (g) => g.workload)).toEqual(["runner"]);
  });

  test("constructs the full Alchemy stack with real Output proxies without coercion errors and wires explicit DAG dependencies", async () => {
    const config = sampleProdConfig({ edge: undefined });

    const gcpDeclarations = Layer.effect(GcpProviders, Provider.collection([]));
    const rejectLiveCredentials = Layer.succeed(
      GcpCredentials,
      Effect.die("A declaration test must not use Google credentials"),
    );
    const compiled = await Stack.Stack(
      "KvitbitTest",
      { state: State.inMemoryState(), providers: gcpDeclarations },
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
    ).pipe(Effect.scoped, Effect.provideService(Stage, "prod"), Effect.runPromise);

    const resourceIds = Record.keys(compiled.resources);
    // Token-route log exclusion is installed unconditionally even when edge is disabled
    expect(resourceIds).toContain("EdgeTokenRouteExclusion");

    const runner0 = compiled.resources["KvitbitRunner0"];
    const serverRes = compiled.resources["KvitbitServer"];
    expect(runner0).toBeDefined();
    expect(serverRes).toBeDefined();

    const runnerUpstreams = Record.keys(Output.upstreamAny(runner0?.Props));
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

    const serverUpstreams = Record.keys(Output.upstreamAny(serverRes?.Props));
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
    const compiledWithEdge = await Stack.Stack(
      "KvitbitEdgeTest",
      {
        state: State.inMemoryState(),
        providers: Layer.mergeAll(
          gcpDeclarations,
          EdgeBackendServiceProvider,
          EdgeSecurityPolicyProvider,
        ).pipe(Layer.provide(rejectLiveCredentials)),
      },
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
    ).pipe(Effect.scoped, Effect.provideService(Stage, "prod"), Effect.runPromise);
    expect(Record.keys(compiledWithEdge.resources)).toContain("EdgeSecurityPolicy");
  });
});

describe("Pure-Alchemy Compute Engine runner pool (#908)", () => {
  test("declares custom VPC, private subnet with Cloud NAT, internal TCP 34431 firewall, and private COS instances", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);

    const vpc = networkProps(config);
    expect(vpc.autoCreateSubnetworks).toBe(false);

    const subnet = subnetworkProps({ config, network: names.networkName });
    expect(subnet.privateIpGoogleAccess).toBe(true);
    expect(subnet.ipCidrRange).toBe("10.42.0.0/20");

    const router = routerProps({ config, network: names.networkName });
    expect(router.nats?.[0]?.natIpAllocateOption).toBe("AUTO_ONLY");

    const fw = runnerFirewallProps({ config, network: names.networkName });
    expect(fw.direction).toBe("INGRESS");
    expect(fw.allowed).toEqual([{ protocol: "tcp", ports: ["34431"] }]);
    expect(fw.sourceRanges).toEqual(["10.42.0.0/20"]);
    expect(fw.targetTags).toEqual([names.runnerTag]);

    const vm = runnerInstanceProps({
      config,
      index: 0,
      deps: {
        network: names.networkName,
        subnetwork: names.subnetworkName,
      },
    });
    expect(vm.sourceImage).toBe(COS_STABLE_IMAGE);
    expect(vm.associatePublicIp).toBe(false);
    expect(vm.zone).toBe("europe-west3-a");
    expect(vm.shieldedInstanceConfig?.enableSecureBoot).toBe(true);
    expect(vm.tags).toEqual([names.runnerTag]);
  });

  test("startup script configures COS host iptables, /bin/bash reconciler invocation (noexec-safe), systemd digest+config reconciliation, backoff retries, and S5 runner DB secrets", async () => {
    const config = sampleProdConfig();
    const script = buildRunnerStartupScript();

    // Valid bash syntax
    const syntaxCheck = await runCommand({
      command: ["bash", "-n"],
      stdin: new TextEncoder().encode(script),
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
    expect(script).toContain('publish_guest_attribute "active-target"');
    expect(script).toContain("retry_with_backoff");
    expect(script).toContain("secretmanager.googleapis.com/v1/projects/");

    const workerConfig = buildRunnerWorkerConfig({ config });
    const workerConfigSha = runnerWorkerConfigSha(workerConfig);
    expect(workerConfigSha).toMatch(sha256Digest);
    expect(Arr.map(workerConfig.secrets, (s) => s.secretId)).toEqual(
      expect.arrayContaining([
        "kvitbit-prod-database-url",
        "kvitbit-prod-runner-database-url-unpooled",
        "kvitbit-prod-better-auth-secret",
      ]),
    );

    const vm = runnerInstanceProps({
      config,
      index: 0,
      deps: {
        network: "vpc",
        subnetwork: "subnet",
      },
    });
    expect(vm.metadata?.["kvitbit-image-ref"]).toBe(imageReference(config));
    expect(vm.metadata?.["kvitbit-image-digest"]).toBe(config.imageDigest);
    expect(vm.metadata?.["kvitbit-worker-config"]).toBe(serializeRunnerWorkerConfig(workerConfig));
    expect(vm.metadata?.["kvitbit-worker-config-sha"]).toBe(workerConfigSha);
    expect(vm.metadata?.["enable-guest-attributes"]).toBe("TRUE");

    const runnerEnvNames = Arr.map(
      runnerPlainEnv({ config, blobsBucket: config.blobsBucket }),
      (e) => e.name,
    );
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

  const makeRunnerSandbox = async (sandbox: string) => {
    const config1 = sampleProdConfig({
      emailFrom: "Kvitbit <no-reply@kvitbit.cz>",
      secrets: defaultSecretBindings({
        stage: "prod",
        options: { enableResend: true, enableSmtp: false },
      }),
    });
    const config2 = sampleProdConfig({
      emailFrom: "Billing <billing@kvitbit.cz>",
      secrets: defaultSecretBindings({
        stage: "prod",
        options: { enableResend: true, enableSmtp: true },
      }),
    });

    const workerConfig1 = buildRunnerWorkerConfig({ config: config1 });
    const workerConfig2 = buildRunnerWorkerConfig({ config: config2 });
    const configJson1 = serializeRunnerWorkerConfig(workerConfig1);
    const configJson2 = serializeRunnerWorkerConfig(workerConfig2);
    const configSha1 = runnerWorkerConfigSha(workerConfig1);
    const configSha2 = runnerWorkerConfigSha(workerConfig2);
    if (configSha1 === configSha2) throw new Error("Runner config edits must change its digest");

    const startup = buildRunnerStartupScript();
    const match = Option.getOrNull(Str.match(reconcileScriptPattern)(startup));
    const source = match?.[1];
    if (source === undefined) throw new Error("Missing runner reconciliation script");

    const binDir = join(sandbox, "bin");
    const runDir = join(sandbox, "run");
    const stateDir = join(sandbox, "state");
    const systemdDir = join(sandbox, "systemd");
    for (const dir of [binDir, runDir, stateDir, systemdDir])
      await Effect.runPromise(fs.makeDirectory(dir));

    // Rewrite /run/kvitbit and /etc/systemd/system to sandboxed dirs for hermetic execution
    const reconcileScript = Str.replaceAll(
      "/etc/systemd/system",
      systemdDir,
    )(Str.replaceAll("/run/kvitbit", runDir)(source));
    const scriptPath = join(sandbox, "reconcile-worker.sh");
    await Effect.runPromise(fs.writeFileString(scriptPath, reconcileScript));
    // Do NOT set +x: proves /bin/bash execution works even on noexec filesystems
    await Effect.runPromise(fs.chmod(scriptPath, 0o600));

    const digest2 = `sha256:${Str.repeat(64)("b")}`;
    const ref1 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${SAMPLE_DIGEST}`;
    const ref2 = `europe-west3-docker.pkg.dev/kvitbit-prod/kvitbit/kvitbit@${digest2}`;
    const imageId1 = `sha256:${Str.repeat(64)("c")}`;
    const imageId2 = `sha256:${Str.repeat(64)("d")}`;
    await Effect.runPromise(fs.writeFileString(join(stateDir, "target-ref"), ref1));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "target-digest"), SAMPLE_DIGEST));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config"), configJson1));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config-sha"), configSha1));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "attributes-etag"), "initial"));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "fail-once"), "1"));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "registry-ref"), ref1));
    await Effect.runPromise(fs.writeFileString(join(stateDir, "registry-image-id"), imageId1));

    // Stub sleep (no-op for fast retry test)
    await Effect.runPromise(fs.writeFileString(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n"));
    await Effect.runPromise(fs.chmod(join(binDir, "sleep"), 0o755));

    // Stub iptables (tracks whether rule is installed)
    await Effect.runPromise(
      fs.writeFileString(
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
      ),
    );
    await Effect.runPromise(fs.chmod(join(binDir, "iptables"), 0o755));

    // Stub curl (simulates metadata, transient failure on first metadata call, Secret Manager, and guest attributes PUT)
    await Effect.runPromise(
      fs.writeFileString(
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
    *"guest-attributes/kvitbit/active-target")
      if [ "$DATA" = "pending" ] && [ -f "${stateDir}/fail-invalidation" ]; then
        exit 22
      fi
      if [ "$DATA" != "pending" ] && [ -f "${stateDir}/fail-active-target-once" ]; then
        rm -f "${stateDir}/fail-active-target-once"
        exit 22
      fi
      printf '%s' "$DATA" > "${stateDir}/guest-active-target"
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
      ),
    );
    await Effect.runPromise(fs.chmod(join(binDir, "curl"), 0o755));

    // Stub docker
    await Effect.runPromise(
      fs.writeFileString(
        join(binDir, "docker"),
        `#!/bin/sh
set -eu
case "$1" in
  inspect)
    [ -f "${stateDir}/running-image-id" ] || exit 1
    image_id="$(cat "${stateDir}/running-image-id")"
    configured_image="$image_id"
    if [ -f "${stateDir}/legacy-image-ref" ]; then
      configured_image="$(cat "${stateDir}/legacy-image-ref")"
    fi
    printf 'true|%s|%s|%s|%s' "$image_id" "$configured_image" "$(cat "${stateDir}/running-digest")" "$(cat "${stateDir}/running-config-sha")"
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
      ),
    );
    await Effect.runPromise(fs.chmod(join(binDir, "docker"), 0o755));

    // Stub systemctl (activates target digest + config sha as running)
    await Effect.runPromise(
      fs.writeFileString(
        join(binDir, "systemctl"),
        `#!/bin/sh
set -eu
echo "systemctl:$*" >> "${stateDir}/log"
if [ "$1" = "stop" ]; then
  rm -f "${stateDir}/running-image-id" "${stateDir}/running-digest" "${stateDir}/running-config-sha" "${stateDir}/legacy-image-ref"
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
      ),
    );
    await Effect.runPromise(fs.chmod(join(binDir, "systemctl"), 0o755));

    const env = { PATH: `${binDir}:${systemPath}` };
    const reconcile = () => runCommand({ command: ["/bin/bash", scriptPath], env });

    return {
      binDir,
      reconcile,
      runDir,
      stateDir,
      digest1: SAMPLE_DIGEST,
      digest2,
      ref1,
      ref2,
      imageId1,
      imageId2,
      configSha1,
      configSha2,
      configJson2,
    };
  };

  const withRunnerSandbox = async (
    run: (fixture: Awaited<ReturnType<typeof makeRunnerSandbox>>) => Promise<void>,
  ) => {
    const sandbox = await Effect.runPromise(fs.makeTempDirectory({ prefix: "kvitbit-reconcile-" }));
    try {
      await run(await makeRunnerSandbox(sandbox));
    } finally {
      await Effect.runPromise(fs.remove(sandbox, { recursive: true, force: true }));
    }
  };

  test("reconcile replaces legacy workers, rolls out config and digest changes, and skips no-op ticks", async () => {
    await withRunnerSandbox(
      async ({
        reconcile,
        runDir,
        stateDir,
        digest1,
        digest2,
        ref1,
        ref2,
        imageId1,
        imageId2,
        configSha1,
        configSha2,
        configJson2,
      }) => {
        // A legacy worker can have the expected labels and image with stale environment values.
        await Effect.runPromise(fs.writeFileString(join(stateDir, "legacy-image-ref"), ref1));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "pulled-ref"), ref1));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "pulled-repo-digest"), ref1));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "pulled-image-id"), imageId1));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "running-image-id"), imageId1));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "running-digest"), digest1));
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "running-config-sha"), configSha1),
        );
        await Effect.runPromise(
          fs.writeFileString(join(runDir, "worker.env"), "EMAIL_FROM=stale@example.invalid\n"),
        );

        // The initial reconcile survives a transient request failure and replaces the legacy worker.
        expect((await reconcile()).exitCode).toBe(0);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "running-image-id")))).toBe(
          imageId1,
        );
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-digest"))),
        ).toBe(digest1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-config-sha"))),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-target"))),
        ).toBe(`${digest1}|${configSha1}`);
        const env1 = await Effect.runPromise(fs.readFileString(join(runDir, "worker.env")));
        expect(env1).toContain("DATABASE_URL_UNPOOLED=secret-val");
        expect(env1).toContain("EMAIL_FROM=Kvitbit <no-reply@kvitbit.cz>");
        expect(env1).not.toContain("KVITBIT_SMTP_URL=");
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "iptables-rule"))),
        ).toContain("10.42.0.0/20");

        const logAfterFirst = await Effect.runPromise(fs.readFileString(join(stateDir, "log")));
        expect(logAfterFirst).toContain("systemctl:start kvitbit-worker.service");

        // 2. Second reconcile with same digest AND same config is a no-op
        expect((await reconcile()).exitCode).toBe(0);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "log")))).toBe(
          logAfterFirst,
        );

        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config"), configJson2));
        expect((await reconcile()).exitCode).toBe(0);
        const env2 = await Effect.runPromise(fs.readFileString(join(runDir, "worker.env")));
        expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
        expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
        const logAfterConfigUpdate = await Effect.runPromise(
          fs.readFileString(join(stateDir, "log")),
        );

        // Image metadata updates must agree before the runner pulls anything.
        const guestWritesAfterConfigUpdate = await Effect.runPromise(
          fs.readFileString(join(stateDir, "guest-writes")),
        );
        const targetEnv2 = await Effect.runPromise(
          fs.readFileString(join(runDir, "worker-target.env")),
        );
        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-ref"), ref2));
        expect((await reconcile()).exitCode).toBe(1);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "log")))).toBe(
          logAfterConfigUpdate,
        );

        // A successful pull still needs to report the requested registry digest.
        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-digest"), digest2));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "registry-image-id"), imageId2));
        expect((await reconcile()).exitCode).toBe(1);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "running-digest")))).toBe(
          digest1,
        );
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "running-image-id")))).toBe(
          imageId1,
        );
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "guest-writes")))).toBe(
          guestWritesAfterConfigUpdate,
        );
        expect(await Effect.runPromise(fs.readFileString(join(runDir, "worker.env")))).toBe(env2);
        expect(await Effect.runPromise(fs.readFileString(join(runDir, "worker-target.env")))).toBe(
          targetEnv2,
        );

        await Effect.runPromise(fs.writeFileString(join(stateDir, "registry-ref"), ref2));
        expect((await reconcile()).exitCode).toBe(0);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "running-image-id")))).toBe(
          imageId2,
        );
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-digest"))),
        ).toBe(digest2);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-config-sha"))),
        ).toBe(configSha2);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-target"))),
        ).toBe(`${digest2}|${configSha2}`);
        const logAfterFourth = await Effect.runPromise(fs.readFileString(join(stateDir, "log")));
        expect(logAfterFourth).toContain(`docker:pull:${ref2}`);
        expect(
          Arr.filter(
            Str.split("\n")(logAfterFourth),
            (l) => l === "systemctl:start kvitbit-worker.service",
          ).length,
        ).toBe(3);
      },
    );
  }, 30_000);

  test("reconcile retries unavailable config without changing the running target, then converges on recovery", async () => {
    await withRunnerSandbox(
      async ({ reconcile, runDir, stateDir, digest1, configSha1, configSha2, configJson2 }) => {
        expect((await reconcile()).exitCode).toBe(0);
        const env1 = await Effect.runPromise(fs.readFileString(join(runDir, "worker.env")));
        const logAfterFirst = await Effect.runPromise(fs.readFileString(join(stateDir, "log")));

        // A new config SHA can become visible while fetching its JSON still fails.
        const guestWrites = await Effect.runPromise(
          fs.readFileString(join(stateDir, "guest-writes")),
        );
        const configReads = await Effect.runPromise(
          fs.readFileString(join(stateDir, "config-reads")),
        );
        const targetEnv1 = await Effect.runPromise(
          fs.readFileString(join(runDir, "worker-target.env")),
        );
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(fs.remove(join(stateDir, "target-config")));
        expect((await reconcile()).exitCode).toBe(1);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "config-reads")))).toBe(
          configReads + Str.repeat(6)("config fetch\n"),
        );

        // The expected SHA covers every response byte, including any trailing newline.
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "target-config"), `${configJson2}\n`),
        );
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "running-config-sha"))),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-config-sha"))),
        ).toBe(configSha1);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "guest-writes")))).toBe(
          guestWrites,
        );
        expect(await Effect.runPromise(fs.readFileString(join(runDir, "worker.env")))).toBe(env1);
        expect(await Effect.runPromise(fs.readFileString(join(runDir, "worker-target.env")))).toBe(
          targetEnv1,
        );
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "log")))).toBe(
          logAfterFirst,
        );

        // The next tick applies the config-only rollout once its JSON is available.
        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config"), configJson2));
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "next-attributes-etag"), "changed-during-fetch"),
        );
        const readsBeforeRecovery = await Effect.runPromise(
          fs.readFileString(join(stateDir, "config-reads")),
        );
        expect((await reconcile()).exitCode).toBe(0);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "config-reads")))).toBe(
          readsBeforeRecovery + Str.repeat(2)("config fetch\n"),
        );
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-digest"))),
        ).toBe(digest1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-config-sha"))),
        ).toBe(configSha2);
        const env2 = await Effect.runPromise(fs.readFileString(join(runDir, "worker.env")));
        expect(env2).toContain("EMAIL_FROM=Billing <billing@kvitbit.cz>");
        expect(env2).toContain("KVITBIT_SMTP_URL=smtps://mailer.example:465");
        expect(
          Arr.filter(
            Str.split("\n")(await Effect.runPromise(fs.readFileString(join(stateDir, "log")))),
            (l) => l === "systemctl:start kvitbit-worker.service",
          ).length,
        ).toBe(2);
        const logAfterConfigUpdate = await Effect.runPromise(
          fs.readFileString(join(stateDir, "log")),
        );
        expect((await reconcile()).exitCode).toBe(0);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "log")))).toBe(
          logAfterConfigUpdate,
        );
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-target"))),
        ).toBe(`${digest1}|${configSha2}`);
      },
    );
  }, 30_000);

  test("deploy waits for the verified rollback after a worker acknowledgement fails", async () => {
    await withRunnerSandbox(
      async ({ binDir, reconcile, stateDir, digest1, configSha1, configSha2, configJson2 }) => {
        const workflow = parseDeployWorkflow(
          await Effect.runPromise(
            fs.readFileString(resolve(import.meta.dir, "../../../.github/workflows/deploy.yml")),
          ),
        );
        const verify = Option.getOrUndefined(
          Arr.findFirst(
            workflow.jobs.deploy.steps,
            (step) => step.name === "Verify runner pool reconciled target digest and config",
          ),
        )?.run;
        if (verify === undefined) throw new Error("Expected the runner verification step");
        const gcloud = join(binDir, "gcloud");
        await Effect.runPromise(
          fs.writeFileString(
            gcloud,
            `#!/bin/sh
set -eu
case "$3" in
  list) printf 'runner\\n' ;;
  describe)
    printf '{"metadata":{"items":[{"key":"kvitbit-worker-config-sha","value":"%s"}]}}' "$(cat "${stateDir}/target-config-sha")"
    ;;
  get-guest-attributes) cat "${stateDir}/guest-active-target" ;;
  reset) : ;;
  *) exit 1 ;;
esac
`,
          ),
        );
        await Effect.runPromise(fs.chmod(gcloud, 0o755));
        const verifyRollout = () =>
          runCommand({
            command: ["bash", "-c", verify],
            env: {
              PATH: `${binDir}:${systemPath}`,
              GCP_PROJECT_ID: "kvitbit-prod",
              GCP_ZONE: "europe-west3-a",
              KVITBIT_STAGE: "prod",
              TARGET_DIGEST: digest1,
            },
          });

        expect((await reconcile()).exitCode).toBe(0);
        const configJson1 = await Effect.runPromise(
          fs.readFileString(join(stateDir, "target-config")),
        );
        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config"), configJson2));
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(fs.writeFileString(join(stateDir, "fail-active-target-once"), ""));
        const changed = await reconcile();
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "running-config-sha"))),
        ).toBe(configSha2);

        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config"), configJson1));
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "target-config-sha"), configSha1),
        );
        expect((await verifyRollout()).exitCode).toBe(1);
        expect(changed.exitCode).toBe(1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-target"))),
        ).toBe("pending");
        expect((await reconcile()).exitCode).toBe(0);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "running-config-sha"))),
        ).toBe(configSha1);
        expect((await verifyRollout()).exitCode).toBe(0);

        // If invalidation fails, the current worker must remain running and acknowledged.
        await Effect.runPromise(fs.writeFileString(join(stateDir, "target-config"), configJson2));
        await Effect.runPromise(
          fs.writeFileString(join(stateDir, "target-config-sha"), configSha2),
        );
        await Effect.runPromise(fs.writeFileString(join(stateDir, "fail-invalidation"), ""));
        expect((await reconcile()).exitCode).toBe(1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "running-config-sha"))),
        ).toBe(configSha1);
        expect(
          await Effect.runPromise(fs.readFileString(join(stateDir, "guest-active-target"))),
        ).toBe(`${digest1}|${configSha1}`);

        // A later tick can confirm a running target after an acknowledgement write failure.
        await Effect.runPromise(fs.remove(join(stateDir, "fail-invalidation")));
        await Effect.runPromise(fs.writeFileString(join(stateDir, "fail-active-target-once"), ""));
        expect((await reconcile()).exitCode).toBe(1);
        const log = await Effect.runPromise(fs.readFileString(join(stateDir, "log")));
        expect((await reconcile()).exitCode).toBe(0);
        expect(await Effect.runPromise(fs.readFileString(join(stateDir, "log")))).toBe(log);
        expect((await verifyRollout()).exitCode).toBe(0);
      },
    );
  }, 30_000);
});

describe("Cloud Run server service", () => {
  test("wires configured feedback to Cloud Run with a server-only Secret Manager grant", async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        KVITBIT_STAGE: "staging",
        KVITBIT_GCP_PROJECT_ID: "kvitbit-staging",
        KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST,
        KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: " YES ",
        KVITBIT_FEEDBACK_GITHUB_REPO: " owner/feedback ",
        KVITBIT_FEEDBACK_OWNER_EMAILS: " owner@example.com, admin@example.com ",
      },
    });
    const config = await Effect.runPromise(
      loadStackConfig.pipe(Effect.provide(ConfigProvider.layer(provider))),
    );
    const names = resourceNames(config);
    const secretId = "kvitbit-staging-feedback-github-token";
    const secret = `projects/kvitbit-staging/secrets/${secretId}`;
    expect(Arr.map(secretDeclarations(config), (entry) => entry.secretId)).toContain(secretId);
    expect(
      Arr.filter(secretAccessorGrants(config), (grant) => grant.secretId === secretId),
    ).toEqual([
      {
        id: `SecretAccess-${secretId}-server`,
        secretId,
        workload: "server",
        props: {
          kind: "secretmanager.secret",
          name: secret,
          role: "roles/secretmanager.secretAccessor",
          member: `serviceAccount:${names.serverServiceAccountId}@kvitbit-staging.iam.gserviceaccount.com`,
        },
      },
    ]);

    const service = serverServiceProps({
      config,
      deps: {
        networkName: names.networkName,
        subnetworkName: names.subnetworkName,
        blobsBucketName: config.blobsBucket,
        mobileAssetsBucketName: config.mobileAssetsBucket,
      },
    });
    const container = service.template?.containers?.[0];
    const env = container !== undefined && "env" in container ? container.env : undefined;
    expect(env).toContainEqual({ name: "KVITBIT_FEEDBACK_GITHUB_REPO", value: "owner/feedback" });
    expect(env).toContainEqual({
      name: "KVITBIT_FEEDBACK_OWNER_EMAILS",
      value: "owner@example.com, admin@example.com",
    });
    expect(env).toContainEqual({
      name: "KVITBIT_FEEDBACK_GITHUB_TOKEN",
      valueSource: { secretKeyRef: { secret, version: "latest" } },
    });

    const runner = buildRunnerWorkerConfig({ config });
    expect(
      Arr.some(runner.plainEnv, (entry) => Str.startsWith("KVITBIT_FEEDBACK_")(entry.name)),
    ).toBe(false);
    expect(Arr.map(runner.secrets, (entry) => entry.secretId)).not.toContain(secretId);
  });

  test("wires Direct VPC egress, /healthz probes, cluster mode, and all shared env vars", () => {
    const config = sampleProdConfig();
    const names = resourceNames(config);
    const props = serverServiceProps({
      config,
      deps: {
        networkName: names.networkName,
        subnetworkName: names.subnetworkName,
        blobsBucketName: config.blobsBucket,
        mobileAssetsBucketName: config.mobileAssetsBucket,
      },
    });

    expect(props.location).toBe("europe-west3");
    expect(props.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(props.template?.vpcAccess?.egress).toBe("PRIVATE_RANGES_ONLY");
    expect(props.template?.vpcAccess?.networkInterfaces?.[0]).toEqual({
      network: names.networkName,
      subnetwork: names.subnetworkName,
    });

    const container = props.template?.containers?.[0];
    expect(container !== undefined && "image" in container ? container.image : undefined).toBe(
      imageReference(config),
    );
    expect(
      container !== undefined && "startupProbe" in container
        ? container.startupProbe?.httpGet?.path
        : null,
    ).toBe("/healthz");
    expect(
      container !== undefined && "livenessProbe" in container
        ? container.livenessProbe?.httpGet?.path
        : null,
    ).toBe("/healthz");

    const plainNames = Arr.map(
      serverPlainEnv({
        config,
        buckets: {
          blobsBucket: config.blobsBucket,
          mobileAssetsBucket: config.mobileAssetsBucket,
        },
      }),
      (e) => e.name,
    );
    const secretNames = Arr.map(serverSecretEnv(config), (e) => e.name);
    expect(plainNames).not.toContain("KVITBIT_FEEDBACK_GITHUB_REPO");
    expect(plainNames).not.toContain("KVITBIT_FEEDBACK_OWNER_EMAILS");
    expect(secretNames).not.toContain("KVITBIT_FEEDBACK_GITHUB_TOKEN");

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

    const policy = edgeSecurityPolicyProps({ config, edge });
    expect(policy.type).toBe("CLOUD_ARMOR");
    expect(Arr.some(policy.rules, (r) => r.action === "throttle")).toBe(true);
    expect(Arr.some(policy.rules, (r) => r.priority === 2147483647 && r.action === "allow")).toBe(
      true,
    );

    const links = { backendGroup: "neg-link", securityPolicy: "policy-link" };
    const dyn = edgeDynamicBackendProps({ config, links });
    expect(dyn.logConfig.enable).toBe(false);

    const stat = edgeStaticBackendProps({ config, edge, links });
    expect("cdnPolicy" in stat && stat.cdnPolicy.cacheMode).toBe("USE_ORIGIN_HEADERS");

    const urlMap = edgeUrlMapProps({ config, edge, backends: { dynamic: "dyn", static: "stat" } });
    expect(urlMap.hostRules[0]?.hosts).toEqual(["kvitbit.cz", "kvitbit.app"]);
    expect(urlMap.pathMatchers[0]?.pathRules[0]?.paths).toEqual([...edgeStaticAssetPaths]);

    expect(tokenRouteExclusionFilter).toContain("/i/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/invite/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/share/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/v1/invitations/[^/?#]+");
    expect(tokenRouteExclusionFilter).toContain("/api/auth/magic-link/verify");

    // Behavioral regex check against real token-bearing and non-token URLs
    const regexMatch = Option.getOrNull(Str.match(logFilterPattern)(tokenRouteExclusionFilter));
    expect(regexMatch?.[1]).toBeDefined();
    const pattern = new RegExp(regexMatch?.[1] ?? "");

    const invoiceLink = "https://kvitbit.cz/i/tok123";
    for (const url of [
      invoiceLink,
      `${invoiceLink}?download=1`,
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

describe("Pure-Alchemy Cloud DNS", () => {
  const compile = (config: KvitbitStackConfig) =>
    Stack.Stack(
      KVITBIT_STACK_NAME,
      { state: State.inMemoryState(), providers: Layer.empty },
      declareKvitbitStack(config).pipe(Effect.orDie),
    ).pipe(Effect.scoped, Effect.provideService(Stage, config.stage), Effect.runPromise);

  const resolveOutputs = <A>(
    value: Output.Output<A, never> | A,
    upstream: Record<string, Schema.Json>,
  ) =>
    Effect.runPromise(
      Output.evaluate<A>(value, upstream).pipe(Effect.provide(State.inMemoryState())),
    );

  test.each(["prod", "staging"] as const)(
    "keeps DNS opt-in for %s even when the edge is configured",
    async (stage) => {
      const compiled = await compile(sampleProdConfig({ stage }));
      expect(compiled.resources["EdgeAddress"]).toBeDefined();
      expect(compiled.resources["CloudDnsApi"]).toBeUndefined();
      expect(
        Arr.some(Record.keys(compiled.resources), (id) => Str.startsWith("DnsZone-")(id)),
      ).toBe(false);
      expect(compiled.output).not.toHaveProperty("dnsNameServers");
    },
  );

  test("declares public zones and exports each zone's nameservers before edge setup", async () => {
    const compiled = await compile(sampleProdConfig({ dnsZones: PROD_DNS_ZONES, edge: undefined }));
    const api = compiled.resources["CloudDnsApi"];
    expect(api?.Type).toBe("GCP.ServiceUsage.ProjectService");
    expect(api?.Props).toEqual({ project: "kvitbit-prod", service: "dns.googleapis.com" });
    expect(
      Arr.filter(Record.keys(compiled.resources), (id) => Str.startsWith("DnsZone-")(id)),
    ).toEqual(Arr.map(PROD_DNS_ZONES, (domain) => `DnsZone-${domain}`));

    const upstream: Record<string, Schema.Json> = {};
    upstream["CloudDnsApi"] = { state: "ENABLED" };
    const expectedNameServers: Record<string, string[]> = {};
    await runSerial(PROD_DNS_ZONES.entries())(async ([index, domain]) => {
      const id = `DnsZone-${domain}`;
      const resource = compiled.resources[id];
      expect(resource?.Type).toBe("GCP.DNS.ManagedZone");
      expect(Record.keys(Output.upstreamAny(resource?.Props))).toEqual(["CloudDnsApi"]);
      expect(await resolveOutputs(resource?.Props, upstream)).toMatchObject({
        zoneName: expect.stringMatching(
          new RegExp(`^kvitbit-prod-${Str.replace(".", "-")(domain)}-[0-9a-f]{12}$`),
        ),
        dnsName: `${domain}.`,
        visibility: "public",
        labels: { app: "kvitbit", stage: "prod", "managed-by": "alchemy" },
      });
      const nameServers = [`ns-cloud-a${index + 1}.googledomains.com.`];
      upstream[id] = { nameServers };
      expectedNameServers[domain] = nameServers;
    });
    if (!("dnsNameServers" in compiled.output)) throw new Error("Expected DNS outputs");
    const resolvedNameServers = await Promise.all(
      Arr.map(
        Record.toEntries(compiled.output.dnsNameServers),
        async ([domain, output]) =>
          [domain, await resolveOutputs<ReadonlyArray<string>>(output, upstream)] as const,
      ),
    );
    expect(Record.fromEntries(resolvedNameServers)).toEqual(expectedNameServers);
  });

  test("points each apex and www at the reserved edge IP and configures CAA", async () => {
    const compiled = await compile(sampleProdConfig({ dnsZones: PROD_DNS_ZONES }));
    expect(compiled.resources["EdgeAddress"]).toBeDefined();
    await runSerial(PROD_DNS_ZONES)(async (domain) => {
      const id = `DnsZone-${domain}`;
      const upstream = {
        [id]: { zoneName: "resolved-zone" },
        EdgeAddress: { address: "192.0.2.42" },
      };
      const expectedRecords = [
        { suffix: "ApexA", name: `${domain}.`, type: "A", rrdatas: ["192.0.2.42"] },
        { suffix: "WwwA", name: `www.${domain}.`, type: "A", rrdatas: ["192.0.2.42"] },
        {
          suffix: "ApexCaa",
          name: `${domain}.`,
          type: "CAA",
          rrdatas: ['0 issue "pki.goog"', '0 issue "letsencrypt.org"'],
        },
      ];
      await runSerial(expectedRecords)(async ({ suffix, ...record }) => {
        const resource = compiled.resources[`${id}-${suffix}`];
        expect(resource?.Type).toBe("GCP.DNS.ResourceRecordSet");
        expect(Record.keys(Output.upstreamAny(resource?.Props))).toEqual(
          record.type === "A" ? [id, "EdgeAddress"] : [id],
        );
        expect(await resolveOutputs(resource?.Props, upstream)).toEqual({
          managedZone: "resolved-zone",
          ttl: 300,
          ...record,
        });
      });
    });
  });
});

describe("Zero-Terraform enforcement", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");

  const collectFiles = async (dir: string): Promise<Array<string>> => {
    const out: Array<string> = [];
    for (const name of await Effect.runPromise(fs.readDirectory(dir))) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      const info = await Effect.runPromise(fs.lstat(full));
      if (info.type === "Directory") out.push(...(await collectFiles(full)));
      else out.push(full);
    }
    return out;
  };

  test("contains zero .tf/.tfvars files and zero terraform CLI usage in infra/deploy artifacts", async () => {
    const infraFiles = await collectFiles(join(repoRoot, "infra"));
    const tfFiles = Arr.filter(infraFiles, (file) => terraformFile.test(file));
    expect(tfFiles).toEqual([]);

    const deployWorkflow = await Effect.runPromise(
      fs.readFileString(join(repoRoot, ".github/workflows/deploy.yml")),
    );
    expect(Str.toLowerCase(deployWorkflow)).not.toContain("terraform");
    expect(Str.toLowerCase(deployWorkflow)).not.toContain("opentofu");
  });
});
