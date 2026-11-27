/**
 * API seam for Commands. `WebServices` is the runtime `resources` layer (KvitbitApi over fetch,
 * same-origin session cookie, ui-port-contracts 7.1). `request` runs one endpoint call and turns
 * every failure into a Schema-typed `Failure`, so Commands never fail and Messages stay codecs.
 */

import { ALTCHA_HEADER } from "@kvitbit/api-contract";
import { Api } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { browserOrigin, fetchBrowser } from "./browser";

const TextSchema = Schema.Struct({
  key: Schema.String,
  params: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite])),
  ),
});

/** What a screen needs to show a failed request (from ui-port `describeError`). */
export const Failure = Schema.Struct({
  tag: Schema.String,
  surface: Schema.Literals(["fields", "inline", "banner", "page", "session", "silent"]),
  text: TextSchema,
  issues: Schema.Array(Schema.Struct({ path: Schema.String, text: TextSchema })),
  retryable: Schema.Boolean,
  staleRevision: Schema.Boolean,
  freshBotProof: Schema.Boolean,
  requestId: Schema.NullOr(Schema.String),
});
export type Failure = typeof Failure.Type;

const failureOf = (error: Api.UiError): Failure => {
  const v = Api.describeError(error);
  return {
    tag: error._tag,
    surface: v.surface,
    text: v.text,
    issues: Arr.map(v.issues, (i) => ({
      path: Arr.join(Arr.map(i.path, String), "."),
      text: i.text,
    })),
    retryable: v.retryable,
    staleRevision: v.staleRevision,
    freshBotProof: v.freshBotProof,
    requestId: v.requestId,
  };
};

export const failureFromUnknown = Fn.flow(Api.toUiError, failureOf);

const currentLanguage = (): string => {
  if (globalThis.document === undefined) return "cs";
  return (
    document.querySelector<HTMLElement>(".kb-root")?.lang || document.documentElement.lang || "cs"
  );
};

export type WebServices = Api.KvitbitApi;

export const WebServicesLive: Layer.Layer<WebServices> = Layer.suspend(() =>
  Api.layerFetch({
    baseUrl: browserOrigin(),
    credentials: Api.sessionCookie,
    acceptLanguage: currentLanguage,
  }),
);

export type Client = Api.KvitbitApiClient;

/**
 * One API call as a never-failing Effect: `onSuccess` and `onFailure` build the result Message.
 * Defects and transport errors are mapped through ui-port `toUiError`.
 */
const requestImpl = <A, E, M>(
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => M,
  onFailure: (f: Failure) => M,
): Effect.Effect<M, never, WebServices> =>
  Effect.gen(function* () {
    const client = yield* Api.KvitbitApi;
    return yield* call(client);
  }).pipe(
    Effect.map(onSuccess),
    Effect.catchCause((cause) => cause.pipe(Api.fromCause, failureOf, onFailure, Effect.succeed)),
  );

export const request: {
  <A, E, M>(
    onSuccess: (a: A) => M,
    onFailure: (f: Failure) => M,
  ): (call: (client: Client) => Effect.Effect<A, E>) => Effect.Effect<M, never, WebServices>;
  <A, E, M>(
    call: (client: Client) => Effect.Effect<A, E>,
    onSuccess: (a: A) => M,
    onFailure: (f: Failure) => M,
  ): Effect.Effect<M, never, WebServices>;
} = Fn.dual(3, requestImpl);

class AuthResponseError extends Schema.TaggedError<
  AuthResponseError,
  { readonly brand: unique symbol }
>()("AuthResponseError", {
  status: Schema.Int,
  json: Schema.Json,
}) {}

interface AuthRequest {
  readonly method?: "GET" | "POST";
  readonly body?: Schema.Json;
  readonly altchaHeader?: string | undefined;
}

interface AuthCall extends AuthRequest {
  readonly path: string;
}

const decodeAuthJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

export const sendAuthRequest = Effect.fn("sendAuthRequest")(function* (init: AuthCall) {
  const authRequest = HttpClientRequest.make(init.method ?? "GET")(
    `${browserOrigin()}/api/auth${init.path}`,
  );
  const requestWithProof =
    init.altchaHeader === undefined
      ? authRequest
      : HttpClientRequest.setHeader(authRequest, ALTCHA_HEADER, init.altchaHeader);
  const prepared =
    init.body === undefined
      ? requestWithProof
      : yield* HttpClientRequest.bodyJson(requestWithProof, init.body);
  const response = yield* fetchBrowser(prepared);
  const type = response.headers["content-type"] ?? "";
  const json = Str.includes("json")(type)
    ? yield* response.text.pipe(Effect.flatMap(decodeAuthJson))
    : null;
  if (response.status < 200 || response.status >= 300) {
    return yield* AuthResponseError.make({ status: response.status, json });
  }
  return json;
});

/** Same-origin JSON call outside the typed contract (Better Auth routes under /api/auth). */
const authFetchImpl = <M, F = M>(
  path: string,
  init: AuthRequest,
  onSuccess: (json: Schema.Json) => M,
  onFailure: (failure: Failure) => F,
): Effect.Effect<M | F> =>
  sendAuthRequest({ ...init, path }).pipe(
    Effect.match({ onSuccess, onFailure: (error) => onFailure(failureFromUnknown(error)) }),
  );

export const authFetch: {
  <M, F = M>(
    init: AuthRequest,
    onSuccess: (json: Schema.Json) => M,
    onFailure: (failure: Failure) => F,
  ): (path: string) => Effect.Effect<M | F>;
  <M, F = M>(
    path: string,
    init: AuthRequest,
    onSuccess: (json: Schema.Json) => M,
    onFailure: (failure: Failure) => F,
  ): Effect.Effect<M | F>;
} = Fn.dual(4, authFetchImpl);
