#!/usr/bin/env bun
/**
 * Kvitbit mobile release pipeline CLI.
 *
 * Subcommands:
 *   metadata     Print app version, Android versionCode, and APK file name.
 *   build        Build and verify the Android APK (supports --dry-run, --signing debug|release).
 *   publish-apk  Publish signed APK + release.json to storage (create-only, supports --dry-run).
 *   publish-ota  Export and publish Expo Updates OTA assets + channel record (create-only, --dry-run).
 *   rollback     Publish a rollBackToEmbedded directive for a channel/platform/runtimeVersion (--dry-run).
 *   verify       Verify a live origin or local storage directory (manifest multipart + RSA signature).
 */

import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { parseArgs } from "node:util";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import {
  buildManifestResponse,
  parseMultipartMixed,
  readManifestRequest,
  verifyManifestSignature,
} from "../../apps/mobile/release/manifest-response";
import {
  KVITBIT_ANDROID_PACKAGE,
  obtainiumImportUrl,
} from "../../apps/mobile/release/obtainium-link";
import {
  APK_CONTENT_TYPE,
  ASSET_CACHE_CONTROL,
  type AssetMeta,
  androidVersionCode,
  apkFileName,
  apkObjectKey,
  apkRoutePath,
  assertChannel,
  assertRuntimeVersion,
  assetMetaObjectKey,
  assetObjectKey,
  DEFAULT_UPDATE_CHANNEL,
  isMobilePlatform,
  latestPublicationKey,
  latestRelease,
  MOBILE_PLATFORMS,
  type MobilePlatform,
  parseAppVersion,
  parseAssetMeta,
  parsePublication,
  parseReleaseInfo,
  publicationObjectKey,
  publicationPrefix,
  type ReleaseInfo,
  releaseInfoObjectKey,
  releasePrefix,
  type StoredPublication,
  type StoredRollback,
  type StoredUpdate,
  type StoredUpdateAsset,
} from "../../apps/mobile/release/storage-layout";

const decodeJson = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string) =>
  Result.getOrThrowWith(decodeJson(text), () => new SyntaxError("Invalid release JSON"));

const compactJson = Fn.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const prettyJson = Fn.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 })),
  Result.getOrThrow,
);

const DEFAULT_ORIGIN = "https://kvitbit.cz";
const DEFAULT_MIN_ANDROID_SDK = 28;
const RELEASE_TAG_PREFIX = "mobile-v";
const TRAILING_SLASHES = /\/+$/u;

const hasText = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

class ReleaseError extends Schema.TaggedError<ReleaseError, { readonly brand: unique symbol }>()(
  "ReleaseError",
  { message: Schema.String },
) {}

const readDirectoryIfPresent = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );

const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  html: "text/html",
  txt: "text/plain",
};

const writeStdout = (text: string): void => {
  process.stdout.write(Str.endsWith("\n")(text) ? text : `${text}\n`);
};

const writeStderr = (text: string): void => {
  process.stderr.write(Str.endsWith("\n")(text) ? text : `${text}\n`);
};

const HELP_TEXT = `Usage: bun run scripts/release/mobile-release.ts <command> [options]

Commands:
  metadata      Read apps/mobile/app.json and emit version, version-code, apk-name.
  build         Build and verify Android APK (release or debug signing).
  publish-apk   Publish signed APK and release.json to storage (create-only).
  publish-ota   Export and publish Expo Updates assets and channel manifest (create-only).
  rollback      Publish a rollBackToEmbedded directive for a channel/platform/runtimeVersion.
  verify        Verify manifest multipart + RSA-v1_5-SHA256 signature against origin or storage-dir.

Common options:
  --dry-run                    Validate and print planned operations without network/secrets/writes.
  --project <dir>              Expo mobile project directory (default: apps/mobile).
  --origin <url>               Public Kvitbit origin (default: https://kvitbit.cz).
  --storage-dir <dir>          Local disk storage root (env: KVITBIT_MOBILE_STORAGE_DIR).
  --bucket <name>              GCS bucket name (env: KVITBIT_MOBILE_STORAGE_BUCKET).
  --channel <name>             Expo Updates channel (default: production).
  --platform <android|ios>     Target platform (repeatable for publish-ota/rollback).
  --runtime-version <ver>      Explicit runtime version (skips expo-updates resolve).
  -h, --help                   Show this help message.
`;

// --- Pure helpers (adapted from DeskoHub release scripts) ---

const releaseTagVersion = (tag: string): string => {
  if (!Str.startsWith(RELEASE_TAG_PREFIX)(tag)) {
    throw new Error(`Release tag ${compactJson(tag)} must start with ${RELEASE_TAG_PREFIX}.`);
  }
  const version = Str.slice(RELEASE_TAG_PREFIX.length)(tag);
  parseAppVersion(version);
  return version;
};

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SIGNER_DIGEST_RE =
  /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer(?: #\d+)?:) certificate SHA-256 digest: ([0-9a-fA-F]+)$/;

const normalizeCertificateSha256 = (digest: string): string => {
  const hex = Str.toLowerCase(Str.replaceAll(":", "")(digest));
  if (!SHA256_HEX_RE.test(hex)) {
    throw new Error(`${compactJson(digest)} is not a SHA-256 digest.`);
  }
  return hex;
};

const formatCertificateSha256 = (digest: string): string =>
  Fn.pipe(
    normalizeCertificateSha256(digest),
    Str.match(/../g),
    Option.map(Arr.join(":")),
    Option.getOrElse(() => ""),
    Str.toUpperCase,
  );

const parseApkSignerDigests = (apksignerOutput: string): string[] =>
  Fn.pipe(
    apksignerOutput,
    Str.split("\n"),
    Arr.map((line) => SIGNER_DIGEST_RE.exec(Str.trim(line))?.[1]),
    Arr.filter(Predicate.isNotUndefined),
    Arr.map(normalizeCertificateSha256),
  );

const findAndroidBuildTool = Effect.fn("MobileRelease.findAndroidBuildTool")(function* (
  tool: "apksigner" | "aapt2",
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const sdk = readEnv("ANDROID_HOME") ?? readEnv("ANDROID_SDK_ROOT");
  if (sdk !== undefined) {
    const buildToolsDir = join(sdk, "build-tools");
    const versions = yield* readDirectoryIfPresent(fs, buildToolsDir);
    const found = yield* Effect.filter(versions, (version) =>
      fs.exists(join(buildToolsDir, version, tool)),
    );
    const sorted = Arr.sort(
      found,
      Order.make((left: string, right: string) =>
        Str.localeCompare(left, undefined, { numeric: true })(right),
      ),
    );
    const newest = sorted[0];
    if (newest !== undefined) return join(buildToolsDir, newest, tool);
  }
  return Bun.which(tool) ?? undefined;
});

const inspectApkSignerSha256s = Effect.fn("MobileRelease.inspectApkSignerSha256s")(function* (
  apkPath: string,
) {
  const apksigner = yield* findAndroidBuildTool("apksigner");
  if (apksigner === undefined)
    return yield* ReleaseError.make({
      message: "Android build-tools apksigner is required to verify APKs.",
    });
  const res = yield* runProcess([apksigner, "verify", "--print-certs", apkPath]);
  if (res.exitCode !== 0) {
    return yield* ReleaseError.make({
      message: `apksigner verification failed for ${apkPath}:\n${res.stderr || res.stdout}`,
    });
  }
  const digests = parseApkSignerDigests(res.stdout);
  if (digests.length === 0) {
    return yield* ReleaseError.make({
      message: `apksigner reported no signer certificates for ${apkPath}.`,
    });
  }
  return digests;
});

const verifyApkArtifact = Effect.fn("MobileRelease.verifyApkArtifact")(function* (
  apkPath: string,
  expected: {
    readonly packageName: string;
    readonly versionCode: number;
    readonly versionName: string;
    readonly expectedSignerSha256: string | undefined;
  },
) {
  const signers = yield* inspectApkSignerSha256s(apkPath);
  const uniqueSigners = [...new Set(signers)];
  if (uniqueSigners.length !== 1) {
    return yield* ReleaseError.make({
      message: `APK ${apkPath} must have exactly one current signer.`,
    });
  }
  if (hasText(expected.expectedSignerSha256)) {
    const expectedHex = normalizeCertificateSha256(expected.expectedSignerSha256);
    const unexpected = Arr.filter(uniqueSigners, (digest) => digest !== expectedHex);
    if (unexpected.length > 0) {
      return yield* ReleaseError.make({
        message: `APK signer certificate ${Arr.join(Arr.map(unexpected, formatCertificateSha256), ", ")} does not match expected ${formatCertificateSha256(expectedHex)}.`,
      });
    }
  }
  const primarySigner = uniqueSigners[0];
  if (primarySigner === undefined) {
    return yield* ReleaseError.make({ message: `APK ${apkPath} has no signer certificate.` });
  }

  const aapt2 = yield* findAndroidBuildTool("aapt2");
  if (aapt2 === undefined)
    return yield* ReleaseError.make({
      message: "Android build-tools aapt2 is required to verify APK identity.",
    });
  const badging = yield* runProcess([aapt2, "dump", "badging", apkPath]);
  if (badging.exitCode !== 0) {
    return yield* ReleaseError.make({
      message: `aapt2 dump badging failed for ${apkPath}:\n${badging.stderr}`,
    });
  }
  const actual = parseApkBadgingIdentity(badging.stdout);
  if (
    actual.packageName !== expected.packageName ||
    actual.versionCode !== expected.versionCode ||
    actual.versionName !== expected.versionName
  ) {
    return yield* ReleaseError.make({
      message: `APK identity mismatch: got ${actual.packageName} (${actual.versionName} / ${actual.versionCode}), expected ${expected.packageName} (${expected.versionName} / ${expected.versionCode}).`,
    });
  }

  return { signingCertSha256: formatCertificateSha256(primarySigner) };
});

const withOtaCodeSigningEnv = Effect.fn("MobileRelease.withOtaCodeSigningEnv")(function* <T, E, R>(
  projectDir: string,
  env: Record<string, string | undefined>,
  fn: (resolvedEnv: Record<string, string | undefined>) => Effect.Effect<T, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const { join, dirname } = yield* Path.Path;
  const pemContent = Str.trim(env["MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE_PEM"] ?? "");
  if (!hasText(pemContent)) {
    return yield* fn(env);
  }
  const certificate = new X509Certificate(pemContent);
  // Expo uses a project-relative path. The same certificate must have the same
  // path in the APK build and in the OTA job's independent checkout.
  const fileName = `${Str.toLowerCase(Str.replaceAll(":", "")(certificate.fingerprint256))}.pem`;
  const certPath = join(projectDir, ".expo", "release-signing", fileName);
  yield* fs.makeDirectory(dirname(certPath), { recursive: true });
  yield* fs.writeFileString(certPath, `${Str.trim(certificate.toString())}\n`);
  return yield* fn({
    ...env,
    MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: certPath,
  });
});

const parseApkBadgingIdentity = (
  badging: string,
): { readonly packageName: string; readonly versionCode: number; readonly versionName: string } => {
  const line = Option.getOrUndefined(
    Arr.findFirst(Str.split("\n")(badging), Str.startsWith("package:")),
  );
  const attr = (name: string) =>
    line === undefined ? undefined : new RegExp(`\\b${name}='([^']*)'`, "u").exec(line)?.[1];
  const packageName = attr("name");
  const versionCode = attr("versionCode");
  const versionName = attr("versionName");
  if (!(hasText(packageName) && hasText(versionCode) && hasText(versionName))) {
    throw new Error("aapt2 badging has no package name and version.");
  }
  return { packageName, versionCode: Number(versionCode), versionName };
};

const isExpoAppConfig = Schema.is(
  Schema.Struct({
    version: Schema.String,
    android: Schema.optional(Schema.Unknown),
    plugins: Schema.optional(Schema.Unknown),
  }),
);

const readAppMeta = Effect.fn("MobileRelease.readAppMeta")(function* (
  projectDir: string,
  tag?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const path = join(projectDir, "app.json");
  const raw = yield* fs.readFileString(path);
  const parsed = parseJson(raw);
  const expo = Predicate.isObject(parsed) ? parsed["expo"] : undefined;
  if (!isExpoAppConfig(expo)) {
    return yield* ReleaseError.make({ message: `Missing expo.version in ${path}` });
  }
  const version = expo.version;
  const versionCode = androidVersionCode(version);
  const trimmedTag = Str.trim(tag ?? "");
  if (hasText(trimmedTag)) {
    const tagVer = releaseTagVersion(trimmedTag);
    if (tagVer !== version) {
      return yield* ReleaseError.make({
        message: `Release tag ${tag} (${tagVer}) does not match app.json version ${version}.`,
      });
    }
  }
  const androidPackage = Predicate.isObject(expo.android) ? expo.android["package"] : undefined;
  const packageName = Predicate.isString(androidPackage) ? androidPackage : KVITBIT_ANDROID_PACKAGE;
  let minAndroidSdk = DEFAULT_MIN_ANDROID_SDK;
  if (Arr.isArray(expo.plugins)) {
    for (const plugin of expo.plugins) {
      if (!Arr.isArray(plugin)) continue;
      const [name, config] = plugin;
      if (
        name === "expo-build-properties" &&
        Predicate.isObject(config) &&
        Predicate.isObject(config["android"])
      ) {
        const { minSdkVersion } = config["android"];
        if (Predicate.isNumber(minSdkVersion)) minAndroidSdk = minSdkVersion;
      }
    }
  }
  return {
    version,
    versionCode,
    packageName,
    minAndroidSdk,
    apkName: apkFileName(version),
    expoConfig: expo,
  };
});

// --- Subprocess runner ---

const runProcess = Effect.fn("MobileRelease.runProcess")(function* (
  cmd: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
) {
  const [command, ...args] = cmd;
  if (command === undefined)
    return yield* ReleaseError.make({ message: "Missing subprocess command" });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make(command, args, options));
  return yield* Effect.all(
    {
      stdout: handle.stdout.pipe(Stream.decodeText, Stream.mkString),
      stderr: handle.stderr.pipe(Stream.decodeText, Stream.mkString),
      exitCode: handle.exitCode,
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

// --- Storage backend (create-only: local disk `wx` or GCS `--if-generation-match=0`) ---

type StorageTarget =
  | { readonly kind: "dir"; readonly root: string }
  | { readonly kind: "gcs"; readonly bucket: string }
  | { readonly kind: "none" };

const readEnv = (name: string): string | undefined => {
  const value = Str.trim(Bun.env[name] ?? "");
  return hasText(value) ? value : undefined;
};

const resolveStorageTarget = (
  path: Path.Path,
  storageDirArg: string | undefined,
  bucketArg: string | undefined,
  dryRun: boolean,
): StorageTarget => {
  const trimmedDirArg = Str.trim(storageDirArg ?? "");
  const trimmedBucketArg = Str.trim(bucketArg ?? "");
  const dir = hasText(trimmedDirArg) ? trimmedDirArg : readEnv("KVITBIT_MOBILE_STORAGE_DIR");
  const bucket = hasText(trimmedBucketArg)
    ? trimmedBucketArg
    : readEnv("KVITBIT_MOBILE_STORAGE_BUCKET");
  if (dir !== undefined && bucket !== undefined) {
    throw new Error("Specify either --storage-dir or --bucket, not both.");
  }
  if (dir !== undefined) return { kind: "dir", root: path.resolve(dir) };
  if (bucket !== undefined) return { kind: "gcs", bucket };
  if (dryRun) return { kind: "none" };
  throw new Error(
    "No storage target configured. Pass --storage-dir (KVITBIT_MOBILE_STORAGE_DIR) or --bucket (KVITBIT_MOBILE_STORAGE_BUCKET), or use --dry-run.",
  );
};

const writeCreateOnly = Effect.fn("MobileRelease.writeCreateOnly")(function* (
  target: StorageTarget,
  key: string,
  bytes: Uint8Array,
  options: {
    readonly contentType: string;
    readonly cacheControl?: string;
    readonly allowExisting: boolean;
  },
): Effect.fn.Return<
  "written" | "exists",
  ReleaseError | PlatformError.PlatformError,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | import("effect/Scope").Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const { join, dirname } = yield* Path.Path;
  if (target.kind === "none") {
    return yield* ReleaseError.make({ message: "Cannot write without a storage target." });
  }
  if (target.kind === "dir") {
    const fullPath = join(target.root, key);
    const directory = dirname(fullPath);
    yield* fs.makeDirectory(directory, { recursive: true });
    const stagingDir = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".staging-" });
    const stagedPath = join(stagingDir, "payload");
    yield* fs.writeFile(stagedPath, bytes);
    // Same-filesystem link publishes the complete file atomically and fails if it exists.
    return yield* fs.link(stagedPath, fullPath).pipe(
      Effect.as("written" as const),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () =>
          options.allowExisting
            ? Effect.succeed("exists" as const)
            : ReleaseError.make({
                message: `Object ${key} already exists (create-only storage refuses overwrite).`,
              }),
      ),
    );
  }

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-gcs-" });
  const tempFile = join(tempDir, "payload");
  yield* fs.writeFile(tempFile, bytes);
  const args = [
    "gcloud",
    "storage",
    "cp",
    "--if-generation-match=0",
    `--content-type=${options.contentType}`,
  ];
  if (hasText(options.cacheControl)) args.push(`--cache-control=${options.cacheControl}`);
  args.push(tempFile, `gs://${target.bucket}/${key}`);
  const result = yield* runProcess(args);
  if (result.exitCode === 0) return "written";
  if (
    options.allowExisting &&
    (Str.includes("PreconditionException")(result.stderr) ||
      Str.includes("412")(result.stderr) ||
      Str.includes("conditionNotMet")(result.stderr))
  )
    return "exists";
  return yield* ReleaseError.make({
    message: `gcloud storage cp failed for ${key}: ${Str.trim(result.stderr)}`,
  });
}, Effect.scoped);

const readStorageObject = Effect.fn("MobileRelease.readStorageObject")(function* (
  target: StorageTarget,
  key: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  if (target.kind === "none") {
    return yield* ReleaseError.make({ message: "Cannot read without a storage target." });
  }
  if (target.kind === "dir") return yield* fs.readFile(join(target.root, key));
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-gcs-read-" });
  const tempFile = join(tempDir, "payload");
  const result = yield* runProcess([
    "gcloud",
    "storage",
    "cp",
    `gs://${target.bucket}/${key}`,
    tempFile,
  ]);
  if (result.exitCode !== 0) {
    return yield* ReleaseError.make({
      message: `gcloud storage cp failed reading ${key}: ${Str.trim(result.stderr)}`,
    });
  }
  return yield* fs.readFile(tempFile);
}, Effect.scoped);

// --- Exported update reader ---

interface ExportedAssetFile {
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly asset: StoredUpdateAsset;
  readonly meta: AssetMeta;
}

const describeAssetBytes = (
  bytes: Uint8Array,
  contentType: string,
  fileExtension?: string,
): ExportedAssetFile => {
  const sha256Hex = Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const hashBase64Url = Bun.CryptoHasher.hash("sha256", bytes, "base64url");
  const keyMd5 = Bun.CryptoHasher.hash("md5", bytes, "hex");
  const asset: StoredUpdateAsset =
    fileExtension === undefined
      ? { sha256: sha256Hex, hash: hashBase64Url, key: keyMd5, contentType }
      : { sha256: sha256Hex, hash: hashBase64Url, key: keyMd5, contentType, fileExtension };
  const meta: AssetMeta = {
    schema: 1,
    sha256: sha256Hex,
    contentType,
    size: bytes.byteLength,
  };
  return { sha256: sha256Hex, bytes, asset, meta };
};

const isExpoPlatformExport = Schema.is(
  Schema.Struct({ bundle: Schema.String, assets: Schema.optional(Schema.Unknown) }),
);
const isExpoAsset = Schema.is(Schema.Struct({ path: Schema.String, ext: Schema.String }));

const readExpoExport = Effect.fn("MobileRelease.readExpoExport")(function* (
  exportDir: string,
  platform: MobilePlatform,
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const metaRaw = yield* fs.readFileString(join(exportDir, "metadata.json"));
  const parsed: unknown = parseJson(metaRaw);
  const fileMetadata = Predicate.isObject(parsed) ? parsed["fileMetadata"] : undefined;
  const platformFiles = Predicate.isObject(fileMetadata) ? fileMetadata[platform] : undefined;
  if (!isExpoPlatformExport(platformFiles)) {
    return yield* ReleaseError.make({
      message: `Export directory ${exportDir} has no ${platform} bundle in metadata.json`,
    });
  }
  const bundleBytes = yield* fs.readFile(join(exportDir, platformFiles.bundle));
  const launchAsset = describeAssetBytes(bundleBytes, "application/javascript");
  if (!Arr.isArray(platformFiles.assets)) {
    return yield* ReleaseError.make({
      message: `Export directory ${exportDir} has no ${platform} assets array in metadata.json`,
    });
  }
  const assets: ExportedAssetFile[] = [];
  yield* Effect.forEach(
    platformFiles.assets,
    Effect.fnUntraced(function* (item) {
      if (!isExpoAsset(item)) {
        return yield* ReleaseError.make({
          message: `Invalid ${platform} asset in ${exportDir}/metadata.json`,
        });
      }
      const bytes = yield* fs.readFile(join(exportDir, item.path));
      const ext = Str.toLowerCase(item.ext);
      const contentType = ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream";
      assets.push(describeAssetBytes(bytes, contentType, `.${item.ext}`));
    }),
    { concurrency: 1, discard: true },
  );
  return { launchAsset, assets };
});

// --- Subcommands ---

const cmdMetadata = Effect.fn("MobileRelease.cmdMetadata")(function* (argv: readonly string[]) {
  const { resolve } = yield* Path.Path;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: resolve(import.meta.dir, "../../apps/mobile") },
      tag: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const meta = yield* readAppMeta(resolve(values.project), values.tag);
  if (values.json) {
    writeStdout(
      prettyJson({
        version: meta.version,
        versionCode: meta.versionCode,
        packageName: meta.packageName,
        minAndroidSdk: meta.minAndroidSdk,
        apkName: meta.apkName,
      }),
    );
    return;
  }
  writeStdout(`version=${meta.version}`);
  writeStdout(`version-code=${meta.versionCode}`);
  writeStdout(`apk-name=${meta.apkName}`);
  writeStdout(`package-name=${meta.packageName}`);
});

const cmdBuild = Effect.fn("MobileRelease.cmdBuild")(function* (argv: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const { join, resolve } = yield* Path.Path;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: resolve(import.meta.dir, "../../apps/mobile") },
      tag: { type: "string" },
      signing: { type: "string", default: "release" },
      origin: { type: "string", default: DEFAULT_ORIGIN },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (values.signing !== "release" && values.signing !== "debug") {
    return yield* ReleaseError.make({
      message: `--signing must be "release" or "debug", got ${compactJson(values.signing)}`,
    });
  }
  const projectDir = resolve(values.project);
  const meta = yield* readAppMeta(projectDir, values.tag);
  const outDir = hasText(values["out-dir"])
    ? resolve(values["out-dir"])
    : join(projectDir, "dist/release");
  const apkOutPath = join(outDir, meta.apkName);

  if (values["dry-run"]) {
    const plan = {
      dryRun: true,
      command: "build",
      project: projectDir,
      version: meta.version,
      versionCode: meta.versionCode,
      packageName: meta.packageName,
      minAndroidSdk: meta.minAndroidSdk,
      signing: values.signing,
      origin: values.origin,
      apkOutPath,
      apkObjectKey: apkObjectKey(meta.version),
      releaseInfoObjectKey: releaseInfoObjectKey(meta.version),
      obtainiumUrl: obtainiumImportUrl(values.origin),
      steps: [
        "expo prebuild --platform android --non-interactive",
        values.signing === "release"
          ? "./gradlew assembleRelease (signed with ANDROID_KEYSTORE_BASE64)"
          : "./gradlew assembleRelease (signed with ephemeral debug keystore)",
        "aapt2 dump badging <apk> -> verify packageName, versionCode, versionName",
        "apksigner verify --print-certs <apk> -> verify certificate SHA-256",
      ],
    };
    writeStdout(prettyJson(plan));
    return;
  }

  const keystoreBase64 = readEnv("ANDROID_KEYSTORE_BASE64");
  const keystorePathEnv = readEnv("ANDROID_KEYSTORE_PATH");
  const keystorePassword = readEnv("ANDROID_KEYSTORE_PASSWORD");
  const keyAlias = readEnv("ANDROID_KEY_ALIAS") ?? "kvitbit-release";
  const keyPassword = readEnv("ANDROID_KEY_PASSWORD") ?? keystorePassword;

  if (
    values.signing === "release" &&
    ((keystoreBase64 === undefined && keystorePathEnv === undefined) ||
      keystorePassword === undefined)
  ) {
    return yield* ReleaseError.make({
      message:
        "Release build requires ANDROID_KEYSTORE_PASSWORD and ANDROID_KEYSTORE_BASE64 (or ANDROID_KEYSTORE_PATH), or pass --signing debug / --dry-run.",
    });
  }

  yield* fs.makeDirectory(outDir, { recursive: true });
  let resolvedKeystorePath = keystorePathEnv === undefined ? undefined : resolve(keystorePathEnv);
  if (values.signing === "release" && keystoreBase64 !== undefined) {
    const tempKeystoreDir = yield* fs.makeTempDirectoryScoped({
      prefix: "kvitbit-android-keystore-",
    });
    resolvedKeystorePath = join(tempKeystoreDir, "release.keystore");
    yield* fs.writeFile(resolvedKeystorePath, Buffer.from(keystoreBase64, "base64"));
    yield* fs.chmod(resolvedKeystorePath, 0o600);
  }

  const baseBuildEnv = {
    ...Bun.env,
    EXPO_PUBLIC_API_ORIGIN: values.origin,
    MOBILE_UPDATES_CODE_SIGNING: values.signing === "release" ? "required" : "",
    EXPO_UPDATES_WORKFLOW_OVERRIDE: "managed",
  };

  const androidDir = join(projectDir, "android");
  yield* withOtaCodeSigningEnv(
    projectDir,
    baseBuildEnv,
    Effect.fnUntraced(function* (prebuildEnv) {
      const prebuild = yield* runProcess(
        [
          process.execPath,
          "x",
          "--no-install",
          "expo",
          "prebuild",
          "--platform",
          "android",
          "--no-install",
        ],
        {
          cwd: projectDir,
          env: { ...prebuildEnv, CI: "1" },
        },
      );
      if (prebuild.exitCode !== 0) {
        return yield* ReleaseError.make({ message: `expo prebuild failed:\n${prebuild.stderr}` });
      }

      const gradleTask = values.signing === "release" ? "assembleRelease" : "assembleDebug";
      const gradleEnv: Record<string, string | undefined> =
        values.signing === "release"
          ? {
              ...prebuildEnv,
              ANDROID_KEYSTORE_PATH: resolvedKeystorePath,
              ANDROID_KEYSTORE_PASSWORD: keystorePassword,
              ANDROID_KEY_ALIAS: keyAlias,
              ANDROID_KEY_PASSWORD: keyPassword,
              KVITBIT_REQUIRE_RELEASE_SIGNING: "true",
            }
          : prebuildEnv;
      const gradle = yield* runProcess(
        ["./gradlew", gradleTask, "--no-daemon", "--console=plain"],
        {
          cwd: androidDir,
          env: gradleEnv,
        },
      );
      if (gradle.exitCode !== 0) {
        return yield* ReleaseError.make({
          message: `Gradle ${gradleTask} failed:\n${gradle.stderr}\n${Str.slice(-8000)(gradle.stdout)}`,
        });
      }
    }),
  );

  const builtApk = join(
    androidDir,
    "app/build/outputs/apk",
    values.signing === "release" ? "release/app-release.apk" : "debug/app-debug.apk",
  );
  const verified = yield* verifyApkArtifact(builtApk, {
    packageName: meta.packageName,
    versionCode: meta.versionCode,
    versionName: meta.version,
    expectedSignerSha256:
      values.signing === "release" ? readEnv("KVITBIT_ANDROID_SIGNING_CERT_SHA256") : undefined,
  });

  const apkBytes = yield* fs.readFile(builtApk);
  yield* fs.writeFile(apkOutPath, apkBytes);

  const apkSha256 = Bun.CryptoHasher.hash("sha256", apkBytes, "hex");
  writeStdout(
    prettyJson({
      command: "build",
      version: meta.version,
      versionCode: meta.versionCode,
      apkPath: apkOutPath,
      apkSha256,
      signingCertSha256: verified.signingCertSha256,
      sizeBytes: apkBytes.byteLength,
    }),
  );
});

const cmdPublishApk = Effect.fn("MobileRelease.cmdPublishApk")(function* (argv: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { join, resolve } = path;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: resolve(import.meta.dir, "../../apps/mobile") },
      apk: { type: "string" },
      version: { type: "string" },
      origin: { type: "string", default: DEFAULT_ORIGIN },
      "signing-cert-sha256": { type: "string" },
      "storage-dir": { type: "string" },
      bucket: { type: "string" },
      "released-at": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const dryRun = values["dry-run"];
  const projectDir = resolve(values.project);
  const meta = yield* readAppMeta(projectDir);
  const version = values.version ?? meta.version;
  const versionCode = androidVersionCode(version);
  const target = resolveStorageTarget(path, values["storage-dir"], values.bucket, dryRun);
  const releasedAt = values["released-at"] ?? DateTime.formatIso(DateTime.nowUnsafe());

  let apkPath: string | undefined;
  let apkBytes: Uint8Array | undefined;
  let apkSha256: string;
  let sizeBytes: number;

  if (hasText(values.apk)) {
    apkPath = resolve(values.apk);
    apkBytes = yield* fs.readFile(apkPath);
    apkSha256 = Bun.CryptoHasher.hash("sha256", apkBytes, "hex");
    sizeBytes = apkBytes.byteLength;
  } else if (dryRun) {
    apkSha256 = Str.repeat(64)("0");
    sizeBytes = 0;
  } else {
    return yield* ReleaseError.make({
      message: "publish-apk requires --apk <path> (or --dry-run).",
    });
  }

  const expectedCertSha =
    values["signing-cert-sha256"] ?? readEnv("KVITBIT_ANDROID_SIGNING_CERT_SHA256");

  let signingCertSha256: string;
  if (apkPath !== undefined && apkBytes !== undefined) {
    const staging = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-apk-verify-" });
    const snapshot = join(staging, "candidate.apk");
    yield* fs.writeFile(snapshot, apkBytes);
    const verified = yield* verifyApkArtifact(snapshot, {
      packageName: meta.packageName,
      versionCode,
      versionName: version,
      expectedSignerSha256: expectedCertSha,
    });
    signingCertSha256 = verified.signingCertSha256;
  } else if (dryRun) {
    signingCertSha256 = hasText(expectedCertSha)
      ? formatCertificateSha256(expectedCertSha)
      : formatCertificateSha256(Str.repeat(64)("0"));
  } else {
    return yield* ReleaseError.make({ message: "Missing APK path." });
  }

  const releaseInfo: ReleaseInfo = {
    version,
    versionCode,
    releasedAt,
    apkUrl: apkRoutePath(version),
    apkSha256,
    sizeBytes,
    signingCertSha256,
    minAndroidSdk: meta.minAndroidSdk,
    obtainiumUrl: obtainiumImportUrl(values.origin),
  };

  const apkKey = apkObjectKey(version);
  const infoKey = releaseInfoObjectKey(version);

  if (dryRun) {
    writeStdout(
      prettyJson({
        dryRun: true,
        command: "publish-apk",
        target,
        objects: [apkKey, infoKey],
        releaseInfo,
      }),
    );
    return;
  }

  if (apkBytes === undefined) {
    return yield* ReleaseError.make({ message: "Missing APK bytes." });
  }

  const apkOutcome = yield* writeCreateOnly(target, apkKey, apkBytes, {
    contentType: APK_CONTENT_TYPE,
    cacheControl: ASSET_CACHE_CONTROL,
    allowExisting: true,
  });
  if (apkOutcome === "exists") {
    const existingBytes = yield* readStorageObject(target, apkKey);
    const existingSha = Bun.CryptoHasher.hash("sha256", existingBytes, "hex");
    if (existingSha !== apkSha256 || existingBytes.byteLength !== apkBytes.byteLength) {
      return yield* ReleaseError.make({
        message: `Object ${apkKey} already exists with different bytes (existing sha256=${existingSha}, local sha256=${apkSha256}); create-only storage refuses overwrite.`,
      });
    }
  }
  const infoOutcome = yield* writeCreateOnly(
    target,
    infoKey,
    new TextEncoder().encode(`${prettyJson(releaseInfo)}\n`),
    {
      contentType: "application/json; charset=utf-8",
      allowExisting: true,
    },
  );

  let publishedReleaseInfo = releaseInfo;
  if (infoOutcome === "exists") {
    const existingBytes = yield* readStorageObject(target, infoKey);
    const existing = parseReleaseInfo(new TextDecoder().decode(existingBytes));
    const compatible = Rec.every(
      releaseInfo,
      (value, key) =>
        (key === "releasedAt" && values["released-at"] === undefined) || existing[key] === value,
    );
    if (!compatible) {
      return yield* ReleaseError.make({
        message: `Object ${infoKey} already exists with different release metadata.`,
      });
    }
    publishedReleaseInfo = existing;
  }

  writeStdout(
    prettyJson({
      command: "publish-apk",
      target,
      apkKey,
      infoKey,
      releaseInfo: publishedReleaseInfo,
    }),
  );
});

const hasRuntimeVersion = Schema.is(Schema.Struct({ runtimeVersion: Schema.NonEmptyString }));

const resolveRuntimeVersionFromExpo = Effect.fn("MobileRelease.resolveRuntimeVersionFromExpo")(
  function* (projectDir: string, platform: MobilePlatform, origin: string) {
    return yield* withOtaCodeSigningEnv(
      projectDir,
      {
        ...Bun.env,
        EXPO_PUBLIC_API_ORIGIN: origin,
      },
      Effect.fnUntraced(function* (env) {
        const result = yield* runProcess(
          [
            process.execPath,
            "x",
            "--no-install",
            "expo-updates",
            "runtimeversion:resolve",
            "--platform",
            platform,
            "--workflow",
            "managed",
          ],
          {
            cwd: projectDir,
            env,
          },
        );
        if (result.exitCode !== 0) {
          return yield* ReleaseError.make({
            message: `expo-updates runtimeversion:resolve failed for ${platform}:\n${result.stderr}`,
          });
        }
        const parsed: unknown = parseJson(result.stdout);
        if (!hasRuntimeVersion(parsed)) {
          return yield* ReleaseError.make({
            message: `Unexpected runtimeversion:resolve output: ${result.stdout}`,
          });
        }
        return assertRuntimeVersion(parsed.runtimeVersion);
      }),
    );
  },
);

const parsePlatforms = (raw: readonly string[] | undefined): readonly MobilePlatform[] => {
  const input = raw !== undefined && raw.length > 0 ? raw : ["android"];
  const out: MobilePlatform[] = [];
  for (const item of input) {
    if (item === "all") {
      for (const p of MOBILE_PLATFORMS) {
        if (!out.includes(p)) out.push(p);
      }
      continue;
    }
    if (!isMobilePlatform(item)) {
      throw new Error(`Invalid platform ${compactJson(item)}; expected android, ios, or all.`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
};

const cmdPublishOta = Effect.fn("MobileRelease.cmdPublishOta")(function* (argv: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { resolve } = path;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: resolve(import.meta.dir, "../../apps/mobile") },
      "export-dir": { type: "string" },
      channel: { type: "string", default: DEFAULT_UPDATE_CHANNEL },
      platform: { type: "string", multiple: true },
      "runtime-version": { type: "string" },
      origin: { type: "string", default: DEFAULT_ORIGIN },
      "storage-dir": { type: "string" },
      bucket: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const dryRun = values["dry-run"];
  const projectDir = resolve(values.project);
  const channel = assertChannel(values.channel);
  const platforms = parsePlatforms(values.platform);
  const target = resolveStorageTarget(path, values["storage-dir"], values.bucket, dryRun);
  const meta = yield* readAppMeta(projectDir);

  let exportDir = hasText(values["export-dir"]) ? resolve(values["export-dir"]) : undefined;

  if (exportDir === undefined && !dryRun) {
    const tempExportDir = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-ota-export-" });
    const exportArgs = [
      process.execPath,
      "x",
      "--no-install",
      "expo",
      "export",
      "--output-dir",
      tempExportDir,
      ...Arr.flatMap(platforms, (p) => ["--platform", p]),
    ];
    const exported = yield* withOtaCodeSigningEnv(
      projectDir,
      { ...Bun.env, EXPO_PUBLIC_API_ORIGIN: values.origin },
      (env) => runProcess(exportArgs, { cwd: projectDir, env }),
    );
    if (exported.exitCode !== 0) {
      return yield* ReleaseError.make({ message: `expo export failed:\n${exported.stderr}` });
    }
    exportDir = tempExportDir;
  }

  const published: Array<{
    readonly platform: MobilePlatform;
    readonly runtimeVersion: string;
    readonly publicationKey: string;
    readonly id: string;
    readonly assetCount: number;
  }> = [];

  const requestedRuntime = values["runtime-version"];
  const explicitRuntime = hasText(requestedRuntime)
    ? assertRuntimeVersion(requestedRuntime)
    : undefined;
  yield* Effect.forEach(
    platforms,
    Effect.fnUntraced(function* (platform) {
      let runtimeVersion = explicitRuntime ?? `dry-run-${meta.version}`;
      if (explicitRuntime === undefined && !dryRun) {
        runtimeVersion = yield* resolveRuntimeVersionFromExpo(projectDir, platform, values.origin);
      }

      const id = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4());
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      const pubKey = publicationObjectKey({ channel, platform, runtimeVersion, createdAt, id });

      const platformExportDir = exportDir;
      if (platformExportDir === undefined) {
        published.push({ platform, runtimeVersion, publicationKey: pubKey, id, assetCount: 0 });
        return;
      }

      const exported = yield* readExpoExport(platformExportDir, platform);
      const allFiles = [exported.launchAsset, ...exported.assets];
      const record: StoredUpdate = {
        schema: 1,
        type: "update",
        id,
        createdAt,
        channel,
        platform,
        runtimeVersion,
        launchAsset: exported.launchAsset.asset,
        assets: Arr.map(exported.assets, (a) => a.asset),
        metadata: {},
        extra: { expoClient: meta.expoConfig },
      };

      if (!dryRun) {
        const seen = new Set<string>();
        yield* Effect.forEach(
          allFiles,
          Effect.fnUntraced(function* (file) {
            if (seen.has(file.sha256)) return;
            seen.add(file.sha256);
            yield* writeCreateOnly(target, assetObjectKey(file.sha256), file.bytes, {
              contentType: file.meta.contentType,
              cacheControl: ASSET_CACHE_CONTROL,
              allowExisting: true,
            });
            yield* writeCreateOnly(
              target,
              assetMetaObjectKey(file.sha256),
              new TextEncoder().encode(`${compactJson(file.meta)}\n`),
              {
                contentType: "application/json; charset=utf-8",
                allowExisting: true,
              },
            );
          }),
          { concurrency: 1, discard: true },
        );
        yield* writeCreateOnly(
          target,
          pubKey,
          new TextEncoder().encode(`${prettyJson(record)}\n`),
          {
            contentType: "application/json; charset=utf-8",
            allowExisting: false,
          },
        );
      }

      published.push({
        platform,
        runtimeVersion,
        publicationKey: pubKey,
        id,
        assetCount: allFiles.length,
      });
    }),
    { concurrency: 1, discard: true },
  );

  writeStdout(
    prettyJson({
      dryRun,
      command: "publish-ota",
      channel,
      target,
      published,
    }),
  );
});

const cmdRollback = Effect.fn("MobileRelease.cmdRollback")(function* (argv: readonly string[]) {
  const path = yield* Path.Path;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      channel: { type: "string", default: DEFAULT_UPDATE_CHANNEL },
      platform: { type: "string", multiple: true },
      "runtime-version": { type: "string" },
      "storage-dir": { type: "string" },
      bucket: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const dryRun = values["dry-run"];
  const channel = assertChannel(values.channel);
  const platforms = parsePlatforms(values.platform);
  const runtimeVersion = hasText(values["runtime-version"])
    ? assertRuntimeVersion(values["runtime-version"])
    : (() => {
        throw new Error("rollback requires --runtime-version <version>.");
      })();
  const target = resolveStorageTarget(path, values["storage-dir"], values.bucket, dryRun);

  const records: Array<{
    readonly platform: MobilePlatform;
    readonly publicationKey: string;
    readonly record: StoredRollback;
  }> = [];

  yield* Effect.forEach(
    platforms,
    Effect.fnUntraced(function* (platform) {
      const id = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4());
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      const record: StoredRollback = {
        schema: 1,
        type: "rollBackToEmbedded",
        id,
        createdAt,
        channel,
        platform,
        runtimeVersion,
      };
      const key = publicationObjectKey({ channel, platform, runtimeVersion, createdAt, id });
      if (!dryRun) {
        yield* writeCreateOnly(target, key, new TextEncoder().encode(`${prettyJson(record)}\n`), {
          contentType: "application/json; charset=utf-8",
          allowExisting: false,
        });
      }
      records.push({ platform, publicationKey: key, record });
    }),
    { concurrency: 1, discard: true },
  );

  writeStdout(
    prettyJson({
      dryRun,
      command: "rollback",
      channel,
      runtimeVersion,
      target,
      records,
    }),
  );
});

const listLocalKeys = Effect.fn("MobileRelease.listLocalKeys")(function* (
  root: string,
  prefix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const dir = join(root, prefix);
  const entries = yield* readDirectoryIfPresent(fs, dir);
  return Arr.map(entries, (name) => `${prefix}${name}`);
});

interface LocalVerificationChecks {
  readonly mode: "storage-dir";
  readonly root: string;
  readonly dryRun: boolean;
  update?: {
    readonly latestKey: string | null;
    readonly publicationType: StoredPublication["type"] | "noUpdateAvailable";
    readonly signatureVerified: boolean;
  };
  latestRelease?: ReleaseInfo | null;
}

const cmdVerify = Effect.fn("MobileRelease.cmdVerify")(function* (argv: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const { join, resolve } = yield* Path.Path;
  const { values } = parseArgs({
    args: [...argv],
    options: {
      origin: { type: "string", default: DEFAULT_ORIGIN },
      "storage-dir": { type: "string" },
      channel: { type: "string", default: DEFAULT_UPDATE_CHANNEL },
      platform: { type: "string", default: "android" },
      "runtime-version": { type: "string" },
      certificate: { type: "string" },
      "signing-key": { type: "string" },
      "check-release": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const dryRun = values["dry-run"];
  const channel = assertChannel(values.channel);
  if (!isMobilePlatform(values.platform)) {
    return yield* ReleaseError.make({
      message: `Invalid platform: ${compactJson(values.platform)}`,
    });
  }
  const platform: MobilePlatform = values.platform;
  const storageDirArg = Str.trim(values["storage-dir"] ?? "");
  const storageDir = hasText(storageDirArg) ? storageDirArg : readEnv("KVITBIT_MOBILE_STORAGE_DIR");

  if (storageDir !== undefined) {
    const root = resolve(storageDir);
    const checks: LocalVerificationChecks = { mode: "storage-dir", root, dryRun };

    if (hasText(values["runtime-version"])) {
      const runtimeVersion = assertRuntimeVersion(values["runtime-version"]);
      const prefix = publicationPrefix({ channel, platform, runtimeVersion });
      const keys = yield* listLocalKeys(root, prefix);
      const latestKey = latestPublicationKey(keys);
      const latestJson =
        latestKey === undefined ? null : yield* fs.readFileString(join(root, latestKey));
      const latest = latestJson === null ? null : parsePublication(latestJson);

      if (latest?.type === "update") {
        yield* Effect.forEach(
          [latest.launchAsset, ...latest.assets],
          Effect.fnUntraced(function* (asset) {
            const assetBytes = yield* fs.readFile(join(root, assetObjectKey(asset.sha256)));
            const actualSha = Bun.CryptoHasher.hash("sha256", assetBytes, "hex");
            if (actualSha !== asset.sha256) {
              return yield* ReleaseError.make({
                message: `Asset hash mismatch for ${asset.sha256}: got ${actualSha}`,
              });
            }
            const metaJson = yield* fs.readFileString(join(root, assetMetaObjectKey(asset.sha256)));
            const meta = parseAssetMeta(metaJson);
            if (meta.sha256 !== asset.sha256 || meta.size !== assetBytes.byteLength) {
              return yield* ReleaseError.make({
                message: `Asset metadata mismatch for ${asset.sha256}`,
              });
            }
          }),
          { concurrency: 1, discard: true },
        );
      }

      const req = readManifestRequest({
        headers: {
          "expo-protocol-version": "1",
          "expo-platform": platform,
          "expo-runtime-version": runtimeVersion,
          "expo-channel-name": channel,
          "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
          accept: "multipart/mixed",
        },
      });
      if (req._tag !== "Request") {
        return yield* ReleaseError.make({
          message: `Internal manifest request rejected: ${req.message}`,
        });
      }

      let signingKeyPem = hasText(values["signing-key"])
        ? yield* fs.readFileString(resolve(values["signing-key"]))
        : readEnv("KVITBIT_MOBILE_UPDATES_SIGNING_KEY");
      let verifyCertPem = hasText(values.certificate)
        ? yield* fs.readFileString(resolve(values.certificate))
        : undefined;

      if (!(hasText(signingKeyPem) || hasText(verifyCertPem))) {
        const ephemeral = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        signingKeyPem = ephemeral.privateKey;
        verifyCertPem = ephemeral.publicKey;
      }

      const response = buildManifestResponse({
        request: req,
        latest,
        origin: values.origin,
        signingKeyPem,
      });
      if (response._tag !== "Response") {
        return yield* ReleaseError.make({
          message: `Manifest response failed: ${response.message}`,
        });
      }
      const { "content-type": contentType = "" } = response.headers;
      const parts = parseMultipartMixed(contentType, response.body);
      const mainPart = parts?.[0];
      if (mainPart === undefined) {
        return yield* ReleaseError.make({ message: "Multipart response had no main part." });
      }
      if (hasText(verifyCertPem)) {
        const sigOk = verifyManifestSignature({
          body: mainPart.body,
          expoSignatureHeader: mainPart.headers.get("expo-signature"),
          publicKeyOrCert: verifyCertPem,
        });
        if (!sigOk) {
          return yield* ReleaseError.make({
            message: "Manifest RSA-v1_5-SHA256 signature verification failed.",
          });
        }
      }
      checks.update = {
        latestKey: latestKey ?? null,
        publicationType: latest?.type ?? "noUpdateAvailable",
        signatureVerified: verifyCertPem !== undefined,
      };
    }

    if (values["check-release"]) {
      const releaseDir = join(root, releasePrefix());
      const versionDirs = yield* readDirectoryIfPresent(fs, releaseDir);
      const releases: ReleaseInfo[] = [];
      yield* Effect.forEach(
        versionDirs,
        Effect.fnUntraced(function* (ver) {
          const infoPath = join(root, releaseInfoObjectKey(ver));
          const infoStat = yield* fs.stat(infoPath).pipe(Effect.orElseSucceed(() => null));
          if (infoStat?.type !== "File") return;
          const infoJson = yield* fs.readFileString(infoPath);
          const info = parseReleaseInfo(infoJson);
          const apkPath = join(root, apkObjectKey(info.version));
          const apkBytes = yield* fs.readFile(apkPath);
          const actualSha = Bun.CryptoHasher.hash("sha256", apkBytes, "hex");
          if (actualSha !== info.apkSha256 || apkBytes.byteLength !== info.sizeBytes) {
            return yield* ReleaseError.make({
              message: `APK integrity mismatch for ${info.version}`,
            });
          }
          releases.push(info);
        }),
        { concurrency: 1, discard: true },
      );
      checks.latestRelease = latestRelease(releases) ?? null;
    }

    writeStdout(prettyJson({ ok: true, ...checks }));
    return;
  }

  const origin = Str.replace(TRAILING_SLASHES, "")(values.origin);
  const manifestUrl = `${origin}/api/mobile/updates/manifest`;
  if (dryRun) {
    writeStdout(
      prettyJson({
        dryRun: true,
        command: "verify",
        mode: "http",
        manifestUrl,
        releaseUrl: values["check-release"] ? `${origin}/api/mobile/releases/latest` : null,
        channel,
        platform,
        runtimeVersion: values["runtime-version"] ?? "<required>",
      }),
    );
    return;
  }

  if (!hasText(values["runtime-version"])) {
    return yield* ReleaseError.make({
      message: "HTTP verify requires --runtime-version <version> (or --storage-dir).",
    });
  }
  const runtimeVersion = assertRuntimeVersion(values["runtime-version"]);

  const headers = {
    "expo-protocol-version": "1",
    "expo-platform": platform,
    "expo-runtime-version": runtimeVersion,
    "expo-channel-name": channel,
    accept: "multipart/mixed",
  };
  const manifestHeaders = hasText(values.certificate)
    ? { ...headers, "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"' }
    : headers;
  const res = yield* HttpClient.get(manifestUrl, { headers: manifestHeaders });
  if (res.status < 200 || res.status >= 300) {
    return yield* ReleaseError.make({
      message: `Manifest request failed with HTTP ${res.status}: ${yield* res.text}`,
    });
  }
  const contentType = res.headers["content-type"] ?? "";
  const body = yield* res.text;
  const parts = parseMultipartMixed(contentType, body);
  const mainPart = parts?.[0];
  if (mainPart === undefined) {
    return yield* ReleaseError.make({
      message: `Invalid multipart/mixed manifest response from ${manifestUrl}`,
    });
  }
  if (hasText(values.certificate)) {
    const certPem = yield* fs.readFileString(resolve(values.certificate));
    const ok = verifyManifestSignature({
      body: mainPart.body,
      expoSignatureHeader: mainPart.headers.get("expo-signature"),
      publicKeyOrCert: certPem,
    });
    if (!ok) {
      return yield* ReleaseError.make({
        message: "Live manifest signature failed verification against --certificate.",
      });
    }
  }
  let latestReleaseInfo: ReleaseInfo | null = null;
  if (values["check-release"]) {
    const relRes = yield* HttpClient.get(`${origin}/api/mobile/releases/latest`);
    if (relRes.status < 200 || relRes.status >= 300) {
      return yield* ReleaseError.make({
        message: `Release latest check failed with HTTP ${relRes.status}`,
      });
    }
    const releaseJson = yield* relRes.text;
    latestReleaseInfo = parseReleaseInfo(releaseJson);
  }

  writeStdout(
    prettyJson({
      ok: true,
      mode: "http",
      manifestUrl,
      partDisposition: mainPart.headers.get("content-disposition"),
      signatureVerified: values.certificate !== undefined,
      latestRelease: latestReleaseInfo,
    }),
  );
});

// --- Entrypoint ---

const main = Effect.fn("MobileRelease.main")(function* (argv: readonly string[]) {
  const [command, ...rest] = argv;
  if (!hasText(command) || command === "-h" || command === "--help" || command === "help") {
    writeStdout(HELP_TEXT);
    return 0;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    writeStdout(HELP_TEXT);
    return 0;
  }

  switch (command) {
    case "metadata":
      yield* cmdMetadata(rest);
      return 0;
    case "build":
      yield* cmdBuild(rest);
      return 0;
    case "publish-apk":
      yield* cmdPublishApk(rest);
      return 0;
    case "publish-ota":
      yield* cmdPublishOta(rest);
      return 0;
    case "rollback":
      yield* cmdRollback(rest);
      return 0;
    case "verify":
      yield* cmdVerify(rest);
      return 0;
    default:
      writeStderr(`Unknown command: ${command}\n\n${HELP_TEXT}`);
      return 1;
  }
});

if (import.meta.main) {
  const program = main(Arr.drop(process.argv, 2)).pipe(
    Effect.scoped,
    Effect.matchCause({
      onSuccess: (code) => {
        process.exitCode = code;
      },
      onFailure: (cause) => {
        const error = Cause.squash(cause);
        writeStderr(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    }),
  );
  BunRuntime.runMain(
    program.pipe(
      Effect.provide([BunServices.layer, FetchHttpClient.layer, SecureRandom.layerWebCrypto]),
    ),
  );
}
