import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Types from "effect/Types";
import { parseCloudTrace, RequestLogContext } from "../../logging/trace";

const HEADER = "x-request-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestIdFor = (value: string | undefined): string =>
  value !== undefined && UUID.test(value) ? value : SecureRandom.uuidV4Unsafe();

export const withRequestLogging = Effect.fn("withRequestLogging")(function* <A, E, R>(
  handle: Effect.Effect<A, E, R>,
) {
  if ((yield* RequestLogContext) !== undefined) return yield* handle;
  const { headers } = yield* HttpServerRequest.HttpServerRequest;
  const requestId = requestIdFor(headers[HEADER]);
  return yield* handle.pipe(
    Effect.annotateLogs({ requestId }),
    Effect.provideService(RequestLogContext, {
      requestId,
      trace: parseCloudTrace(headers["x-cloud-trace-context"]),
    }),
  );
});

export const RequestIdsLive = HttpRouter.middleware(
  Effect.fn("RequestIds.apply")(function* (
    handle: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const logContext = yield* RequestLogContext;
    const requestId = logContext?.requestId ?? requestIdFor(request.headers[HEADER]);
    yield* Effect.annotateCurrentSpan("http.request.id", requestId);
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
      Effect.ensuring(
        Effect.withFiberSucceed((fiber) => {
          const route = Context.getOrUndefined(fiber.context, HttpRouter.RouteContext)?.route.path;
          if (logContext !== undefined && route !== undefined) logContext.route = route;
        }),
      ),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ headers: Headers.set(request.headers, HEADER, requestId) }),
      ),
    );
  }, withRequestLogging),
  { global: true },
);
