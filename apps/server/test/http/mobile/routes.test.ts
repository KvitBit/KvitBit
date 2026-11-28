import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { ReleaseInfo } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  assetKey,
  assetMetaKey,
  MobileConfigTest,
  MobileRoutesLive,
  MobileStorage,
  MobileStorageLocal,
  MobileStorageUnavailable,
  obtainiumImportUrl,
  publicationKey,
  releaseApkKey,
  releaseApkPath,
  releaseInfoKey,
  type StoredAssetMeta,
  type StoredRollback,
  type StoredUpdate,
} from "../../../src/http/mobile";
import { makeLocalMobileStorage } from "../../../src/http/mobile/storage";

const ORIGIN = "https://kvitbit.test";
const MULTIPART_BOUNDARY = /multipart\/mixed;\s*boundary=([^\s;]+)/i;
const MANIFEST_SIGNATURE = /^sig="([^"]+)", keyid="main", alg="rsa-v1_5-sha256"$/;

const signedManifestRequest = () =>
  new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
    headers: {
      "expo-protocol-version": "1",
      "expo-platform": "android",
      "expo-runtime-version": "1.4.0",
      "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
    },
  });

const privateKeyPem = (label: string, base64: string) =>
  `-----BEGIN ${label}-----\r\n${base64}\r\n-----END ${label}-----`;

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJsonEffect = Schema.encodeEffect(JsonText);
const decodeJsonEffect = Schema.decodeUnknownEffect(JsonText);
const encodeJson = (value: StoredUpdate | StoredRollback | StoredAssetMeta | ReleaseInfo) =>
  encodeJsonEffect(value).pipe(Effect.runSync);
const decodeJson = (text: string) => decodeJsonEffect(text).pipe(Effect.runSync);
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      createdAt: Schema.String,
      launchAsset: Schema.Struct({ url: Schema.String }),
      assets: Schema.Array(
        Schema.Struct({ url: Schema.String, fileExtension: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
);
const decodeReleaseInfo = Schema.decodeUnknownEffect(ReleaseInfo);

const sha256Hex = (data: Uint8Array | string) => Bun.CryptoHasher.hash("sha256", data, "hex");
const sha256Base64Url = (data: Uint8Array | string) =>
  Bun.CryptoHasher.hash("sha256", data, "base64url");
const md5Hex = (data: Uint8Array | string) => Bun.CryptoHasher.hash("md5", data, "hex");

interface ParsedMultipartPart {
  readonly headers: Record<string, string>;
  readonly body: string;
}

const parseMultipart = (
  contentType: string,
  rawBody: string,
): ReadonlyArray<ParsedMultipartPart> => {
  const boundary = MULTIPART_BOUNDARY.exec(contentType)?.[1];
  assert(boundary, `Missing multipart boundary in ${contentType}`);
  const delimiter = `--${boundary}`;
  const chunks = Str.split(rawBody, delimiter).slice(1);
  const parts: Array<ParsedMultipartPart> = [];
  for (const chunk of chunks) {
    if (Str.startsWith("--")(chunk)) break;
    const trimmed = Str.startsWith("\r\n")(chunk) ? Str.slice(2)(chunk) : chunk;
    const separator = Str.indexOf("\r\n\r\n")(trimmed);
    assert(Option.isSome(separator), "Multipart part has no header/body separator");
    const headerBlock = Str.slice(0, separator.value)(trimmed);
    const bodyWithTrailing = Str.slice(separator.value + 4)(trimmed);
    const body = Str.endsWith("\r\n")(bodyWithTrailing)
      ? Str.slice(0, -2)(bodyWithTrailing)
      : bodyWithTrailing;
    const headers: Record<string, string> = {};
    for (const line of Str.split(headerBlock, "\r\n")) {
      const colon = Str.indexOf(":")(line);
      if (Option.isSome(colon) && colon.value > 0) {
        const name = Str.slice(0, colon.value)(line);
        const value = Str.slice(colon.value + 1)(line);
        headers[Str.toLowerCase(Str.trim(name))] = Str.trim(value);
      }
    }
    parts.push({ headers, body });
  }
  return parts;
};

let storageDir: string;

const fixtureFs = FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer), Effect.runSync);
const fixturePath = Path.Path.pipe(Effect.provide(Path.layer), Effect.runSync);

const putFile = async (relativeKey: string, content: string | Uint8Array) => {
  const fullPath = fixturePath.join(storageDir, relativeKey);
  await Effect.runPromise(
    fixtureFs.makeDirectory(fixturePath.dirname(fullPath), { recursive: true }),
  );
  await Effect.runPromise(
    Predicate.isString(content)
      ? fixtureFs.writeFileString(fullPath, content)
      : fixtureFs.writeFile(fullPath, content),
  );
};

const makeWebHandler = (
  options: {
    readonly signingKeyPem?: Option.Option<Redacted.Redacted<string>>;
    readonly androidAssetLinksSha256?: ReadonlyArray<string>;
    readonly storageLayer?: Layer.Layer<MobileStorage>;
    readonly appOrigin?: string;
  } = {},
) => {
  const app = MobileRoutesLive.pipe(
    Layer.provide([
      options.storageLayer ?? MobileStorageLocal(storageDir),
      MobileConfigTest({
        appOrigin: options.appOrigin ?? ORIGIN,
        signingKeyPem: options.signingKeyPem ?? Option.none(),
        androidAssetLinksSha256: options.androidAssetLinksSha256 ?? [],
      }),
    ]),
  );
  return HttpRouter.toWebHandler(app, { disableLogger: true });
};

const makeUpdateFixture = (overrides: Partial<StoredUpdate> = {}): StoredUpdate => {
  const bundleBytes = new TextEncoder().encode("console.log('kvitbit');");
  const iconBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  return {
    schema: 1,
    type: "update",
    id: "01900000-0000-7000-8000-000000000001",
    createdAt: "2026-11-24T10:00:00.000Z",
    channel: "production",
    platform: "android",
    runtimeVersion: "1.4.0",
    launchAsset: {
      sha256: sha256Hex(bundleBytes),
      hash: sha256Base64Url(bundleBytes),
      key: md5Hex(bundleBytes),
      contentType: "application/javascript",
    },
    assets: [
      {
        sha256: sha256Hex(iconBytes),
        hash: sha256Base64Url(iconBytes),
        key: md5Hex(iconBytes),
        contentType: "image/png",
        fileExtension: ".png",
      },
    ],
    metadata: { branch: "main" },
    extra: { expoClient: { name: "Kvitbit" } },
    ...overrides,
  };
};

beforeEach(async () => {
  storageDir = await Effect.runPromise(
    fixtureFs.makeTempDirectory({ prefix: "kvitbit-mobile-routes-" }),
  );
});

afterEach(async () => {
  await Effect.runPromise(fixtureFs.remove(storageDir, { recursive: true, force: true }));
});

describe("mobile updates manifest route", () => {
  test("returns multipart/mixed manifest for latest publication with origin asset URLs", async () => {
    const older = makeUpdateFixture({
      id: "01900000-0000-7000-8000-000000000001",
      createdAt: "2026-11-24T09:00:00.000Z",
    });
    const newer = makeUpdateFixture({
      id: "01900000-0000-7000-8000-000000000002",
      createdAt: "2026-11-24T10:30:00.000Z",
    });
    await putFile(publicationKey(older), encodeJson(older));
    await putFile(publicationKey(newer), encodeJson(newer));

    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
            accept: "multipart/mixed",
          },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("expo-protocol-version")).toBe("1");
      expect(res.headers.get("expo-sfv-version")).toBe("0");
      expect(res.headers.get("cache-control")).toBe("private, max-age=0");
      const contentType = res.headers.get("content-type") ?? "";
      expect(Str.startsWith("multipart/mixed; boundary=")(contentType)).toBe(true);

      const parts = parseMultipart(contentType, await res.text());
      expect(parts).toHaveLength(2);
      expect(parts[0]?.headers["content-disposition"]).toBe('form-data; name="manifest"');
      expect(parts[0]?.headers["expo-signature"]).toBeUndefined();
      const manifest = decodeManifest(parts[0]?.body ?? "{}").pipe(Effect.runSync);
      expect(manifest.id).toBe(newer.id);
      expect(manifest.createdAt).toBe(newer.createdAt);
      expect(manifest.launchAsset.url).toBe(
        `${ORIGIN}/api/mobile/updates/assets/${newer.launchAsset.sha256}`,
      );
      expect(manifest.assets[0]?.url).toBe(
        `${ORIGIN}/api/mobile/updates/assets/${newer.assets[0]?.sha256}`,
      );
      expect(manifest.assets[0]?.fileExtension).toBe(".png");

      expect(parts[1]?.headers["content-disposition"]).toBe('form-data; name="extensions"');
      expect(decodeJson(parts[1]?.body ?? "{}")).toEqual({ assetRequestHeaders: {} });
    } finally {
      await dispose();
    }
  });

  test("returns rollBackToEmbedded directive when newest publication is a rollback", async () => {
    const update = makeUpdateFixture({
      createdAt: "2026-11-24T09:00:00.000Z",
    });
    const rollback: StoredRollback = {
      schema: 1,
      type: "rollBackToEmbedded",
      id: "01900000-0000-7000-8000-000000000099",
      createdAt: "2026-11-24T11:00:00.000Z",
      channel: "production",
      platform: "android",
      runtimeVersion: "1.4.0",
    };
    await putFile(publicationKey(update), encodeJson(update));
    await putFile(publicationKey(rollback), encodeJson(rollback));

    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
          },
        }),
      );
      expect(res.status).toBe(200);
      const parts = parseMultipart(res.headers.get("content-type") ?? "", await res.text());
      expect(parts[0]?.headers["content-disposition"]).toBe('form-data; name="directive"');
      expect(decodeJson(parts[0]?.body ?? "{}")).toEqual({
        type: "rollBackToEmbedded",
        parameters: { commitTime: rollback.createdAt },
      });
    } finally {
      await dispose();
    }
  });

  test("returns noUpdateAvailable for unknown runtime or matching currentUpdateId", async () => {
    const update = makeUpdateFixture({ channel: "preview", platform: "ios" });
    await putFile(publicationKey(update), encodeJson(update));

    const { handler, dispose } = makeWebHandler();
    try {
      const unknownRuntime = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest?platform=ios&runtime-version=9.9.9`, {
          headers: { "expo-protocol-version": "1", "expo-channel-name": "preview" },
        }),
      );
      expect(unknownRuntime.status).toBe(200);
      const unknownParts = parseMultipart(
        unknownRuntime.headers.get("content-type") ?? "",
        await unknownRuntime.text(),
      );
      expect(unknownParts[0]?.headers["content-disposition"]).toBe('form-data; name="directive"');
      expect(decodeJson(unknownParts[0]?.body ?? "{}")).toEqual({ type: "noUpdateAvailable" });

      const alreadyCurrent = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest?platform=ios&runtime-version=1.4.0`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-channel-name": "preview",
            "expo-current-update-id": update.id,
          },
        }),
      );
      expect(alreadyCurrent.status).toBe(200);
      const currentParts = parseMultipart(
        alreadyCurrent.headers.get("content-type") ?? "",
        await alreadyCurrent.text(),
      );
      expect(decodeJson(currentParts[0]?.body ?? "{}")).toEqual({ type: "noUpdateAvailable" });
    } finally {
      await dispose();
    }
  });

  test.each(["PRIVATE KEY", "RSA PRIVATE KEY"] as const)(
    "signs the manifest with the configured %s PEM",
    async (label) => {
      const update = makeUpdateFixture({ extra: { expoClient: { name: "Kvitbit Česko" } } });
      await putFile(publicationKey(update), encodeJson(update));

      const algorithm = "RSASSA-PKCS1-v1_5";
      const { privateKey, publicKey } = await crypto.subtle.generateKey(
        {
          name: algorithm,
          hash: "SHA-256",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
        },
        true,
        ["sign", "verify"],
      );
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
      // A 2048-bit RSA key exported by WebCrypto has a 26-byte PKCS#8 wrapper.
      const der = label === "RSA PRIVATE KEY" ? pkcs8.subarray(26) : pkcs8;
      const base64 = der.toBase64();
      const pem =
        label === "PRIVATE KEY"
          ? `Bag Attributes\r\nKey Attributes: <No Attributes>\r\n${privateKeyPem(label, `${Str.slice(0, 64)(base64)}  \r\n${Str.slice(64)(base64)}`)}`
          : privateKeyPem(label, base64);
      const { handler, dispose } = makeWebHandler({
        signingKeyPem: Option.some(Redacted.make(pem)),
      });
      try {
        const res = await handler(signedManifestRequest());
        expect(res.status).toBe(200);
        const parts = parseMultipart(res.headers.get("content-type") ?? "", await res.text());
        const manifest = parts[0];
        assert(manifest);
        const sig = MANIFEST_SIGNATURE.exec(manifest.headers["expo-signature"] ?? "")?.[1];
        assert(sig);
        expect(
          await crypto.subtle.verify(
            algorithm,
            publicKey,
            Uint8Array.fromBase64(sig),
            new TextEncoder().encode(manifest.body),
          ),
        ).toBe(true);
      } finally {
        await dispose();
      }
    },
  );

  test("answers 500 when a requested signature cannot use the configured key", async () => {
    const { handler, dispose } = makeWebHandler({
      signingKeyPem: Option.some(Redacted.make(privateKeyPem("RSA PRIVATE KEY", "YWJj"))),
    });
    try {
      const res = await handler(signedManifestRequest());
      expect(res.status).toBe(500);
    } finally {
      await dispose();
    }
  });

  test("answers 503 when expo-expect-signature is requested but no signing key is configured", async () => {
    const update = makeUpdateFixture();
    await putFile(publicationKey(update), encodeJson(update));

    const { handler, dispose } = makeWebHandler({ signingKeyPem: Option.none() });
    try {
      const res = await handler(signedManifestRequest());
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await dispose();
    }
  });

  test("answers 406 for wrong protocol or accept header, and 400 for missing/invalid platform or runtime", async () => {
    const { handler, dispose } = makeWebHandler();
    try {
      const badProtocol = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: { "expo-protocol-version": "0", "expo-platform": "android" },
        }),
      );
      expect(badProtocol.status).toBe(406);

      const badAccept = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            accept: "application/json",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
          },
        }),
      );
      expect(badAccept.status).toBe(406);

      const badPlatform = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "windows",
            "expo-runtime-version": "1.4.0",
          },
        }),
      );
      expect(badPlatform.status).toBe(400);

      const missingRuntime = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: { "expo-protocol-version": "1", "expo-platform": "android" },
        }),
      );
      expect(missingRuntime.status).toBe(400);

      const dotChannel = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
            "expo-channel-name": "..",
          },
        }),
      );
      expect(dotChannel.status).toBe(400);
    } finally {
      await dispose();
    }
  });

  test("answers 503 when storage fails and 500 when stored publication JSON is malformed", async () => {
    const failingStorage = Layer.succeed(MobileStorage, {
      list: () => Effect.fail(MobileStorageUnavailable.make({ cause: "boom" })),
      getText: () => Effect.fail(MobileStorageUnavailable.make({ cause: "boom" })),
      getStream: () => Effect.fail(MobileStorageUnavailable.make({ cause: "boom" })),
    });
    const unavailableHandler = makeWebHandler({ storageLayer: failingStorage });
    try {
      const res = await unavailableHandler.handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
          },
        }),
      );
      expect(res.status).toBe(503);
    } finally {
      await unavailableHandler.dispose();
    }

    await putFile(
      "mobile/updates/channels/production/android/1.4.0/20261124T100000000Z-corrupt.json",
      '{"schema": 99}',
    );
    const corruptHandler = makeWebHandler();
    try {
      const res = await corruptHandler.handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
          },
        }),
      );
      expect(res.status).toBe(500);
    } finally {
      await corruptHandler.dispose();
    }
  });
});

describe("mobile update assets route", () => {
  test("returns 503 on an asset probe close error and preserves a completed text read", async () => {
    const content = "asset";
    const hash = sha256Hex(content);
    await putFile(assetKey(hash), content);

    const closeError = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "open",
      syscall: "close",
      description: "EIO",
    });
    const fs: FileSystem.FileSystem = {
      ...fixtureFs,
      open: (path, options) =>
        fixtureFs
          .open(path, options)
          .pipe(Effect.tap(() => Effect.addFinalizer(() => Effect.die(closeError)))),
    };
    const storageLayer = Layer.effect(MobileStorage, makeLocalMobileStorage(storageDir)).pipe(
      Layer.provide([Layer.succeed(FileSystem.FileSystem, fs), Path.layer]),
    );
    const { handler, dispose } = makeWebHandler({ storageLayer });
    try {
      const res = await handler(new Request(`${ORIGIN}/api/mobile/updates/assets/${hash}`));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await MobileStorage.pipe(
        Effect.flatMap((storage) => storage.getText(assetKey(hash))),
        Effect.provide(storageLayer),
        Effect.runPromise,
      );
      expect(text).toBe(content);
    } finally {
      await dispose();
    }
  });

  test("serves asset bytes with sidecar contentType, immutable cache-control, and nosniff", async () => {
    const bytes = new TextEncoder().encode("export const ok = true;");
    const hash = sha256Hex(bytes);
    const meta: StoredAssetMeta = {
      schema: 1,
      sha256: hash,
      contentType: "application/javascript",
      size: bytes.byteLength,
    };
    await putFile(assetKey(hash), bytes);
    await putFile(assetMetaKey(hash), encodeJson(meta));

    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(new Request(`${ORIGIN}/api/mobile/updates/assets/${hash}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/javascript");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    } finally {
      await dispose();
    }
  });

  test("falls back to application/octet-stream when sidecar is absent and returns 404 for unknown/invalid hash", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = sha256Hex(bytes);
    await putFile(assetKey(hash), bytes);

    const { handler, dispose } = makeWebHandler();
    try {
      const ok = await handler(new Request(`${ORIGIN}/api/mobile/updates/assets/${hash}`));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("application/octet-stream");
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);

      const unknown = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/assets/${Str.repeat(64)("a")}`),
      );
      expect(unknown.status).toBe(404);

      const invalid = await handler(new Request(`${ORIGIN}/api/mobile/updates/assets/not-a-hash`));
      expect(invalid.status).toBe(404);
    } finally {
      await dispose();
    }
  });
});

describe("android releases routes", () => {
  const makeRelease = (version: string, versionCode: number): ReleaseInfo => ({
    version,
    versionCode,
    releasedAt: "2026-11-24T10:00:00.000Z",
    apkUrl: releaseApkPath(version),
    apkSha256: Str.repeat(64)("b"),
    sizeBytes: 123456,
    signingCertSha256: Str.repeat(64)("c"),
    minAndroidSdk: 26,
    obtainiumUrl: obtainiumImportUrl("https://old-build-origin.example"),
  });

  test("GET /api/mobile/releases/latest picks highest versionCode and recomputes obtainiumUrl", async () => {
    const v12 = makeRelease("1.2.0", 1002000);
    const v110 = makeRelease("1.10.0", 1010000);
    await putFile(releaseInfoKey("1.2.0"), encodeJson(v12));
    await putFile(releaseInfoKey("1.10.0"), encodeJson(v110));

    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(new Request(`${ORIGIN}/api/mobile/releases/latest`));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      const body = decodeReleaseInfo(await res.json()).pipe(Effect.runSync);
      expect(body.version).toBe("1.10.0");
      expect(body.versionCode).toBe(1010000);
      expect(body.apkUrl).toBe("/api/mobile/releases/1.10.0/apk");
      expect(body.obtainiumUrl).toBe(obtainiumImportUrl(ORIGIN));
    } finally {
      await dispose();
    }
  });

  test("GET /api/mobile/releases/latest returns 404 when no releases exist", async () => {
    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(new Request(`${ORIGIN}/api/mobile/releases/latest`));
      expect(res.status).toBe(404);
    } finally {
      await dispose();
    }
  });

  test("GET /api/mobile/releases/:version/apk streams APK with attachment disposition", async () => {
    const apkBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    await putFile(releaseApkKey("1.4.0"), apkBytes);

    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(new Request(`${ORIGIN}/api/mobile/releases/1.4.0/apk`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="kvitbit-1.4.0.apk"',
      );
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-length")).toBe(String(apkBytes.byteLength));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(apkBytes);

      const missing = await handler(new Request(`${ORIGIN}/api/mobile/releases/9.9.9/apk`));
      expect(missing.status).toBe(404);
    } finally {
      await dispose();
    }
  });
});

describe("android assetlinks.json route", () => {
  test("returns empty array when no fingerprints configured", async () => {
    const { handler, dispose } = makeWebHandler({ androidAssetLinksSha256: [] });
    try {
      const res = await handler(new Request(`${ORIGIN}/.well-known/assetlinks.json`));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(await res.json()).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("returns cz.kvitbit.app statement with configured SHA-256 fingerprints", async () => {
    const fp1 = Arr.join(
      Array.from({ length: 32 }, () => "AA"),
      ":",
    );
    const fp2 = Arr.join(
      Array.from({ length: 32 }, () => "BB"),
      ":",
    );
    const { handler, dispose } = makeWebHandler({ androidAssetLinksSha256: [fp1, fp2] });
    try {
      const res = await handler(new Request(`${ORIGIN}/.well-known/assetlinks.json`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: "cz.kvitbit.app",
            sha256_cert_fingerprints: [fp1, fp2],
          },
        },
      ]);
    } finally {
      await dispose();
    }
  });
});
