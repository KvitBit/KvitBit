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

import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
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

export const releaseTagVersion = (tag: string): string => {
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

export const normalizeCertificateSha256 = (digest: string): string => {
  const hex = digest.replaceAll(":", "").toLowerCase();
  if (!SHA256_HEX_RE.test(hex)) {
    throw new Error(`${JSON.stringify(digest)} is not a SHA-256 digest.`);
  }
  return hex;
};

export const formatCertificateSha256 = (digest: string): string =>
  (normalizeCertificateSha256(digest).match(/../g) ?? []).join(":").toUpperCase();

export const parseApkSignerDigests = (apksignerOutput: string): string[] =>
  apksignerOutput
    .split("\n")
    .map((line) => SIGNER_DIGEST_RE.exec(line.trim())?.[1])
    .filter((digest): digest is string => digest !== undefined)
    .map(normalizeCertificateSha256);

export const parseApkBadgingIdentity = (
  badging: string,
): { readonly packageName: string; readonly versionCode: number; readonly versionName: string } => {
  const line = badging.split("\n").find((entry) => entry.startsWith("package:"));
  const attr = (name: string) =>
    line ? new RegExp(`\\b${name}='([^']*)'`).exec(line)?.[1] : undefined;
  const packageName = attr("name");
  const versionCode = attr("versionCode");
  const versionName = attr("versionName");
  if (!packageName || !versionCode || !versionName) {
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
  const raw = await readFile(join(projectDir, "app.json"), "utf8");
  const parsed = JSON.parse(raw) as { expo?: Record<string, unknown> };
  const expo = parsed.expo;
  if (!expo || typeof expo.version !== "string") {
    throw new Error(`Missing expo.version in ${join(projectDir, "app.json")}`);
  }
  const version = expo.version;
  const versionCode = androidVersionCode(version);
  if (tag && tag.trim().length > 0) {
    const tagVer = releaseTagVersion(tag.trim());
    if (tagVer !== version) {
      throw new Error(`Release tag ${tag} (${tagVer}) does not match app.json version ${version}.`);
    }
  }
  const android =
    typeof expo.android === "object" && expo.android !== null
      ? (expo.android as Record<string, unknown>)
      : {};
  const packageName =
    typeof android.package === "string" ? android.package : KVITBIT_ANDROID_PACKAGE;
  let minAndroidSdk = DEFAULT_MIN_ANDROID_SDK;
  if (Array.isArray(expo.plugins)) {
    for (const plugin of expo.plugins) {
      if (
        Array.isArray(plugin) &&
        plugin[0] === "expo-build-properties" &&
        typeof plugin[1] === "object" &&
        plugin[1] !== null
      ) {
        const cfg = plugin[1] as { android?: { minSdkVersion?: unknown } };
        if (typeof cfg.android?.minSdkVersion === "number") {
          minAndroidSdk = cfg.android.minSdkVersion;
        }
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
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: options.env ?? process.env,
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
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

const resolveStorageTarget = (
  storageDirArg: string | undefined,
  bucketArg: string | undefined,
  dryRun: boolean,
): StorageTarget => {
  const dir = storageDirArg?.trim() || readEnv("KVITBIT_MOBILE_STORAGE_DIR");
  const bucket = bucketArg?.trim() || readEnv("KVITBIT_MOBILE_STORAGE_BUCKET");
  if (dir && bucket) {
    throw new Error("Specify either --storage-dir or --bucket, not both.");
  }
  if (dir) return { kind: "dir", root: resolve(dir) };
  if (bucket) return { kind: "gcs", bucket };
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
    try {
      const handle = await open(
        fullPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o644,
      );
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return "written";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && options.allowExisting) {
        return "exists";
      }
      throw new Error(
        `Object ${key} already exists (create-only storage refuses overwrite): ${String(err)}`,
      );
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
    if (options.cacheControl) {
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

interface ExpoExportMetadata {
  readonly fileMetadata: Readonly<
    Record<
      string,
      {
        readonly bundle: string;
        readonly assets: readonly { readonly path: string; readonly ext: string }[];
      }
    >
  >;
}

const readExpoExport = async (
  exportDir: string,
  platform: MobilePlatform,
): Promise<{
  readonly launchAsset: ExportedAssetFile;
  readonly assets: readonly ExportedAssetFile[];
}> => {
  const metaRaw = await readFile(join(exportDir, "metadata.json"), "utf8");
  const parsed = JSON.parse(metaRaw) as ExpoExportMetadata;
  const platformFiles = parsed.fileMetadata?.[platform];
  if (!platformFiles) {
    throw new Error(`Export directory ${exportDir} has no ${platform} bundle in metadata.json`);
  }
  const bundleBytes = new Uint8Array(await readFile(join(exportDir, platformFiles.bundle)));
  const launchAsset = describeAssetBytes(bundleBytes, "application/javascript");
  const assets: ExportedAssetFile[] = [];
  for (const item of platformFiles.assets) {
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
  const outDir = values["out-dir"] ? resolve(values["out-dir"]) : join(projectDir, "dist/release");
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

  if (values.signing === "release") {
    if (!readEnv("ANDROID_KEYSTORE_BASE64") || !readEnv("ANDROID_KEYSTORE_PASSWORD")) {
      throw new Error(
        "Release build requires ANDROID_KEYSTORE_BASE64 and ANDROID_KEYSTORE_PASSWORD (or pass --signing debug / --dry-run).",
      );
    }
  }

  await mkdir(outDir, { recursive: true });
  const prebuild = await runProcess(
    [
      process.execPath,
      "x",
      "--no-install",
      "expo",
      "prebuild",
      "--platform",
      "android",
      "--non-interactive",
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_API_ORIGIN: values.origin,
        MOBILE_UPDATES_CODE_SIGNING: values.signing === "release" ? "required" : "",
      },
    },
  );
  if (prebuild.exitCode !== 0) {
    throw new Error(`expo prebuild failed:\n${prebuild.stderr}`);
  }

  const androidDir = join(projectDir, "android");
  const gradleTask = values.signing === "release" ? "assembleRelease" : "assembleDebug";
  const gradle = await runProcess(["./gradlew", gradleTask, "--no-daemon"], { cwd: androidDir });
  if (gradle.exitCode !== 0) {
    throw new Error(`Gradle ${gradleTask} failed:\n${gradle.stderr}`);
  }

  const builtApk = join(
    androidDir,
    "app/build/outputs/apk",
    values.signing === "release" ? "release/app-release.apk" : "debug/app-debug.apk",
  );
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
        sizeBytes: apkBytes.byteLength,
      },
      null,
      2,
    ),
  );
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

  let apkBytes: Uint8Array | undefined;
  let apkSha256: string;
  let sizeBytes: number;

  if (values.apk) {
    const apkPath = resolve(values.apk);
    apkBytes = new Uint8Array(await readFile(apkPath));
    apkSha256 = createHash("sha256").update(apkBytes).digest("hex");
    sizeBytes = apkBytes.byteLength;
  } else if (dryRun) {
    apkSha256 = "0".repeat(64);
    sizeBytes = 0;
  } else {
    throw new Error("publish-apk requires --apk <path> (or --dry-run).");
  }

  const rawCertSha =
    values["signing-cert-sha256"] ?? readEnv("KVITBIT_ANDROID_SIGNING_CERT_SHA256");
  const signingCertSha256 = rawCertSha
    ? formatCertificateSha256(rawCertSha)
    : dryRun
      ? formatCertificateSha256("0".repeat(64))
      : (() => {
          throw new Error(
            "publish-apk requires --signing-cert-sha256 or KVITBIT_ANDROID_SIGNING_CERT_SHA256.",
          );
        })();

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

  if (!apkBytes) {
    throw new Error("Missing APK bytes.");
  }

  await writeCreateOnly(target, apkKey, apkBytes, {
    contentType: APK_CONTENT_TYPE,
    cacheControl: ASSET_CACHE_CONTROL,
    allowExisting: false,
  });
  await writeCreateOnly(
    target,
    infoKey,
    new TextEncoder().encode(`${JSON.stringify(releaseInfo, null, 2)}\n`),
    {
      contentType: "application/json; charset=utf-8",
      allowExisting: false,
    },
  );

  writeStdout(
    JSON.stringify(
      {
        command: "publish-apk",
        target,
        apkKey,
        infoKey,
        releaseInfo,
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
): Promise<string> => {
  const result = await runProcess(
    [
      process.execPath,
      "x",
      "--no-install",
      "expo-updates",
      "runtimeversion:resolve",
      "--platform",
      platform,
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_API_ORIGIN: origin,
      },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `expo-updates runtimeversion:resolve failed for ${platform}:\n${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { runtimeVersion?: unknown };
  if (typeof parsed.runtimeVersion !== "string" || parsed.runtimeVersion.length === 0) {
    throw new Error(`Unexpected runtimeversion:resolve output: ${result.stdout}`);
  }
  return assertRuntimeVersion(parsed.runtimeVersion);
};

const parsePlatforms = (raw: readonly string[] | undefined): readonly MobilePlatform[] => {
  const input = raw && raw.length > 0 ? raw : ["android"];
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

  let exportDir = values["export-dir"] ? resolve(values["export-dir"]) : undefined;
  let tempExportDir: string | undefined;

  if (!exportDir && !dryRun) {
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
    const exported = await runProcess(exportArgs, {
      cwd: projectDir,
      env: { ...process.env, EXPO_PUBLIC_API_ORIGIN: values.origin },
    });
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

    for (const platform of platforms) {
      const runtimeVersion = values["runtime-version"]
        ? assertRuntimeVersion(values["runtime-version"])
        : dryRun
          ? `dry-run-${meta.version}`
          : await resolveRuntimeVersionFromExpo(projectDir, platform, values.origin);

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const pubKey = publicationObjectKey({ channel, platform, runtimeVersion, createdAt, id });

      if (!exportDir) {
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
    if (tempExportDir) {
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
  const runtimeVersion = values["runtime-version"]
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
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
  const storageDir = values["storage-dir"]?.trim() || readEnv("KVITBIT_MOBILE_STORAGE_DIR");

  if (storageDir) {
    const root = resolve(storageDir);
    const checks: Record<string, unknown> = { mode: "storage-dir", root, dryRun };

    if (values["runtime-version"]) {
      const runtimeVersion = assertRuntimeVersion(values["runtime-version"]);
      const prefix = publicationPrefix({ channel, platform, runtimeVersion });
      const keys = await listLocalKeys(root, prefix);
      const latestKey = latestPublicationKey(keys);
      const latest = latestKey
        ? parsePublication(await readFile(join(root, latestKey), "utf8"))
        : null;

      if (latest?.type === "update") {
        for (const asset of [latest.launchAsset, ...latest.assets]) {
          const assetBytes = new Uint8Array(
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

      let signingKeyPem = values["signing-key"]
        ? await readFile(resolve(values["signing-key"]), "utf8")
        : readEnv("KVITBIT_MOBILE_UPDATES_SIGNING_KEY");
      let verifyCertPem = values.certificate
        ? await readFile(resolve(values.certificate), "utf8")
        : undefined;

      if (!signingKeyPem && !verifyCertPem) {
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
      const parts = parseMultipartMixed(response.headers["content-type"] ?? "", response.body);
      const mainPart = parts?.[0];
      if (!mainPart) {
        throw new Error("Multipart response had no main part.");
      }
      if (verifyCertPem) {
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
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const releases: ReleaseInfo[] = [];
      for (const ver of versionDirs) {
        const infoPath = join(root, releaseInfoObjectKey(ver));
        const infoStat = await stat(infoPath).catch(() => null);
        if (!infoStat?.isFile()) continue;
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
          manifestUrl: `${values.origin.replace(/\/+$/, "")}/api/mobile/updates/manifest`,
          releaseUrl: values["check-release"]
            ? `${values.origin.replace(/\/+$/, "")}/api/mobile/releases/latest`
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

  const runtimeVersion = values["runtime-version"]
    ? assertRuntimeVersion(values["runtime-version"])
    : (() => {
        throw new Error("HTTP verify requires --runtime-version <version> (or --storage-dir).");
      })();

  const manifestUrl = `${values.origin.replace(/\/+$/, "")}/api/mobile/updates/manifest`;
  const headers: Record<string, string> = {
    "expo-protocol-version": "1",
    "expo-platform": platform,
    "expo-runtime-version": runtimeVersion,
    "expo-channel-name": channel,
    accept: "multipart/mixed",
  };
  if (values.certificate) {
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
  if (!mainPart) {
    throw new Error(`Invalid multipart/mixed manifest response from ${manifestUrl}`);
  }
  if (values.certificate) {
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
    const relRes = await fetch(`${values.origin.replace(/\/+$/, "")}/api/mobile/releases/latest`);
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

export const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
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
