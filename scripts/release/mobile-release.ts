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

// The standalone Bun CLI uses native promises, subprocesses, and data formats.
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferEffectArray:off
// @effect-diagnostics preferEffectRecord:off
// @effect-diagnostics preferEffectString:off
import { createHash, generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  type StoredRollback,
  type StoredUpdate,
  type StoredUpdateAsset,
} from "../../apps/mobile/release/storage-layout";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MOBILE_DIR = join(REPO_ROOT, "apps/mobile");
const DEFAULT_ORIGIN = "https://kvitbit.cz";
const DEFAULT_MIN_ANDROID_SDK = 28;
const RELEASE_TAG_PREFIX = "mobile-v";
const TRAILING_SLASHES = /\/+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasText = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

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
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
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
  if (!tag.startsWith(RELEASE_TAG_PREFIX)) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must start with ${RELEASE_TAG_PREFIX}.`);
  }
  const version = tag.slice(RELEASE_TAG_PREFIX.length);
  parseAppVersion(version);
  return version;
};

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SIGNER_DIGEST_RE =
  /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer(?: #\d+)?:) certificate SHA-256 digest: ([0-9a-fA-F]+)$/;

const normalizeCertificateSha256 = (digest: string): string => {
  const hex = digest.replaceAll(":", "").toLowerCase();
  if (!SHA256_HEX_RE.test(hex)) {
    throw new Error(`${JSON.stringify(digest)} is not a SHA-256 digest.`);
  }
  return hex;
};

const formatCertificateSha256 = (digest: string): string =>
  (normalizeCertificateSha256(digest).match(/../g) ?? []).join(":").toUpperCase();

const parseApkSignerDigests = (apksignerOutput: string): string[] =>
  apksignerOutput
    .split("\n")
    .map((line) => SIGNER_DIGEST_RE.exec(line.trim())?.[1])
    .filter((digest): digest is string => digest !== undefined)
    .map(normalizeCertificateSha256);

const findAndroidBuildTool = (tool: "apksigner" | "aapt2"): string | undefined => {
  const sdk = readEnv("ANDROID_HOME") ?? readEnv("ANDROID_SDK_ROOT");
  if (sdk !== undefined) {
    const buildToolsDir = join(sdk, "build-tools");
    if (existsSync(buildToolsDir)) {
      const versions = readdirSync(buildToolsDir)
        .filter((version) => existsSync(join(buildToolsDir, version, tool)))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      const newest = versions[0];
      if (newest !== undefined) return join(buildToolsDir, newest, tool);
    }
  }
  return Bun.which(tool) ?? undefined;
};

const inspectApkSignerSha256s = async (apkPath: string): Promise<string[]> => {
  const apksigner = findAndroidBuildTool("apksigner");
  if (apksigner === undefined)
    throw new Error("Android build-tools apksigner is required to verify APKs.");
  const res = await runProcess([apksigner, "verify", "--print-certs", apkPath]);
  if (res.exitCode !== 0) {
    throw new Error(`apksigner verification failed for ${apkPath}:\n${res.stderr || res.stdout}`);
  }
  const digests = parseApkSignerDigests(res.stdout);
  if (digests.length === 0) {
    throw new Error(`apksigner reported no signer certificates for ${apkPath}.`);
  }
  return digests;
};

const verifyApkArtifact = async (
  apkPath: string,
  expected: {
    readonly packageName: string;
    readonly versionCode: number;
    readonly versionName: string;
    readonly expectedSignerSha256: string | undefined;
  },
): Promise<{ readonly signingCertSha256: string }> => {
  const signers = await inspectApkSignerSha256s(apkPath);
  const uniqueSigners = [...new Set(signers)];
  if (uniqueSigners.length !== 1) {
    throw new Error(`APK ${apkPath} must have exactly one current signer.`);
  }
  if (hasText(expected.expectedSignerSha256)) {
    const expectedHex = normalizeCertificateSha256(expected.expectedSignerSha256);
    const unexpected = uniqueSigners.filter((digest) => digest !== expectedHex);
    if (unexpected.length > 0) {
      throw new Error(
        `APK signer certificate ${unexpected.map(formatCertificateSha256).join(", ")} does not match expected ${formatCertificateSha256(expectedHex)}.`,
      );
    }
  }
  const primarySigner = uniqueSigners[0];
  if (primarySigner === undefined) {
    throw new Error(`APK ${apkPath} has no signer certificate.`);
  }

  const aapt2 = findAndroidBuildTool("aapt2");
  if (aapt2 === undefined)
    throw new Error("Android build-tools aapt2 is required to verify APK identity.");
  const badging = await runProcess([aapt2, "dump", "badging", apkPath]);
  if (badging.exitCode !== 0) {
    throw new Error(`aapt2 dump badging failed for ${apkPath}:\n${badging.stderr}`);
  }
  const actual = parseApkBadgingIdentity(badging.stdout);
  if (
    actual.packageName !== expected.packageName ||
    actual.versionCode !== expected.versionCode ||
    actual.versionName !== expected.versionName
  ) {
    throw new Error(
      `APK identity mismatch: got ${actual.packageName} (${actual.versionName} / ${actual.versionCode}), expected ${expected.packageName} (${expected.versionName} / ${expected.versionCode}).`,
    );
  }

  return { signingCertSha256: formatCertificateSha256(primarySigner) };
};

const withOtaCodeSigningEnv = async <T>(
  projectDir: string,
  env: Record<string, string | undefined>,
  fn: (resolvedEnv: Record<string, string | undefined>) => Promise<T>,
): Promise<T> => {
  const pemContent = env.MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE_PEM?.trim();
  if (!hasText(pemContent)) {
    return fn(env);
  }
  const certificate = new X509Certificate(pemContent);
  // Expo uses a project-relative path. The same certificate must have the same
  // path in the APK build and in the OTA job's independent checkout.
  const fileName = `${certificate.fingerprint256.replaceAll(":", "").toLowerCase()}.pem`;
  const certPath = join(projectDir, ".expo", "release-signing", fileName);
  await Bun.write(certPath, `${certificate.toString().trim()}\n`, { createPath: true });
  return fn({
    ...env,
    MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: certPath,
  });
};

const parseApkBadgingIdentity = (
  badging: string,
): { readonly packageName: string; readonly versionCode: number; readonly versionName: string } => {
  const line = badging.split("\n").find((entry) => entry.startsWith("package:"));
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

interface AppJsonMeta {
  readonly version: string;
  readonly versionCode: number;
  readonly packageName: string;
  readonly minAndroidSdk: number;
  readonly apkName: string;
  readonly expoConfig: Record<string, unknown>;
}

const readAppMeta = async (projectDir: string, tag?: string): Promise<AppJsonMeta> => {
  const path = join(projectDir, "app.json");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const expo = isRecord(parsed) ? parsed.expo : undefined;
  if (!isRecord(expo) || typeof expo.version !== "string") {
    throw new Error(`Missing expo.version in ${path}`);
  }
  const version = expo.version;
  const versionCode = androidVersionCode(version);
  const trimmedTag = tag?.trim();
  if (hasText(trimmedTag)) {
    const tagVer = releaseTagVersion(trimmedTag);
    if (tagVer !== version) {
      throw new Error(`Release tag ${tag} (${tagVer}) does not match app.json version ${version}.`);
    }
  }
  const android = isRecord(expo.android) ? expo.android : {};
  const packageName =
    typeof android.package === "string" ? android.package : KVITBIT_ANDROID_PACKAGE;
  let minAndroidSdk = DEFAULT_MIN_ANDROID_SDK;
  if (Array.isArray(expo.plugins)) {
    const plugins: readonly unknown[] = expo.plugins;
    for (const plugin of plugins) {
      if (!Array.isArray(plugin)) continue;
      const [name, config]: readonly unknown[] = plugin;
      if (name === "expo-build-properties" && isRecord(config) && isRecord(config.android)) {
        const { minSdkVersion } = config.android;
        if (typeof minSdkVersion === "number") minAndroidSdk = minSdkVersion;
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
};

// --- Subprocess runner ---

const runProcess = async (
  cmd: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const { cwd } = options;
  const proc = Bun.spawn([...cmd], {
    ...(cwd === undefined ? {} : { cwd }),
    env: options.env ?? Bun.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

// --- Storage backend (create-only: local disk `wx` or GCS `--if-generation-match=0`) ---

type StorageTarget =
  | { readonly kind: "dir"; readonly root: string }
  | { readonly kind: "gcs"; readonly bucket: string }
  | { readonly kind: "none" };

const readEnv = (name: string): string | undefined => {
  const value = Bun.env[name]?.trim();
  return hasText(value) ? value : undefined;
};

const resolveStorageTarget = (
  storageDirArg: string | undefined,
  bucketArg: string | undefined,
  dryRun: boolean,
): StorageTarget => {
  const trimmedDirArg = storageDirArg?.trim();
  const trimmedBucketArg = bucketArg?.trim();
  const dir = hasText(trimmedDirArg) ? trimmedDirArg : readEnv("KVITBIT_MOBILE_STORAGE_DIR");
  const bucket = hasText(trimmedBucketArg)
    ? trimmedBucketArg
    : readEnv("KVITBIT_MOBILE_STORAGE_BUCKET");
  if (dir !== undefined && bucket !== undefined) {
    throw new Error("Specify either --storage-dir or --bucket, not both.");
  }
  if (dir !== undefined) return { kind: "dir", root: resolve(dir) };
  if (bucket !== undefined) return { kind: "gcs", bucket };
  if (dryRun) return { kind: "none" };
  throw new Error(
    "No storage target configured. Pass --storage-dir (KVITBIT_MOBILE_STORAGE_DIR) or --bucket (KVITBIT_MOBILE_STORAGE_BUCKET), or use --dry-run.",
  );
};

const writeCreateOnly = async (
  target: StorageTarget,
  key: string,
  bytes: Uint8Array,
  options: {
    readonly contentType: string;
    readonly cacheControl?: string;
    readonly allowExisting: boolean;
  },
): Promise<"written" | "exists"> => {
  if (target.kind === "none") {
    throw new Error("Cannot write without a storage target.");
  }
  if (target.kind === "dir") {
    const fullPath = join(target.root, key);
    await mkdir(dirname(fullPath), { recursive: true });
    const stagingDir = await mkdtemp(join(dirname(fullPath), ".staging-"));
    const stagedPath = join(stagingDir, "payload");
    try {
      await Bun.write(stagedPath, bytes);
      // Same-filesystem link publishes the complete file atomically and fails if it exists.
      await link(stagedPath, fullPath);
      return "written";
    } catch (err) {
      if (!hasErrorCode(err, "EEXIST")) throw err;
      if (options.allowExisting) return "exists";
      throw new Error(`Object ${key} already exists (create-only storage refuses overwrite).`, {
        cause: err,
      });
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  // GCS via gcloud storage cp --if-generation-match=0
  const tempDir = await mkdtemp(join(tmpdir(), "kvitbit-gcs-"));
  const tempFile = join(tempDir, "payload");
  try {
    await Bun.write(tempFile, bytes);
    const args = [
      "gcloud",
      "storage",
      "cp",
      "--if-generation-match=0",
      `--content-type=${options.contentType}`,
    ];
    if (hasText(options.cacheControl)) {
      args.push(`--cache-control=${options.cacheControl}`);
    }
    args.push(tempFile, `gs://${target.bucket}/${key}`);
    const result = await runProcess(args);
    if (result.exitCode === 0) return "written";
    if (
      options.allowExisting &&
      (result.stderr.includes("PreconditionException") ||
        result.stderr.includes("412") ||
        result.stderr.includes("conditionNotMet"))
    ) {
      return "exists";
    }
    throw new Error(`gcloud storage cp failed for ${key}: ${result.stderr.trim()}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const readStorageObject = async (target: StorageTarget, key: string): Promise<Uint8Array> => {
  if (target.kind === "none") {
    throw new Error("Cannot read without a storage target.");
  }
  if (target.kind === "dir") {
    return new Uint8Array(await readFile(join(target.root, key)));
  }
  const tempDir = await mkdtemp(join(tmpdir(), "kvitbit-gcs-read-"));
  const tempFile = join(tempDir, "payload");
  try {
    const result = await runProcess([
      "gcloud",
      "storage",
      "cp",
      `gs://${target.bucket}/${key}`,
      tempFile,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gcloud storage cp failed reading ${key}: ${result.stderr.trim()}`);
    }
    return new Uint8Array(await readFile(tempFile));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

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
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  const hashBase64Url = createHash("sha256").update(bytes).digest("base64url");
  const keyMd5 = createHash("md5").update(bytes).digest("hex");
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

const readExpoExport = async (
  exportDir: string,
  platform: MobilePlatform,
): Promise<{
  readonly launchAsset: ExportedAssetFile;
  readonly assets: readonly ExportedAssetFile[];
}> => {
  const metaRaw = await readFile(join(exportDir, "metadata.json"), "utf8");
  const parsed: unknown = JSON.parse(metaRaw);
  const fileMetadata = isRecord(parsed) ? parsed.fileMetadata : undefined;
  const platformFiles = isRecord(fileMetadata) ? fileMetadata[platform] : undefined;
  if (!isRecord(platformFiles) || typeof platformFiles.bundle !== "string") {
    throw new Error(`Export directory ${exportDir} has no ${platform} bundle in metadata.json`);
  }
  const bundleBytes = new Uint8Array(await readFile(join(exportDir, platformFiles.bundle)));
  const launchAsset = describeAssetBytes(bundleBytes, "application/javascript");
  if (!Array.isArray(platformFiles.assets)) {
    throw new Error(
      `Export directory ${exportDir} has no ${platform} assets array in metadata.json`,
    );
  }
  const assets: ExportedAssetFile[] = [];
  const assetMetadata: readonly unknown[] = platformFiles.assets;
  for (const item of assetMetadata) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.ext !== "string") {
      throw new Error(`Invalid ${platform} asset in ${exportDir}/metadata.json`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Keep file reads bounded for large Expo exports.
    const bytes = new Uint8Array(await readFile(join(exportDir, item.path)));
    const ext = item.ext.toLowerCase();
    const contentType = ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream";
    assets.push(describeAssetBytes(bytes, contentType, `.${item.ext}`));
  }
  return { launchAsset, assets };
};

// --- Subcommands ---

const cmdMetadata = async (argv: readonly string[]): Promise<void> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: DEFAULT_MOBILE_DIR },
      tag: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const meta = await readAppMeta(resolve(values.project), values.tag);
  if (values.json) {
    writeStdout(
      JSON.stringify(
        {
          version: meta.version,
          versionCode: meta.versionCode,
          packageName: meta.packageName,
          minAndroidSdk: meta.minAndroidSdk,
          apkName: meta.apkName,
        },
        null,
        2,
      ),
    );
    return;
  }
  writeStdout(`version=${meta.version}`);
  writeStdout(`version-code=${meta.versionCode}`);
  writeStdout(`apk-name=${meta.apkName}`);
  writeStdout(`package-name=${meta.packageName}`);
};

const cmdBuild = async (argv: readonly string[]): Promise<void> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: DEFAULT_MOBILE_DIR },
      tag: { type: "string" },
      signing: { type: "string", default: "release" },
      origin: { type: "string", default: DEFAULT_ORIGIN },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (values.signing !== "release" && values.signing !== "debug") {
    throw new Error(
      `--signing must be "release" or "debug", got ${JSON.stringify(values.signing)}`,
    );
  }
  const projectDir = resolve(values.project);
  const meta = await readAppMeta(projectDir, values.tag);
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
    writeStdout(JSON.stringify(plan, null, 2));
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
    throw new Error(
      "Release build requires ANDROID_KEYSTORE_PASSWORD and ANDROID_KEYSTORE_BASE64 (or ANDROID_KEYSTORE_PATH), or pass --signing debug / --dry-run.",
    );
  }

  await mkdir(outDir, { recursive: true });
  let tempKeystoreDir: string | undefined;
  let resolvedKeystorePath = keystorePathEnv === undefined ? undefined : resolve(keystorePathEnv);
  try {
    if (values.signing === "release" && keystoreBase64 !== undefined) {
      tempKeystoreDir = await mkdtemp(join(tmpdir(), "kvitbit-android-keystore-"));
      resolvedKeystorePath = join(tempKeystoreDir, "release.keystore");
      await Bun.write(resolvedKeystorePath, Buffer.from(keystoreBase64, "base64"));
      await chmod(resolvedKeystorePath, 0o600);
    }

    const baseBuildEnv: Record<string, string | undefined> = {
      ...Bun.env,
      EXPO_PUBLIC_API_ORIGIN: values.origin,
      MOBILE_UPDATES_CODE_SIGNING: values.signing === "release" ? "required" : "",
      EXPO_UPDATES_WORKFLOW_OVERRIDE: "managed",
    };

    const androidDir = join(projectDir, "android");
    await withOtaCodeSigningEnv(projectDir, baseBuildEnv, async (prebuildEnv) => {
      const prebuild = await runProcess(
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
        throw new Error(`expo prebuild failed:\n${prebuild.stderr}`);
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
      const gradle = await runProcess(["./gradlew", gradleTask, "--no-daemon", "--console=plain"], {
        cwd: androidDir,
        env: gradleEnv,
      });
      if (gradle.exitCode !== 0) {
        throw new Error(
          `Gradle ${gradleTask} failed:\n${gradle.stderr}\n${gradle.stdout.slice(-8000)}`,
        );
      }
    });

    const builtApk = join(
      androidDir,
      "app/build/outputs/apk",
      values.signing === "release" ? "release/app-release.apk" : "debug/app-debug.apk",
    );
    const verified = await verifyApkArtifact(builtApk, {
      packageName: meta.packageName,
      versionCode: meta.versionCode,
      versionName: meta.version,
      expectedSignerSha256:
        values.signing === "release" ? readEnv("KVITBIT_ANDROID_SIGNING_CERT_SHA256") : undefined,
    });

    const apkBytes = new Uint8Array(await readFile(builtApk));
    await Bun.write(apkOutPath, apkBytes);

    const apkSha256 = createHash("sha256").update(apkBytes).digest("hex");
    writeStdout(
      JSON.stringify(
        {
          command: "build",
          version: meta.version,
          versionCode: meta.versionCode,
          apkPath: apkOutPath,
          apkSha256,
          signingCertSha256: verified.signingCertSha256,
          sizeBytes: apkBytes.byteLength,
        },
        null,
        2,
      ),
    );
  } finally {
    if (tempKeystoreDir !== undefined) {
      await rm(tempKeystoreDir, { recursive: true, force: true });
    }
  }
};

const cmdPublishApk = async (argv: readonly string[]): Promise<void> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: DEFAULT_MOBILE_DIR },
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
  const meta = await readAppMeta(projectDir);
  const version = values.version ?? meta.version;
  const versionCode = androidVersionCode(version);
  const target = resolveStorageTarget(values["storage-dir"], values.bucket, dryRun);
  const releasedAt = values["released-at"] ?? new Date().toISOString();

  let apkPath: string | undefined;
  let apkBytes: Uint8Array | undefined;
  let apkSha256: string;
  let sizeBytes: number;

  if (hasText(values.apk)) {
    apkPath = resolve(values.apk);
    apkBytes = new Uint8Array(await readFile(apkPath));
    apkSha256 = createHash("sha256").update(apkBytes).digest("hex");
    sizeBytes = apkBytes.byteLength;
  } else if (dryRun) {
    apkSha256 = "0".repeat(64);
    sizeBytes = 0;
  } else {
    throw new Error("publish-apk requires --apk <path> (or --dry-run).");
  }

  const expectedCertSha =
    values["signing-cert-sha256"] ?? readEnv("KVITBIT_ANDROID_SIGNING_CERT_SHA256");

  let signingCertSha256: string;
  if (apkPath !== undefined && apkBytes !== undefined) {
    const staging = await mkdtemp(join(tmpdir(), "kvitbit-apk-verify-"));
    const snapshot = join(staging, "candidate.apk");
    try {
      await Bun.write(snapshot, apkBytes);
      const verified = await verifyApkArtifact(snapshot, {
        packageName: meta.packageName,
        versionCode,
        versionName: version,
        expectedSignerSha256: expectedCertSha,
      });
      signingCertSha256 = verified.signingCertSha256;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else if (dryRun) {
    signingCertSha256 = hasText(expectedCertSha)
      ? formatCertificateSha256(expectedCertSha)
      : formatCertificateSha256("0".repeat(64));
  } else {
    throw new Error("Missing APK path.");
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
      JSON.stringify(
        {
          dryRun: true,
          command: "publish-apk",
          target,
          objects: [apkKey, infoKey],
          releaseInfo,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (apkBytes === undefined) {
    throw new Error("Missing APK bytes.");
  }

  const apkOutcome = await writeCreateOnly(target, apkKey, apkBytes, {
    contentType: APK_CONTENT_TYPE,
    cacheControl: ASSET_CACHE_CONTROL,
    allowExisting: true,
  });
  if (apkOutcome === "exists") {
    const existingBytes = await readStorageObject(target, apkKey);
    const existingSha = createHash("sha256").update(existingBytes).digest("hex");
    if (existingSha !== apkSha256 || existingBytes.byteLength !== apkBytes.byteLength) {
      throw new Error(
        `Object ${apkKey} already exists with different bytes (existing sha256=${existingSha}, local sha256=${apkSha256}); create-only storage refuses overwrite.`,
      );
    }
  }
  const infoOutcome = await writeCreateOnly(
    target,
    infoKey,
    new TextEncoder().encode(`${JSON.stringify(releaseInfo, null, 2)}\n`),
    {
      contentType: "application/json; charset=utf-8",
      allowExisting: true,
    },
  );

  let publishedReleaseInfo = releaseInfo;
  if (infoOutcome === "exists") {
    const existing = parseReleaseInfo(
      new TextDecoder().decode(await readStorageObject(target, infoKey)),
    );
    const existingFields: Readonly<Record<string, unknown>> = existing;
    const compatible = Object.entries(releaseInfo).every(
      ([key, value]) =>
        (key === "releasedAt" && values["released-at"] === undefined) ||
        existingFields[key] === value,
    );
    if (!compatible) {
      throw new Error(`Object ${infoKey} already exists with different release metadata.`);
    }
    publishedReleaseInfo = existing;
  }

  writeStdout(
    JSON.stringify(
      {
        command: "publish-apk",
        target,
        apkKey,
        infoKey,
        releaseInfo: publishedReleaseInfo,
      },
      null,
      2,
    ),
  );
};

const resolveRuntimeVersionFromExpo = async (
  projectDir: string,
  platform: MobilePlatform,
  origin: string,
): Promise<string> =>
  withOtaCodeSigningEnv(
    projectDir,
    {
      ...Bun.env,
      EXPO_PUBLIC_API_ORIGIN: origin,
    },
    async (env) => {
      const result = await runProcess(
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
        throw new Error(
          `expo-updates runtimeversion:resolve failed for ${platform}:\n${result.stderr}`,
        );
      }
      const parsed: unknown = JSON.parse(result.stdout);
      if (
        !isRecord(parsed) ||
        typeof parsed.runtimeVersion !== "string" ||
        parsed.runtimeVersion.length === 0
      ) {
        throw new Error(`Unexpected runtimeversion:resolve output: ${result.stdout}`);
      }
      return assertRuntimeVersion(parsed.runtimeVersion);
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
      throw new Error(`Invalid platform ${JSON.stringify(item)}; expected android, ios, or all.`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
};

const cmdPublishOta = async (argv: readonly string[]): Promise<void> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: "string", default: DEFAULT_MOBILE_DIR },
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
  const target = resolveStorageTarget(values["storage-dir"], values.bucket, dryRun);
  const meta = await readAppMeta(projectDir);

  let exportDir = hasText(values["export-dir"]) ? resolve(values["export-dir"]) : undefined;
  let tempExportDir: string | undefined;

  if (exportDir === undefined && !dryRun) {
    tempExportDir = await mkdtemp(join(tmpdir(), "kvitbit-ota-export-"));
    const exportArgs = [
      process.execPath,
      "x",
      "--no-install",
      "expo",
      "export",
      "--output-dir",
      tempExportDir,
      ...platforms.flatMap((p) => ["--platform", p]),
    ];
    const exported = await withOtaCodeSigningEnv(
      projectDir,
      { ...Bun.env, EXPO_PUBLIC_API_ORIGIN: values.origin },
      (env) => runProcess(exportArgs, { cwd: projectDir, env }),
    );
    if (exported.exitCode !== 0) {
      await rm(tempExportDir, { recursive: true, force: true });
      throw new Error(`expo export failed:\n${exported.stderr}`);
    }
    exportDir = tempExportDir;
  }

  try {
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
    for (const platform of platforms) {
      let runtimeVersion = explicitRuntime ?? `dry-run-${meta.version}`;
      if (explicitRuntime === undefined && !dryRun) {
        // biome-ignore lint/performance/noAwaitInLoops: Expo resolves each platform in the same project directory.
        runtimeVersion = await resolveRuntimeVersionFromExpo(projectDir, platform, values.origin);
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const pubKey = publicationObjectKey({ channel, platform, runtimeVersion, createdAt, id });

      if (exportDir === undefined) {
        published.push({ platform, runtimeVersion, publicationKey: pubKey, id, assetCount: 0 });
        continue;
      }

      const exported = await readExpoExport(exportDir, platform);
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
        assets: exported.assets.map((a) => a.asset),
        metadata: {},
        extra: { expoClient: meta.expoConfig },
      };

      if (!dryRun) {
        const seen = new Set<string>();
        for (const file of allFiles) {
          if (seen.has(file.sha256)) continue;
          seen.add(file.sha256);
          // biome-ignore lint/performance/noAwaitInLoops: Complete each asset upload before its metadata and publication.
          await writeCreateOnly(target, assetObjectKey(file.sha256), file.bytes, {
            contentType: file.meta.contentType,
            cacheControl: ASSET_CACHE_CONTROL,
            allowExisting: true,
          });
          await writeCreateOnly(
            target,
            assetMetaObjectKey(file.sha256),
            new TextEncoder().encode(`${JSON.stringify(file.meta)}\n`),
            {
              contentType: "application/json; charset=utf-8",
              allowExisting: true,
            },
          );
        }
        await writeCreateOnly(
          target,
          pubKey,
          new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
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
    }

    writeStdout(
      JSON.stringify(
        {
          dryRun,
          command: "publish-ota",
          channel,
          target,
          published,
        },
        null,
        2,
      ),
    );
  } finally {
    if (tempExportDir !== undefined) {
      await rm(tempExportDir, { recursive: true, force: true });
    }
  }
};

const cmdRollback = async (argv: readonly string[]): Promise<void> => {
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
  const target = resolveStorageTarget(values["storage-dir"], values.bucket, dryRun);

  const records: Array<{
    readonly platform: MobilePlatform;
    readonly publicationKey: string;
    readonly record: StoredRollback;
  }> = [];

  for (const platform of platforms) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
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
      // biome-ignore lint/performance/noAwaitInLoops: Keep the CLI's platform publication order and fail on the first write error.
      await writeCreateOnly(
        target,
        key,
        new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
        {
          contentType: "application/json; charset=utf-8",
          allowExisting: false,
        },
      );
    }
    records.push({ platform, publicationKey: key, record });
  }

  writeStdout(
    JSON.stringify(
      {
        dryRun,
        command: "rollback",
        channel,
        runtimeVersion,
        target,
        records,
      },
      null,
      2,
    ),
  );
};

const listLocalKeys = async (root: string, prefix: string): Promise<string[]> => {
  const dir = join(root, prefix);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return [];
    throw err;
  }
  return entries.map((name) => `${prefix}${name}`);
};

const cmdVerify = async (argv: readonly string[]): Promise<void> => {
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
    throw new Error(`Invalid platform: ${JSON.stringify(values.platform)}`);
  }
  const platform: MobilePlatform = values.platform;
  const storageDirArg = values["storage-dir"]?.trim();
  const storageDir = hasText(storageDirArg) ? storageDirArg : readEnv("KVITBIT_MOBILE_STORAGE_DIR");

  if (storageDir !== undefined) {
    const root = resolve(storageDir);
    const checks: Record<string, unknown> = { mode: "storage-dir", root, dryRun };

    if (hasText(values["runtime-version"])) {
      const runtimeVersion = assertRuntimeVersion(values["runtime-version"]);
      const prefix = publicationPrefix({ channel, platform, runtimeVersion });
      const keys = await listLocalKeys(root, prefix);
      const latestKey = latestPublicationKey(keys);
      const latest =
        latestKey !== undefined
          ? parsePublication(await readFile(join(root, latestKey), "utf8"))
          : null;

      if (latest?.type === "update") {
        for (const asset of [latest.launchAsset, ...latest.assets]) {
          const assetBytes = new Uint8Array(
            // biome-ignore lint/performance/noAwaitInLoops: Verify one asset at a time to bound file reads and memory use.
            await readFile(join(root, assetObjectKey(asset.sha256))),
          );
          const actualSha = createHash("sha256").update(assetBytes).digest("hex");
          if (actualSha !== asset.sha256) {
            throw new Error(`Asset hash mismatch for ${asset.sha256}: got ${actualSha}`);
          }
          const meta = parseAssetMeta(
            await readFile(join(root, assetMetaObjectKey(asset.sha256)), "utf8"),
          );
          if (meta.sha256 !== asset.sha256 || meta.size !== assetBytes.byteLength) {
            throw new Error(`Asset metadata mismatch for ${asset.sha256}`);
          }
        }
      }

      const req = readManifestRequest({
        "expo-protocol-version": "1",
        "expo-platform": platform,
        "expo-runtime-version": runtimeVersion,
        "expo-channel-name": channel,
        "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
        accept: "multipart/mixed",
      });
      if (req._tag !== "Request") {
        throw new Error(`Internal manifest request rejected: ${req.message}`);
      }

      let signingKeyPem = hasText(values["signing-key"])
        ? await readFile(resolve(values["signing-key"]), "utf8")
        : readEnv("KVITBIT_MOBILE_UPDATES_SIGNING_KEY");
      let verifyCertPem = hasText(values.certificate)
        ? await readFile(resolve(values.certificate), "utf8")
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
        throw new Error(`Manifest response failed: ${response.message}`);
      }
      const { "content-type": contentType = "" } = response.headers;
      const parts = parseMultipartMixed(contentType, response.body);
      const mainPart = parts?.[0];
      if (mainPart === undefined) {
        throw new Error("Multipart response had no main part.");
      }
      if (hasText(verifyCertPem)) {
        const sigOk = verifyManifestSignature(
          mainPart.body,
          mainPart.headers.get("expo-signature"),
          verifyCertPem,
        );
        if (!sigOk) {
          throw new Error("Manifest RSA-v1_5-SHA256 signature verification failed.");
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
      let versionDirs: string[] = [];
      try {
        versionDirs = await readdir(releaseDir);
      } catch (err) {
        if (!hasErrorCode(err, "ENOENT")) throw err;
      }
      const releases: ReleaseInfo[] = [];
      for (const ver of versionDirs) {
        const infoPath = join(root, releaseInfoObjectKey(ver));
        // biome-ignore lint/performance/noAwaitInLoops: Verify one release at a time to bound APK memory use.
        const infoStat = await stat(infoPath).catch(() => null);
        if (infoStat?.isFile() !== true) continue;
        const info = parseReleaseInfo(await readFile(infoPath, "utf8"));
        const apkPath = join(root, apkObjectKey(info.version));
        const apkBytes = new Uint8Array(await readFile(apkPath));
        const actualSha = createHash("sha256").update(apkBytes).digest("hex");
        if (actualSha !== info.apkSha256 || apkBytes.byteLength !== info.sizeBytes) {
          throw new Error(`APK integrity mismatch for ${info.version}`);
        }
        releases.push(info);
      }
      checks.latestRelease = latestRelease(releases) ?? null;
    }

    writeStdout(JSON.stringify({ ok: true, ...checks }, null, 2));
    return;
  }

  if (dryRun) {
    writeStdout(
      JSON.stringify(
        {
          dryRun: true,
          command: "verify",
          mode: "http",
          manifestUrl: `${values.origin.replace(TRAILING_SLASHES, "")}/api/mobile/updates/manifest`,
          releaseUrl: values["check-release"]
            ? `${values.origin.replace(TRAILING_SLASHES, "")}/api/mobile/releases/latest`
            : null,
          channel,
          platform,
          runtimeVersion: values["runtime-version"] ?? "<required>",
        },
        null,
        2,
      ),
    );
    return;
  }

  const runtimeVersion = hasText(values["runtime-version"])
    ? assertRuntimeVersion(values["runtime-version"])
    : (() => {
        throw new Error("HTTP verify requires --runtime-version <version> (or --storage-dir).");
      })();

  const manifestUrl = `${values.origin.replace(TRAILING_SLASHES, "")}/api/mobile/updates/manifest`;
  const headers: Record<string, string> = {
    "expo-protocol-version": "1",
    "expo-platform": platform,
    "expo-runtime-version": runtimeVersion,
    "expo-channel-name": channel,
    accept: "multipart/mixed",
  };
  if (hasText(values.certificate)) {
    headers["expo-expect-signature"] = 'sig, keyid="main", alg="rsa-v1_5-sha256"';
  }
  const res = await fetch(manifestUrl, { headers });
  if (!res.ok) {
    throw new Error(`Manifest request failed with HTTP ${res.status}: ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const parts = parseMultipartMixed(contentType, body);
  const mainPart = parts?.[0];
  if (mainPart === undefined) {
    throw new Error(`Invalid multipart/mixed manifest response from ${manifestUrl}`);
  }
  if (hasText(values.certificate)) {
    const certPem = await readFile(resolve(values.certificate), "utf8");
    const ok = verifyManifestSignature(
      mainPart.body,
      mainPart.headers.get("expo-signature"),
      certPem,
    );
    if (!ok) {
      throw new Error("Live manifest signature failed verification against --certificate.");
    }
  }
  let latestReleaseInfo: ReleaseInfo | null = null;
  if (values["check-release"]) {
    const relRes = await fetch(
      `${values.origin.replace(TRAILING_SLASHES, "")}/api/mobile/releases/latest`,
    );
    if (!relRes.ok) {
      throw new Error(`Release latest check failed with HTTP ${relRes.status}`);
    }
    latestReleaseInfo = parseReleaseInfo(await relRes.text());
  }

  writeStdout(
    JSON.stringify(
      {
        ok: true,
        mode: "http",
        manifestUrl,
        partDisposition: mainPart.headers.get("content-disposition"),
        signatureVerified: values.certificate !== undefined,
        latestRelease: latestReleaseInfo,
      },
      null,
      2,
    ),
  );
};

// --- Entrypoint ---

const main = async (argv: readonly string[]): Promise<number> => {
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
      await cmdMetadata(rest);
      return 0;
    case "build":
      await cmdBuild(rest);
      return 0;
    case "publish-apk":
      await cmdPublishApk(rest);
      return 0;
    case "publish-ota":
      await cmdPublishOta(rest);
      return 0;
    case "rollback":
      await cmdRollback(rest);
      return 0;
    case "verify":
      await cmdVerify(rest);
      return 0;
    default:
      writeStderr(`Unknown command: ${command}\n\n${HELP_TEXT}`);
      return 1;
  }
};

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      writeStderr(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
