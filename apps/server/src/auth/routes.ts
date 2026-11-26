/**
 * Better Auth HTTP routes (`/api/auth/*`) and RFC 8414 OAuth 2.1 authorization server metadata
 * (`/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/api/auth`,
 * per http-mcp-contracts section 1 & 6.2 and board agreement #889).
 */
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpConfig } from "../http/config";
import { AuthServer } from "./AuthServer";

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

const toWebRequest = (request: HttpServerRequest, url: string): Effect.Effect<Request, never> =>
  Effect.gen(function* () {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    if (METHODS_WITHOUT_BODY.has(request.method.toUpperCase())) {
      return new Request(url, { method: request.method, headers });
    }
    const body = yield* request.arrayBuffer.pipe(
      Effect.catchCause(() => Effect.succeed(new ArrayBuffer(0))),
    );
    return new Request(url, {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? body : undefined,
    });
  });

const fromWebResponse = (
  response: Response,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.promise(async () => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers: Record<string, string | ReadonlyArray<string>> = {};
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      headers[key] = value;
    });
    if (setCookies.length > 0) {
      headers["set-cookie"] = setCookies;
    }
    return HttpServerResponse.uint8Array(bytes, {
      status: response.status,
      headers,
    });
  });

/** Registers `/api/auth/*` and both RFC 8414 metadata paths on `HttpRouter`. */
export const AuthRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* AuthServer;
    const config = yield* HttpConfig;

    const handleAuth = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, config.appOrigin).toString();
      const webReq = yield* toWebRequest(request, url);
      const webRes = yield* Effect.promise(() => auth.handler(webReq));
      return yield* fromWebResponse(webRes);
    });

    const handleWellKnown = Effect.gen(function* () {
      const webReq = new Request(
        `${config.appOrigin}/api/auth/.well-known/oauth-authorization-server`,
        { method: "GET" },
      );
      const webRes = yield* Effect.promise(() => auth.handler(webReq));
      return yield* fromWebResponse(webRes);
    });

    yield* router.add("*", "/api/auth/*", handleAuth);
    yield* router.add("GET", "/.well-known/oauth-authorization-server", handleWellKnown);
    yield* router.add("GET", "/.well-known/oauth-authorization-server/api/auth", handleWellKnown);
  }),
);

export const AuthLayerLive = Layer.empty;
