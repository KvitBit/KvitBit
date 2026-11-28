import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
/**
 * Live `BlobStorage` port wiring: LocalDisk (`KVITBIT_BLOB_DRIVER=local`) or GCS (`gcs`),
 * validated against the typed-mode environment contract.
 */

import { GcsAccessTokens, GcsBlobStorage, LocalDiskBlobStorage } from "@kvitbit/adapters/blob";
import { BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  type KvitbitEnv,
  loadKvitbitEnv,
  resolveBlobConfig,
  toConfigError,
} from "../config-contract";
import { type BlobWiringConfig, BlobWiringConfigSchema } from "./config";

/** Builds a `BlobStorage` layer from explicit config (used by live wiring and tests). */
const makeBlobStorageLayerImpl = (
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
      (Option.isNone(config.gcsBucket) || Str.trim(config.gcsBucket.value) === "")
    ) {
      return Layer.effect(
        BlobStorage,
        Effect.fail(
          BlobUnavailable.make({
            cause: checked.error.reason,
          }),
        ),
      );
    }
    const error = toConfigError(checked.error);
    return Layer.effect(BlobStorage)(Effect.fail(error));
  }

  if (checked.value.driver === "gcs") {
    return GcsBlobStorage.layer({ bucket: checked.value.gcsBucket ?? "" }).pipe(
      Layer.provide(GcsAccessTokens.metadataServer),
      Layer.provide(FetchHttpClient.layer),
    );
  }
  return LocalDiskBlobStorage.layer({ root: checked.value.localDir });
};

export const makeBlobStorageLayer: {
  (env?: KvitbitEnv): (config: BlobWiringConfig) => ReturnType<typeof makeBlobStorageLayerImpl>;
  (config: BlobWiringConfig, env?: KvitbitEnv): ReturnType<typeof makeBlobStorageLayerImpl>;
} = Fn.dual((args) => Predicate.isObject(args[0]), makeBlobStorageLayerImpl);

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
