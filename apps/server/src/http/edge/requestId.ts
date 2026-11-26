import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Headers, HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

const HEADER = "x-request-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestIdFor = (value: string | undefined): string =>
  value !== undefined && UUID.test(value) ? value : randomUUID();

export const RequestIdsLive = HttpRouter.middleware(
  (handle) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
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
          HttpServerRequest,
          request.modify({ headers: Headers.set(request.headers, HEADER, requestId) }),
        ),
      );
    }),
  { global: true },
);
