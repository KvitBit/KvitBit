import type { ReleaseInfo } from "@kvitbit/api-contract";

export type { ReleaseInfo };

/** Native platforms supported by Kvitbit Expo Updates. */
export type MobilePlatform = "android" | "ios";

export const MOBILE_PLATFORMS: readonly MobilePlatform[] = ["android", "ios"];
export const DEFAULT_UPDATE_CHANNEL = "production";

export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const RELEASE_INFO_CACHE_CONTROL = "public, max-age=300";
export const MANIFEST_CACHE_CONTROL = "private, max-age=0";
export const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

/** Metadata stored alongside each immutable asset at `mobile/updates/assets/<sha256>.json`. */
export interface AssetMeta {
  readonly schema: 1;
  readonly sha256: string;
  readonly contentType: string;
  readonly size: number;
}

/** One asset inside a `StoredUpdate` record; `url` is derived from `origin` + `sha256`. */
export interface StoredUpdateAsset {
  readonly sha256: string;
  /** Base64url SHA-256 of asset bytes (43 chars, no padding), verified by expo-updates. */
  readonly hash: string;
  /** MD5 hex digest Metro uses as the asset key. */
  readonly key: string;
  readonly contentType: string;
  readonly fileExtension?: string;
}

/** Schema-1 OTA update record stored at `mobile/updates/channels/<channel>/<platform>/<runtimeVersion>/<ts>-<uuid>.json`. */
export interface StoredUpdate {
  readonly schema: 1;
  readonly type: "update";
  readonly id: string;
  readonly createdAt: string;
  readonly channel: string;
  readonly platform: MobilePlatform;
  readonly runtimeVersion: string;
  readonly launchAsset: StoredUpdateAsset;
  readonly assets: readonly StoredUpdateAsset[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Schema-1 rollback directive record stored in the same channel prefix as `StoredUpdate`. */
export interface StoredRollback {
  readonly schema: 1;
  readonly type: "rollBackToEmbedded";
  readonly id: string;
  readonly createdAt: string;
  readonly channel: string;
  readonly platform: MobilePlatform;
  readonly runtimeVersion: string;
}

export type StoredPublication = StoredUpdate | StoredRollback;

export interface AppVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const BASE64URL_SHA256_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+(?:;.*)?$/;
const FILE_EXT_RE = /^\.[A-Za-z0-9]+$/;
const PUBLICATION_FILENAME_RE = /^(\d{8}T\d{9}Z)-([0-9a-fA-F-]{36})\.json$/;

const MAJOR_LIMIT = 2100;
const COMPONENT_LIMIT = 1000;

export const isMobilePlatform = (value: unknown): value is MobilePlatform =>
  value === "android" || value === "ios";

export const assertSha256Hex = (sha256: string): string => {
  if (!SHA256_HEX_RE.test(sha256)) {
    throw new Error(`Invalid sha256 hex digest: ${JSON.stringify(sha256)}`);
  }
  return sha256;
};

export const assertChannel = (channel: string): string => {
  if (!CHANNEL_RE.test(channel)) {
    throw new Error(`Invalid update channel: ${JSON.stringify(channel)}`);
  }
  return channel;
};

export const assertRuntimeVersion = (runtimeVersion: string): string => {
  if (!SAFE_SEGMENT_RE.test(runtimeVersion) || runtimeVersion === "." || runtimeVersion === "..") {
    throw new Error(`Invalid runtimeVersion: ${JSON.stringify(runtimeVersion)}`);
  }
  return runtimeVersion;
};

export const assertUuid = (id: string): string => {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid publication UUID: ${JSON.stringify(id)}`);
  }
  return id;
};

/** Parses `MAJOR.MINOR.PATCH` within Android versionCode bounds (DeskoHub invariant). */
export const parseAppVersion = (version: string): AppVersion => {
  const match = VERSION_RE.exec(version);
  if (match === null) {
    throw new Error(
      `App version ${JSON.stringify(version)} must be MAJOR.MINOR.PATCH without a prefix, pre-release or build suffix.`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major >= MAJOR_LIMIT || minor >= COMPONENT_LIMIT || patch >= COMPONENT_LIMIT) {
    throw new Error(
      `App version ${version} must keep MAJOR below ${MAJOR_LIMIT} and MINOR and PATCH below ${COMPONENT_LIMIT} to fit the Android version code.`,
    );
  }
  return { major, minor, patch };
};

/** Derives strictly monotonic positive Android `versionCode` from `MAJOR.MINOR.PATCH`. */
export const androidVersionCode = (version: string): number => {
  const { major, minor, patch } = parseAppVersion(version);
  const code = major * 1_000_000 + minor * 1000 + patch;
  if (code === 0) {
    throw new Error("App version 0.0.0 has no positive Android version code.");
  }
  return code;
};

/** Formats an ISO timestamp or `Date` as compact UTC `yyyymmddThhmmssmmmZ` for lexicographic sort. */
export const formatPublicationTimestamp = (value: Date | string): string => {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid publication timestamp: ${JSON.stringify(value)}`);
  }
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}` +
    `${pad(date.getUTCMonth() + 1, 2)}` +
    `${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}` +
    `${pad(date.getUTCMinutes(), 2)}` +
    `${pad(date.getUTCSeconds(), 2)}` +
    `${pad(date.getUTCMilliseconds(), 3)}Z`
  );
};

// --- Storage object keys (relative to bucket or directory root) ---

export const assetObjectKey = (sha256: string): string =>
  `mobile/updates/assets/${assertSha256Hex(sha256)}`;

export const assetMetaObjectKey = (sha256: string): string =>
  `mobile/updates/assets/${assertSha256Hex(sha256)}.json`;

export const publicationPrefix = (target: {
  readonly channel: string;
  readonly platform: MobilePlatform;
  readonly runtimeVersion: string;
}): string => {
  const channel = assertChannel(target.channel);
  if (!isMobilePlatform(target.platform)) {
    throw new Error(`Invalid platform: ${JSON.stringify(target.platform)}`);
  }
  const runtimeVersion = assertRuntimeVersion(target.runtimeVersion);
  return `mobile/updates/channels/${channel}/${target.platform}/${runtimeVersion}/`;
};

export const publicationObjectKey = (target: {
  readonly channel: string;
  readonly platform: MobilePlatform;
  readonly runtimeVersion: string;
  readonly createdAt: Date | string;
  readonly id: string;
}): string => {
  const prefix = publicationPrefix(target);
  const ts = formatPublicationTimestamp(target.createdAt);
  const id = assertUuid(target.id);
  return `${prefix}${ts}-${id}.json`;
};

export const releasePrefix = (): string => "mobile/releases/";

export const apkFileName = (version: string): string => {
  parseAppVersion(version);
  return `kvitbit-${version}.apk`;
};

export const apkObjectKey = (version: string): string => {
  const fileName = apkFileName(version);
  return `mobile/releases/${version}/${fileName}`;
};

export const releaseInfoObjectKey = (version: string): string => {
  parseAppVersion(version);
  return `mobile/releases/${version}/release.json`;
};

// --- Public HTTP route paths ---

export const assetRoutePath = (sha256: string): string =>
  `/api/mobile/updates/assets/${assertSha256Hex(sha256)}`;

export const apkRoutePath = (version: string): string => {
  parseAppVersion(version);
  return `/api/mobile/releases/${version}/apk`;
};

// --- Selectors & parsers ---

const isPublicationKey = (key: string): boolean => {
  const slash = key.lastIndexOf("/");
  const fileName = slash === -1 ? key : key.slice(slash + 1);
  return PUBLICATION_FILENAME_RE.test(fileName);
};

/** Returns the lexicographically greatest publication object key, or `undefined` if none match. */
export const latestPublicationKey = (keys: readonly string[]): string | undefined => {
  let latest: string | undefined;
  for (const key of keys) {
    if (!isPublicationKey(key)) continue;
    if (latest === undefined || key > latest) {
      latest = key;
    }
  }
  return latest;
};

/** Returns the release with the highest `versionCode`, or `undefined` for an empty list. */
export const latestRelease = (records: readonly ReleaseInfo[]): ReleaseInfo | undefined => {
  let latest: ReleaseInfo | undefined;
  for (const record of records) {
    if (
      latest === undefined ||
      record.versionCode > latest.versionCode ||
      (record.versionCode === latest.versionCode && record.releasedAt > latest.releasedAt)
    ) {
      latest = record;
    }
  }
  return latest;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (obj: Record<string, unknown>, field: string): string => {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for field ${field}`);
  }
  return value;
};

const requireNonNegativeInt = (obj: Record<string, unknown>, field: string): number => {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer for field ${field}`);
  }
  return value;
};

const parseStoredAsset = (value: unknown, label: string): StoredUpdateAsset => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const sha256 = assertSha256Hex(requireString(value, "sha256"));
  const hash = requireString(value, "hash");
  if (!BASE64URL_SHA256_RE.test(hash)) {
    throw new Error(`${label}.hash must be a 43-char base64url SHA-256 digest`);
  }
  const key = requireString(value, "key");
  const contentType = requireString(value, "contentType");
  if (!CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(`${label}.contentType is invalid: ${JSON.stringify(contentType)}`);
  }
  const fileExtension = value.fileExtension;
  if (fileExtension !== undefined) {
    if (typeof fileExtension !== "string" || !FILE_EXT_RE.test(fileExtension)) {
      throw new Error(`${label}.fileExtension is invalid: ${JSON.stringify(fileExtension)}`);
    }
    return { sha256, hash, key, contentType, fileExtension };
  }
  return { sha256, hash, key, contentType };
};

const parseStringRecord = (value: unknown, label: string): Readonly<Record<string, string>> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new Error(`${label}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
};

export const parseAssetMeta = (json: string): AssetMeta => {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("AssetMeta must be a JSON object");
  }
  if (parsed.schema !== 1) {
    throw new Error(`Unsupported AssetMeta schema: ${String(parsed.schema)}`);
  }
  const sha256 = assertSha256Hex(requireString(parsed, "sha256"));
  const contentType = requireString(parsed, "contentType");
  if (!CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(`Invalid AssetMeta contentType: ${JSON.stringify(contentType)}`);
  }
  const size = requireNonNegativeInt(parsed, "size");
  return { schema: 1, sha256, contentType, size };
};

export const parsePublication = (json: string): StoredPublication => {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("Publication must be a JSON object");
  }
  if (parsed.schema !== 1) {
    throw new Error(`Unsupported publication schema: ${String(parsed.schema)}`);
  }
  const type = parsed.type;
  const id = assertUuid(requireString(parsed, "id"));
  const createdAt = requireString(parsed, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Invalid publication createdAt: ${JSON.stringify(createdAt)}`);
  }
  const channel = assertChannel(requireString(parsed, "channel"));
  const platform = parsed.platform;
  if (!isMobilePlatform(platform)) {
    throw new Error(`Invalid publication platform: ${JSON.stringify(platform)}`);
  }
  const runtimeVersion = assertRuntimeVersion(requireString(parsed, "runtimeVersion"));

  if (type === "rollBackToEmbedded") {
    return {
      schema: 1,
      type: "rollBackToEmbedded",
      id,
      createdAt,
      channel,
      platform,
      runtimeVersion,
    };
  }

  if (type === "update") {
    const launchAsset = parseStoredAsset(parsed.launchAsset, "launchAsset");
    if (!Array.isArray(parsed.assets)) {
      throw new Error("Publication assets must be an array");
    }
    const assets = parsed.assets.map((item, idx) => parseStoredAsset(item, `assets[${idx}]`));
    const metadata = parseStringRecord(parsed.metadata ?? {}, "metadata");
    const extra = isRecord(parsed.extra) ? parsed.extra : {};
    return {
      schema: 1,
      type: "update",
      id,
      createdAt,
      channel,
      platform,
      runtimeVersion,
      launchAsset,
      assets,
      metadata,
      extra,
    };
  }

  throw new Error(`Unsupported publication type: ${JSON.stringify(type)}`);
};

export const parseReleaseInfo = (json: string): ReleaseInfo => {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("ReleaseInfo must be a JSON object");
  }
  const version = requireString(parsed, "version");
  parseAppVersion(version);
  const versionCode = requireNonNegativeInt(parsed, "versionCode");
  if (versionCode < 1) {
    throw new Error("ReleaseInfo.versionCode must be a positive integer");
  }
  const releasedAt = requireString(parsed, "releasedAt");
  if (Number.isNaN(Date.parse(releasedAt))) {
    throw new Error(`Invalid ReleaseInfo.releasedAt: ${JSON.stringify(releasedAt)}`);
  }
  const apkUrl = requireString(parsed, "apkUrl");
  const apkSha256 = assertSha256Hex(requireString(parsed, "apkSha256"));
  const sizeBytes = requireNonNegativeInt(parsed, "sizeBytes");
  const signingCertSha256 = requireString(parsed, "signingCertSha256");
  const minAndroidSdk = requireNonNegativeInt(parsed, "minAndroidSdk");
  const obtainiumUrl = requireString(parsed, "obtainiumUrl");
  return {
    version,
    versionCode,
    releasedAt,
    apkUrl,
    apkSha256,
    sizeBytes,
    signingCertSha256,
    minAndroidSdk,
    obtainiumUrl,
  };
};
