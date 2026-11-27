import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const browserOrigin = () => {
  const location = globalThis.location;
  return location === undefined || location.origin === "null"
    ? "http://localhost"
    : location.origin;
};

export const fetchBrowser = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideServiceEffect(
      FetchHttpClient.Fetch,
      Effect.sync(() => globalThis.fetch),
    ),
  );

export const fetchBrowserOk = (request: HttpClientRequest.HttpClientRequest) =>
  fetchBrowser(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));

export const writeClipboard = Effect.fn("writeClipboard")(function* (text: string) {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined) return false;
  return yield* Effect.tryPromise({
    try: () => clipboard.writeText(text),
    catch: () => "clipboard-unavailable" as const,
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

export const readSessionStorage = (key: string) =>
  Effect.try({
    try: () => globalThis.sessionStorage.getItem(key),
    catch: () => "storage-unavailable" as const,
  });

export const writeSessionStorage = ({
  key,
  value,
}: {
  readonly key: string;
  readonly value: string | null;
}) =>
  Effect.try({
    try: () => {
      if (value === null) globalThis.sessionStorage.removeItem(key);
      else globalThis.sessionStorage.setItem(key, value);
    },
    catch: () => "storage-unavailable" as const,
  });
export const downloadFile = Effect.fn("downloadFile")(function* ({
  path,
  filename,
}: {
  readonly path: string;
  readonly filename: string;
}) {
  const response = yield* fetchBrowserOk(HttpClientRequest.get(`${browserOrigin()}${path}`));
  const bytes = yield* response.arrayBuffer;
  const document = globalThis.document;
  if (document === undefined) return;
  const blob = new Blob([bytes], { type: response.headers["content-type"] ?? "" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  yield* Effect.sync(() => {
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      }),
    ),
  );
});
