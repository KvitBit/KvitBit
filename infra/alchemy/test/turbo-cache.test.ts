import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import {
  KVITBIT_PROD_DEFAULTS,
  KVITBIT_TURBO_CACHE_DEFAULTS,
  loadStackConfig,
  validateStackConfig,
} from "../src/config";
import { secretAccessorGrants, secretDeclarations } from "../src/resources/foundation";
import {
  turboCacheBucketProps,
  turboCacheLifecycleJson,
  turboCacheServiceAccountProps,
  turboCacheServiceProps,
} from "../src/resources/turbo-cache";

const SAMPLE_DIGEST = `sha256:${"a".repeat(64)}`;

const loadWithEnv = (env: Record<string, string>) =>
  Effect.runPromise(
    loadStackConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { KVITBIT_IMAGE_DIGEST: SAMPLE_DIGEST, ...env },
          }),
        ),
      ),
    ),
  );

describe("Self-hosted Turborepo remote cache on GCP", () => {
  test("disabled by default with no turbo-cache secret or workload", async () => {
    const config = await loadWithEnv({});
    expect(config.turboCache).toBeUndefined();
    expect(config.secrets.some((s) => s.environmentVariable === "TURBO_TOKEN")).toBe(false);
  });

  test("enables GCS bucket, dedicated SA, Secret Manager token, and Cloud Run service when KVITBIT_ENABLE_TURBO_CACHE=true", async () => {
    const config = await loadWithEnv({ KVITBIT_ENABLE_TURBO_CACHE: "true" });
    expect(config.turboCache).toEqual({
      bucket: `${KVITBIT_PROD_DEFAULTS.projectId}-turbo-cache-prod`,
      image: KVITBIT_TURBO_CACHE_DEFAULTS.image,
      ttlDays: KVITBIT_TURBO_CACHE_DEFAULTS.ttlDays,
      maxInstances: KVITBIT_TURBO_CACHE_DEFAULTS.maxInstances,
    });

    const tokenSecret = config.secrets.find((s) => s.environmentVariable === "TURBO_TOKEN");
    expect(tokenSecret).toEqual({
      environmentVariable: "TURBO_TOKEN",
      secretId: "kvitbit-prod-turbo-cache-token",
      version: "latest",
      required: false,
      consumers: ["turbo-cache"],
    });

    // Secret container is declared by foundation so bootstrap_turbo_cache_secret can create it,
    // while server/runner SAs receive zero access to TURBO_TOKEN.
    expect(
      secretDeclarations(config).some((d) => d.id === "Secret-kvitbit-prod-turbo-cache-token"),
    ).toBe(true);
    expect(
      secretAccessorGrants(config).some((g) => g.secretId === "kvitbit-prod-turbo-cache-token"),
    ).toBe(false);

    const turboCache = config.turboCache;
    if (!turboCache) throw new Error("expected turboCache config");

    const bucket = turboCacheBucketProps(config, turboCache);
    expect(bucket).toMatchObject({
      bucketName: "kvitbit-prod-turbo-cache-prod",
      location: "EUROPE-WEST3",
      versioning: false,
      uniformBucketLevelAccess: true,
      forceDestroy: true,
    });

    const sa = turboCacheServiceAccountProps(config);
    expect(sa.accountId).toBe("kvitbit-prod-turbo-cache");

    const service = turboCacheServiceProps(config, turboCache, {
      bucketName: turboCache.bucket,
    });
    expect(service.serviceId).toBe("kvitbit-prod-turbo-cache");
    expect(service.location).toBe("europe-west3");
    expect(service.ingress).toBe("INGRESS_TRAFFIC_ALL");
    const template = service.template;
    if (!template) throw new Error("expected service.template");
    expect(template.serviceAccount).toBe(
      "kvitbit-prod-turbo-cache@kvitbit-prod.iam.gserviceaccount.com",
    );
    expect(template.scaling).toEqual({ minInstanceCount: 0, maxInstanceCount: 4 });
    const container = template.containers?.[0];
    if (!container || !("env" in container)) {
      throw new Error("expected ContainerSpec with env");
    }
    expect(container.image).toBe(KVITBIT_TURBO_CACHE_DEFAULTS.image);
    expect(container.env).toEqual([
      { name: "STORAGE_PROVIDER", value: "google-cloud-storage" },
      { name: "STORAGE_PATH", value: "kvitbit-prod-turbo-cache-prod" },
      { name: "GOOGLE_CLOUD_PROJECT", value: "kvitbit-prod" },
      { name: "BODY_LIMIT", value: String(KVITBIT_TURBO_CACHE_DEFAULTS.bodyLimitBytes) },
      {
        name: "TURBO_TOKEN",
        valueSource: {
          secretKeyRef: {
            secret: "kvitbit-prod-turbo-cache-token",
            version: "latest",
          },
        },
      },
    ]);
  });

  test("produces valid GCS lifecycle JSON for cache TTL expiration", () => {
    const parsed = JSON.parse(turboCacheLifecycleJson(30)) as {
      rule: Array<{ action: { type: string }; condition: { age: number } }>;
    };
    expect(parsed.rule).toEqual([{ action: { type: "Delete" }, condition: { age: 30 } }]);
  });

  test("rejects out-of-range TTL or max instances", async () => {
    await expect(
      loadWithEnv({ KVITBIT_ENABLE_TURBO_CACHE: "true", KVITBIT_TURBO_CACHE_TTL_DAYS: "0" }),
    ).rejects.toThrow(/KVITBIT_TURBO_CACHE_TTL_DAYS/);

    await expect(
      loadWithEnv({ KVITBIT_ENABLE_TURBO_CACHE: "true", KVITBIT_TURBO_CACHE_MAX_INSTANCES: "99" }),
    ).rejects.toThrow(/KVITBIT_TURBO_CACHE_MAX_INSTANCES/);

    const base = await loadWithEnv({});
    await expect(
      Effect.runPromise(
        validateStackConfig({
          ...base,
          turboCache: {
            bucket: "kvitbit-prod-turbo-cache-prod",
            image: KVITBIT_TURBO_CACHE_DEFAULTS.image,
            ttlDays: 30,
            maxInstances: 4,
          },
        }),
      ),
    ).rejects.toThrow(/TURBO_TOKEN/);
  });
});
