import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import appConfig from "../app.config";
import appJson from "../app.json";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_PATH = join(REPO_ROOT, "scripts/release/mobile-release.ts");

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
      { MOBILE_UPDATES_CODE_SIGNING: "required" },
    );
    expect(resolved.updates?.codeSigningCertificate).toBe(
      "./code-signing/code-signing-certificate.pem",
    );
    expect(resolved.updates?.codeSigningMetadata).toEqual({
      keyid: "main",
      alg: "rsa-v1_5-sha256",
    });
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

  test("publish-apk, publish-ota, rollback, and verify work end-to-end against local storage-dir", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kvitbit-release-test-"));
    try {
      const storageDir = join(workDir, "storage");
      const exportDir = join(workDir, "export");
      const fakeApk = join(workDir, "kvitbit-0.1.0.apk");

      await Bun.write(fakeApk, new TextEncoder().encode("PK\x03\x04fake-apk-bytes"));
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

      // 1. publish-apk (create-only)
      const pubApk = await runCli([
        "publish-apk",
        "--apk",
        fakeApk,
        "--storage-dir",
        storageDir,
        "--signing-cert-sha256",
        "ab".repeat(32),
      ]);
      expect(pubApk.exitCode).toBe(0);

      // Re-publishing the same version must refuse overwrite
      const dupApk = await runCli([
        "publish-apk",
        "--apk",
        fakeApk,
        "--storage-dir",
        storageDir,
        "--signing-cert-sha256",
        "ab".repeat(32),
      ]);
      expect(dupApk.exitCode).toBe(1);
      expect(dupApk.stderr).toContain("already exists");

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
  });
});
