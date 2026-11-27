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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type * as Types from "effect/Types";

const header = (name: string, value: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, name, value)),
  );

const tagOf = (error: Invalid | Types.unhandled): string | undefined =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : undefined;

const numberField = (error: Invalid | Types.unhandled, field: string): number | undefined =>
  Predicate.hasProperty(error, field) && Predicate.isNumber(error[field])
    ? error[field]
    : undefined;

/** Headers the error table of section 3.3 attaches to an error response. */
const errorHeaders = (
  error: Invalid | Types.unhandled,
  hasAuthorization: boolean,
): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> => {
  switch (tagOf(error)) {
    case "RateLimited":
    case "Unavailable": {
      const seconds = numberField(error, "retryAfterSeconds");
      if (seconds !== undefined) return header("retry-after", String(Math.ceil(seconds)));
      return Effect.void;
    }
    case "PreconditionFailed": {
      const revision = numberField(error, "currentRevision");
      if (revision !== undefined) return header("etag", entityTag(revision));
      return Effect.void;
    }
    case "Unauthorized":
      return Effect.asVoid(
        Effect.when(
          header("www-authenticate", 'Bearer realm="kvitbit"'),
          Effect.succeed(hasAuthorization),
        ),
      );
    default:
      return Effect.void;
  }
};

const decodeRevision = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ revision: Schema.Finite })),
);

/** The revision of a JSON response body, if it has one. */
const revisionOf = (response: HttpServerResponse.HttpServerResponse): number | undefined => {
  const body = response.body;
  if (body._tag !== "Uint8Array" || !Str.startsWith("application/json")(body.contentType))
    return undefined;
  return decodeRevision(new TextDecoder().decode(body.body)).pipe(
    Option.map(({ revision }) => revision),
    Option.getOrUndefined,
  );
};

export const SchemaErrorsLive = Layer.succeed(
  SchemaErrors,
  SchemaErrors.of(
    Effect.fnUntraced(function* (handler, { endpoint }) {
      const outcome = yield* makeRequestOutcome;
      const revisioned = Context.get(endpoint.annotations, Revisioned);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* handler.pipe(
        Effect.provideService(RequestOutcome, outcome),
        Effect.catchIf(
          (error): error is Types.unhandled & HttpApiError.HttpApiSchemaError =>
            HttpApiError.HttpApiSchemaError.is(error),
          (error) =>
            schemaErrorToInvalid(error).pipe(
              // HttpApiBuilder turns the original response-side error into a defect.
              Effect.mapError((mapped) =>
                HttpApiError.HttpApiSchemaError.is(mapped) ? error : mapped,
              ),
            ),
        ),
        Effect.tapError((error) =>
          errorHeaders(error, request.headers["authorization"] !== undefined),
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
