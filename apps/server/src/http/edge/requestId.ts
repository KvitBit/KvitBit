import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Types from "effect/Types";

const HEADER = "x-request-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestIdFor = (value: string | undefined): string =>
  value !== undefined && UUID.test(value) ? value : SecureRandom.uuidV4Unsafe();

export const RequestIdsLive = HttpRouter.middleware(
  Effect.fnUntraced(function* (
    handle: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestId = requestIdFor(request.headers[HEADER]);
    yield* Effect.annotateCurrentSpan("http.request.id", requestId);
    yield* Effect.annotateLogsScoped({ requestId });
    return yield* handle.pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("Unhandled HTTP error", defect).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { _tag: "InternalError", requestId },
              { status: 500, headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      ),
      HttpEffect.withPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, HEADER, requestId)),
      ),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ headers: Headers.set(request.headers, HEADER, requestId) }),
      ),
    );
  }),
  { global: true },
);
