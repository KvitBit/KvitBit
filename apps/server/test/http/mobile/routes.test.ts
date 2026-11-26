import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReleaseInfo } from "@kvitbit/api-contract";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/http";
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

const ORIGIN = "https://kvitbit.test";

const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = generateKeyPairSync(
  "rsa",
  {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  },
);

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const sha256Base64Url = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("base64url");
const md5Hex = (data: Uint8Array | string) => createHash("md5").update(data).digest("hex");

interface ParsedMultipartPart {
  readonly headers: Record<string, string>;
  readonly body: string;
}

const parseMultipart = (
  contentType: string,
  rawBody: string,
): ReadonlyArray<ParsedMultipartPart> => {
  const match = /multipart\/mixed;\s*boundary=([^\s;]+)/i.exec(contentType);
  expect(match).not.toBeNull();
  const boundary = match?.[1] ?? "";
  const delimiter = `--${boundary}`;
  const chunks = rawBody.split(delimiter).slice(1);
  const parts: Array<ParsedMultipartPart> = [];
  for (const chunk of chunks) {
    if (chunk.startsWith("--")) break;
    const trimmed = chunk.startsWith("\r\n") ? chunk.slice(2) : chunk;
    const sepIndex = trimmed.indexOf("\r\n\r\n");
    expect(sepIndex).toBeGreaterThan(-1);
    const headerBlock = trimmed.slice(0, sepIndex);
    const bodyWithTrailing = trimmed.slice(sepIndex + 4);
    const body = bodyWithTrailing.endsWith("\r\n")
      ? bodyWithTrailing.slice(0, -2)
      : bodyWithTrailing;
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
    parts.push({ headers, body });
  }
  return parts;
};

let storageDir: string;

const putFile = async (relativeKey: string, content: string | Uint8Array) => {
  const fullPath = join(storageDir, relativeKey);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
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
  storageDir = await mkdtemp(join(tmpdir(), "kvitbit-mobile-routes-"));
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
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
    await putFile(publicationKey(older), JSON.stringify(older));
    await putFile(publicationKey(newer), JSON.stringify(newer));

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
      expect(contentType.startsWith("multipart/mixed; boundary=")).toBe(true);

      const parts = parseMultipart(contentType, await res.text());
      expect(parts).toHaveLength(2);
      expect(parts[0]?.headers["content-disposition"]).toBe('form-data; name="manifest"');
      expect(parts[0]?.headers["expo-signature"]).toBeUndefined();
      const manifest = JSON.parse(parts[0]?.body ?? "{}") as {
        id: string;
        createdAt: string;
        runtimeVersion: string;
        launchAsset: { url: string; contentType: string };
        assets: Array<{ url: string; fileExtension?: string }>;
      };
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
      expect(JSON.parse(parts[1]?.body ?? "{}")).toEqual({ assetRequestHeaders: {} });
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
    await putFile(publicationKey(update), JSON.stringify(update));
    await putFile(publicationKey(rollback), JSON.stringify(rollback));

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
      expect(JSON.parse(parts[0]?.body ?? "{}")).toEqual({
        type: "rollBackToEmbedded",
        parameters: { commitTime: rollback.createdAt },
      });
    } finally {
      await dispose();
    }
  });

  test("returns noUpdateAvailable for unknown runtime or matching currentUpdateId", async () => {
    const update = makeUpdateFixture({ channel: "preview", platform: "ios" });
    await putFile(publicationKey(update), JSON.stringify(update));

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
      expect(JSON.parse(unknownParts[0]?.body ?? "{}")).toEqual({ type: "noUpdateAvailable" });

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
      expect(JSON.parse(currentParts[0]?.body ?? "{}")).toEqual({ type: "noUpdateAvailable" });
    } finally {
      await dispose();
    }
  });

  test("signs manifest part with RSA-SHA256 when expo-expect-signature is set", async () => {
    const update = makeUpdateFixture();
    await putFile(publicationKey(update), JSON.stringify(update));

    const { handler, dispose } = makeWebHandler({
      signingKeyPem: Option.some(Redacted.make(TEST_PRIVATE_KEY_PEM)),
    });
    try {
      const res = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
            "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
          },
        }),
      );
      expect(res.status).toBe(200);
      const parts = parseMultipart(res.headers.get("content-type") ?? "", await res.text());
      const sigHeader = parts[0]?.headers["expo-signature"] ?? "";
      const match = /^sig="([^"]+)", keyid="main", alg="rsa-v1_5-sha256"$/.exec(sigHeader);
      expect(match).not.toBeNull();
      const verified = createVerify("RSA-SHA256")
        .update(parts[0]?.body ?? "", "utf8")
        .verify(TEST_PUBLIC_KEY_PEM, match?.[1] ?? "", "base64");
      expect(verified).toBe(true);
    } finally {
      await dispose();
    }
  });

  test("answers 503 when expo-expect-signature is requested but no signing key is configured", async () => {
    const update = makeUpdateFixture();
    await putFile(publicationKey(update), JSON.stringify(update));

    const { handler, dispose } = makeWebHandler({ signingKeyPem: Option.none() });
    try {
      const res = await handler(
        new Request(`${ORIGIN}/api/mobile/updates/manifest`, {
          headers: {
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "1.4.0",
            "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
          },
        }),
      );
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
      list: () => Effect.fail(new MobileStorageUnavailable({ cause: "boom" })),
      getText: () => Effect.fail(new MobileStorageUnavailable({ cause: "boom" })),
      getStream: () => Effect.fail(new MobileStorageUnavailable({ cause: "boom" })),
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
    await putFile(assetMetaKey(hash), JSON.stringify(meta));

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
        new Request(`${ORIGIN}/api/mobile/updates/assets/${"a".repeat(64)}`),
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
    apkSha256: "b".repeat(64),
    sizeBytes: 123456,
    signingCertSha256: "c".repeat(64),
    minAndroidSdk: 26,
    obtainiumUrl: obtainiumImportUrl("https://old-build-origin.example"),
  });

  test("GET /api/mobile/releases/latest picks highest versionCode and recomputes obtainiumUrl", async () => {
    const v12 = makeRelease("1.2.0", 1002000);
    const v110 = makeRelease("1.10.0", 1010000);
    await putFile(releaseInfoKey("1.2.0"), JSON.stringify(v12));
    await putFile(releaseInfoKey("1.10.0"), JSON.stringify(v110));

    const { handler, dispose } = makeWebHandler();
    try {
      const res = await handler(new Request(`${ORIGIN}/api/mobile/releases/latest`));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      const body = (await res.json()) as ReleaseInfo;
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
    const fp1 = Array.from({ length: 32 }, () => "AA").join(":");
    const fp2 = Array.from({ length: 32 }, () => "BB").join(":");
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
