import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
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
  edgeDynamicBackendProps,
  edgeObjectNames,
  edgeSecurityPolicyProps,
  edgeStaticAssetPaths,
  edgeStaticBackendProps,
  edgeUrlMapProps,
  tokenRouteExclusionFilter,
} from "../src/resources/edge";
import {
  artifactRepositoryProps,
  blobsBucketProps,
  mobileAssetsBucketProps,
  secretAccessorGrants,
  secretDeclarations,
} from "../src/resources/foundation";
import {
  buildRunnerStartupScript,
  COS_STABLE_IMAGE,
  networkProps,
  routerProps,
  runnerFirewallProps,
  runnerInstanceProps,
  subnetworkProps,
} from "../src/resources/network";
import { serverServiceProps } from "../src/resources/server";

const SAMPLE_DIGEST = `sha256:${"a".repeat(64)}`;

const sampleProdConfig = (overrides: Partial<KvitbitStackConfig> = {}): KvitbitStackConfig => ({
  stage: "prod",
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

  test("enables HTTPS edge and bumps trustedProxyHops when KVITBIT_EDGE_DOMAINS is set", async () => {
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
    expect(config.trustedProxyHops).toBe(2);
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
    expect(secrets.map((s) => s.secretId)).toContain("kvitbit-prod-better-auth-secret");

    const grants = secretAccessorGrants(config);
    const mobileSigningGrants = grants.filter(
      (g) => g.secretId === "kvitbit-prod-mobile-updates-signing-key",
    );
    expect(mobileSigningGrants.map((g) => g.workload)).toEqual(["server"]);
    const dbGrants = grants.filter((g) => g.secretId === "kvitbit-prod-database-url");
    expect(dbGrants.map((g) => g.workload).sort()).toEqual(["runner", "server"]);
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

  test("startup script runs Kvitbit image in worker mode with full KVITBIT_* env, Chromium, and Secret Manager boot fetch", () => {
    const config = sampleProdConfig();
    const script = buildRunnerStartupScript(config);

    expect(script).toContain("network-interfaces/0/ip");
    expect(script).toContain("docker run --rm --name kvitbit-worker --network host");
    expect(script).toContain(`${imageReference(config)} worker`);
    expect(script).toContain("secretmanager.googleapis.com/v1/projects/kvitbit-prod/secrets/");
    expect(script).toContain("fetch_secret 'DATABASE_URL' 'kvitbit-prod-database-url'");
    expect(script).toContain("fetch_secret 'BETTER_AUTH_SECRET' 'kvitbit-prod-better-auth-secret'");
    expect(script).toContain("'KVITBIT_RUNNER_MODE' 'cluster'");
    expect(script).toContain("'KVITBIT_BLOB_DRIVER' 'gcs'");
    expect(script).toContain("'KVITBIT_CHROMIUM_PATH' '/usr/bin/chromium'");
    expect(script).toContain("'PORT' '34431'");

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
    expect(tokenRouteExclusionFilter).toContain("/api/auth/magic-link/verify");
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
