/**
 * Demo transport: an in-browser fake of `/api/*` used by `bun run dev` with VITE_KVITBIT_DEMO=1 and by
 * the Playwright suite, so every screen renders realistic data without apps/server. Handlers return
 * the ENCODED wire form of the contract's success schema (build values with the domain schema and
 * `Schema.encodeSync(...)`), or `{ status, body }` for an error response.
 *
 * Each page group owns one handler file (src/demo/<group>.ts); src/demo/index.ts combines them.
 */
export interface DemoRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export type DemoResponse =
  | unknown
  | { readonly status: number; readonly body: unknown; readonly __demo: true };

export interface DemoRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below the origin, `:name` segments captured, e.g. "/api/v1/workspaces/:workspaceId/contacts". */
  readonly path: string;
  readonly respond: (req: DemoRequest) => DemoResponse;
}

export const status = (code: number, body: unknown): DemoResponse => ({
  status: code,
  body,
  __demo: true,
});

const compile = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\:(\w+)|:(\w+)/g, (_m, a, b) => `(?<${a ?? b}>[^/]+)`)}/?$`,
  );

export const match = (
  routes: ReadonlyArray<DemoRoute>,
  method: string,
  path: string,
): { readonly route: DemoRoute; readonly params: Record<string, string> } | undefined => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = compile(route.path).exec(path);
    if (m !== null) return { route, params: { ...(m.groups ?? {}) } };
  }
  return undefined;
};

const isStatus = (r: DemoResponse): r is { status: number; body: unknown; __demo: true } =>
  typeof r === "object" && r !== null && "__demo" in r;

/** Replaces `globalThis.fetch` for same-origin `/api/*` calls; everything else passes through. */
export const installDemoFetch = (routes: ReadonlyArray<DemoRoute>, latencyMs = 120): void => {
  const original = globalThis.fetch.bind(globalThis);
  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/"))
      return original(input, init);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    const found = match(routes, req.method, url.pathname);
    await new Promise((r) => setTimeout(r, latencyMs));
    if (found === undefined) {
      return Response.json(
        { _tag: "NotFound", entity: "Route", id: url.pathname },
        { status: 404 },
      );
    }
    const out = found.route.respond({
      method: req.method,
      path: url.pathname,
      params: found.params,
      query: url.searchParams,
      body,
    });
    if (isStatus(out)) return Response.json(out.body, { status: out.status });
    return out === undefined ? new Response(null, { status: 204 }) : Response.json(out);
  };
  globalThis.fetch = Object.assign(demoFetch, { preconnect: () => undefined }) as typeof fetch;
};
