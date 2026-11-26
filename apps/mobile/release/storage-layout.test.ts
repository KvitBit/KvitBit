import { describe, expect, test } from "bun:test";
import {
  androidVersionCode,
  apkFileName,
  apkObjectKey,
  apkRoutePath,
  assetMetaObjectKey,
  assetObjectKey,
  assetRoutePath,
  formatPublicationTimestamp,
  latestPublicationKey,
  latestRelease,
  parseAppVersion,
  parseAssetMeta,
  parsePublication,
  parseReleaseInfo,
  publicationObjectKey,
  publicationPrefix,
  type ReleaseInfo,
  releaseInfoObjectKey,
  type StoredRollback,
  type StoredUpdate,
} from "./storage-layout";

const SAMPLE_SHA256 = "a".repeat(64);
const SAMPLE_HASH_B64URL = "A".repeat(43);
const SAMPLE_UUID_1 = "11111111-1111-4111-8111-111111111111";
const SAMPLE_UUID_2 = "22222222-2222-4222-8222-222222222222";

describe("storage-layout object keys", () => {
  test("builds exact #929 update asset and publication keys", () => {
    expect(assetObjectKey(SAMPLE_SHA256)).toBe(`mobile/updates/assets/${SAMPLE_SHA256}`);
    expect(assetMetaObjectKey(SAMPLE_SHA256)).toBe(`mobile/updates/assets/${SAMPLE_SHA256}.json`);
    expect(assetRoutePath(SAMPLE_SHA256)).toBe(`/api/mobile/updates/assets/${SAMPLE_SHA256}`);

    expect(
      publicationPrefix({
        channel: "production",
        platform: "android",
        runtimeVersion: "fp-abc123",
      }),
    ).toBe("mobile/updates/channels/production/android/fp-abc123/");

    expect(formatPublicationTimestamp("2026-11-24T09:05:03.007Z")).toBe("20261124T090503007Z");

    expect(
      publicationObjectKey({
        channel: "production",
        platform: "android",
        runtimeVersion: "fp-abc123",
        createdAt: "2026-11-24T09:05:03.007Z",
        id: SAMPLE_UUID_1,
      }),
    ).toBe(
      `mobile/updates/channels/production/android/fp-abc123/20261124T090503007Z-${SAMPLE_UUID_1}.json`,
    );
  });

  test("builds exact #929 release APK and release.json keys", () => {
    expect(apkFileName("1.4.0")).toBe("kvitbit-1.4.0.apk");
    expect(apkObjectKey("1.4.0")).toBe("mobile/releases/1.4.0/kvitbit-1.4.0.apk");
    expect(releaseInfoObjectKey("1.4.0")).toBe("mobile/releases/1.4.0/release.json");
    expect(apkRoutePath("1.4.0")).toBe("/api/mobile/releases/1.4.0/apk");
  });

  test("rejects path traversal and malformed digests", () => {
    expect(() => assetObjectKey("../etc/passwd")).toThrow();
    expect(() =>
      publicationPrefix({ channel: "../bad", platform: "android", runtimeVersion: "1.0.0" }),
    ).toThrow();
    expect(() =>
      publicationPrefix({ channel: "production", platform: "android", runtimeVersion: ".." }),
    ).toThrow();
    expect(() => apkObjectKey("1.0.0-beta.1")).toThrow();
  });
});

describe("versionCode invariant", () => {
  test("derives monotonic Android versionCode from semver", () => {
    expect(parseAppVersion("1.4.2")).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(androidVersionCode("0.1.0")).toBe(1000);
    expect(androidVersionCode("1.4.2")).toBe(1_004_002);
    expect(androidVersionCode("1.10.0")).toBeGreaterThan(androidVersionCode("1.9.999"));
  });

  test("rejects 0.0.0 and out-of-range components", () => {
    expect(() => androidVersionCode("0.0.0")).toThrow();
    expect(() => androidVersionCode("2100.0.0")).toThrow();
    expect(() => androidVersionCode("1.1000.0")).toThrow();
  });
});

describe("selectors and parsers", () => {
  test("latestPublicationKey picks lexicographic max and ignores non-matching keys", () => {
    const k1 = `mobile/updates/channels/production/android/1/20261124T080000000Z-${SAMPLE_UUID_1}.json`;
    const k2 = `mobile/updates/channels/production/android/1/20261124T090000000Z-${SAMPLE_UUID_2}.json`;
    expect(
      latestPublicationKey([k1, "mobile/updates/channels/production/android/1/notes.txt", k2]),
    ).toBe(k2);
    expect(latestPublicationKey([])).toBeUndefined();
  });

  test("parsePublication validates StoredUpdate and StoredRollback", () => {
    const update: StoredUpdate = {
      schema: 1,
      type: "update",
      id: SAMPLE_UUID_1,
      createdAt: "2026-11-24T10:00:00.000Z",
      channel: "production",
      platform: "android",
      runtimeVersion: "fp-1",
      launchAsset: {
        sha256: SAMPLE_SHA256,
        hash: SAMPLE_HASH_B64URL,
        key: "0123456789abcdef0123456789abcdef",
        contentType: "application/javascript",
      },
      assets: [
        {
          sha256: "b".repeat(64),
          hash: "B".repeat(43),
          key: "fedcba9876543210fedcba9876543210",
          contentType: "image/png",
          fileExtension: ".png",
        },
      ],
      metadata: { gitSha: "d716dec" },
      extra: { expoClient: { name: "Kvitbit" } },
    };
    expect(parsePublication(JSON.stringify(update))).toEqual(update);

    const rollback: StoredRollback = {
      schema: 1,
      type: "rollBackToEmbedded",
      id: SAMPLE_UUID_2,
      createdAt: "2026-11-24T11:00:00.000Z",
      channel: "production",
      platform: "ios",
      runtimeVersion: "fp-1",
    };
    expect(parsePublication(JSON.stringify(rollback))).toEqual(rollback);

    expect(() => parsePublication(JSON.stringify({ ...rollback, schema: 2 }))).toThrow();
  });

  test("parseAssetMeta validates schema 1 asset metadata", () => {
    const meta = {
      schema: 1 as const,
      sha256: SAMPLE_SHA256,
      contentType: "image/png",
      size: 4096,
    };
    expect(parseAssetMeta(JSON.stringify(meta))).toEqual(meta);
    expect(() => parseAssetMeta(JSON.stringify({ ...meta, size: -1 }))).toThrow();
  });

  test("parseReleaseInfo and latestRelease pick highest versionCode", () => {
    const r1: ReleaseInfo = {
      version: "0.1.0",
      versionCode: 1000,
      releasedAt: "2026-11-20T10:00:00.000Z",
      apkUrl: "/api/mobile/releases/0.1.0/apk",
      apkSha256: SAMPLE_SHA256,
      sizeBytes: 12_345_678,
      signingCertSha256: "AA:BB",
      minAndroidSdk: 28,
      obtainiumUrl: "https://apps.obtainium.imranr.dev/redirect?r=test",
    };
    const r2: ReleaseInfo = {
      ...r1,
      version: "0.2.0",
      versionCode: 2000,
      apkUrl: "/api/mobile/releases/0.2.0/apk",
    };
    expect(parseReleaseInfo(JSON.stringify(r2))).toEqual(r2);
    expect(latestRelease([r1, r2])).toEqual(r2);
    expect(latestRelease([])).toBeUndefined();
  });
});
