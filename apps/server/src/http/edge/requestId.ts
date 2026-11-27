import { randomUUID } from "node:crypto";
import { Context, Effect } from "effect";
import { Headers, HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { parseCloudTrace, RequestLogContext } from "../../logging/trace";

const HEADER = "x-request-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestIdFor = (value: string | undefined): string =>
  value !== undefined && UUID.test(value) ? value : randomUUID();

export const withRequestLogging = <A, E, R>(handle: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if ((yield* RequestLogContext) !== undefined) return yield* handle;
    const { headers } = yield* HttpServerRequest;
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
  (handle) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
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
            const route = Context.getOrUndefined(fiber.context, HttpRouter.RouteContext)?.route
              .path;
            if (logContext !== undefined && route !== undefined) logContext.route = route;
          }),
        ),
        Effect.provideService(
          HttpServerRequest,
          request.modify({ headers: Headers.set(request.headers, HEADER, requestId) }),
        ),
      );
    }).pipe(withRequestLogging),
  { global: true },
);
