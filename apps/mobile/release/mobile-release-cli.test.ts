import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import appConfig, { deriveAndroidVersionCode } from "../app.config";
import appJson from "../app.json";
import { apkObjectKey, releaseInfoObjectKey } from "./storage-layout";

const { applyAndroidReleaseSigning } = require("../plugins/with-android-release-signing.cjs") as {
  applyAndroidReleaseSigning: (contents: string) => string;
};

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_PATH = join(REPO_ROOT, "scripts/release/mobile-release.ts");

const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const findSdkFile = (directory: string, filename: string): string | undefined => {
  if (sdkRoot === undefined) return undefined;
  const root = join(sdkRoot, directory);
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((version) => join(root, version, filename))
    .find(existsSync);
};
const aapt2 = findSdkFile("build-tools", "aapt2");
const apksigner = findSdkFile("build-tools", "apksigner");
const androidJar = findSdkFile("platforms", "android.jar");
const hasApkTools =
  aapt2 !== undefined &&
  apksigner !== undefined &&
  androidJar !== undefined &&
  Bun.which("keytool") !== null;

const createSignedTestApk = async (
  workDir: string,
  fileName: string,
  packageName = appJson.expo.android.package,
): Promise<{ readonly apkPath: string; readonly certSha256: string }> => {
  const keystorePath = join(workDir, `${fileName}.keystore`);
  const manifest = join(workDir, "AndroidManifest.xml");
  const apkPath = join(workDir, fileName);
  if (!aapt2 || !apksigner || !androidJar)
    throw new Error("Android SDK is required for the APK test.");
  await Bun.write(
    manifest,
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}" android:versionCode="${deriveAndroidVersionCode(appJson.expo.version)}" android:versionName="${appJson.expo.version}"><uses-sdk android:minSdkVersion="24"/><application/></manifest>`,
  );

  const gen = Bun.spawnSync([
    "keytool",
    "-genkeypair",
    "-noprompt",
    "-keystore",
    keystorePath,
    "-storetype",
    "PKCS12",
    "-alias",
    "kvitbit-test",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "30",
    "-dname",
    "CN=Kvitbit Test",
    "-storepass",
    "testpass123",
    "-keypass",
    "testpass123",
  ]);
  if (gen.exitCode !== 0) throw new Error(gen.stderr.toString());

  const linkResult = Bun.spawnSync([
    aapt2,
    "link",
    "-I",
    androidJar,
    "--manifest",
    manifest,
    "-o",
    apkPath,
  ]);
  if (linkResult.exitCode !== 0) throw new Error(linkResult.stderr.toString());

  const signed = Bun.spawnSync([
    apksigner,
    "sign",
    "--ks",
    keystorePath,
    "--ks-key-alias",
    "kvitbit-test",
    "--ks-pass",
    "pass:testpass123",
    "--key-pass",
    "pass:testpass123",
    apkPath,
  ]);
  if (signed.exitCode !== 0) throw new Error(signed.stderr.toString());

  const cert = Bun.spawnSync([
    "keytool",
    "-exportcert",
    "-keystore",
    keystorePath,
    "-alias",
    "kvitbit-test",
    "-storepass",
    "testpass123",
  ]);
  if (cert.exitCode !== 0) throw new Error(cert.stderr.toString());
  const rawDigest = createHash("sha256").update(cert.stdout).digest("hex");
  const certSha256 = rawDigest.toUpperCase().match(/../g)?.join(":") ?? "";
  return { apkPath, certSha256 };
};

const runCli = async (
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn([process.execPath, "run", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
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

describe("app.config.ts", () => {
  test("layers updates.url, android.package, and versionCode over app.json", () => {
    const resolved = appConfig(
      {
        config: appJson.expo as never,
        projectRoot: resolve(import.meta.dir, ".."),
        staticConfigPath: null,
        packageJsonPath: null,
      },
      { EXPO_PUBLIC_API_ORIGIN: "https://preview.kvitbit.cz/" },
    );

    expect(resolved.android?.package).toBe("cz.kvitbit.app");
    expect(resolved.android?.versionCode).toBe(1000);
    expect(resolved.updates?.url).toBe("https://preview.kvitbit.cz/api/mobile/updates/manifest");
    expect(resolved.updates?.codeSigningCertificate).toBeUndefined();
  });

  test("adds codeSigningCertificate only when MOBILE_UPDATES_CODE_SIGNING=required", () => {
    const resolved = appConfig(
      {
        config: appJson.expo as never,
        projectRoot: resolve(import.meta.dir, ".."),
        staticConfigPath: null,
        packageJsonPath: null,
      },
      {
        MOBILE_UPDATES_CODE_SIGNING: "required",
        MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: join(
          import.meta.dir,
          "fixtures/ota-public-certificate.pem",
        ),
      },
    );
    expect(resolved.updates?.codeSigningCertificate).toBe(
      "release/fixtures/ota-public-certificate.pem",
    );
    expect(resolved.updates?.codeSigningMetadata).toEqual({
      keyid: "main",
      alg: "rsa-v1_5-sha256",
    });
    expect(resolved.plugins).toContain("./plugins/with-android-release-signing.cjs");
  });

  test("required OTA signing rejects an unprovisioned certificate", () => {
    expect(() =>
      appConfig(
        {
          config: appJson.expo as never,
          projectRoot: resolve(import.meta.dir, ".."),
          staticConfigPath: null,
          packageJsonPath: null,
        },
        {
          MOBILE_UPDATES_CODE_SIGNING: "required",
          MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: "./missing.pem",
        },
      ),
    ).toThrow("code-signing certificate was not found");
  });

  test("with-android-release-signing configures release signingConfig instead of debug", () => {
    const sampleGradle = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;
    const patched = applyAndroidReleaseSigning(sampleGradle);
    expect(patched).toContain("ANDROID_KEYSTORE_PATH");
    expect(patched).toContain("KVITBIT_REQUIRE_RELEASE_SIGNING");
    expect(patched).toContain("signingConfigs.release");
    // Idempotent if applied twice
    expect(applyAndroidReleaseSigning(patched)).toBe(patched);
  });
});

describe("mobile-release CLI", () => {
  test("--help and metadata work without secrets", async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("publish-apk");
    expect(help.stdout).toContain("publish-ota");
    expect(help.stdout).toContain("rollback");

    const meta = await runCli(["metadata", "--json"]);
    expect(meta.exitCode).toBe(0);
    const parsed = JSON.parse(meta.stdout) as {
      version: string;
      versionCode: number;
      apkName: string;
    };
    expect(parsed.version).toBe(appJson.expo.version);
    expect(parsed.versionCode).toBe(1000);
    expect(parsed.apkName).toBe(`kvitbit-${appJson.expo.version}.apk`);

    const badTag = await runCli(["metadata", "--tag", "mobile-v9.9.9"]);
    expect(badTag.exitCode).toBe(1);
    expect(badTag.stderr).toContain("does not match");
  });

  test("all subcommands support --dry-run without network or secrets", async () => {
    const build = await runCli(["build", "--dry-run"]);
    expect(build.exitCode).toBe(0);
    expect(JSON.parse(build.stdout)).toMatchObject({ dryRun: true, command: "build" });

    const pubApk = await runCli(["publish-apk", "--dry-run"]);
    expect(pubApk.exitCode).toBe(0);
    expect(JSON.parse(pubApk.stdout)).toMatchObject({ dryRun: true, command: "publish-apk" });

    const pubOta = await runCli(["publish-ota", "--dry-run", "--platform", "android"]);
    expect(pubOta.exitCode).toBe(0);
    expect(JSON.parse(pubOta.stdout)).toMatchObject({ dryRun: true, command: "publish-ota" });

    const rollback = await runCli(["rollback", "--dry-run", "--runtime-version", "fp-test"]);
    expect(rollback.exitCode).toBe(0);
    expect(JSON.parse(rollback.stdout)).toMatchObject({ dryRun: true, command: "rollback" });

    const verify = await runCli(["verify", "--dry-run", "--runtime-version", "fp-test"]);
    expect(verify.exitCode).toBe(0);
    expect(JSON.parse(verify.stdout)).toMatchObject({ dryRun: true, command: "verify" });
  });

  test.skipIf(!hasApkTools)(
    "publish-apk, publish-ota, rollback, and verify work end-to-end against local storage-dir",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "kvitbit-release-test-"));
      try {
        const storageDir = join(workDir, "storage");
        const exportDir = join(workDir, "export");
        const { apkPath: signedApk, certSha256 } = await createSignedTestApk(
          workDir,
          "kvitbit-0.1.0.apk",
        );

        await Bun.write(join(exportDir, "bundles/android.hbc"), "console.log('kvitbit');");
        await Bun.write(join(exportDir, "assets/icon.png"), new Uint8Array([137, 80, 78, 71]));
        await Bun.write(
          join(exportDir, "metadata.json"),
          JSON.stringify({
            fileMetadata: {
              android: {
                bundle: "bundles/android.hbc",
                assets: [{ path: "assets/icon.png", ext: "png" }],
              },
            },
          }),
        );

        // 1a. publish-apk rejects mismatched expected signing-cert-sha256
        const wrongCert = await runCli([
          "publish-apk",
          "--apk",
          signedApk,
          "--storage-dir",
          storageDir,
          "--signing-cert-sha256",
          "ab".repeat(32),
        ]);
        expect(wrongCert.exitCode).toBe(1);
        expect(wrongCert.stderr).toContain("does not match expected");

        // 1b. publish-apk extracts actual signer cert SHA-256 and writes APK + release.json
        const pubApk = await runCli([
          "publish-apk",
          "--apk",
          signedApk,
          "--storage-dir",
          storageDir,
          "--signing-cert-sha256",
          certSha256,
        ]);
        expect(pubApk.exitCode).toBe(0);
        const pubApkJson = JSON.parse(pubApk.stdout) as {
          releaseInfo: { signingCertSha256: string };
        };
        expect(pubApkJson.releaseInfo.signingCertSha256).toBe(certSha256);

        // A retry after the metadata write returns the original immutable release.
        const dupApk = await runCli([
          "publish-apk",
          "--apk",
          signedApk,
          "--storage-dir",
          storageDir,
          "--signing-cert-sha256",
          certSha256,
        ]);
        expect(dupApk.exitCode).toBe(0);
        expect(JSON.parse(dupApk.stdout).releaseInfo).toEqual(pubApkJson.releaseInfo);

        const wrongVersion = await runCli([
          "publish-apk",
          "--apk",
          signedApk,
          "--version",
          "0.1.1",
          "--storage-dir",
          storageDir,
        ]);
        expect(wrongVersion.exitCode).toBe(1);
        expect(wrongVersion.stderr).toContain("APK identity mismatch");

        // 1c. Resumable recovery: if APK exists with identical bytes and release.json is missing, resume succeeds
        const resumeDir = join(workDir, "storage-resume");
        const version = appJson.expo.version;
        await Bun.write(
          join(resumeDir, apkObjectKey(version)),
          await Bun.file(signedApk).arrayBuffer(),
        );
        const resumed = await runCli([
          "publish-apk",
          "--apk",
          signedApk,
          "--storage-dir",
          resumeDir,
          "--signing-cert-sha256",
          certSha256,
        ]);
        expect(resumed.exitCode).toBe(0);
        expect(await Bun.file(join(resumeDir, releaseInfoObjectKey(version))).exists()).toBe(true);

        // 1d. If APK exists with DIFFERENT bytes, publish-apk refuses overwrite even when release.json is missing
        const conflictDir = join(workDir, "storage-conflict");
        await Bun.write(join(conflictDir, apkObjectKey(version)), "corrupted-other-apk");
        const conflicted = await runCli([
          "publish-apk",
          "--apk",
          signedApk,
          "--storage-dir",
          conflictDir,
          "--signing-cert-sha256",
          certSha256,
        ]);
        expect(conflicted.exitCode).toBe(1);
        expect(conflicted.stderr).toContain("different bytes");

        // 2. publish-ota from exportDir
        const pubOta = await runCli([
          "publish-ota",
          "--export-dir",
          exportDir,
          "--storage-dir",
          storageDir,
          "--runtime-version",
          "fp-e2e-1",
          "--platform",
          "android",
        ]);
        expect(pubOta.exitCode).toBe(0);
        const otaResult = JSON.parse(pubOta.stdout) as {
          published: Array<{ assetCount: number; publicationKey: string }>;
        };
        expect(otaResult.published[0]?.assetCount).toBe(2);

        // 3. verify storage-dir (update + release + ephemeral RSA signature check)
        const verifyUpdate = await runCli([
          "verify",
          "--storage-dir",
          storageDir,
          "--runtime-version",
          "fp-e2e-1",
          "--platform",
          "android",
          "--check-release",
        ]);
        expect(verifyUpdate.exitCode).toBe(0);
        const verifyJson = JSON.parse(verifyUpdate.stdout) as {
          ok: boolean;
          update: { publicationType: string; signatureVerified: boolean };
          latestRelease: { version: string };
        };
        expect(verifyJson.ok).toBe(true);
        expect(verifyJson.update.publicationType).toBe("update");
        expect(verifyJson.update.signatureVerified).toBe(true);
        expect(verifyJson.latestRelease.version).toBe(appJson.expo.version);

        // 4. rollback and re-verify
        const rollback = await runCli([
          "rollback",
          "--storage-dir",
          storageDir,
          "--runtime-version",
          "fp-e2e-1",
          "--platform",
          "android",
        ]);
        expect(rollback.exitCode).toBe(0);

        const verifyRollback = await runCli([
          "verify",
          "--storage-dir",
          storageDir,
          "--runtime-version",
          "fp-e2e-1",
          "--platform",
          "android",
        ]);
        expect(verifyRollback.exitCode).toBe(0);
        expect(JSON.parse(verifyRollback.stdout)).toMatchObject({
          ok: true,
          update: { publicationType: "rollBackToEmbedded", signatureVerified: true },
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
