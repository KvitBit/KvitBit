import type { ConfigContext, ExpoConfig } from "expo/config";

// Dynamic Expo config layered over app.json.
// Imports no local runtime modules: Expo transpiles only app.config.ts itself.
// Derives Android versionCode from app.json's expo.version (DeskoHub invariant)
// and points expo-updates at `${EXPO_PUBLIC_API_ORIGIN}/api/mobile/updates/manifest`.

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
      `App version ${JSON.stringify(version)} must be MAJOR.MINOR.PATCH without a prefix, pre-release or build suffix.`,
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
  const candidate = configured?.trim() || PRODUCTION_API_ORIGIN;
  const url = URL.parse(candidate);
  const allowed =
    url !== null &&
    (url.protocol === "https:" || (url.protocol === "http:" && PLAIN_HTTP_HOSTS.has(url.hostname)));
  if (!allowed) {
    throw new Error(
      `EXPO_PUBLIC_API_ORIGIN must be an absolute https URL (plain http only for a local host), got ${JSON.stringify(candidate)}.`,
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
): UpdatesCodeSigning => {
  const setting = env.MOBILE_UPDATES_CODE_SIGNING;
  if (setting === undefined || setting === "") return {};
  if (setting !== "required") {
    throw new Error(
      `MOBILE_UPDATES_CODE_SIGNING must be "required" or unset, got ${JSON.stringify(setting)}.`,
    );
  }
  const certPath =
    env.MOBILE_UPDATES_CODE_SIGNING_CERTIFICATE?.trim() ||
    "./code-signing/code-signing-certificate.pem";
  return {
    codeSigningCertificate: certPath,
    codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
  };
};

export default (
  { config }: ConfigContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExpoConfig => ({
  ...config,
  name: config.name ?? "Kvitbit",
  slug: config.slug ?? "kvitbit",
  android: {
    ...config.android,
    package: config.android?.package ?? ANDROID_PACKAGE,
    versionCode: deriveAndroidVersionCode(config.version),
  },
  updates: {
    ...config.updates,
    enabled: true,
    url: updatesManifestUrl(env.EXPO_PUBLIC_API_ORIGIN),
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 15_000,
    ...updatesCodeSigning(env),
  },
});
