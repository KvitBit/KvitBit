/**
 * First-party reverse proxy for browser PostHog ingestion (`/_kvb/*`).
 *
 * Keeps browser pageview ingestion on the active Kvitbit origin so ad/tracker blockers do not
 * block third-party `*.posthog.com` requests, while enforcing strict privacy and abuse controls:
 * - Only forwards allowlisted PostHog ingestion POST paths (`/e`, `/i/v0/e`, `/batch`) and query params.
 * - Strips all Kvitbit credentials (`cookie`, `authorization`, `x-api-key`) and referrer/origin headers.
 * - Forwards the validated visitor IP via `x-forwarded-for` for EU cookieless daily hashing.
 * - Enforces same-host/trusted Origin, 64 KB body cap, per-IP rate limiting, no redirects, and a 5 s timeout.
 */
import { ByteSize, Clock, Effect } from "effect";
import { FetchHttpClient, HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpConfig, type HttpConfigShape } from "./config";
import { RATE_LIMITS, RateLimiter } from "./edge/RateLimiter";
import { clientIp } from "./edge/request";

export const POSTHOG_PROXY_PATH = "/_kvb";

const BODY_MAX_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;

const ALLOWED_INGESTION_PATHS = new Set(["/e", "/e/", "/i/v0/e", "/i/v0/e/", "/batch", "/batch/"]);
const ALLOWED_QUERY_PARAMS = ["ip", "_", "ver", "compression", "retry_count", "beacon"] as const;
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "content-encoding",
  "accept",
  "user-agent",
] as const;

const notFound = HttpServerResponse.empty({ status: 404 });
const forbidden = HttpServerResponse.empty({ status: 403 });
const malformed = HttpServerResponse.empty({ status: 400 });
const oversized = HttpServerResponse.empty({ status: 413 });
const badGateway = HttpServerResponse.empty({
  status: 502,
  headers: { "cache-control": "no-store" },
});

const isAllowedOrigin = (
  originHeader: string | undefined,
  hostHeader: string | undefined,
  config: HttpConfigShape,
): boolean => {
  if (originHeader === undefined) return true;
  const parsed = URL.parse(originHeader);
  if (parsed === null) return false;
  if (config.trustedOrigins.has(parsed.origin) || config.corsOrigins.includes(parsed.origin)) {
    return true;
  }
  return hostHeader !== undefined && parsed.host.toLowerCase() === hostHeader.toLowerCase();
};

export const AnalyticsProxyRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    const limiter = yield* RateLimiter;
    const clock = yield* Clock.Clock;
    const fetch = yield* FetchHttpClient.Fetch;

    yield* router.add(
      "POST",
      `${POSTHOG_PROXY_PATH}/*`,
      Effect.gen(function* () {
        if (config.posthog === null) return notFound;

        const request = yield* HttpServerRequest;
        const incomingUrl = URL.parse(request.url, config.appOrigin);
        if (incomingUrl === null || !incomingUrl.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
          return notFound;
        }
        const subpath = incomingUrl.pathname.slice(POSTHOG_PROXY_PATH.length);
        if (!ALLOWED_INGESTION_PATHS.has(subpath)) return notFound;

        if (!isAllowedOrigin(request.headers.origin, request.headers.host, config)) {
          return forbidden;
        }

        const ip = clientIp(request, config.trustedProxyHops);
        const decision = yield* limiter
          .consume(`analytics-proxy:${ip}`, RATE_LIMITS.analyticsProxy)
          .pipe(Effect.provideService(Clock.Clock, clock));
        if (!decision.allowed) {
          return HttpServerResponse.empty({
            status: 429,
            headers: {
              "retry-after": String(decision.retryAfterSeconds),
              "cache-control": "no-store",
            },
          });
        }

        if (Number(request.headers["content-length"]) > BODY_MAX_BYTES) return oversized;

        const bodyResult = yield* request.arrayBuffer.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(BODY_MAX_BYTES)),
          Effect.result,
        );
        if (bodyResult._tag === "Failure") {
          const reason = bodyResult.failure.reason;
          return reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge"
            ? oversized
            : malformed;
        }

        const upstreamBase = config.posthog.host.replace(/\/+$/, "");
        const upstreamUrl = new URL(`${upstreamBase}${subpath}`);
        for (const key of ALLOWED_QUERY_PARAMS) {
          const value = incomingUrl.searchParams.get(key);
          if (value !== null) upstreamUrl.searchParams.set(key, value);
        }

        const headers = new Headers();
        for (const name of FORWARDED_REQUEST_HEADERS) {
          const value = request.headers[name];
          if (value !== undefined) headers.set(name, value);
        }
        if (ip !== "unknown") {
          headers.set("x-forwarded-for", ip);
        }

        const upstream = yield* Effect.tryPromise(() =>
          fetch(upstreamUrl.toString(), {
            method: "POST",
            headers,
            body: new Uint8Array(bodyResult.success),
            redirect: "manual",
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          }),
        ).pipe(Effect.orElseSucceed(() => null));
        if (upstream === null || (upstream.status >= 300 && upstream.status < 400)) {
          return badGateway;
        }

        const responseBytes = yield* Effect.tryPromise(
          async () => new Uint8Array(await upstream.arrayBuffer()),
        ).pipe(Effect.orElseSucceed(() => null));
        if (responseBytes === null) return badGateway;

        const contentType = upstream.headers.get("content-type");
        return HttpServerResponse.uint8Array(responseBytes, {
          status: upstream.status,
          headers: {
            ...(contentType === null ? {} : { "content-type": contentType }),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }),
    );
  }),
);
