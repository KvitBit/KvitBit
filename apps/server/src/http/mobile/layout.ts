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
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export const UpdatePlatform = Schema.Literals(["android", "ios"]);
export type UpdatePlatform = typeof UpdatePlatform.Type;

export const defaultChannel = "production";

export const androidPackage = "cz.kvitbit.app";

/** Stored update files and APKs never change, so apps and CDNs may cache them for a year. */
export const immutableCacheControl = "public, max-age=31536000, immutable";

export const apkContentType = "application/vnd.android.package-archive";

export const releasePrefix = "mobile/releases/";

/** One file of an update as the Expo Updates v1 manifest describes it, minus its URL. */
interface StoredUpdateAsset {
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
  readonly extra: typeof ManifestObject.Type;
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

type StoredPublication = StoredUpdate | StoredRollback;

export interface StoredAssetMeta {
  readonly schema: 1;
  readonly sha256: string;
  readonly contentType: string;
  readonly size: number;
}

const sha256Pattern = /^[0-9a-f]{64}$/;
const releaseVersionPattern = /^[0-9A-Za-z._+-]+$/;
const createdAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const timestampSeparators = /[-:.]/g;

export const isValidSha256 = (value: string): boolean => sha256Pattern.test(value);

export const isValidSegment = (value: string): boolean =>
  value !== "" && value !== "." && value !== "..";

export const isValidReleaseVersion = (value: string): boolean =>
  isValidSegment(value) && releaseVersionPattern.test(value);

const StorageSegment = Schema.String.check(Schema.makeFilter(isValidSegment));
const Sha256Hex = Schema.String.check(Schema.isPattern(sha256Pattern));
const UtcTimestamp = Schema.String.check(Schema.isPattern(createdAtPattern));

const checkSegment = Schema.decodeResult(StorageSegment);
const checkSha256 = Schema.decodeResult(Sha256Hex);
const checkCreatedAt = Schema.decodeResult(UtcTimestamp);

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = (value: object | string): string =>
  Result.getOrThrowWith(encodeJsonValue(value), (error) => error);

const segment = (value: string): string => {
  const checked = Result.getOrThrowWith(
    checkSegment(value),
    () => new Error(`${encodeJson(value)} is not a storage path segment.`),
  );
  return encodeURIComponent(checked);
};

export const assetKey = (sha256: string): string => {
  const checked = Result.getOrThrowWith(
    checkSha256(sha256),
    () => new Error(`${encodeJson(sha256)} is not a hex SHA-256.`),
  );
  return `mobile/updates/assets/${checked}`;
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
const createdAtKey = (createdAt: string): string => {
  const checked = Result.getOrThrowWith(
    checkCreatedAt(createdAt),
    () => new Error(`createdAt ${createdAt} must be UTC ISO 8601 with milliseconds.`),
  );
  return Str.replace(timestampSeparators, "")(checked);
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
    if (!Str.endsWith(".json")(key)) continue;
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

const obtainiumSourceSettings = {
  customLinkFilterRegex: "/api/mobile/releases/[0-9]+\\.[0-9]+\\.[0-9]+/apk$",
  versionExtractionRegEx: "/api/mobile/releases/([0-9]+\\.[0-9]+\\.[0-9]+)/apk",
  matchGroupToUse: "1",
} as const;

/** `obtainium://app/...`: the app link Obtainium registers. */
const obtainiumAppLink = (origin: string): string =>
  `obtainium://app/${encodeURIComponent(
    encodeJson({
      id: androidPackage,
      url: new URL("/android", origin).href,
      author: "Kvitbit",
      name: "Kvitbit",
      additionalSettings: encodeJson(obtainiumSourceSettings),
    }),
  )}`;

/** Obtainium redirect URL pointing at `origin`'s `/android` page. */
export const obtainiumImportUrl = (origin: string): string => {
  const url = new URL("https://apps.obtainium.imranr.dev/redirect");
  url.searchParams.set("r", obtainiumAppLink(origin));
  return url.href;
};

const StoredAsset = Schema.Struct({
  sha256: Sha256Hex,
  hash: Schema.String,
  key: Schema.String,
  contentType: Schema.String,
  fileExtension: Schema.optionalKey(Schema.String),
});

const publicationFields = {
  schema: Schema.Literal(1),
  id: Schema.String,
  createdAt: Schema.String,
  channel: Schema.String,
  platform: UpdatePlatform,
  runtimeVersion: Schema.String,
};

// Expo receives both objects verbatim, including fields written by older publishers.
const ManifestObject = Schema.declare(Predicate.isReadonlyObject);
const Publication = Schema.Union([
  Schema.Struct({
    ...publicationFields,
    type: Schema.Literal("update"),
    launchAsset: StoredAsset,
    assets: Schema.Array(StoredAsset),
    metadata: ManifestObject,
    extra: ManifestObject,
  }),
  Schema.Struct({ ...publicationFields, type: Schema.Literal("rollBackToEmbedded") }),
]);

export type ReadPublication = typeof Publication.Type;
const decodePublication = Schema.decodeEffect(Schema.fromJsonString(Publication));
export const parsePublication = (json: string) => decodePublication(json);

const AssetMeta = Schema.Struct({
  schema: Schema.Literal(1),
  sha256: Sha256Hex,
  contentType: Schema.String.check(Schema.isNonEmpty()),
  size: Schema.Finite.check(Schema.makeFilter(Number.isInteger), Schema.isGreaterThanOrEqualTo(0)),
});

const decodeAssetMeta = Schema.decodeEffect(Schema.fromJsonString(AssetMeta));
export const parseAssetMeta = (json: string) => decodeAssetMeta(json);
