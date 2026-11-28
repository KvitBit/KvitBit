/**
 * Better Auth HTTP routes (`/api/auth/*`) and RFC 8414 OAuth 2.1 authorization server metadata
 * (`/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/api/auth`,
 * per http-mcp-contracts section 1 & 6.2 and board agreement #889).
 */

import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpConfig } from "../http/config";
import { JSON_BODY_MAX_BYTES } from "../http/edge/middleware";
import {
  canSubmitFeedback,
  type FeedbackConfig,
  FeedbackSessionUser,
  feedbackSessionCookie,
} from "../http/feedback/access";
import { AuthServer } from "./AuthServer";
import { fromAuthPromise, withDrizzleSqlContext } from "./drizzleBridge";

const bodyTooLarge = { BodyTooLarge: true };
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

const isString = Schema.is(Schema.String);

const toWebRequest = Effect.fn("toAuthWebRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: string,
) {
  const headers = new Headers();
  for (const [name, value] of EffectRecord.toEntries(request.headers)) {
    if (isString(value)) headers.set(name, value);
  }
  if (METHODS_WITHOUT_BODY.has(Str.toUpperCase(request.method))) {
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

const fromWebResponse = Effect.fn("fromAuthWebResponse")(function* (
  response: Response,
  sessionRequest?: {
    readonly hasCookie: boolean;
    readonly feedback: FeedbackConfig | undefined;
    readonly sql: SqlClient.SqlClient;
  },
) {
  const buffer = yield* fromAuthPromise(() => response.arrayBuffer()).pipe(Effect.orDie);
  const bytes = new Uint8Array(buffer);
  const headers: Record<string, string | ReadonlyArray<string>> = {};
  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (Str.toLowerCase(key) === "set-cookie") return;
    headers[key] = value;
  });
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }
  if (sessionRequest !== undefined && response.ok) {
    const session = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.orElseSucceed(() => null));
    if (isSessionResponse(session)) {
      const feedbackEnabled =
        sessionRequest.hasCookie &&
        (yield* canSubmitFeedback(sessionRequest.sql, sessionRequest.feedback, session.user));
      const responseHeaders = EffectRecord.remove(headers, "content-length");
      responseHeaders["cache-control"] = "no-store";
      return HttpServerResponse.jsonUnsafe(
        { ...session, feedbackEnabled },
        { status: response.status, headers: responseHeaders },
      );
    }
  }
  return HttpServerResponse.uint8Array(bytes, {
    status: response.status,
    headers,
  });
});

/** Registers `/api/auth/*` and both RFC 8414 metadata paths on `HttpRouter`. */
export const AuthRoutesLive = HttpRouter.use(
  Effect.fn("registerAuthRoutes")(function* (router: HttpRouter.HttpRouter) {
    const auth = yield* AuthServer;
    const config = yield* HttpConfig;
    const sql = yield* SqlClient.SqlClient;

    const handleAuth = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (Number(request.headers["content-length"]) > JSON_BODY_MAX_BYTES) return oversized;

      const url = new URL(request.url, config.appOrigin);
      const webReq = yield* toWebRequest(request, url.toString()).pipe(Effect.result);
      if (webReq._tag === "Failure") {
        const reason = webReq.failure.reason;
        return reason._tag === "RequestParseError" &&
          reason.reason !== undefined &&
          reason.reason in bodyTooLarge
          ? oversized
          : HttpServerResponse.empty({ status: 400 });
      }
      const webRes = yield* withDrizzleSqlContext(() => auth.handler(webReq.success)).pipe(
        Effect.orDie,
      );
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
      const webRes = yield* withDrizzleSqlContext(() => auth.handler(webReq)).pipe(Effect.orDie);
      return yield* fromWebResponse(webRes);
    });

    yield* router.add("*", "/api/auth/*", handleAuth);
    yield* router.add("GET", "/.well-known/oauth-authorization-server", handleWellKnown);
    yield* router.add("GET", "/.well-known/oauth-authorization-server/api/auth", handleWellKnown);
  }),
);
