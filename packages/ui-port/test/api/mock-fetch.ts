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

// Mock response bodies are arbitrary values, including numeric statuses.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  Response.json(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const mockFetch = (respond: Responder) => {
  const calls: Array<RecordedRequest> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
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
        resolve(
          init?.body === undefined || init.body === null
            ? record(null)
            : new Response(init.body).text().then(record),
        );
      }),
    { preconnect: () => undefined },
  );
  return { calls, fetch };
};

/** A fetch that never answers until aborted (for timeout and interruption). */
export const hangingFetch = (): typeof globalThis.fetch =>
  Object.assign(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    { preconnect: () => undefined },
  );
