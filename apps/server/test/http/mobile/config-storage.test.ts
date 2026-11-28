import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GcsAccessToken } from "@kvitbit/adapters/blob";
import { ConfigProvider, Effect, Layer, Option, Redacted, Stream } from "effect";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import {
  MobileConfig,
  MobileConfigLive,
  MobileStorage,
  MobileStorageGcs,
  MobileStorageLocal,
  normalizeFingerprint,
} from "../../../src/http/mobile";

const loadConfig = (env: Record<string, string>) =>
  Effect.gen(function* () {
    return yield* MobileConfig;
  }).pipe(
    Effect.provide(MobileConfigLive),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

describe("MobileConfigLive", () => {
  test("prefers KVITBIT_MOBILE_STORAGE_BUCKET over dir and KVITBIT_BLOB_*", async () => {
    const config = await Effect.runPromise(
      loadConfig({
        APP_ORIGIN: "https://app.kvitbit.cz/",
        KVITBIT_MOBILE_STORAGE_BUCKET: "mobile-bucket",
        KVITBIT_MOBILE_STORAGE_DIR: "/ignored/mobile",
        KVITBIT_BLOB_DRIVER: "local",
        KVITBIT_BLOB_DIR: "/ignored/blob",
      }),
    );
    expect(config.appOrigin).toBe("https://app.kvitbit.cz");
    expect(config.storage).toEqual({
      _tag: "gcs",
      bucket: "mobile-bucket",
      endpoint: undefined,
    });
  });

  test("uses KVITBIT_MOBILE_STORAGE_DIR before KVITBIT_BLOB_*", async () => {
    const config = await Effect.runPromise(
      loadConfig({
        KVITBIT_MOBILE_STORAGE_DIR: "/srv/mobile",
        KVITBIT_BLOB_DRIVER: "gcs",
        KVITBIT_BLOB_BUCKET: "ignored-bucket",
      }),
    );
    expect(config.storage).toEqual({ _tag: "local", dir: "/srv/mobile" });
  });

  test("falls back to KVITBIT_BLOB_DRIVER/BUCKET/DIR and default blob dir", async () => {
    const gcsConfig = await Effect.runPromise(
      loadConfig({
        KVITBIT_BLOB_DRIVER: "gcs",
        KVITBIT_BLOB_BUCKET: "shared-blobs",
      }),
    );
    expect(gcsConfig.storage).toEqual({
      _tag: "gcs",
      bucket: "shared-blobs",
      endpoint: undefined,
    });

    const localConfig = await Effect.runPromise(
      loadConfig({
        KVITBIT_BLOB_DRIVER: "local",
        KVITBIT_BLOB_DIR: "/data/kvitbit",
      }),
    );
    expect(localConfig.storage).toEqual({ _tag: "local", dir: "/data/kvitbit" });

    const defaultConfig = await Effect.runPromise(loadConfig({}));
    expect(defaultConfig.storage).toEqual({ _tag: "local", dir: "/var/lib/kvitbit/blobs" });

    const missingBucket = await Effect.runPromise(
      Effect.result(loadConfig({ KVITBIT_BLOB_DRIVER: "gcs" })),
    );
    expect(missingBucket._tag).toBe("Failure");
  });

  test("honors explicit GCS driver in staging/preview even when image default KVITBIT_MOBILE_STORAGE_DIR is set, and rejects implicit local fallback", async () => {
    for (const env of ["staging", "preview"] as const) {
      const gcs = await Effect.runPromise(
        loadConfig({
          KVITBIT_ENV: env,
          APP_ORIGIN: "https://staging.kvitbit.cz",
          KVITBIT_BLOB_DRIVER: "gcs",
          KVITBIT_BLOB_BUCKET: "shared-blobs",
          KVITBIT_MOBILE_STORAGE_DIR: "/var/lib/kvitbit/mobile",
        }),
      );
      expect(gcs.storage).toEqual({ _tag: "gcs", bucket: "shared-blobs", endpoint: undefined });

      const implicitDisk = await Effect.runPromise(
        Effect.result(
          loadConfig({
            KVITBIT_ENV: env,
            APP_ORIGIN: "https://staging.kvitbit.cz",
            KVITBIT_MOBILE_STORAGE_DIR: "/var/lib/kvitbit/mobile",
          }),
        ),
      );
      expect(implicitDisk._tag).toBe("Failure");

      const explicitLocal = await Effect.runPromise(
        loadConfig({
          KVITBIT_ENV: env,
          APP_ORIGIN: "https://staging.kvitbit.cz",
          KVITBIT_BLOB_DRIVER: "local",
          KVITBIT_MOBILE_STORAGE_DIR: "/var/lib/kvitbit/mobile",
        }),
      );
      expect(explicitLocal.storage).toEqual({ _tag: "local", dir: "/var/lib/kvitbit/mobile" });
    }
  });

  test("unescapes PEM signing key and normalizes comma-separated SHA-256 fingerprints", async () => {
    const hex64 = "ab".repeat(32);
    const colon = Array.from({ length: 32 }, () => "cd").join(":");
    const config = await Effect.runPromise(
      loadConfig({
        KVITBIT_MOBILE_UPDATES_SIGNING_KEY:
          "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        KVITBIT_ANDROID_ASSETLINKS_SHA256: ` ${hex64}, ${colon}, ${hex64.toUpperCase()} `,
      }),
    );
    expect(Option.isSome(config.signingKeyPem)).toBe(true);
    if (Option.isSome(config.signingKeyPem)) {
      expect(Redacted.value(config.signingKeyPem.value)).toBe(
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      );
    }
    expect(config.androidAssetLinksSha256).toEqual([
      Array.from({ length: 32 }, () => "AB").join(":"),
      Array.from({ length: 32 }, () => "CD").join(":"),
    ]);

    const invalid = await Effect.runPromise(
      Effect.result(loadConfig({ KVITBIT_ANDROID_ASSETLINKS_SHA256: "not-a-fingerprint" })),
    );
    expect(invalid._tag).toBe("Failure");
    expect(normalizeFingerprint("zz".repeat(32))).toBeUndefined();
  });
});

describe("MobileStorageLocal", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kvitbit-mobile-storage-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns empty list and NotFound for missing root or traversal keys", async () => {
    const missingRoot = join(root, "does-not-exist");
    const layer = MobileStorageLocal(missingRoot);

    const keys = await Effect.runPromise(
      Effect.flatMap(MobileStorage, (s) => s.list("mobile/releases/")).pipe(Effect.provide(layer)),
    );
    expect(keys).toEqual([]);

    const traversal = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(MobileStorage, (s) => s.getText("../etc/passwd")).pipe(
          Effect.provide(layer),
        ),
      ),
    );
    expect(traversal._tag).toBe("Failure");
    if (traversal._tag === "Failure") {
      expect(traversal.failure._tag).toBe("MobileStorageNotFound");
    }
  });

  test("rejects symlinks under root with MobileStorageUnavailable", async () => {
    const outsideFile = join(root, "outside.txt");
    const storeRoot = join(root, "store");
    await writeFile(outsideFile, "secret");
    await mkdir(join(storeRoot, "mobile/updates/assets"), { recursive: true });
    await symlink(outsideFile, join(storeRoot, "mobile/updates/assets/link"));

    const layer = MobileStorageLocal(storeRoot);
    const readRes = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(MobileStorage, (s) => s.getText("mobile/updates/assets/link")).pipe(
          Effect.provide(layer),
        ),
      ),
    );
    expect(readRes._tag).toBe("Failure");
    if (readRes._tag === "Failure") {
      expect(readRes.failure._tag).toBe("MobileStorageUnavailable");
    }

    const listRes = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(MobileStorage, (s) => s.list("mobile/updates/assets/")).pipe(
          Effect.provide(layer),
        ),
      ),
    );
    expect(listRes._tag).toBe("Failure");
    if (listRes._tag === "Failure") {
      expect(listRes.failure._tag).toBe("MobileStorageUnavailable");
    }
  });
});

describe("MobileStorageGcs", () => {
  test("paginates list, streams objects, handles 404, and retries once on 401", async () => {
    let tokenCounter = 0;
    const invalidated: Array<string> = [];
    const tokensLayer = Layer.succeed(GcsAccessToken, {
      get: Effect.sync(() => `tok-${++tokenCounter}`),
      invalidate: (token) => Effect.sync(() => void invalidated.push(token)),
    });

    const fakeClient = HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const auth = request.headers.authorization;
        if (url.pathname === "/storage/v1/b/my-bucket/o") {
          if (auth === "Bearer tok-1") {
            return HttpClientResponse.fromWeb(
              request,
              new Response("unauthorized", { status: 401 }),
            );
          }
          const pageToken = Option.getOrNull(UrlParams.getFirst(request.urlParams, "pageToken"));
          const body =
            pageToken === null
              ? { items: [{ name: "mobile/releases/1.0.0/release.json" }], nextPageToken: "p2" }
              : { items: [{ name: "mobile/releases/1.1.0/release.json" }] };
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.pathname.endsWith(encodeURIComponent("mobile/updates/assets/ok"))) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([9, 8, 7]), {
              status: 200,
              headers: {
                "content-type": "application/javascript",
                "content-length": "3",
              },
            }),
          );
        }
        return HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }));
      }),
    );

    const layer = MobileStorageGcs({
      bucket: "my-bucket",
      endpoint: "https://gcs.test",
    }).pipe(Layer.provide([Layer.succeed(HttpClient.HttpClient, fakeClient), tokensLayer]));

    const listed = await Effect.runPromise(
      Effect.flatMap(MobileStorage, (s) => s.list("mobile/releases/")).pipe(Effect.provide(layer)),
    );
    expect(listed).toEqual([
      "mobile/releases/1.0.0/release.json",
      "mobile/releases/1.1.0/release.json",
    ]);
    expect(invalidated).toEqual(["tok-1"]);

    const streamed = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* MobileStorage;
        const result = yield* storage.getStream("mobile/updates/assets/ok");
        const chunks = yield* Stream.runCollect(result.stream);
        return {
          contentType: result.contentType,
          size: result.size,
          bytes: Array.from(chunks).flatMap((c) => Array.from(c)),
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(streamed).toEqual({
      contentType: "application/javascript",
      size: 3,
      bytes: [9, 8, 7],
    });

    const missing = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(MobileStorage, (s) => s.getText("mobile/updates/assets/nope")).pipe(
          Effect.provide(layer),
        ),
      ),
    );
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") {
      expect(missing.failure._tag).toBe("MobileStorageNotFound");
    }
  });
});
