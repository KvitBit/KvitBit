import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Pred from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { buildAppConfig, deriveAndroidVersionCode } from "../app.config";
import appJson from "../app.json" with { type: "json" };
import { runReleaseProcess } from "./release-process.testkit";
import { apkObjectKey, releaseInfoObjectKey } from "./storage-layout";

const json = Schema.fromJsonString(Schema.Unknown);
const parseJson = (value: string) => Schema.decodeOption(json)(value).pipe(Option.getOrThrow);
const encodeJson = <A>(value: A) => Schema.encodeOption(json)(value).pipe(Option.getOrThrow);
const bytePairs = /../g;

const { fileSystem, path } = Effect.runSync(
  Effect.all({ fileSystem: FileSystem.FileSystem, path: Path.Path }, { concurrency: 1 }).pipe(
    Effect.provide(BunServices.layer),
  ),
);
const { join, resolve } = path;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_PATH = join(REPO_ROOT, "scripts/release/mobile-release.ts");
const appContext: Parameters<typeof buildAppConfig>[0]["context"] = {
  config: {
    name: appJson.expo.name,
    slug: appJson.expo.slug,
    version: appJson.expo.version,
    android: { package: appJson.expo.android.package },
  },
  projectRoot: resolve(import.meta.dir, ".."),
  staticConfigPath: null,
  packageJsonPath: null,
};

const sdkRoot = Config.String("ANDROID_HOME").pipe(
  Config.orElse(() => Config.String("ANDROID_SDK_ROOT")),
  Config.option,
  Effect.runSync,
  Option.getOrUndefined,
);
const findSdkFile = Effect.fn("MobileReleaseTest.findSdkFile")(function* (
  directory: string,
  filename: string,
) {
  if (sdkRoot === undefined) return;
  const root = join(sdkRoot, directory);
  if (!(yield* fileSystem.exists(root))) return;
  const entries = yield* fileSystem.readDirectory(root);
  const versions = [...entries].sort((left, right) =>
    Str.localeCompare(left, [], { numeric: true })(right),
  );
  for (const version of versions) {
    const candidate = join(root, version, filename);
    if (yield* fileSystem.exists(candidate)) return candidate;
  }
});
const [aapt2, apksigner, androidJar] = await Effect.runPromise(
  Effect.all(
    [
      findSdkFile("build-tools", "aapt2"),
      findSdkFile("build-tools", "apksigner"),
      findSdkFile("platforms", "android.jar"),
    ],
    { concurrency: "unbounded" },
  ),
);
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
  if (aapt2 === undefined || apksigner === undefined || androidJar === undefined)
    throw new Error("Android SDK is required for the APK test.");
  await Bun.write(
    manifest,
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}" android:versionCode="${deriveAndroidVersionCode(appJson.expo.version)}" android:versionName="${appJson.expo.version}"><uses-sdk android:minSdkVersion="24"/><application/></manifest>`,
  );

  const gen = await runReleaseProcess(
    ChildProcess.make("keytool", [
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
    ]),
  );
  if (gen.exitCode !== 0) throw new Error(gen.stderr);

  const linkResult = await runReleaseProcess(
    ChildProcess.make(aapt2, ["link", "-I", androidJar, "--manifest", manifest, "-o", apkPath]),
  );
  if (linkResult.exitCode !== 0) throw new Error(linkResult.stderr);

  const signed = await runReleaseProcess(
    ChildProcess.make(apksigner, [
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
    ]),
  );
  if (signed.exitCode !== 0) throw new Error(signed.stderr);

  const cert = await runReleaseProcess(
    ChildProcess.make("keytool", [
      "-exportcert",
      "-keystore",
      keystorePath,
      "-alias",
      "kvitbit-test",
      "-storepass",
      "testpass123",
    ]),
  );
  if (cert.exitCode !== 0) throw new Error(cert.stderr);
  const rawDigest = new Bun.CryptoHasher("sha256").update(cert.stdout).digest("hex");
  const certSha256 = Str.match(bytePairs)(Str.toUpperCase(rawDigest)).pipe(
    Option.map(Arr.join(":")),
    Option.getOrElse(() => ""),
  );
  return { apkPath, certSha256 };
};

const runCli = async (
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const { stdout, stderr, exitCode } = await runReleaseProcess(
    ChildProcess.make(process.execPath, ["run", CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env,
      extendEnv: true,
    }),
  );
  return { exitCode, stdout: stdout.toString(), stderr };
};

describe("app.config.ts", () => {
  test("layers updates.url, android.package, and versionCode over app.json", () => {
    const resolved = buildAppConfig({
      context: appContext,
      env: {
        EXPO_PUBLIC_API_ORIGIN: "https://preview.kvitbit.cz/",
      },
    });

    expect(resolved.android?.package).toBe("cz.kvitbit.app");
    expect(resolved.android?.versionCode).toBe(1000);
    expect(resolved.updates?.url).toBe("https://preview.kvitbit.cz/api/mobile/updates/manifest");
    expect(resolved.updates?.codeSigningCertificate).toBeUndefined();
  });

  test("adds codeSigningCertificate only when MOBILE_UPDATES_CODE_SIGNING=required", () => {
    const resolved = buildAppConfig({
      context: appContext,
      env: {
        MOBILE_UPDATES_CODE_SIGNING: "required",
        MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: join(
          import.meta.dir,
          "fixtures/ota-public-certificate.pem",
        ),
      },
    });
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
      buildAppConfig({
        context: appContext,
        env: {
          MOBILE_UPDATES_CODE_SIGNING: "required",
          MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: "./missing.pem",
        },
      }),
    ).toThrow("code-signing certificate was not found");
  });

  test("with-android-release-signing configures release signingConfig instead of debug", async () => {
    const plugin: unknown = await import(
      new URL("../plugins/with-android-release-signing.cjs", import.meta.url).href
    );
    const isSigningPlugin = Schema.is(
      Schema.Struct({ applyAndroidReleaseSigning: Schema.declare(Pred.isFunction) }),
    );
    if (!isSigningPlugin(plugin)) throw new Error("Expected the Android signing plugin");
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
    const patched: unknown = plugin.applyAndroidReleaseSigning(sampleGradle);
    if (!Schema.is(Schema.String)(patched)) throw new Error("Expected Gradle source");
    expect(patched).toContain("ANDROID_KEYSTORE_PATH");
    expect(patched).toContain("KVITBIT_REQUIRE_RELEASE_SIGNING");
    expect(patched).toContain("signingConfigs.release");
    // Idempotent if applied twice
    expect(plugin.applyAndroidReleaseSigning(patched)).toBe(patched);
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
    expect(Schema.decodeOption(json)(meta.stdout)).toEqual(
      Option.some(
        expect.objectContaining({
          version: appJson.expo.version,
          versionCode: 1000,
          apkName: `kvitbit-${appJson.expo.version}.apk`,
        }),
      ),
    );

    const badTag = await runCli(["metadata", "--tag", "mobile-v9.9.9"]);
    expect(badTag.exitCode).toBe(1);
    expect(badTag.stderr).toContain("does not match");
  });

  test("all subcommands support --dry-run without network or secrets", async () => {
    const build = await runCli(["build", "--dry-run"]);
    expect(build.exitCode).toBe(0);
    expect(parseJson(build.stdout)).toMatchObject({ dryRun: true, command: "build" });

    const pubApk = await runCli(["publish-apk", "--dry-run"]);
    expect(pubApk.exitCode).toBe(0);
    expect(parseJson(pubApk.stdout)).toMatchObject({ dryRun: true, command: "publish-apk" });

    const pubOta = await runCli(["publish-ota", "--dry-run", "--platform", "android"]);
    expect(pubOta.exitCode).toBe(0);
    expect(parseJson(pubOta.stdout)).toMatchObject({ dryRun: true, command: "publish-ota" });

    const rollback = await runCli(["rollback", "--dry-run", "--runtime-version", "fp-test"]);
    expect(rollback.exitCode).toBe(0);
    expect(parseJson(rollback.stdout)).toMatchObject({ dryRun: true, command: "rollback" });

    const verify = await runCli(["verify", "--dry-run", "--runtime-version", "fp-test"]);
    expect(verify.exitCode).toBe(0);
    expect(parseJson(verify.stdout)).toMatchObject({ dryRun: true, command: "verify" });
  });

  describe.skipIf(!hasApkTools)("with Android SDK tools", () => {
    test("publish-apk, publish-ota, rollback, and verify work end-to-end against local storage-dir", async () => {
      const workDir = await Effect.runPromise(
        fileSystem.makeTempDirectory({ prefix: "kvitbit-release-test-" }),
      );
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
          encodeJson({
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
          Str.repeat(32)("ab"),
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
        const readRelease = Schema.decodeUnknownResult(
          Schema.fromJsonString(
            Schema.Struct({
              releaseInfo: Schema.StructWithRest(
                Schema.Struct({ signingCertSha256: Schema.String }),
                [Schema.JsonObject],
              ),
            }),
          ),
        );
        const pubApkJson = Result.getOrThrow(readRelease(pubApk.stdout));
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
        expect(Result.getOrThrow(readRelease(dupApk.stdout)).releaseInfo).toEqual(
          pubApkJson.releaseInfo,
        );

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
        expect(parseJson(pubOta.stdout)).toMatchObject({
          published: [expect.objectContaining({ assetCount: 2 })],
        });

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
        expect(parseJson(verifyUpdate.stdout)).toMatchObject({
          ok: true,
          update: { publicationType: "update", signatureVerified: true },
          latestRelease: { version: appJson.expo.version },
        });

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
        expect(parseJson(verifyRollback.stdout)).toMatchObject({
          ok: true,
          update: { publicationType: "rollBackToEmbedded", signatureVerified: true },
        });
      } finally {
        await Effect.runPromise(fileSystem.remove(workDir, { recursive: true, force: true }));
      }
    }, 30_000);
  });
});
