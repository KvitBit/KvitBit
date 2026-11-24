/**
 * API seam for Commands. `WebServices` is the runtime `resources` layer (KvitbitApi over fetch,
 * same-origin session cookie, ui-port-contracts 7.1). `request` runs one endpoint call and turns
 * every failure into a Schema-typed `Failure`, so Commands never fail and Messages stay codecs.
 */
import { Api } from "@kvitbit/ui-port";
import { Effect, Layer, Schema } from "effect";

export const TextSchema = Schema.Struct({
  key: Schema.String,
  params: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  ),
});
export type TextValue = typeof TextSchema.Type;

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

export const failureOf = (error: Api.UiError): Failure => {
  const v = Api.describeError(error);
  return {
    tag: error._tag,
    surface: v.surface,
    text: v.text,
    issues: v.issues.map((i) => ({ path: i.path.join("."), text: i.text })),
    retryable: v.retryable,
    staleRevision: v.staleRevision,
    freshBotProof: v.freshBotProof,
    requestId: v.requestId,
  };
};

export const failureFromUnknown = (error: unknown): Failure => failureOf(Api.toUiError(error));

const currentLanguage = (): string => {
  if (typeof document === "undefined") return "cs";
  return (
    document.querySelector<HTMLElement>(".kb-root")?.lang || document.documentElement.lang || "cs"
  );
};

const origin = (): string =>
  typeof location === "undefined" || location.origin === "null"
    ? "http://localhost"
    : location.origin;

export type WebServices = Api.KvitbitApi;

export const WebServicesLive: Layer.Layer<WebServices> = Layer.suspend(() =>
  Api.layerFetch({
    baseUrl: origin(),
    credentials: Api.sessionCookie,
    acceptLanguage: currentLanguage,
  }),
);

export type Client = Api.KvitbitApiClient;

/**
 * One API call as a never-failing Effect: `onSuccess` and `onFailure` build the result Message.
 * Defects and transport errors are mapped through ui-port `toUiError`.
 */
export const request = <A, E, M>(
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => M,
  onFailure: (f: Failure) => M,
): Effect.Effect<M, never, WebServices> =>
  Effect.gen(function* () {
    const client = yield* Api.KvitbitApi;
    return yield* call(client);
  }).pipe(
    Effect.map(onSuccess),
    Effect.catchCause((cause) => Effect.succeed(onFailure(failureOf(Api.fromCause(cause))))),
  );

/** Same-origin JSON call outside the typed contract (Better Auth routes under /api/auth). */
export const authFetch = <M>(
  path: string,
  init: { readonly method?: "GET" | "POST"; readonly body?: unknown },
  onSuccess: (json: unknown) => M,
  onFailure: (f: Failure) => M,
): Effect.Effect<M> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${origin()}/api/auth${path}`, {
        method: init.method ?? "GET",
        credentials: "same-origin",
        headers: init.body === undefined ? {} : { "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const json: unknown = res.headers.get("content-type")?.includes("json")
        ? await res.json()
        : null;
      if (!res.ok)
        throw Object.assign(new Error(`auth ${res.status}`), { status: res.status, json });
      return json;
    },
    catch: (e) => e,
  }).pipe(
    Effect.map(onSuccess),
    Effect.catch((e) => Effect.succeed(onFailure(failureFromUnknown(e)))),
  );
