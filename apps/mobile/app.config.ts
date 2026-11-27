// Expo loads its config synchronously before the app runtime exists.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync } from "node:fs";
// This path is resolved on the operating system where Expo loads the config.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { relative, resolve } from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import type { ConfigContext, ExpoConfig } from "expo/config";

// Dynamic Expo config layered over app.json.
// Imports no local runtime modules: Expo transpiles only app.config.ts itself.
// Derives Android versionCode from app.json's expo.version (DeskoHub invariant)
// and points expo-updates at `${EXPO_PUBLIC_API_ORIGIN}/api/mobile/updates/manifest`.

const showString = (value: string) =>
  Schema.encodeOption(Schema.fromJsonString(Schema.String))(value).pipe(Option.getOrThrow);

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAJOR_LIMIT = 2100;
const COMPONENT_LIMIT = 1000;
const PRODUCTION_API_ORIGIN = "https://kvitbit.cz";
const ANDROID_PACKAGE = "cz.kvitbit.app";
const PLAIN_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

export const deriveAndroidVersionCode = (version: string | undefined): number => {
  if (version === undefined) {
    throw new Error("The Expo config has no version to derive the Android version code from.");
  }
  const match = VERSION_RE.exec(version);
  if (match === null) {
    throw new Error(
      `App version ${showString(version)} must be MAJOR.MINOR.PATCH without a prefix, pre-release or build suffix.`,
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
  const code = major * 1_000_000 + minor * 1000 + patch;
  if (code === 0) {
    throw new Error("App version 0.0.0 has no positive Android version code.");
  }
  return code;
};

export const updatesManifestUrl = (configured: string | undefined): string => {
  const trimmed = EffectString.trim(configured ?? "");
  const candidate = trimmed === "" ? PRODUCTION_API_ORIGIN : trimmed;
  const url = URL.parse(candidate);
  const allowed =
    url !== null &&
    (url.protocol === "https:" || (url.protocol === "http:" && PLAIN_HTTP_HOSTS.has(url.hostname)));
  if (!allowed) {
    throw new Error(
      `EXPO_PUBLIC_API_ORIGIN must be an absolute https URL (plain http only for a local host), got ${showString(candidate)}.`,
    );
  }
  return `${url.origin}/api/mobile/updates/manifest`;
};

type UpdatesCodeSigning = Pick<
  NonNullable<ExpoConfig["updates"]>,
  "codeSigningCertificate" | "codeSigningMetadata"
>;

const updatesCodeSigning = (
  env: Readonly<Record<string, string | undefined>>,
  projectRoot: string,
): UpdatesCodeSigning => {
  const setting = env["MOBILE_UPDATES_CODE_SIGNING"];
  if (setting === undefined || setting === "") return {};
  if (setting !== "required") {
    throw new Error(
      `MOBILE_UPDATES_CODE_SIGNING must be "required" or unset, got ${showString(setting)}.`,
    );
  }
  const configuredPath = EffectString.trim(env["MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE"] ?? "");
  const certPath =
    configuredPath === "" ? "./code-signing/code-signing-certificate.pem" : configuredPath;
  const resolvedCertPath = resolve(projectRoot, certPath);
  if (!existsSync(resolvedCertPath)) {
    throw new Error(
      `MOBILE_UPDATES_CODE_SIGNING=required but code-signing certificate was not found at ${resolvedCertPath}. Provision apps/mobile/code-signing/code-signing-certificate.pem or set MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE.`,
    );
  }
  return {
    codeSigningCertificate: EffectString.replaceAll(
      "\\",
      "/",
    )(relative(projectRoot, resolvedCertPath)),
    codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
  };
};

export const buildAppConfig = ({
  context: { config, projectRoot },
  env,
}: {
  readonly context: ConfigContext;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ExpoConfig => {
  const plugins = [...(config.plugins ?? [])];
  if (!plugins.includes("expo-background-task")) {
    plugins.push("expo-background-task");
  }
  if (!plugins.includes("./plugins/with-android-release-signing.cjs")) {
    plugins.push("./plugins/with-android-release-signing.cjs");
  }
  if (!plugins.includes("./plugins/with-android-platform-modules.cjs")) {
    plugins.push("./plugins/with-android-platform-modules.cjs");
  }
  return {
    ...config,
    name: config.name ?? "Kvitbit",
    slug: config.slug ?? "kvitbit",
    plugins,
    android: {
      ...config.android,
      package: config.android?.package ?? ANDROID_PACKAGE,
      versionCode: deriveAndroidVersionCode(config.version),
    },
    updates: {
      ...config.updates,
      enabled: true,
      url: updatesManifestUrl(env["EXPO_PUBLIC_API_ORIGIN"]),
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 15_000,
      ...updatesCodeSigning(env, projectRoot),
    },
  };
};

const optionalEnv = (name: string) =>
  Config.String(name).pipe(Config.option, Effect.map(Option.getOrUndefined));

export default (context: ConfigContext): ExpoConfig => {
  const env = Effect.runSync(
    Effect.all(
      {
        EXPO_PUBLIC_API_ORIGIN: optionalEnv("EXPO_PUBLIC_API_ORIGIN"),
        MOBILE_UPDATES_CODE_SIGNING: optionalEnv("MOBILE_UPDATES_CODE_SIGNING"),
        MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE: optionalEnv(
          "MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE",
        ),
      },
      { concurrency: 1 },
    ),
  );
  return buildAppConfig({ context, env });
};
