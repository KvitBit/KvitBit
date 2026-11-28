/**
 * Configuration for the mobile updates, Android releases, and App Links routes
 * (http-mcp-contracts section 5, board contract #929).
 */
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { loadKvitbitEnv, loadValidatedAppOrigin } from "../../config-contract";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

type MobileStorageConfig =
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
  "@kvitbit/server/http/mobile/config/MobileConfig",
) {}

const DEFAULT_BLOB_DIR = "/var/lib/kvitbit/blobs";

const hex64Pattern = /^[0-9a-fA-F]{64}$/;
const escapedNewline = /\\n/g;
const encodeString = Schema.encodeResult(Schema.fromJsonString(Schema.String));
const quote = (value: string): string =>
  Result.getOrThrowWith(encodeString(value), (error) => error);
const colonHexPattern = /^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/;

/**
 * Normalizes an Android signing certificate SHA-256 fingerprint to the uppercase colon-separated
 * form expected by `/.well-known/assetlinks.json` (`AA:BB:...`), or returns `undefined` if invalid.
 */
export const normalizeFingerprint = (raw: string): string | undefined => {
  const trimmed = Str.trim(raw);
  if (colonHexPattern.test(trimmed)) return Str.toUpperCase(trimmed);
  if (hex64Pattern.test(trimmed)) {
    const upper = Str.toUpperCase(trimmed);
    const pairs: Array<string> = [];
    for (let i = 0; i < upper.length; i += 2) {
      pairs.push(Str.slice(i, i + 2)(upper));
    }
    return Arr.join(pairs, ":");
  }
  return undefined;
};

const nonEmptyOption = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((opt) =>
      Option.flatMap(opt, (value) => {
        const trimmed = Str.trim(value);
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const normalizePem = Str.replace(escapedNewline, "\n");

const configError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

const makeMobileConfig = (input: Partial<MobileConfigShape> = {}): MobileConfigShape => ({
  appOrigin: new URL(input.appOrigin ?? "https://kvitbit.test").origin,
  signingKeyPem: input.signingKeyPem ?? Option.none(),
  storage: input.storage ?? { _tag: "local", dir: DEFAULT_BLOB_DIR },
  androidAssetLinksSha256: input.androidAssetLinksSha256 ?? [],
});

const failConfig = (message: string) => Effect.fail(configError(message));

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
    const rawEndpoint = yield* nonEmptyOption("KVITBIT_GCS_ENDPOINT");
    const gcsEndpoint = Option.getOrUndefined(rawEndpoint);

    let storage: MobileStorageConfig;
    if (env === "production") {
      if (Option.isSome(blobDriver) && blobDriver.value !== "gcs") {
        return yield* failConfig(
          `Non-production KVITBIT_BLOB_DRIVER=${encodeJson(blobDriver.value)} is forbidden in production`,
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
        return yield* failConfig(
          "KVITBIT_MOBILE_STORAGE_BUCKET (or KVITBIT_BLOB_DRIVER=gcs with KVITBIT_BLOB_BUCKET) is required when KVITBIT_ENV=production",
        );
      }
    } else if (env === "staging" || env === "preview") {
      if (Option.isSome(blobDriver) && blobDriver.value !== "gcs" && blobDriver.value !== "local") {
        return yield* failConfig(
          `Unsupported KVITBIT_BLOB_DRIVER: ${encodeJson(blobDriver.value)}`,
        );
      }
      if (Option.isSome(mobileBucket)) {
        storage = { _tag: "gcs", bucket: mobileBucket.value, endpoint: gcsEndpoint };
      } else if (Option.isSome(blobDriver)) {
        if (blobDriver.value === "gcs") {
          if (Option.isNone(blobBucket)) {
            return yield* failConfig(
              "KVITBIT_BLOB_BUCKET is required when KVITBIT_BLOB_DRIVER=gcs",
            );
          }
          storage = { _tag: "gcs", bucket: blobBucket.value, endpoint: gcsEndpoint };
        } else {
          storage = {
            _tag: "local",
            dir: Option.getOrElse(mobileDir, () =>
              Option.getOrElse(blobDir, () => DEFAULT_BLOB_DIR),
            ),
          };
        }
      } else {
        return yield* failConfig(
          `Mobile storage must be explicitly configured via KVITBIT_MOBILE_STORAGE_BUCKET or KVITBIT_BLOB_DRIVER ('gcs' or 'local') when KVITBIT_ENV=${env}`,
        );
      }
    } else if (Option.isSome(mobileBucket)) {
      storage = { _tag: "gcs", bucket: mobileBucket.value, endpoint: gcsEndpoint };
    } else if (Option.isSome(mobileDir)) {
      storage = { _tag: "local", dir: mobileDir.value };
    } else if (Option.isSome(blobDriver)) {
      if (blobDriver.value === "gcs") {
        if (Option.isNone(blobBucket)) {
          return yield* Effect.fail(
            configError("KVITBIT_BLOB_BUCKET is required when KVITBIT_BLOB_DRIVER=gcs"),
          );
        }
        storage = { _tag: "gcs", bucket: blobBucket.value, endpoint: gcsEndpoint };
      } else if (blobDriver.value === "local") {
        storage = {
          _tag: "local",
          dir: Option.getOrElse(blobDir, () => DEFAULT_BLOB_DIR),
        };
      } else {
        return yield* Effect.fail(
          configError(`Unsupported KVITBIT_BLOB_DRIVER: ${quote(blobDriver.value)}`),
        );
      }
    } else if (Option.isSome(blobBucket)) {
      storage = { _tag: "gcs", bucket: blobBucket.value, endpoint: gcsEndpoint };
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
      for (const entry of Str.split(rawFingerprints.value, ",")) {
        const trimmed = Str.trim(entry);
        if (trimmed.length === 0) continue;
        const normalized = normalizeFingerprint(trimmed);
        if (normalized === undefined) {
          return yield* Effect.fail(
            configError(
              `Invalid SHA-256 fingerprint in KVITBIT_ANDROID_ASSETLINKS_SHA256: ${quote(trimmed)}`,
            ),
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
