import type { ReleaseInfo } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Num from "effect/Number";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export type { ReleaseInfo } from "@kvitbit/api-contract";

const StoredFields = Schema.Record(Schema.String, Schema.Unknown);
type StoredFields = typeof StoredFields.Type;
const isStoredFields = Schema.is(StoredFields);
const encodeJsonResult = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = (value: StoredFields[string]): string =>
  value === undefined ? "undefined" : Result.getOrThrow(encodeJsonResult(value));

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
  readonly extra: StoredFields;
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

export const isMobilePlatform = Schema.is(Schema.Literals(MOBILE_PLATFORMS));

export const assertSha256Hex = (sha256: string): string => {
  if (!SHA256_HEX_RE.test(sha256)) {
    throw new Error(`Invalid sha256 hex digest: ${encodeJson(sha256)}`);
  }
  return sha256;
};

export const assertChannel = (channel: string): string => {
  if (!CHANNEL_RE.test(channel)) {
    throw new Error(`Invalid update channel: ${encodeJson(channel)}`);
  }
  return channel;
};

export const assertRuntimeVersion = (runtimeVersion: string): string => {
  if (!SAFE_SEGMENT_RE.test(runtimeVersion) || runtimeVersion === "." || runtimeVersion === "..") {
    throw new Error(`Invalid runtimeVersion: ${encodeJson(runtimeVersion)}`);
  }
  return runtimeVersion;
};

export const assertUuid = (id: string): string => {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid publication UUID: ${encodeJson(id)}`);
  }
  return id;
};

/** Parses `MAJOR.MINOR.PATCH` within Android versionCode bounds (DeskoHub invariant). */
export const parseAppVersion = (version: string): AppVersion => {
  const match = VERSION_RE.exec(version);
  if (match === null) {
    throw new Error(
      `App version ${encodeJson(version)} must be MAJOR.MINOR.PATCH without a prefix, pre-release or build suffix.`,
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
  const date = DateTime.make(value instanceof Date ? value : Date.parse(value));
  if (Option.isNone(date)) {
    throw new Error(`Invalid publication timestamp: ${encodeJson(value)}`);
  }
  const { year, month, day, hour, minute, second, millisecond } = DateTime.toPartsUtc(date.value);
  const pad = (n: number, width: number) => Str.padStart(width, "0")(String(n));
  return (
    `${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}` +
    `T${pad(hour, 2)}${pad(minute, 2)}${pad(second, 2)}${pad(millisecond, 3)}Z`
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
    throw new Error(`Invalid platform: ${encodeJson(target.platform)}`);
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
  const slash = Str.lastIndexOf("/")(key);
  const fileName = Option.isNone(slash) ? key : Str.slice(slash.value + 1)(key);
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

// Preserve the SyntaxError and message exposed by the release CLI.
const parseJson = (json: string): unknown =>
  // @effect-diagnostics-next-line globalJson:off The release CLI exposes the native SyntaxError message for malformed stored JSON.
  JSON.parse(json);

const requireString = (obj: StoredFields, field: string): string => {
  const value = obj[field];
  if (!Str.isString(value) || value.length === 0) {
    throw new Error(`Expected non-empty string for field ${field}`);
  }
  return value;
};

const requireNonNegativeInt = (obj: StoredFields, field: string): number => {
  const value = obj[field];
  if (!(Num.isNumber(value) && Number.isInteger(value)) || value < 0) {
    throw new Error(`Expected non-negative integer for field ${field}`);
  }
  return value;
};

const parseStoredAsset = (value: StoredFields, label: string): StoredUpdateAsset => {
  const sha256 = assertSha256Hex(requireString(value, "sha256"));
  const hash = requireString(value, "hash");
  if (!BASE64URL_SHA256_RE.test(hash)) {
    throw new Error(`${label}.hash must be a 43-char base64url SHA-256 digest`);
  }
  const key = requireString(value, "key");
  const contentType = requireString(value, "contentType");
  if (!CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(`${label}.contentType is invalid: ${encodeJson(contentType)}`);
  }
  const fileExtension = value["fileExtension"];
  if (fileExtension !== undefined) {
    if (!(Str.isString(fileExtension) && FILE_EXT_RE.test(fileExtension))) {
      throw new Error(`${label}.fileExtension is invalid: ${encodeJson(fileExtension)}`);
    }
    return { sha256, hash, key, contentType, fileExtension };
  }
  return { sha256, hash, key, contentType };
};

const parseMetadata = (value: StoredFields): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Rec.toEntries(value)) {
    if (!Str.isString(v)) {
      throw new Error(`metadata.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
};

export const parseAssetMeta = (json: string): AssetMeta => {
  const parsed = parseJson(json);
  if (!isStoredFields(parsed)) {
    throw new Error("AssetMeta must be a JSON object");
  }
  if (parsed["schema"] !== 1) {
    throw new Error(`Unsupported AssetMeta schema: ${String(parsed["schema"])}`);
  }
  const sha256 = assertSha256Hex(requireString(parsed, "sha256"));
  const contentType = requireString(parsed, "contentType");
  if (!CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(`Invalid AssetMeta contentType: ${encodeJson(contentType)}`);
  }
  const size = requireNonNegativeInt(parsed, "size");
  return { schema: 1, sha256, contentType, size };
};

export const parsePublication = (json: string): StoredPublication => {
  const parsed = parseJson(json);
  if (!isStoredFields(parsed)) {
    throw new Error("Publication must be a JSON object");
  }
  if (parsed["schema"] !== 1) {
    throw new Error(`Unsupported publication schema: ${String(parsed["schema"])}`);
  }
  const type = parsed["type"];
  const id = assertUuid(requireString(parsed, "id"));
  const createdAt = requireString(parsed, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Invalid publication createdAt: ${encodeJson(createdAt)}`);
  }
  const channel = assertChannel(requireString(parsed, "channel"));
  const platform = parsed["platform"];
  if (!isMobilePlatform(platform)) {
    throw new Error(`Invalid publication platform: ${encodeJson(platform)}`);
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
    if (!isStoredFields(parsed["launchAsset"])) {
      throw new Error("launchAsset must be an object");
    }
    const launchAsset = parseStoredAsset(parsed["launchAsset"], "launchAsset");
    if (!Arr.isArray(parsed["assets"])) {
      throw new Error("Publication assets must be an array");
    }
    const assets = Arr.map(parsed["assets"], (item, idx) => {
      const label = `assets[${idx}]`;
      if (!isStoredFields(item)) {
        throw new Error(`${label} must be an object`);
      }
      return parseStoredAsset(item, label);
    });
    const rawMetadata = parsed["metadata"] ?? {};
    if (!isStoredFields(rawMetadata)) {
      throw new Error("metadata must be an object");
    }
    const metadata = parseMetadata(rawMetadata);
    const extra = isStoredFields(parsed["extra"]) ? parsed["extra"] : {};
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

  throw new Error(`Unsupported publication type: ${encodeJson(type)}`);
};

export const parseReleaseInfo = (json: string): ReleaseInfo => {
  const parsed = parseJson(json);
  if (!isStoredFields(parsed)) {
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
    throw new Error(`Invalid ReleaseInfo.releasedAt: ${encodeJson(releasedAt)}`);
  }
  const apkUrl = requireString(parsed, "apkUrl");
  const apkSha256 = assertSha256Hex(requireString(parsed, "apkSha256"));
  const sizeBytes = requireNonNegativeInt(parsed, "sizeBytes");
  // biome-ignore lint/security/noSecrets: This names a public signing certificate fingerprint field.
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
