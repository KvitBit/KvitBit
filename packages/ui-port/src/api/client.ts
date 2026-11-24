/**
 * The typed client over `@kvitbit/api-contract` (ui-port-contracts section 2.3). Presenters reach
 * the server only through `KvitbitApi`; Better Auth routes under `/api/auth` go through the
 * AuthClient port instead.
 */
import { Api } from "@kvitbit/api-contract";
import type { WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Option, type Redacted } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { annotateFailedResponse, isUiError } from "./errors";

export type KvitbitApiClient = HttpApiClient.ForApi<typeof Api>;

export class KvitbitApi extends Context.Service<KvitbitApi, KvitbitApiClient>()(
  "ui-port/KvitbitApi",
) {}

/**
 * How requests authenticate (http-mcp-contracts section 2.1). The web keeps the Better Auth session
 * cookie, so fetch must send credentials; Expo and API Key callers send a bearer value (a session
 * token, or a `kvb_` API Key, which the server binds to its one Workspace).
 */
export type Credentials =
  | { readonly _tag: "SessionCookie" }
  | { readonly _tag: "Bearer"; readonly token: string | Redacted.Redacted<string> };

export const sessionCookie: Credentials = { _tag: "SessionCookie" };
export const bearer = (token: string | Redacted.Redacted<string>): Credentials => ({
  _tag: "Bearer",
  token,
});

export interface KvitbitApiConfig {
  /** Origin the API is served from, e.g. `https://app.kvitbit.cz`. Paths carry `/api/v1`. */
  readonly baseUrl: string | URL;
  readonly credentials: Credentials;
  /**
   * `Accept-Language` for every request (`ctx.locale`). Read per request, so a locale switch
   * applies without rebuilding the layer.
   */
  readonly acceptLanguage: () => string;
  /** Adapter hook (tracing, retries); applied before the auth and language headers. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

/** What the last response of a call said, beyond its decoded body (ui-port-contracts 2.3). */
export interface ObservedResponse {
  readonly status: number;
  readonly requestId: string | null;
  /** Parsed from a strong `ETag: "<revision>"`. */
  readonly etag: number | null;
  /** `Idempotent-Replayed: true`: the server returned the stored result of this key. */
  readonly replayed: boolean;
}

/**
 * Cell `attempt` provides per command: the response of the latest endpoint call that succeeded
 * (decoded, or returned raw in `response-only` mode), for success metadata. Failures never read
 * it; a decode failure is annotated with its own response (`annotateFailedResponse`), so sibling
 * calls cannot misattribute one.
 */
export interface ResponseCell {
  current: ObservedResponse | null;
}

export class ResponseObserver extends Context.Service<ResponseObserver, ResponseCell>()(
  "ui-port/ResponseObserver",
) {}

export const emptyResponseCell = (): ResponseCell => ({ current: null });

/** The response of one endpoint call, provided fresh around each call. */
interface ExchangeCell {
  response: ObservedResponse | null;
}

class Exchange extends Context.Service<Exchange, ExchangeCell>()("ui-port/Exchange") {}

const parseEtag = (value: string | undefined): number | null => {
  const match = value === undefined ? null : /^"(0|[1-9]\d{0,9})"$/.exec(value);
  return match?.[1] === undefined ? null : Number(match[1]);
};

export const observeResponse = (
  response: HttpClientResponse.HttpClientResponse,
): ObservedResponse => ({
  status: response.status,
  requestId: response.headers["x-request-id"] ?? null,
  etag: parseEtag(response.headers.etag),
  replayed: response.headers["idempotent-replayed"] === "true",
});

const recordResponse = HttpClient.transformResponse(
  Effect.tap((response: HttpClientResponse.HttpClientResponse) =>
    Effect.serviceOption(Exchange).pipe(
      Effect.flatMap((cell) =>
        Option.isSome(cell)
          ? Effect.sync(() => {
              cell.value.response = observeResponse(response);
            })
          : Effect.void,
      ),
    ),
  ),
);

/**
 * Decoding one endpoint call's response, which is in hand: a body that does not decode keeps its
 * error (typed recovery on `SchemaError` still works), annotated with that response's status and
 * request id. Typed wire errors (declared error statuses) and HttpClientErrors carry their response.
 */
const decodingResponse = <A, E, R>(decoded: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(Exchange), (exchange) => {
    const response = Option.isSome(exchange) ? exchange.value.response : null;
    if (response === null) return decoded;
    return decoded.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!isUiError(error) && !HttpClientError.isHttpClientError(error)) {
            annotateFailedResponse(error, response);
          }
        }),
      ),
    );
  });

/** Publishes a succeeded call's response to the command's observer, in every response mode. */
const publishResponse = (exchange: ExchangeCell) =>
  Effect.serviceOption(ResponseObserver).pipe(
    Effect.flatMap((cell) =>
      Option.isSome(cell) && exchange.response !== null
        ? Effect.sync(() => {
            cell.value.current = exchange.response;
          })
        : Effect.void,
    ),
  );

/** Gives every endpoint call of a client its own exchange cell (groups are nested records). */
const withExchanges = (client: object): object =>
  Object.fromEntries(
    Object.entries(client).map(([name, member]: [string, unknown]) => [
      name,
      typeof member === "function"
        ? (...args: ReadonlyArray<unknown>) => {
            const call: unknown = member(...args);
            return Effect.isEffect(call)
              ? Effect.suspend(() => {
                  const exchange: ExchangeCell = { response: null };
                  return Effect.provideService(call, Exchange, exchange).pipe(
                    Effect.tap(() => publishResponse(exchange)),
                  );
                })
              : call;
          }
        : typeof member === "object" && member !== null
          ? withExchanges(member)
          : member,
    ]),
  );

/** The request pipeline every KvitbitApi call goes through. */
export const configureClient =
  (config: KvitbitApiConfig) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient => {
    const base = (config.transformClient ? config.transformClient(client) : client).pipe(
      recordResponse,
    );
    const credentials = config.credentials;
    // FetchHttpClient reads RequestInit from the requesting fiber, so set fetch credentials per
    // request, keeping any options the adapter already set. Bearer mode omits cookies so a
    // same-origin session cookie never rides along with an API Key or session token.
    const fetchCredentials = credentials._tag === "Bearer" ? "omit" : "include";
    const withBearer =
      credentials._tag === "Bearer"
        ? base.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(credentials.token)))
        : base;
    const authed = withBearer.pipe(
      HttpClient.transformResponse((effect) =>
        Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
          Effect.provideService(effect, FetchHttpClient.RequestInit, {
            ...Option.getOrElse(init, () => ({})),
            credentials: fetchCredentials,
          }),
        ),
      ),
    );
    const acceptLanguage = config.acceptLanguage;
    return authed.pipe(
      HttpClient.mapRequest((request) =>
        HttpClientRequest.setHeader(request, "accept-language", acceptLanguage()),
      ),
    );
  };

export const make = (
  config: KvitbitApiConfig,
): Effect.Effect<KvitbitApiClient, never, HttpClient.HttpClient> =>
  Effect.map(
    HttpApiClient.make(Api, {
      baseUrl: config.baseUrl,
      transformClient: configureClient(config),
      transformResponse: decodingResponse,
    }),
    // same shape, each endpoint call now running in its own exchange
    (client) => withExchanges(client) as KvitbitApiClient,
  );

/** KvitbitApi over the adapter's `HttpClient` (tests inject a mock transport here). */
export const layer = (
  config: KvitbitApiConfig,
): Layer.Layer<KvitbitApi, never, HttpClient.HttpClient> => Layer.effect(KvitbitApi)(make(config));

/** KvitbitApi over the platform `fetch` (`FetchHttpClient.Fetch` stays overridable per request). */
export const layerFetch = (config: KvitbitApiConfig): Layer.Layer<KvitbitApi> =>
  layer(config).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Workspace binding. Every Workspace endpoint takes `workspaceId` as a path parameter (the contract
 * declares no Workspace header); API calls always use the id, never the slug.
 */
export const inWorkspace = <P extends object = Record<never, never>>(
  workspaceId: WorkspaceId,
  params?: P,
): P & { readonly workspaceId: WorkspaceId } =>
  ({ ...(params ?? {}), workspaceId }) as P & { readonly workspaceId: WorkspaceId };
