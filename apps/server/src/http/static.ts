/**
 * Static asset mounts (board agreements #871, #873, #877, #878):
 * - `KVITBIT_PWA_DIR` -> `/app/` (SPA fallback to `/app/index.html`; `no-cache` on `index.html`,
 *   `sw.js`, `manifest.webmanifest`; `public, max-age=31536000, immutable` on hashed assets).
 * - `KVITBIT_WEB_DIR` -> `/` (SPA fallback to `/index.html` excluding `/api`, `/mcp`, `/app/`,
 *   `/assets/`, `/.well-known`; `no-cache` on `index.html`; `immutable` on `/assets/*`).
 *
 * Absent or non-existent directories are simply not mounted. Path traversal is rejected.
 */
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { POSTHOG_PROXY_PATH } from "./analyticsProxy";
import { HttpConfig } from "./config";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const isPathType = (fs: FileSystem.FileSystem, filePath: string, type: FileSystem.File.Type) =>
  fs
    .stat(filePath)
    .pipe(Effect.match({ onSuccess: (info) => info.type === type, onFailure: () => false }));

const decodePath = Option.liftThrowable(decodeURIComponent);
const LEADING_SLASHES = /^\/+/;
const HASHED_ASSET = /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i;
const PUBLIC_SHARE = /^\/i\/[^/]+\/?$/;

/** Resolves `relativePath` strictly inside `rootDir`; returns undefined on traversal. */
const safeResolve = (
  path: Path.Path,
  rootDir: string,
  relativePath: string,
): string | undefined => {
  const decoded = decodePath(relativePath);
  if (Option.isNone(decoded) || Str.includes("\0")(decoded.value)) return undefined;
  const trimmed = Str.replace(LEADING_SLASHES, "")(decoded.value);
  const root = path.resolve(rootDir);
  const target = path.resolve(root, trimmed);
  if (target !== root && !Str.startsWith(root + path.sep)(target)) return undefined;
  return target;
};

const serveFile = Effect.fn("serveStaticFile")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  cacheControl: string,
  headOnly: boolean,
) {
  const bytes = headOnly ? new Uint8Array(0) : yield* Effect.orDie(fs.readFile(filePath));
  const size = headOnly
    ? yield* fs
        .stat(filePath)
        .pipe(Effect.match({ onSuccess: (info) => info.size, onFailure: () => 0 }))
    : bytes.byteLength;
  return HttpServerResponse.uint8Array(bytes, {
    status: 200,
    headers: {
      "content-type":
        CONTENT_TYPES[Str.toLowerCase(path.extname(filePath))] ?? "application/octet-stream",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "content-length": String(size),
    },
  });
});

const notFound = HttpServerResponse.empty({ status: 404 });

const PWA_NO_CACHE = new Set(["index.html", "sw.js", "manifest.webmanifest"]);

const isHashedAsset = (rel: string): boolean =>
  Str.startsWith("assets/")(rel) || Str.startsWith("_expo/static/")(rel) || HASHED_ASSET.test(rel);

const WEB_EXCLUDED_PREFIXES = [
  "/api/",
  "/mcp/",
  "/app/",
  "/assets/",
  "/.well-known/",
  `${POSTHOG_PROXY_PATH}/`,
];
const WEB_EXCLUDED_EXACT = new Set([
  "/api",
  "/mcp",
  "/app",
  "/assets",
  "/.well-known",
  POSTHOG_PROXY_PATH,
]);

const isWebFallbackExcluded = (pathname: string): boolean =>
  WEB_EXCLUDED_EXACT.has(pathname) ||
  Arr.some(WEB_EXCLUDED_PREFIXES, (prefix) => Str.startsWith(prefix)(pathname));

const pwaHandler = Effect.fn("servePwa")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headOnly = Str.toUpperCase(request.method) === "HEAD";
  const pathname = new URL(request.url, "http://localhost").pathname;
  const rel =
    pathname === "/app" || pathname === "/app/"
      ? "index.html"
      : Str.slice("/app/".length)(pathname);
  const candidate = safeResolve(path, rootDir, rel);

  if (candidate !== undefined && (yield* isPathType(fs, candidate, "File"))) {
    const cacheControl = PWA_NO_CACHE.has(rel)
      ? "no-cache"
      : isHashedAsset(rel)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300";
    return yield* serveFile(fs, path, candidate, cacheControl, headOnly);
  }

  // Don't SPA-fallback missing static asset files under /app/_expo/static/ or /app/assets/
  if (Str.startsWith("assets/")(rel) || Str.startsWith("_expo/static/")(rel)) {
    return notFound;
  }

  const indexPath = safeResolve(path, rootDir, "index.html");
  if (indexPath !== undefined && (yield* isPathType(fs, indexPath, "File"))) {
    return yield* serveFile(fs, path, indexPath, "no-cache", headOnly);
  }
  return notFound;
});

const webHandler = Effect.fn("serveWeb")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headOnly = Str.toUpperCase(request.method) === "HEAD";
  const pathname = new URL(request.url, "http://localhost").pathname;
  const rel = pathname === "/" ? "index.html" : Str.slice(1)(pathname);
  const candidate = safeResolve(path, rootDir, rel);

  if (candidate !== undefined && (yield* isPathType(fs, candidate, "File"))) {
    const cacheControl =
      rel === "index.html"
        ? "no-cache"
        : Str.startsWith("assets/")(rel) && !Str.startsWith("assets/brand/")(rel)
          ? "public, max-age=31536000, immutable"
          : isHashedAsset(rel)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=300";
    return yield* serveFile(fs, path, candidate, cacheControl, headOnly);
  }

  if (isWebFallbackExcluded(pathname)) {
    return notFound;
  }

  const indexPath = safeResolve(path, rootDir, "index.html");
  if (indexPath !== undefined && (yield* isPathType(fs, indexPath, "File"))) {
    if (PUBLIC_SHARE.test(pathname)) {
      const page = yield* serveFile(fs, path, indexPath, "private, no-store", headOnly);
      return HttpServerResponse.setHeaders(page, {
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
      });
    }
    return yield* serveFile(fs, path, indexPath, "no-cache", headOnly);
  }
  return notFound;
});

/** Registers optional PWA (`/app/*`) and Web (`/*`) static mounts from `HttpConfig`. */
export const StaticRoutesLive = HttpRouter.use(
  Effect.fn("mountStaticRoutes")(function* (router: HttpRouter.HttpRouter) {
    const { pwaDir, webDir } = yield* HttpConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (Option.isSome(pwaDir) && (yield* isPathType(fs, pwaDir.value, "Directory"))) {
      yield* router.add("GET", "/app/*", pwaHandler(fs, path, pwaDir.value));
    }

    if (Option.isSome(webDir) && (yield* isPathType(fs, webDir.value, "Directory"))) {
      yield* router.add("GET", "/*", webHandler(fs, path, webDir.value));
    }
  }),
).pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]));
