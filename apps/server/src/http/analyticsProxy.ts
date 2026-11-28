import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Str from "effect/String";
import { HttpConfig, type HttpConfigShape } from "./config";
import { RATE_LIMITS, RateLimiter } from "./edge/RateLimiter";
import { clientIp } from "./edge/request";

const upstreamBasePattern = /\/+$/;

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
  return hostHeader !== undefined && Str.toLowerCase(parsed.host) === Str.toLowerCase(hostHeader);
};

export const AnalyticsProxyRoutesLive = HttpRouter.use(
  Effect.fn("AnalyticsProxy.register")(function* (router) {
    const config = yield* HttpConfig;
    const limiter = yield* RateLimiter;
    const clock = yield* Clock.Clock;
    const fetch = yield* FetchHttpClient.Fetch;

    yield* router.add(
      "POST",
      `${POSTHOG_PROXY_PATH}/*`,
      Effect.gen(function* () {
        if (config.posthog === null) return notFound;

        const request = yield* HttpServerRequest.HttpServerRequest;
        const incomingUrl = URL.parse(request.url, config.appOrigin);
        if (
          incomingUrl === null ||
          !Str.startsWith(`${POSTHOG_PROXY_PATH}/`)(incomingUrl.pathname)
        ) {
          return notFound;
        }
        const subpath = Str.slice(POSTHOG_PROXY_PATH.length)(incomingUrl.pathname);
        if (!ALLOWED_INGESTION_PATHS.has(subpath)) return notFound;

        if (!isAllowedOrigin(request.headers["origin"], request.headers["host"], config)) {
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

        const upstreamBase = Str.replace(upstreamBasePattern, "")(config.posthog.host);
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

        const upstream = yield* Effect.tryPromise({
          try: () =>
            fetch(upstreamUrl.toString(), {
              method: "POST",
              headers,
              body: new Uint8Array(bodyResult.success),
              redirect: "manual",
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            }),
          catch: () => "PostHogRequestFailed" as const,
        }).pipe(Effect.orElseSucceed(() => null));
        if (upstream === null || (upstream.status >= 300 && upstream.status < 400)) {
          return badGateway;
        }

        const responseBytes = yield* Effect.tryPromise({
          try: () => upstream.arrayBuffer(),
          catch: () => "PostHogResponseBodyFailed" as const,
        }).pipe(
          Effect.map((bytes) => new Uint8Array(bytes)),
          Effect.orElseSucceed(() => null),
        );
        if (responseBytes === null) return badGateway;

        const contentType = upstream.headers.get("content-type");
        const contentTypeFields = contentType === null ? {} : { "content-type": contentType };
        return HttpServerResponse.uint8Array(responseBytes, {
          status: upstream.status,
          headers: {
            ...contentTypeFields,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }),
    );
  }),
);
