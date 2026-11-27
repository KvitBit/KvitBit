import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Demo transport: an in-browser fake of `/api/*` used by `bun run dev` with VITE_KVITBIT_DEMO=1 and by
 * the Playwright suite, so every screen renders realistic data without apps/server. Handlers return
 * the encoded wire form of the contract's success schema, or use `status` to set an HTTP status.
 *
 * Each page group owns one handler file (src/demo/<group>.ts); src/demo/index.ts combines them.
 */
interface DemoRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface DemoRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below the origin, `:name` segments captured, e.g. "/api/v1/workspaces/:workspaceId/contacts". */
  readonly path: string;
  readonly respond: (req: DemoRequest) => unknown;
}

interface DemoStatus {
  readonly status: number;
  readonly body: object | null | undefined;
  readonly __demo: true;
}

export const status: {
  (body: DemoStatus["body"]): (code: number) => DemoStatus;
  (code: number, body: DemoStatus["body"]): DemoStatus;
} = Fn.dual(2, (code: number, body: DemoStatus["body"]) => ({
  status: code,
  body,
  __demo: true,
}));

const escapePattern = Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const captureParams = Str.replace(/\\?:(\w+)/g, "(?<$1>[^/]+)");
const compile = (pattern: string): RegExp =>
  new RegExp(`^${captureParams(escapePattern(pattern))}/?$`);

interface RouteMatch {
  readonly route: DemoRoute;
  readonly params: Record<string, string>;
}

export const match: {
  (method: string, path: string): (routes: ReadonlyArray<DemoRoute>) => RouteMatch | undefined;
  (routes: ReadonlyArray<DemoRoute>, method: string, path: string): RouteMatch | undefined;
} = Fn.dual(3, (routes: ReadonlyArray<DemoRoute>, method: string, path: string) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = compile(route.path).exec(path);
    if (m !== null) return { route, params: { ...(m.groups ?? {}) } };
  }
});

export const isStatus = Schema.is(
  Schema.Struct({ status: Schema.Finite, body: Schema.Unknown, __demo: Schema.Literal(true) }),
);

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isApiPath = Str.startsWith("/api/");

interface DemoFetchOptions {
  readonly routes: ReadonlyArray<DemoRoute>;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly latencyMs?: number;
}

class DemoFetchError extends Schema.TaggedError<
  DemoFetchError,
  { readonly brand: unique symbol }
>()("DemoFetchError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

/** Replaces `globalThis.fetch` for same-origin `/api/*` calls; everything else passes through. */
export const installDemoFetch = ({ routes, run, latencyMs = 120 }: DemoFetchOptions): void => {
  const original = globalThis.fetch.bind(globalThis);
  const demoFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    run(
      Effect.gen(function* () {
        const req =
          input instanceof Request
            ? input
            : yield* Effect.try({
                try: () => new Request(input, init),
                catch: (cause) => DemoFetchError.make({ message: "Create request", cause }),
              });
        const url = new URL(req.url, location.origin);
        if (url.origin !== location.origin || !isApiPath(url.pathname)) {
          return yield* Effect.tryPromise({
            try: () => original(input, init),
            catch: (cause) => DemoFetchError.make({ message: "Forward request", cause }),
          });
        }
        const text =
          req.method === "GET" || req.method === "HEAD"
            ? ""
            : yield* Effect.tryPromise({
                try: () => req.text(),
                catch: (cause) => DemoFetchError.make({ message: "Read request body", cause }),
              });
        const body = text === "" ? null : Option.getOrElse(parseJson(text), () => text);
        const found = match(routes, req.method, url.pathname);
        yield* Effect.sleep(latencyMs);
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
      }),
    );
  globalThis.fetch = Object.assign(demoFetch, { preconnect: () => undefined });
};
