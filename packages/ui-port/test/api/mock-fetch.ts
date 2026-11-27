import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

/** A recording `fetch` for FetchHttpClient: no network, one scripted response per call. */
interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly credentials: string | undefined;
  readonly cache: string | undefined;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export const json = (fixture: {
  readonly status: number;
  readonly body: Schema.Json;
  readonly headers?: Record<string, string>;
}): Response =>
  Response.json(fixture.body, {
    status: fixture.status,
    headers: { "content-type": "application/json", ...fixture.headers },
  });

export const mockFetch = (respond: Responder) => {
  const calls: Array<RecordedRequest> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      Effect.runPromise(
        Effect.promise(() => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const record = (body: string | null): Response | Promise<Response> => {
            const recorded: RecordedRequest = {
              url,
              method: init?.method ?? "GET",
              headers: new Headers(init?.headers),
              body,
              credentials: init?.credentials,
              cache: init?.cache,
            };
            calls.push(recorded);
            return respond(recorded);
          };
          return Promise.resolve(
            init?.body === undefined || init.body === null
              ? record(null)
              : new Response(init.body).text().then(record),
          );
        }),
      ),
    { preconnect: () => undefined },
  );
  return { calls, fetch };
};

/** A fetch that never answers until aborted (for timeout and interruption). */
export const hangingFetch = (): typeof globalThis.fetch =>
  Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      const pending = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), {
        once: true,
      });
      return pending.promise;
    },
    { preconnect: () => undefined },
  );
