/**
 * The outermost HttpApi middleware (`SchemaErrors`, added API-wide last). Besides the
 * `request.malformed` transform it carries the per-request response rules of section 3.2 and
 * 3.3 that need the endpoint, since the contract declares no separate middleware for them:
 *
 * - a fresh `RequestOutcome` per request; a replayed request answers `Idempotent-Replayed: true`;
 * - `ETag: "<revision>"` on success for endpoints annotated `Revisioned` (the server's
 *   `EntityTagResponse` rule);
 * - error headers: `Retry-After` (429, and 503 when `retryAfterSeconds` is set), `ETag` of the
 *   current revision on 412, `WWW-Authenticate: Bearer realm="kvitbit"` on 401 for bearer callers;
 */
import { entityTag, Revisioned, SchemaErrors, schemaErrorToInvalid } from "@kvitbit/api-contract";
import { makeRequestOutcome } from "@kvitbit/core";
import type { Invalid } from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Context, Effect, Layer, Predicate } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { HttpServerResponse as Response } from "effect/http/HttpServerResponse";
import { HttpApiError } from "effect/http-api";
import type { unhandled } from "effect/Types";

const header = (name: string, value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, name, value)),
  );

const tagOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : undefined;

const numberField = (error: unknown, field: string): number | undefined =>
  Predicate.hasProperty(error, field) && typeof error[field] === "number"
    ? error[field]
    : undefined;

/** Headers the error table of section 3.3 attaches to an error response. */
export const errorHeaders = (
  error: unknown,
  hasAuthorization: boolean,
): Effect.Effect<void, never, HttpServerRequest> => {
  switch (tagOf(error)) {
    case "RateLimited":
    case "Unavailable": {
      const seconds = numberField(error, "retryAfterSeconds");
      return seconds === undefined
        ? Effect.void
        : header("retry-after", String(Math.ceil(seconds)));
    }
    case "PreconditionFailed": {
      const revision = numberField(error, "currentRevision");
      return revision === undefined ? Effect.void : header("etag", entityTag(revision));
    }
    case "Unauthorized":
      return hasAuthorization ? header("www-authenticate", 'Bearer realm="kvitbit"') : Effect.void;
    default:
      return Effect.void;
  }
};

/** The `revision` of a JSON response body, if it has one. */
const revisionOf = (response: Response): number | undefined => {
  const body = response.body;
  if (body._tag !== "Uint8Array" || !body.contentType.startsWith("application/json"))
    return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body.body));
    return Predicate.hasProperty(value, "revision") && typeof value.revision === "number"
      ? value.revision
      : undefined;
  } catch {
    return undefined;
  }
};

export const SchemaErrorsLive = Layer.succeed(
  SchemaErrors,
  SchemaErrors.of((handler, { endpoint }) =>
    Effect.gen(function* () {
      const outcome = yield* makeRequestOutcome;
      const revisioned = Context.get(endpoint.annotations, Revisioned);
      const request = yield* HttpServerRequest;
      const response = yield* handler.pipe(
        Effect.provideService(RequestOutcome, outcome),
        Effect.catch(
          (error): Effect.Effect<never, Invalid | unhandled> =>
            HttpApiError.HttpApiSchemaError.is(error)
              ? // Response-side schema errors pass through and HttpApiBuilder turns them into a
                // defect; only the request-side Invalid is typed here.
                (schemaErrorToInvalid(error) as Effect.Effect<never, Invalid>)
              : Effect.fail(error),
        ),
        Effect.tapError((error) =>
          errorHeaders(error, request.headers.authorization !== undefined),
        ),
      );
      if (yield* outcome.replayed) {
        yield* header("idempotent-replayed", "true");
      }
      if (revisioned && response.status < 300) {
        const revision = revisionOf(response);
        if (revision !== undefined)
          return HttpServerResponse.setHeader(response, "etag", entityTag(revision));
      }
      return response;
    }),
  ),
);
