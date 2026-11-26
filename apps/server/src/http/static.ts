/**
 * Static asset mounts (board agreements #871, #873, #877, #878):
 * - `KVITBIT_PWA_DIR` -> `/app/` (SPA fallback to `/app/index.html`; `no-cache` on `index.html`,
 *   `sw.js`, `manifest.webmanifest`; `public, max-age=31536000, immutable` on hashed assets).
 * - `KVITBIT_WEB_DIR` -> `/` (SPA fallback to `/index.html` excluding `/api`, `/mcp`, `/app/`,
 *   `/assets/`, `/.well-known`; `no-cache` on `index.html`; `immutable` on `/assets/*`).
 *
 * Absent or non-existent directories are simply not mounted. Path traversal is rejected.
 */
import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
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

const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";

const isExistingFile = (filePath: string): boolean => {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const isExistingDir = (dirPath: string): boolean => {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
};

/** Resolves `relativePath` strictly inside `rootDir`; returns undefined on traversal. */
const safeResolve = (rootDir: string, relativePath: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const trimmed = decoded.replace(/^\/+/, "");
  const root = resolve(rootDir);
  const target = resolve(root, trimmed);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
};

const serveFile = (
  filePath: string,
  cacheControl: string,
  headOnly: boolean,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.promise(async () => {
    const file = Bun.file(filePath);
    const bytes = headOnly ? new Uint8Array(0) : new Uint8Array(await file.arrayBuffer());
    return HttpServerResponse.uint8Array(bytes, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(filePath),
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
        "content-length": String(file.size),
      },
    });
  });

const notFound = HttpServerResponse.empty({ status: 404 });

const PWA_NO_CACHE = new Set(["index.html", "sw.js", "manifest.webmanifest"]);

const isHashedAsset = (rel: string): boolean =>
  rel.startsWith("assets/") ||
  rel.startsWith("_expo/static/") ||
  /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(rel);

const WEB_EXCLUDED_PREFIXES = ["/api/", "/mcp/", "/app/", "/assets/", "/.well-known/"];
const WEB_EXCLUDED_EXACT = new Set(["/api", "/mcp", "/app", "/assets", "/.well-known"]);

const isWebFallbackExcluded = (pathname: string): boolean =>
  WEB_EXCLUDED_EXACT.has(pathname) ||
  WEB_EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

const makePwaHandler = (rootDir: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const headOnly = request.method.toUpperCase() === "HEAD";
    const pathname = new URL(request.url, "http://localhost").pathname;
    const rel =
      pathname === "/app" || pathname === "/app/" ? "index.html" : pathname.slice("/app/".length);
    const candidate = safeResolve(rootDir, rel);

    if (candidate !== undefined && isExistingFile(candidate)) {
      const cacheControl = PWA_NO_CACHE.has(rel)
        ? "no-cache"
        : isHashedAsset(rel)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300";
      return yield* serveFile(candidate, cacheControl, headOnly);
    }

    // Don't SPA-fallback missing static asset files under /app/_expo/static/ or /app/assets/
    if (rel.startsWith("assets/") || rel.startsWith("_expo/static/")) {
      return notFound;
    }

    const indexPath = safeResolve(rootDir, "index.html");
    if (indexPath !== undefined && isExistingFile(indexPath)) {
      return yield* serveFile(indexPath, "no-cache", headOnly);
    }
    return notFound;
  });

const makeWebHandler = (rootDir: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const headOnly = request.method.toUpperCase() === "HEAD";
    const pathname = new URL(request.url, "http://localhost").pathname;
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = safeResolve(rootDir, rel);

    if (candidate !== undefined && isExistingFile(candidate)) {
      const cacheControl =
        rel === "index.html"
          ? "no-cache"
          : rel.startsWith("assets/") && !rel.startsWith("assets/brand/")
            ? "public, max-age=31536000, immutable"
            : isHashedAsset(rel)
              ? "public, max-age=31536000, immutable"
              : "public, max-age=300";
      return yield* serveFile(candidate, cacheControl, headOnly);
    }

    if (isWebFallbackExcluded(pathname)) {
      return notFound;
    }

    const indexPath = safeResolve(rootDir, "index.html");
    if (indexPath !== undefined && isExistingFile(indexPath)) {
      if (/^\/i\/[^/]+\/?$/.test(pathname)) {
        const page = yield* serveFile(indexPath, "private, no-store", headOnly);
        return HttpServerResponse.setHeaders(page, {
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex",
        });
      }
      return yield* serveFile(indexPath, "no-cache", headOnly);
    }
    return notFound;
  });

/** Registers optional PWA (`/app/*`) and Web (`/*`) static mounts from `HttpConfig`. */
export const StaticRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* HttpConfig;

    if (Option.isSome(config.pwaDir) && isExistingDir(config.pwaDir.value)) {
      const pwaHandler = makePwaHandler(config.pwaDir.value);
      yield* router.add("GET", "/app/*", pwaHandler);
    }

    if (Option.isSome(config.webDir) && isExistingDir(config.webDir.value)) {
      const webHandler = makeWebHandler(config.webDir.value);
      yield* router.add("GET", "/*", webHandler);
    }
  }),
);
