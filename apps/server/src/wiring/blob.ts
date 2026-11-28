/**
 * Live `BlobStorage` port wiring: LocalDisk (`KVITBIT_BLOB_DRIVER=local`) or GCS (`gcs`),
 * validated against the typed-mode environment contract.
 */
import { GcsAccessTokens, GcsBlobStorage, LocalDiskBlobStorage } from "@kvitbit/adapters/blob";
import { BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import { type Config, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  type KvitbitEnv,
  liftValidation,
  loadKvitbitEnv,
  resolveBlobConfig,
} from "../config-contract";
import { type BlobWiringConfig, BlobWiringConfigSchema } from "./config";

/** Builds a `BlobStorage` layer from explicit config (used by live wiring and tests). */
export const makeBlobStorageLayer = (
  config: BlobWiringConfig,
  env: KvitbitEnv = "development",
): Layer.Layer<BlobStorage, BlobUnavailable | Config.ConfigError> => {
  const checked = resolveBlobConfig(env, {
    driver: config.driver,
    bucket: Option.getOrUndefined(config.gcsBucket),
    localDir: config.localDir,
    gcsProject: Option.getOrUndefined(config.gcsProject),
  });
  if (!checked.ok) {
    if (
      config.driver === "gcs" &&
      (Option.isNone(config.gcsBucket) || config.gcsBucket.value.trim() === "")
    ) {
      return Layer.effect(
        BlobStorage,
        Effect.fail(
          new BlobUnavailable({
            cause: checked.error.reason,
          }),
        ),
      );
    }
    return Layer.effect(
      BlobStorage,
      liftValidation(checked) as Effect.Effect<never, Config.ConfigError>,
    );
  }

  if (checked.value.driver === "gcs") {
    return GcsBlobStorage.layer({ bucket: checked.value.gcsBucket ?? "" }).pipe(
      Layer.provide(GcsAccessTokens.metadataServer),
      Layer.provide(FetchHttpClient.layer),
    );
  }
  return LocalDiskBlobStorage.layer({ root: checked.value.localDir });
};

/**
 * Live `BlobStorage` configured from `KVITBIT_ENV`/`NODE_ENV`, `KVITBIT_BLOB_DRIVER` (`local` | `gcs`),
 * `KVITBIT_BLOB_DIR`, `KVITBIT_BLOB_BUCKET`, and `KVITBIT_GCS_PROJECT`.
 */
export const BlobStorageLive: Layer.Layer<BlobStorage, BlobUnavailable | Config.ConfigError> =
  Layer.unwrap(
    Effect.gen(function* () {
      const env = yield* loadKvitbitEnv;
      const config = yield* BlobWiringConfigSchema;
      return makeBlobStorageLayer(config, env);
    }),
  );
