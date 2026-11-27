import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Str from "effect/String";
import { HttpConfig } from "../config";

export const CorsLive = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const { corsOrigins, trustedOrigins } = yield* HttpConfig;
    if (corsOrigins.length === 0) return;

    const withCors = (origins: ReadonlyArray<string>) =>
      HttpMiddleware.cors({
        allowedOrigins: (origin) => origins.includes(origin),
        credentials: true,
        exposedHeaders: [
          "Content-Disposition",
          "ETag",
          "Idempotent-Replayed",
          "Location",
          "MCP-Protocol-Version",
          "Retry-After",
          "WWW-Authenticate",
          "X-Request-Id",
        ],
      });

    const restCors = withCors(corsOrigins);
    const mcpCors = withCors(Arr.filter(corsOrigins, (origin) => trustedOrigins.has(origin)));
    yield* router.addGlobalMiddleware((handle) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const { pathname } = new URL(request.url, "http://localhost");
        if (pathname === "/mcp") return mcpCors(handle);
        if (Str.startsWith("/api/v1/")(pathname)) return restCors(handle);
        return handle;
      }),
    );
  }),
);
