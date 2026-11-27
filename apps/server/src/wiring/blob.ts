/**
 * Live `BlobStorage` port wiring: LocalDisk (`KVITBIT_BLOB_DRIVER=local`) or GCS (`gcs`).
 */

import { GcsAccessTokens, GcsBlobStorage, LocalDiskBlobStorage } from "@kvitbit/adapters/blob";
import { BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { type BlobWiringConfig, BlobWiringConfigSchema } from "./config";

/** Builds a `BlobStorage` layer from explicit config (used by live wiring and tests). */
export const makeBlobStorageLayer = (
  config: BlobWiringConfig,
): Layer.Layer<BlobStorage, BlobUnavailable> => {
  if (config.driver === "gcs") {
    if (Option.isNone(config.gcsBucket) || Str.trim(config.gcsBucket.value) === "") {
      return Layer.effect(
        BlobStorage,
        Effect.fail(
          new BlobUnavailable({
            cause: "KVITBIT_BLOB_BUCKET is required when KVITBIT_BLOB_DRIVER=gcs",
          }),
        ),
      );
    }
    const bucket = Str.trim(config.gcsBucket.value);
    return GcsBlobStorage.layer({ bucket }).pipe(
      Layer.provide(GcsAccessTokens.metadataServer),
      Layer.provide(FetchHttpClient.layer),
    );
  }
  return LocalDiskBlobStorage.layer({ root: config.localDir });
};

/**
 * Live `BlobStorage` configured from `KVITBIT_BLOB_DRIVER` (`local` | `gcs`),
 * `KVITBIT_BLOB_DIR`, `KVITBIT_BLOB_BUCKET`, and `KVITBIT_GCS_PROJECT`.
 */
export const BlobStorageLive: Layer.Layer<BlobStorage, BlobUnavailable | Config.ConfigError> =
  Layer.unwrap(Effect.map(BlobWiringConfigSchema, makeBlobStorageLayer));
