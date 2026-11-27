/**
 * Better Auth HTTP routes (`/api/auth/*`) and RFC 8414 OAuth 2.1 authorization server metadata
 * (`/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/api/auth`,
 * per http-mcp-contracts section 1 & 6.2 and board agreement #889).
 */
import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { SqlClient } from "effect/sql";
import { HttpConfig } from "../http/config";
import { JSON_BODY_MAX_BYTES } from "../http/edge/middleware";
import {
  canSubmitFeedback,
  type FeedbackConfig,
  FeedbackSessionUser,
  feedbackSessionCookie,
} from "../http/feedback/access";
import { AuthServer } from "./AuthServer";

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

const toWebRequest = (request: HttpServerRequest, url: string) =>
  Effect.gen(function* () {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    if (METHODS_WITHOUT_BODY.has(request.method.toUpperCase())) {
      return new Request(url, { method: request.method, headers });
    }
    const body = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_BODY_MAX_BYTES)),
    );
    return new Request(url, {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? body : undefined,
    });
  });

const oversized = HttpServerResponse.jsonUnsafe(
  { _tag: "PayloadTooLarge", limitBytes: JSON_BODY_MAX_BYTES },
  { status: 413 },
);

const isSessionResponse = Schema.is(
  Schema.Struct({
    session: Schema.Record(Schema.String, Schema.Unknown),
    user: FeedbackSessionUser,
  }),
);

const fromWebResponse = (
  response: Response,
  sessionRequest?: {
    readonly hasCookie: boolean;
    readonly feedback: FeedbackConfig | undefined;
    readonly sql: SqlClient.SqlClient;
  },
) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
    const headers: Record<string, string | ReadonlyArray<string>> = {};
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      headers[key] = value;
    });
    if (setCookies.length > 0) {
      headers["set-cookie"] = setCookies;
    }
    if (sessionRequest !== undefined && response.ok) {
      const session: unknown = yield* Effect.try(() =>
        JSON.parse(new TextDecoder().decode(bytes)),
      ).pipe(Effect.orElseSucceed(() => null));
      if (isSessionResponse(session)) {
        const feedbackEnabled =
          sessionRequest.hasCookie &&
          (yield* canSubmitFeedback(sessionRequest.sql, sessionRequest.feedback, session.user));
        delete headers["content-length"];
        headers["cache-control"] = "no-store";
        return HttpServerResponse.jsonUnsafe(
          { ...session, feedbackEnabled },
          { status: response.status, headers },
        );
      }
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
    const sql = yield* SqlClient.SqlClient;

    const handleAuth = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (Number(request.headers["content-length"]) > JSON_BODY_MAX_BYTES) return oversized;

      const url = new URL(request.url, config.appOrigin);
      const webReq = yield* toWebRequest(request, url.toString()).pipe(Effect.result);
      if (webReq._tag === "Failure") {
        const reason = webReq.failure.reason;
        return reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge"
          ? oversized
          : HttpServerResponse.empty({ status: 400 });
      }
      const webRes = yield* Effect.promise(() => auth.handler(webReq.success));
      return yield* fromWebResponse(
        webRes,
        request.method === "GET" && url.pathname === "/api/auth/get-session"
          ? {
              hasCookie: feedbackSessionCookie(request) !== undefined,
              feedback: config.feedback,
              sql,
            }
          : undefined,
      );
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
