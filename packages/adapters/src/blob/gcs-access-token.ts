/**
 * OAuth access tokens for the GCS JSON API. Adapted from DeskoHub
 * apps/deskohub-workspace/shared/backend/google-cloud/google-access-token.ts (metadata-server
 * read, cached until shortly before expiry, one shared refresh).
 */
import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
  SynchronizedRef,
} from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/** No access token. Carries no token or response body. */
export class GcsAccessTokenError extends Data.TaggedError("GcsAccessTokenError")<{
  readonly reason: "transport" | "timeout" | "status" | "invalid-response";
  readonly httpStatus?: number | undefined;
}> {}

export interface GcsAccessTokenService {
  /** A bearer token for storage.googleapis.com. */
  readonly get: Effect.Effect<string, GcsAccessTokenError>;
  /** Drops `token` after GCS rejected it, so the next `get` fetches another. */
  readonly invalidate: (token: string) => Effect.Effect<void>;
}

export class GcsAccessToken extends Context.Service<GcsAccessToken, GcsAccessTokenService>()(
  "kvitbit/adapters/GcsAccessToken",
) {}

/** Where Cloud Run and Compute Engine expose the service account's token. */
export const metadataServerTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const attemptTimeout = Duration.seconds(10);
const refreshDeadline = Duration.seconds(30);
/** Refreshes a token this long before it expires. */
const expiryMargin = Duration.minutes(1);

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
});

interface CachedToken {
  readonly accessToken: string;
  readonly refreshAtMillis: number;
}

const toTokenError = ({ reason }: HttpClientError.HttpClientError) => {
  if (reason._tag === "StatusCodeError") {
    return new GcsAccessTokenError({ reason: "status", httpStatus: reason.response.status });
  }
  if (reason._tag === "TransportError" && Cause.isTimeoutError(reason.cause)) {
    return new GcsAccessTokenError({ reason: "timeout" });
  }
  return new GcsAccessTokenError({ reason: "transport" });
};

const readTokenResponse = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
    Effect.mapError(() => new GcsAccessTokenError({ reason: "invalid-response" })),
  );

/**
 * Reads the token from the metadata server and reuses it until a minute before it expires.
 * Concurrent callers share one refresh. Requires an `HttpClient` (FetchHttpClient in production).
 */
const metadataServer: Layer.Layer<GcsAccessToken, never, HttpClient.HttpClient> = Layer.effect(
  GcsAccessToken,
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.transformResponse(Effect.tap((response) => response.arrayBuffer)),
      HttpClient.timeout(attemptTimeout),
      HttpClient.retryTransient({
        schedule: Schedule.exponential("200 millis"),
        times: 2,
        while: ({ reason }) => reason._tag === "DecodeError",
      }),
    );
    const cache = yield* SynchronizedRef.make(Option.none<CachedToken>());

    const fetchToken = client
      .execute(
        HttpClientRequest.get(metadataServerTokenUrl).pipe(
          HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
        ),
      )
      .pipe(
        Effect.mapError(toTokenError),
        Effect.flatMap(readTokenResponse),
        Effect.timeoutOrElse({
          duration: refreshDeadline,
          orElse: () => Effect.fail(new GcsAccessTokenError({ reason: "timeout" })),
        }),
        Effect.flatMap((response) =>
          Effect.map(
            Clock.currentTimeMillis,
            (now): CachedToken => ({
              accessToken: response.access_token,
              refreshAtMillis: now + response.expires_in * 1000 - Duration.toMillis(expiryMargin),
            }),
          ),
        ),
      );

    const reuseOrRefresh = (cached: Option.Option<CachedToken>) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const fresh = Option.filter(cached, ({ refreshAtMillis }) => now < refreshAtMillis);
        return Option.isSome(fresh)
          ? Effect.succeed([fresh.value.accessToken, cached] as const)
          : Effect.map(fetchToken, (token) => [token.accessToken, Option.some(token)] as const);
      });

    return GcsAccessToken.of({
      get: SynchronizedRef.modifyEffect(cache, reuseOrRefresh).pipe(
        Effect.withSpan("GcsAccessToken.get"),
      ),
      invalidate: (token) =>
        SynchronizedRef.update(
          cache,
          Option.filter(({ accessToken }) => accessToken !== token),
        ),
    });
  }),
);

/** Tokens from an injected effect, e.g. a fixed token in tests or a custom credential flow. */
const fromEffect = <E>(
  get: Effect.Effect<string, E>,
  toError: (error: E) => GcsAccessTokenError = () =>
    new GcsAccessTokenError({ reason: "transport" }),
): Layer.Layer<GcsAccessToken> =>
  Layer.succeed(
    GcsAccessToken,
    GcsAccessToken.of({ get: Effect.mapError(get, toError), invalidate: () => Effect.void }),
  );

export const GcsAccessTokens = { metadataServer, fromEffect } as const;
