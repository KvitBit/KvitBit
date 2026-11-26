/**
 * Raw HttpRouter routes for Expo Updates v1, Android releases, and Android App Links
 * (http-mcp-contracts section 5, board contract #929).
 *
 * Routes:
 *   GET /api/mobile/updates/manifest
 *   GET /api/mobile/updates/assets/:sha256
 *   GET /api/mobile/releases/latest
 *   GET /api/mobile/releases/:version/apk
 *   GET /.well-known/assetlinks.json
 */
import { ReleaseInfo } from "@kvitbit/api-contract";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { MobileConfig, type MobileConfigShape } from "./config";
import {
  androidPackage,
  apkContentType,
  apkFileName,
  assetKey,
  assetMetaKey,
  immutableCacheControl,
  isValidReleaseVersion,
  isValidSha256,
  latestPublicationKey,
  latestRelease,
  obtainiumImportUrl,
  parseAssetMeta,
  parsePublication,
  publicationPrefix,
  releaseApkKey,
  releasePrefix,
  type StoredPublication,
} from "./layout";
import { buildManifestResponse, type HeaderReader, readManifestRequest } from "./manifest";
import { MobileStorage, type MobileStorageShape } from "./storage";

const textEncoder = new TextEncoder();

const noStoreHeaders = { "cache-control": "no-store" } as const;

const headerReaderOf = (request: HttpServerRequest.HttpServerRequest): HeaderReader => ({
  get: (name: string) => {
    const value = request.headers[name.toLowerCase()];
    return typeof value === "string" ? value : null;
  },
});

const searchParamsOf = (request: HttpServerRequest.HttpServerRequest, origin: string) =>
  new URL(request.url, origin).searchParams;

const releaseInfoKeyPattern = /^mobile\/releases\/[^/]+\/release\.json$/;

const decodeReleaseInfo = Schema.decodeUnknownEffect(ReleaseInfo);

const handleManifest =
  (config: MobileConfigShape, storage: MobileStorageShape) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const parsed = readManifestRequest(
        headerReaderOf(request),
        searchParamsOf(request, config.appOrigin),
      );
      if (parsed._tag === "Rejected") {
        return HttpServerResponse.text(parsed.message, {
          status: parsed.status,
          headers: noStoreHeaders,
        });
      }

      const prefix = publicationPrefix({
        channel: parsed.channel,
        platform: parsed.platform,
        runtimeVersion: parsed.runtimeVersion,
      });

      const keysResult = yield* Effect.result(storage.list(prefix));
      if (keysResult._tag === "Failure") {
        return HttpServerResponse.text("Mobile update storage is unavailable", {
          status: 503,
          headers: noStoreHeaders,
        });
      }

      const latestKey = latestPublicationKey(keysResult.success);
      let latest: StoredPublication | undefined;
      if (latestKey !== undefined) {
        const jsonResult = yield* Effect.result(storage.getText(latestKey));
        if (jsonResult._tag === "Failure") {
          if (jsonResult.failure._tag === "MobileStorageUnavailable") {
            return HttpServerResponse.text("Mobile update storage is unavailable", {
              status: 503,
              headers: noStoreHeaders,
            });
          }
          // Race where object disappeared between list and get: treat as no update.
          latest = undefined;
        } else {
          try {
            latest = parsePublication(jsonResult.success);
          } catch {
            return HttpServerResponse.text("Stored mobile update manifest is malformed", {
              status: 500,
              headers: noStoreHeaders,
            });
          }
        }
      }

      const signingKeyPem = Option.getOrUndefined(
        Option.map(config.signingKeyPem, (redacted) => Redacted.value(redacted)),
      );
      const built = buildManifestResponse({
        request: parsed,
        latest,
        origin: config.appOrigin,
        signingKeyPem,
      });
      if (built._tag === "SigningUnavailable") {
        return HttpServerResponse.text(built.message, {
          status: 503,
          headers: noStoreHeaders,
        });
      }

      const { "content-type": contentType, ...otherHeaders } = built.headers;
      return HttpServerResponse.uint8Array(textEncoder.encode(built.body), {
        status: 200,
        contentType,
        headers: otherHeaders,
      });
    });

const handleUpdateAsset = (storage: MobileStorageShape) => () =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const sha256 = params.sha256 ?? "";
    if (!isValidSha256(sha256)) {
      return HttpServerResponse.text("Update asset not found", {
        status: 404,
        headers: noStoreHeaders,
      });
    }

    const streamResult = yield* Effect.result(storage.getStream(assetKey(sha256)));
    if (streamResult._tag === "Failure") {
      if (streamResult.failure._tag === "MobileStorageNotFound") {
        return HttpServerResponse.text("Update asset not found", {
          status: 404,
          headers: noStoreHeaders,
        });
      }
      return HttpServerResponse.text("Mobile update storage is unavailable", {
        status: 503,
        headers: noStoreHeaders,
      });
    }

    const metaResult = yield* Effect.result(storage.getText(assetMetaKey(sha256)));
    let contentType = streamResult.success.contentType ?? "application/octet-stream";
    if (metaResult._tag === "Success") {
      try {
        contentType = parseAssetMeta(metaResult.success).contentType;
      } catch {
        // Fall back to stream content-type / octet-stream if sidecar is unreadable.
      }
    }

    const headers: Record<string, string> = {
      "cache-control": immutableCacheControl,
      "x-content-type-options": "nosniff",
    };
    if (streamResult.success.size !== undefined) {
      headers["content-length"] = String(streamResult.success.size);
    }

    return HttpServerResponse.stream(streamResult.success.stream, {
      status: 200,
      contentType,
      headers,
    });
  });

const handleLatestRelease = (config: MobileConfigShape, storage: MobileStorageShape) => () =>
  Effect.gen(function* () {
    const keysResult = yield* Effect.result(storage.list(releasePrefix));
    if (keysResult._tag === "Failure") {
      return HttpServerResponse.text("Mobile release storage is unavailable", {
        status: 503,
        headers: noStoreHeaders,
      });
    }

    const releaseKeys = keysResult.success.filter((key) => releaseInfoKeyPattern.test(key));
    if (releaseKeys.length === 0) {
      return HttpServerResponse.jsonUnsafe(
        { error: "No Android release published" },
        { status: 404, headers: noStoreHeaders },
      );
    }

    const releases: Array<ReleaseInfo> = [];
    for (const key of releaseKeys) {
      const jsonResult = yield* Effect.result(storage.getText(key));
      if (jsonResult._tag === "Failure") {
        if (jsonResult.failure._tag === "MobileStorageUnavailable") {
          return HttpServerResponse.text("Mobile release storage is unavailable", {
            status: 503,
            headers: noStoreHeaders,
          });
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonResult.success);
      } catch {
        return HttpServerResponse.text("Stored Android release metadata is malformed", {
          status: 500,
          headers: noStoreHeaders,
        });
      }
      const decoded = yield* Effect.result(decodeReleaseInfo(parsed));
      if (decoded._tag === "Failure") {
        return HttpServerResponse.text("Stored Android release metadata is malformed", {
          status: 500,
          headers: noStoreHeaders,
        });
      }
      releases.push(decoded.success);
    }

    const newest = latestRelease(releases);
    if (newest === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "No Android release published" },
        { status: 404, headers: noStoreHeaders },
      );
    }

    const payload: ReleaseInfo = {
      ...newest,
      obtainiumUrl: obtainiumImportUrl(config.appOrigin),
    };

    return HttpServerResponse.jsonUnsafe(payload, {
      status: 200,
      headers: { "cache-control": "public, max-age=300" },
    });
  });

const handleReleaseApk = (storage: MobileStorageShape) => () =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const version = params.version ?? "";
    if (!isValidReleaseVersion(version)) {
      return HttpServerResponse.text("Release APK not found", {
        status: 404,
        headers: noStoreHeaders,
      });
    }

    const streamResult = yield* Effect.result(storage.getStream(releaseApkKey(version)));
    if (streamResult._tag === "Failure") {
      if (streamResult.failure._tag === "MobileStorageNotFound") {
        return HttpServerResponse.text("Release APK not found", {
          status: 404,
          headers: noStoreHeaders,
        });
      }
      return HttpServerResponse.text("Mobile release storage is unavailable", {
        status: 503,
        headers: noStoreHeaders,
      });
    }

    const headers: Record<string, string> = {
      "content-disposition": `attachment; filename="${apkFileName(version)}"`,
      "cache-control": immutableCacheControl,
      "x-content-type-options": "nosniff",
    };
    if (streamResult.success.size !== undefined) {
      headers["content-length"] = String(streamResult.success.size);
    }

    return HttpServerResponse.stream(streamResult.success.stream, {
      status: 200,
      contentType: apkContentType,
      headers,
    });
  });

const handleAssetLinks = (config: MobileConfigShape) => () =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      config.androidAssetLinksSha256.length === 0
        ? []
        : [
            {
              relation: ["delegate_permission/common.handle_all_urls"],
              target: {
                namespace: "android_app",
                package_name: androidPackage,
                sha256_cert_fingerprints: config.androidAssetLinksSha256,
              },
            },
          ],
      {
        status: 200,
        headers: { "cache-control": "public, max-age=3600" },
      },
    ),
  );

/** Registers all 5 mobile updates, Android release, and App Links routes on `HttpRouter`. */
export const MobileRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* MobileConfig;
    const storage = yield* MobileStorage;
    yield* router.add("GET", "/api/mobile/updates/manifest", handleManifest(config, storage));
    yield* router.add("GET", "/api/mobile/updates/assets/:sha256", handleUpdateAsset(storage));
    yield* router.add("GET", "/api/mobile/releases/latest", handleLatestRelease(config, storage));
    yield* router.add("GET", "/api/mobile/releases/:version/apk", handleReleaseApk(storage));
    yield* router.add("GET", "/.well-known/assetlinks.json", handleAssetLinks(config));
  }),
);
