/**
 * The typed client over `@kvitbit/api-contract` (ui-port-contracts section 2.3). Presenters reach
 * the server only through `KvitbitApi`; Better Auth routes under `/api/auth` go through the
 * AuthClient port instead.
 */
import { Api } from "@kvitbit/api-contract";
import type { WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, type Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

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
  /** Read per request, so a locale switch applies without rebuilding the layer. */
  readonly acceptLanguage?: () => string | undefined;
  /** Adapter hook (tracing, retries); applied before the auth and language headers. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

const COOKIE_REQUEST_INIT: globalThis.RequestInit = { credentials: "include" };

/** The request pipeline every KvitbitApi call goes through. */
export const configureClient =
  (config: KvitbitApiConfig) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient => {
    const base = config.transformClient ? config.transformClient(client) : client;
    const credentials = config.credentials;
    const authed =
      credentials._tag === "Bearer"
        ? base.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(credentials.token)))
        : // FetchHttpClient reads RequestInit from the requesting fiber, so provide it per request.
          base.pipe(
            HttpClient.transformResponse(
              Effect.provideService(FetchHttpClient.RequestInit, COOKIE_REQUEST_INIT),
            ),
          );
    const acceptLanguage = config.acceptLanguage;
    return acceptLanguage === undefined
      ? authed
      : authed.pipe(
          HttpClient.mapRequest((request) => {
            const language = acceptLanguage();
            return language === undefined
              ? request
              : HttpClientRequest.setHeader(request, "accept-language", language);
          }),
        );
  };

export const make = (
  config: KvitbitApiConfig,
): Effect.Effect<KvitbitApiClient, never, HttpClient.HttpClient> =>
  HttpApiClient.make(Api, { baseUrl: config.baseUrl, transformClient: configureClient(config) });

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
