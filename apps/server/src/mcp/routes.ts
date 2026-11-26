/**
 * `McpRoutesLive` on `effect/http` `HttpRouter`:
 * - `GET /.well-known/oauth-protected-resource`
 * - `GET /.well-known/oauth-protected-resource/mcp`
 * - `POST /mcp` (Streamable HTTP JSON-RPC 2.0)
 * - `GET /mcp` and `DELETE /mcp` (405 Method Not Allowed, `Allow: POST`)
 */
import { MCP_PATH } from "@kvitbit/api-contract";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { protectedResourceMetadata } from "./caller";
import { McpConfig } from "./config";
import { McpConfirmationsLive } from "./confirmation";
import { handleMcpPost, type McpTransportServices } from "./transport";

const methodNotAllowed = HttpServerResponse.jsonUnsafe(
  {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed: use POST /mcp" },
    id: null,
  },
  {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  },
);

export const McpRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* McpConfig;
    const services = yield* Effect.context<McpTransportServices>();
    const metadata = protectedResourceMetadata(config.appOrigin);
    const metadataResponse = Effect.succeed(
      HttpServerResponse.jsonUnsafe(metadata, {
        status: 200,
        headers: { "cache-control": "public, max-age=300" },
      }),
    );

    yield* router.add("GET", "/.well-known/oauth-protected-resource", metadataResponse);
    yield* router.add("GET", "/.well-known/oauth-protected-resource/mcp", metadataResponse);
    yield* router.add("GET", MCP_PATH, Effect.succeed(methodNotAllowed));
    yield* router.add("DELETE", MCP_PATH, Effect.succeed(methodNotAllowed));
    yield* router.add(
      "POST",
      MCP_PATH,
      Effect.flatMap(HttpServerRequest, (request) =>
        handleMcpPost(request, config).pipe(Effect.provideContext(services)),
      ),
    );
  }),
).pipe(Layer.provide(McpConfirmationsLive));
