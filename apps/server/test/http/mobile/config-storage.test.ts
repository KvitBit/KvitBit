import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { GcsAccessToken } from "@kvitbit/adapters/blob";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import {
  MobileConfig,
  MobileConfigLive,
  MobileStorage,
  MobileStorageGcs,
  MobileStorageLocal,
  normalizeFingerprint,
} from "../../../src/http/mobile";

const loadConfig = (env: Record<string, string>) =>
  MobileConfig.pipe(
    Effect.provide(
      MobileConfigLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
    ),
  );

const fixtureFs = FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer), Effect.runSync);
const fixturePath = Path.Path.pipe(Effect.provide(Path.layer), Effect.runSync);

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

    const missingBucket = await loadConfig({ KVITBIT_BLOB_DRIVER: "gcs" }).pipe(
      Effect.result,
      Effect.runPromise,
    );
    expect(missingBucket._tag).toBe("Failure");
  });

  test("unescapes PEM signing key and normalizes comma-separated SHA-256 fingerprints", async () => {
    const hex64 = Str.repeat(32)("ab");
    const colon = Arr.join(
      Array.from({ length: 32 }, () => "cd"),
      ":",
    );
    const config = await Effect.runPromise(
      loadConfig({
        KVITBIT_MOBILE_UPDATES_SIGNING_KEY:
          "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        KVITBIT_ANDROID_ASSETLINKS_SHA256: ` ${hex64}, ${colon}, ${Str.toUpperCase(hex64)} `,
      }),
    );
    expect(Option.isSome(config.signingKeyPem)).toBe(true);
    const signingKey = config.signingKeyPem.pipe(Option.getOrThrow, Redacted.value);
    expect(signingKey).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    expect(config.androidAssetLinksSha256).toEqual([
      Arr.join(
        Array.from({ length: 32 }, () => "AB"),
        ":",
      ),
      Arr.join(
        Array.from({ length: 32 }, () => "CD"),
        ":",
      ),
    ]);

    const invalid = await loadConfig({
      KVITBIT_ANDROID_ASSETLINKS_SHA256: "not-a-fingerprint",
    }).pipe(Effect.result, Effect.runPromise);
    expect(invalid._tag).toBe("Failure");
    expect(normalizeFingerprint(Str.repeat(32)("zz"))).toBeUndefined();
  });
});

describe("MobileStorageLocal", () => {
  let root: string;

  beforeEach(async () => {
    root = await Effect.runPromise(
      fixtureFs.makeTempDirectory({ prefix: "kvitbit-mobile-storage-" }),
    );
  });

  afterEach(async () => {
    await Effect.runPromise(fixtureFs.remove(root, { recursive: true, force: true }));
  });

  test("returns empty list and NotFound for missing root or traversal keys", async () => {
    const missingRoot = fixturePath.join(root, "does-not-exist");
    const layer = MobileStorageLocal(missingRoot);

    const keys = await Effect.runPromise(
      Effect.flatMap(MobileStorage, (s) => s.list("mobile/releases/")).pipe(Effect.provide(layer)),
    );
    expect(keys).toEqual([]);

    const traversal = await MobileStorage.pipe(
      Effect.flatMap((s) => s.getText("../etc/passwd")),
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
    expect(traversal._tag).toBe("Failure");
    expect(traversal).toHaveProperty("failure._tag", "MobileStorageNotFound");
  });

  test("consumes a local storage stream once", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await Effect.runPromise(fixtureFs.writeFile(fixturePath.join(root, "asset"), bytes));

    const reads = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* MobileStorage;
        const { stream } = yield* storage.getStream("asset");
        const first = yield* Stream.runCollect(stream);
        const second = yield* Stream.runCollect(stream);
        return { first, second };
      }).pipe(Effect.provide(MobileStorageLocal(root))),
    );

    expect(reads).toEqual({ first: [bytes], second: [] });
  });

  test("rejects symlinks under root with MobileStorageUnavailable", async () => {
    const outsideFile = fixturePath.join(root, "outside.txt");
    const storeRoot = fixturePath.join(root, "store");
    await Effect.runPromise(fixtureFs.writeFileString(outsideFile, "secret"));
    await Effect.runPromise(
      fixtureFs.makeDirectory(fixturePath.join(storeRoot, "mobile/updates/assets"), {
        recursive: true,
      }),
    );
    await Effect.runPromise(
      fixtureFs.symlink(outsideFile, fixturePath.join(storeRoot, "mobile/updates/assets/link")),
    );

    const layer = MobileStorageLocal(storeRoot);
    const readRes = await MobileStorage.pipe(
      Effect.flatMap((s) => s.getText("mobile/updates/assets/link")),
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
    expect(readRes._tag).toBe("Failure");
    expect(readRes).toHaveProperty("failure._tag", "MobileStorageUnavailable");

    const listRes = await MobileStorage.pipe(
      Effect.flatMap((s) => s.list("mobile/updates/assets/")),
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
    expect(listRes._tag).toBe("Failure");
    expect(listRes).toHaveProperty("failure._tag", "MobileStorageUnavailable");
  });

  test("rechecks the stream's parent directories when the stream opens", async () => {
    const storeRoot = fixturePath.join(root, "store");
    const assets = fixturePath.join(storeRoot, "assets");
    const movedAssets = fixturePath.join(root, "moved");

    const read = await Effect.gen(function* () {
      yield* fixtureFs.makeDirectory(assets, { recursive: true });
      yield* fixtureFs.writeFileString(fixturePath.join(assets, "asset"), "contents");
      const storage = yield* MobileStorage;
      const { stream } = yield* storage.getStream("assets/asset");
      yield* fixtureFs.rename(assets, movedAssets);
      yield* fixtureFs.symlink(movedAssets, assets);
      return yield* Stream.runCollect(stream).pipe(Effect.result);
    }).pipe(Effect.provide(MobileStorageLocal(storeRoot)), Effect.runPromise);

    expect(read).toHaveProperty("failure._tag", "MobileStorageUnavailable");
  });
});

describe("MobileStorageGcs", () => {
  test("paginates list, streams objects, handles 404, and retries once on 401", async () => {
    let tokenCounter = 0;
    const invalidated: Array<string> = [];
    const tokensLayer = Layer.succeed(GcsAccessToken, {
      get: Effect.sync(() => `tok-${++tokenCounter}`),
      invalidate: (token) =>
        Effect.sync(() => {
          invalidated.push(token);
        }),
    });

    const fakeClient = HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const auth = request.headers["authorization"];
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
        if (Str.endsWith(encodeURIComponent("mobile/updates/assets/ok"))(url.pathname)) {
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
          bytes: Arr.flatMap(chunks, Arr.fromIterable),
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(streamed).toEqual({
      contentType: "application/javascript",
      size: 3,
      bytes: [9, 8, 7],
    });

    const missing = await MobileStorage.pipe(
      Effect.flatMap((s) => s.getText("mobile/updates/assets/nope")),
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    );
    expect(missing._tag).toBe("Failure");
    expect(missing).toHaveProperty("failure._tag", "MobileStorageNotFound");
  });
});
