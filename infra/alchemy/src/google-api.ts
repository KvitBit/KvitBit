import { Credentials } from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** How long one attempt may take and how a transient failure retries. */
export interface GoogleApiRetryPolicy {
  /** One deadline per attempt: token lookup, dispatch and body together. */
  readonly attemptTimeout: Duration.Input;
  /** The first delay of the exponential backoff between attempts. */
  readonly backoff: Duration.Input;
  /** Retries after the first attempt, shared by every transient failure. */
  readonly retries: number;
}

/**
 * Why an attempt produced no answer: the transport failed, the request
 * was sent but the deadline passed, or the token lookup outlasted the
 * deadline so nothing was sent.
 */
export type GoogleApiNoAnswer = "unreachable" | "no-answer-in-time" | "credentials-stalled";

/** Rate limiting or a server error: a later attempt can succeed. */
export const isTransientGoogleApiStatus = (status: number) => status === 429 || status >= 500;

/** One authorized Google API request and how its outcomes map. */
export interface GoogleApiCall<A, E> {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly policy: GoogleApiRetryPolicy;
  /**
   * When the bearer token is looked up. `each-attempt` (the default) puts
   * the lookup inside every attempt's deadline, so a stalled lookup is
   * retried. `once` looks it up before the first attempt under a deadline
   * of its own; a lookup that fails or stalls ends the call, and every
   * attempt then gets its full deadline for the request.
   */
  readonly tokenLookup?: "each-attempt" | "once";
  /**
   * Handles any answer but 429 and 5xx, inside the attempt's deadline and
   * scope; a body read here counts against the deadline, and a body left
   * unread is released when the attempt ends.
   */
  readonly handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>;
  /** A handled failure a later attempt may fix; none by default. */
  readonly retryHandledFailure?: (error: E) => boolean;
  /** The caller's failure for an answer of 429 or 5xx; always retried. */
  readonly transientStatus: (status: number) => E;
  /** The caller's failure for an attempt without an answer; always retried. */
  readonly noAnswer: (cause: GoogleApiNoAnswer) => E;
  /**
   * The caller's failure when the token lookup fails. It is never retried
   * and carries nothing from the provider's error.
   */
  readonly credentialsUnavailable: () => E;
  /** Observes each failed attempt, the last included, before any retry. */
  readonly onAttemptFailure?: (error: E) => Effect.Effect<void>;
}

/** The token lookup failed; it ends the call without a retry. */
class CredentialsUnavailable extends Schema.TaggedError<
  CredentialsUnavailable,
  { readonly brand: unique symbol }
>()("CredentialsUnavailable", {}) {}

type RequestFailure<E> =
  | { readonly _tag: "TransientAttempt"; readonly error: E }
  | { readonly _tag: "HandledFailure"; readonly error: E };

/**
 * Authorized access to Google REST APIs with the workspace GCP identity.
 * Every attempt sends a bearer token (billing user credentials to their
 * quota project), looked up per attempt or once per call, runs under one deadline in its own scope, and
 * retries transport failures, timeouts, 429 and 5xx with exponential
 * backoff within one bounded budget. A failed token lookup is never
 * retried and never reaches the caller's error.
 */
export const makeGoogleApi = Effect.fnUntraced(function* () {
  const credentials = yield* Credentials;
  // Each attempt owns its request: closing the attempt's scope aborts the
  // transport and any body a status-only answer left unread.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

  // Providers may die on a failed token lookup; any outcome but the
  // caller's interruption becomes the same sanitized failure.
  const authorization = credentials.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.fail(CredentialsUnavailable.make()),
    ),
    Effect.map(
      ({ accessToken, quotaProject }) =>
        (request: HttpClientRequest.HttpClientRequest) =>
          request.pipe(
            HttpClientRequest.bearerToken(accessToken),
            // User credentials bill quota to an explicit project.
            quotaProject !== undefined && quotaProject !== ""
              ? HttpClientRequest.setHeader("x-goog-user-project", quotaProject)
              : (unchanged) => unchanged,
          ),
    ),
  );

  const call = <A, E>(options: GoogleApiCall<A, E>): Effect.Effect<A, E> =>
    options.tokenLookup === "once"
      ? authorization.pipe(
          Effect.timeoutOrElse({
            duration: options.policy.attemptTimeout,
            orElse: () => Effect.fail(CredentialsUnavailable.make()),
          }),
          Effect.mapError(() => options.credentialsUnavailable()),
          Effect.flatMap((authorize) => callWith(Effect.succeed(authorize), options)),
        )
      : callWith(authorization, options);

  const callWith = <A, E>(
    authorize: typeof authorization,
    options: GoogleApiCall<A, E>,
  ): Effect.Effect<A, E> => {
    const transient = (error: E) => ({ _tag: "TransientAttempt", error }) as const;
    const attempt = Ref.make(false).pipe(
      Effect.flatMap((dispatched) =>
        authorize.pipe(
          Effect.tap(() => Ref.set(dispatched, true)),
          Effect.flatMap((authorized) =>
            client
              .execute(authorized(options.request))
              .pipe(Effect.mapError(() => transient(options.noAnswer("unreachable")))),
          ),
          Effect.flatMap(
            (response): Effect.Effect<A, RequestFailure<E>> =>
              isTransientGoogleApiStatus(response.status)
                ? Effect.fail(transient(options.transientStatus(response.status)))
                : options
                    .handle(response)
                    .pipe(Effect.mapError((error) => ({ _tag: "HandledFailure", error }) as const)),
          ),
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: options.policy.attemptTimeout,
            orElse: () =>
              Effect.flatMap(Ref.get(dispatched), (sent) =>
                Effect.fail(
                  transient(options.noAnswer(sent ? "no-answer-in-time" : "credentials-stalled")),
                ),
              ),
          }),
        ),
      ),
    );
    const observed =
      options.onAttemptFailure !== undefined
        ? attempt.pipe(
            Effect.tapError((failure) =>
              failure._tag === "CredentialsUnavailable"
                ? Effect.void
                : (options.onAttemptFailure?.(failure.error) ?? Effect.void),
            ),
          )
        : attempt;
    return observed.pipe(
      Effect.retry({
        schedule: Schedule.exponential(options.policy.backoff),
        times: options.policy.retries,
        while: (failure) =>
          failure._tag === "TransientAttempt" ||
          (failure._tag === "HandledFailure" &&
            (options.retryHandledFailure?.(failure.error) ?? false)),
      }),
      Effect.mapError((failure) =>
        failure._tag === "CredentialsUnavailable"
          ? options.credentialsUnavailable()
          : failure.error,
      ),
    );
  };

  return { call } as const;
});

/** Authorized, bounded access to Google REST APIs. */
