/**
 * Configuration for the mobile updates, Android releases, and App Links routes
 * (http-mcp-contracts section 5, board contract #929).
 */
import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted } from "effect";
import { loadKvitbitEnv, loadValidatedAppOrigin } from "../../config-contract";

export type MobileStorageConfig =
  | { readonly _tag: "local"; readonly dir: string }
  | {
      readonly _tag: "gcs";
      readonly bucket: string;
      readonly endpoint?: string | undefined;
    };

export interface MobileConfigShape {
  /** Public origin, no trailing slash (APP_ORIGIN). */
  readonly appOrigin: string;
  /** PEM private key for Expo Updates RSA-SHA256 signing (KVITBIT_MOBILE_UPDATES_SIGNING_KEY). */
  readonly signingKeyPem: Option.Option<Redacted.Redacted<string>>;
  /** Where mobile update manifests, assets, and Android releases are stored. */
  readonly storage: MobileStorageConfig;
  /** Uppercase colon-separated SHA-256 cert fingerprints for /.well-known/assetlinks.json. */
  readonly androidAssetLinksSha256: ReadonlyArray<string>;
}

export class MobileConfig extends Context.Service<MobileConfig, MobileConfigShape>()(
  "kvitbit/server/http/MobileConfig",
) {}

const DEFAULT_BLOB_DIR = "/var/lib/kvitbit/blobs";

const hex64Pattern = /^[0-9a-fA-F]{64}$/;
const colonHexPattern = /^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/;

/**
 * Normalizes an Android signing certificate SHA-256 fingerprint to the uppercase colon-separated
 * form expected by `/.well-known/assetlinks.json` (`AA:BB:...`), or returns `undefined` if invalid.
 */
export const normalizeFingerprint = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (colonHexPattern.test(trimmed)) return trimmed.toUpperCase();
  if (hex64Pattern.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    const pairs: Array<string> = [];
    for (let i = 0; i < upper.length; i += 2) {
      pairs.push(upper.slice(i, i + 2));
    }
    return pairs.join(":");
  }
  return undefined;
};

const nonEmptyOption = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((opt) =>
      Option.flatMap(opt, (value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const normalizePem = (raw: string): string =>
  raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;

const configError = (message: string) =>
  Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })));

export const makeMobileConfig = (input: Partial<MobileConfigShape> = {}): MobileConfigShape => ({
  appOrigin: new URL(input.appOrigin ?? "https://kvitbit.test").origin,
  signingKeyPem: input.signingKeyPem ?? Option.none(),
  storage: input.storage ?? { _tag: "local", dir: DEFAULT_BLOB_DIR },
  androidAssetLinksSha256: input.androidAssetLinksSha256 ?? [],
});

/** MobileConfig read from process environment variables. */
export const MobileConfigLive: Layer.Layer<MobileConfig, Config.ConfigError> = Layer.effect(
  MobileConfig,
  Effect.gen(function* () {
    const env = yield* loadKvitbitEnv;
    const appOrigin = yield* loadValidatedAppOrigin;

    const rawSigningKey = yield* nonEmptyOption("KVITBIT_MOBILE_UPDATES_SIGNING_KEY");
    const signingKeyPem = Option.map(rawSigningKey, (pem) => Redacted.make(normalizePem(pem)));

    const mobileBucket = yield* nonEmptyOption("KVITBIT_MOBILE_STORAGE_BUCKET");
    const mobileDir = yield* nonEmptyOption("KVITBIT_MOBILE_STORAGE_DIR");
    const blobDriver = yield* nonEmptyOption("KVITBIT_BLOB_DRIVER");
    const blobBucket = yield* nonEmptyOption("KVITBIT_BLOB_BUCKET");
    const blobDir = yield* nonEmptyOption("KVITBIT_BLOB_DIR");
    const gcsEndpoint = Option.getOrUndefined(yield* nonEmptyOption("KVITBIT_GCS_ENDPOINT"));

    let storage: MobileStorageConfig;
    if (env === "production") {
      if (Option.isSome(blobDriver) && blobDriver.value !== "gcs") {
        return yield* configError(
          `Non-production KVITBIT_BLOB_DRIVER=${JSON.stringify(blobDriver.value)} is forbidden in production`,
        );
      }
      if (Option.isSome(mobileBucket)) {
        storage = { _tag: "gcs", bucket: mobileBucket.value, endpoint: gcsEndpoint };
      } else if (
        Option.isSome(blobDriver) &&
        blobDriver.value === "gcs" &&
        Option.isSome(blobBucket)
      ) {
        storage = { _tag: "gcs", bucket: blobBucket.value, endpoint: gcsEndpoint };
      } else {
        return yield* configError(
          "KVITBIT_MOBILE_STORAGE_BUCKET (or KVITBIT_BLOB_DRIVER=gcs with KVITBIT_BLOB_BUCKET) is required when KVITBIT_ENV=production",
        );
      }
    } else if (Option.isSome(mobileBucket)) {
      storage = { _tag: "gcs", bucket: mobileBucket.value, endpoint: gcsEndpoint };
    } else if (Option.isSome(mobileDir)) {
      storage = { _tag: "local", dir: mobileDir.value };
    } else if (Option.isSome(blobDriver)) {
      if (blobDriver.value === "gcs") {
        if (Option.isNone(blobBucket)) {
          return yield* configError("KVITBIT_BLOB_BUCKET is required when KVITBIT_BLOB_DRIVER=gcs");
        }
        storage = { _tag: "gcs", bucket: blobBucket.value, endpoint: gcsEndpoint };
      } else if (blobDriver.value === "local") {
        storage = {
          _tag: "local",
          dir: Option.getOrElse(blobDir, () => DEFAULT_BLOB_DIR),
        };
      } else {
        return yield* configError(
          `Unsupported KVITBIT_BLOB_DRIVER: ${JSON.stringify(blobDriver.value)}`,
        );
      }
    } else if (Option.isSome(blobBucket)) {
      storage = { _tag: "gcs", bucket: blobBucket.value, endpoint: gcsEndpoint };
    } else if (env === "staging" || env === "preview") {
      return yield* configError(
        `Mobile storage must be explicitly configured (KVITBIT_MOBILE_STORAGE_BUCKET, KVITBIT_MOBILE_STORAGE_DIR, or KVITBIT_BLOB_DRIVER) when KVITBIT_ENV=${env}`,
      );
    } else {
      storage = {
        _tag: "local",
        dir: Option.getOrElse(blobDir, () => DEFAULT_BLOB_DIR),
      };
    }

    const rawFingerprints = yield* nonEmptyOption("KVITBIT_ANDROID_ASSETLINKS_SHA256");
    const androidAssetLinksSha256: Array<string> = [];
    if (Option.isSome(rawFingerprints)) {
      const seen = new Set<string>();
      for (const entry of rawFingerprints.value.split(",")) {
        const trimmed = entry.trim();
        if (trimmed.length === 0) continue;
        const normalized = normalizeFingerprint(trimmed);
        if (normalized === undefined) {
          return yield* configError(
            `Invalid SHA-256 fingerprint in KVITBIT_ANDROID_ASSETLINKS_SHA256: ${JSON.stringify(trimmed)}`,
          );
        }
        if (!seen.has(normalized)) {
          seen.add(normalized);
          androidAssetLinksSha256.push(normalized);
        }
      }
    }

    return {
      appOrigin,
      signingKeyPem,
      storage,
      androidAssetLinksSha256,
    } satisfies MobileConfigShape;
  }),
);

/** Fixed MobileConfig for tests. */
export const MobileConfigTest = (
  overrides: Partial<MobileConfigShape> = {},
): Layer.Layer<MobileConfig> => Layer.succeed(MobileConfig, makeMobileConfig(overrides));
