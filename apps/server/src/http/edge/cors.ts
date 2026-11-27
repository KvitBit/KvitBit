import { Effect } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpConfig } from "../config";

export const CorsLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
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
    const mcpCors = withCors(corsOrigins.filter((origin) => trustedOrigins.has(origin)));
    yield* router.addGlobalMiddleware((handle) =>
      Effect.flatMap(HttpServerRequest, (request) => {
        const { pathname } = new URL(request.url, "http://localhost");
        if (pathname === "/mcp") return mcpCors(handle);
        if (pathname.startsWith("/api/v1/")) return restCors(handle);
        return handle;
      }),
    );
  }),
);
