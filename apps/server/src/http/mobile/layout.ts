/**
 * Storage layout and wire helpers for Expo Updates v1 and Android releases
 * (http-mcp-contracts section 5, board contract #929).
 *
 * Objects are write-once and never overwritten:
 *   mobile/updates/assets/<sha256hex>
 *   mobile/updates/assets/<sha256hex>.json
 *   mobile/updates/channels/<channel>/<platform>/<runtimeVersion>/<yyyymmddThhmmssmmmZ>-<uuid>.json
 *   mobile/releases/<version>/kvitbit-<version>.apk
 *   mobile/releases/<version>/release.json
 */

export const updatePlatforms = ["android", "ios"] as const;
export type UpdatePlatform = (typeof updatePlatforms)[number];

export const defaultChannel = "production";

export const androidPackage = "cz.kvitbit.app";

/** Stored update files and APKs never change, so apps and CDNs may cache them for a year. */
export const immutableCacheControl = "public, max-age=31536000, immutable";

export const apkContentType = "application/vnd.android.package-archive";

export const releasePrefix = "mobile/releases/";

/** One file of an update as the Expo Updates v1 manifest describes it, minus its URL. */
export interface StoredUpdateAsset {
  /** Hex SHA-256 of the bytes; the object key and the `/assets/{sha256}` route segment. */
  readonly sha256: string;
  /** Base64url SHA-256, which the app checks after the download. */
  readonly hash: string;
  /** Hex MD5, the key Metro names assets by. */
  readonly key: string;
  readonly contentType: string;
  /** With the leading dot; absent for the launch asset. */
  readonly fileExtension?: string;
}

export interface StoredUpdate {
  readonly schema: 1;
  readonly type: "update";
  /** UUID; the manifest `id` and the app's `expo-current-update-id`. */
  readonly id: string;
  /** ISO 8601 with milliseconds; the manifest `createdAt`. */
  readonly createdAt: string;
  readonly channel: string;
  readonly platform: UpdatePlatform;
  readonly runtimeVersion: string;
  readonly launchAsset: StoredUpdateAsset;
  readonly assets: readonly StoredUpdateAsset[];
  readonly metadata: Readonly<Record<string, string>>;
  /** `{ expoClient }`: the public app config the export resolved. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Sends apps on this runtime back to the update embedded in their APK. */
export interface StoredRollback {
  readonly schema: 1;
  readonly type: "rollBackToEmbedded";
  readonly id: string;
  readonly createdAt: string;
  readonly channel: string;
  readonly platform: UpdatePlatform;
  readonly runtimeVersion: string;
}

export type StoredPublication = StoredUpdate | StoredRollback;

export interface StoredAssetMeta {
  readonly schema: 1;
  readonly sha256: string;
  readonly contentType: string;
  readonly size: number;
}

const sha256Pattern = /^[0-9a-f]{64}$/;
const releaseVersionPattern = /^[0-9A-Za-z._+-]+$/;

export const isValidSha256 = (value: string): boolean => sha256Pattern.test(value);

export const isValidSegment = (value: string): boolean =>
  value !== "" && value !== "." && value !== "..";

export const isValidReleaseVersion = (value: string): boolean =>
  isValidSegment(value) && releaseVersionPattern.test(value);

const segment = (value: string): string => {
  if (!isValidSegment(value)) {
    throw new Error(`${JSON.stringify(value)} is not a storage path segment.`);
  }
  return encodeURIComponent(value);
};

export const assetKey = (sha256: string): string => {
  if (!sha256Pattern.test(sha256)) {
    throw new Error(`${JSON.stringify(sha256)} is not a hex SHA-256.`);
  }
  return `mobile/updates/assets/${sha256}`;
};

export const assetMetaKey = (sha256: string): string => `${assetKey(sha256)}.json`;

/** The prefix the server lists to find the newest publication for one app's runtime. */
export const publicationPrefix = (query: {
  readonly channel: string;
  readonly platform: UpdatePlatform;
  readonly runtimeVersion: string;
}): string =>
  `mobile/updates/channels/${segment(query.channel)}/${segment(query.platform)}/${segment(query.runtimeVersion)}/`;

/** `2026-11-24T10:00:00.000Z` -> `20261124T100000000Z`: sorts like the instant. */
export const createdAtKey = (createdAt: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(createdAt);
  if (match === null) {
    throw new Error(`createdAt ${createdAt} must be UTC ISO 8601 with milliseconds.`);
  }
  const [, y, mo, d, h, mi, s, ms] = match;
  return `${y}${mo}${d}T${h}${mi}${s}${ms}Z`;
};

export const publicationKey = (publication: StoredPublication): string =>
  `${publicationPrefix(publication)}${createdAtKey(publication.createdAt)}-${segment(publication.id)}.json`;

/**
 * The newest publication key under one prefix: keys sort by their creation instant, so the
 * lexicographic maximum wins. `undefined` when the runtime has no publication.
 */
export const latestPublicationKey = (keys: Iterable<string>): string | undefined => {
  let latest: string | undefined;
  for (const key of keys) {
    if (!key.endsWith(".json")) continue;
    if (latest === undefined || key > latest) latest = key;
  }
  return latest;
};

export const apkFileName = (version: string): string => `kvitbit-${version}.apk`;

export const releaseApkKey = (version: string): string =>
  `${releasePrefix}${segment(version)}/${apkFileName(version)}`;

export const releaseInfoKey = (version: string): string =>
  `${releasePrefix}${segment(version)}/release.json`;

/** The route the server answers with the APK (http-mcp-contracts section 5). */
export const releaseApkPath = (version: string): string =>
  `/api/mobile/releases/${encodeURIComponent(version)}/apk`;

export const updateAssetPath = (sha256: string): string => `/api/mobile/updates/assets/${sha256}`;

/** The newest release among stored ReleaseInfo records, by version code. */
export const latestRelease = <R extends { readonly versionCode: number }>(
  releases: Iterable<R>,
): R | undefined => {
  let latest: R | undefined;
  for (const release of releases) {
    if (latest === undefined || release.versionCode > latest.versionCode) latest = release;
  }
  return latest;
};

export const obtainiumSourceSettings = {
  customLinkFilterRegex: "/api/mobile/releases/[0-9]+\\.[0-9]+\\.[0-9]+/apk$",
  versionExtractionRegEx: "/api/mobile/releases/([0-9]+\\.[0-9]+\\.[0-9]+)/apk",
  matchGroupToUse: "1",
} as const;

/** `obtainium://app/...`: the app link Obtainium registers. */
export const obtainiumAppLink = (origin: string): string =>
  `obtainium://app/${encodeURIComponent(
    JSON.stringify({
      id: androidPackage,
      url: new URL("/android", origin).href,
      author: "Kvitbit",
      name: "Kvitbit",
      additionalSettings: JSON.stringify(obtainiumSourceSettings),
    }),
  )}`;

/** Obtainium redirect URL pointing at `origin`'s `/android` page. */
export const obtainiumImportUrl = (origin: string): string => {
  const url = new URL("https://apps.obtainium.imranr.dev/redirect");
  url.searchParams.set("r", obtainiumAppLink(origin));
  return url.href;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAsset = (value: unknown): value is StoredUpdateAsset =>
  isRecord(value) &&
  typeof value.sha256 === "string" &&
  sha256Pattern.test(value.sha256) &&
  typeof value.hash === "string" &&
  typeof value.key === "string" &&
  typeof value.contentType === "string" &&
  (value.fileExtension === undefined || typeof value.fileExtension === "string");

/** Reads a stored publication record; throws on anything this layout never writes. */
export const parsePublication = (json: string): StoredPublication => {
  const value: unknown = JSON.parse(json);
  const common =
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.channel === "string" &&
    typeof value.runtimeVersion === "string" &&
    updatePlatforms.includes(value.platform as UpdatePlatform);
  if (common && value.type === "rollBackToEmbedded") return value as unknown as StoredRollback;
  if (
    common &&
    value.type === "update" &&
    isAsset(value.launchAsset) &&
    Array.isArray(value.assets) &&
    value.assets.every(isAsset) &&
    isRecord(value.metadata) &&
    isRecord(value.extra)
  ) {
    return value as unknown as StoredUpdate;
  }
  throw new Error("The stored mobile update record does not match schema 1.");
};

/** Reads a stored asset sidecar; throws on anything this layout never writes. */
export const parseAssetMeta = (json: string): StoredAssetMeta => {
  const value: unknown = JSON.parse(json);
  if (
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.sha256 === "string" &&
    sha256Pattern.test(value.sha256) &&
    typeof value.contentType === "string" &&
    value.contentType.length > 0 &&
    typeof value.size === "number" &&
    Number.isInteger(value.size) &&
    value.size >= 0
  ) {
    return value as unknown as StoredAssetMeta;
  }
  throw new Error("The stored mobile asset metadata does not match schema 1.");
};
