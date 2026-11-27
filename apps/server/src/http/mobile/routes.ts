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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
  type ReadPublication,
  releaseApkKey,
  releasePrefix,
} from "./layout";
import { buildManifestResponse, type HeaderReader, readManifestRequest } from "./manifest";
import { MobileStorage, type MobileStorageShape } from "./storage";

const textEncoder = new TextEncoder();

const noStoreHeaders = { "cache-control": "no-store" } as const;

const headerReaderOf = (request: HttpServerRequest.HttpServerRequest): HeaderReader => ({
  get: (name) => Option.getOrNull(Headers.get(request.headers, name)),
});

const searchParamsOf = (request: HttpServerRequest.HttpServerRequest, origin: string) =>
  new URL(request.url, origin).searchParams;

const releaseInfoKeyPattern = /^mobile\/releases\/[^/]+\/release\.json$/;

const decodeReleaseInfo = Schema.decodeEffect(Schema.fromJsonString(ReleaseInfo));

const handleManifest = (config: MobileConfigShape, storage: MobileStorageShape) =>
  Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    const parsed = readManifestRequest({
      headers: headerReaderOf(request),
      query: searchParamsOf(request, config.appOrigin),
    });
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
    let latest: ReadPublication | undefined;
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
        const publication = yield* Effect.result(parsePublication(jsonResult.success));
        if (publication._tag === "Failure") {
          return HttpServerResponse.text("Stored mobile update manifest is malformed", {
            status: 500,
            headers: noStoreHeaders,
          });
        }
        latest = publication.success;
      }
    }

    const signingKeyPem = Option.getOrUndefined(
      Option.map(config.signingKeyPem, (redacted) => Redacted.value(redacted)),
    );
    const built = yield* buildManifestResponse({
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

const handleUpdateAsset = (storage: MobileStorageShape) =>
  Effect.fnUntraced(function* () {
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
      const metadata = yield* Effect.result(parseAssetMeta(metaResult.success));
      if (metadata._tag === "Success") contentType = metadata.success.contentType;
    }

    const headers = {
      "cache-control": immutableCacheControl,
      "x-content-type-options": "nosniff",
    };
    if (streamResult.success.size !== undefined) {
      Object.assign(headers, { "content-length": String(streamResult.success.size) });
    }

    return HttpServerResponse.stream(streamResult.success.stream, {
      status: 200,
      contentType,
      headers,
    });
  });

const handleLatestRelease = (config: MobileConfigShape, storage: MobileStorageShape) =>
  Effect.fnUntraced(function* () {
    const keysResult = yield* Effect.result(storage.list(releasePrefix));
    if (keysResult._tag === "Failure") {
      return HttpServerResponse.text("Mobile release storage is unavailable", {
        status: 503,
        headers: noStoreHeaders,
      });
    }

    const releaseKeys = Arr.filter(keysResult.success, (key) => releaseInfoKeyPattern.test(key));
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
      const decoded = yield* Effect.result(decodeReleaseInfo(jsonResult.success));
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

const handleReleaseApk = (storage: MobileStorageShape) =>
  Effect.fnUntraced(function* () {
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

    const headers = {
      "content-disposition": `attachment; filename="${apkFileName(version)}"`,
      "cache-control": immutableCacheControl,
      "x-content-type-options": "nosniff",
    };
    if (streamResult.success.size !== undefined) {
      Object.assign(headers, { "content-length": String(streamResult.success.size) });
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
export const MobileRoutesLive = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const config = yield* MobileConfig;
    const storage = yield* MobileStorage;
    yield* router.add("GET", "/api/mobile/updates/manifest", handleManifest(config, storage));
    yield* router.add("GET", "/api/mobile/updates/assets/:sha256", handleUpdateAsset(storage));
    yield* router.add("GET", "/api/mobile/releases/latest", handleLatestRelease(config, storage));
    yield* router.add("GET", "/api/mobile/releases/:version/apk", handleReleaseApk(storage));
    yield* router.add("GET", "/.well-known/assetlinks.json", handleAssetLinks(config));
  }),
);
