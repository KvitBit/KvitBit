/** A recording `fetch` for FetchHttpClient: no network, one scripted response per call. */
export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly credentials: string | undefined;
  readonly cache: string | undefined;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const mockFetch = (respond: Responder) => {
  const calls: Array<RecordedRequest> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body =
      init?.body === undefined || init.body === null ? null : await new Response(init.body).text();
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
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

/** A fetch that never answers until aborted (for timeout and interruption). */
export const hangingFetch = (): typeof globalThis.fetch =>
  ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof globalThis.fetch;
