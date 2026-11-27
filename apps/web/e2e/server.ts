import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { demoRoutes } from "../src/demo";
import { isStatus, match } from "../src/demo/router";

const sharePdfPathPattern = /^\/api\/v1\/share\/[^/]+\/pdf$/;

const port = Effect.runSync(Config.Int("KVITBIT_WEB_E2E_PORT").pipe(Config.withDefault(4173)));
const paths = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
const dist = paths.resolve(import.meta.dirname, "../dist");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/app/") {
      return new Response("<!doctype html><title>Mobile app</title><main>Mobile app mount</main>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (sharePdfPathPattern.test(url.pathname)) {
      return new Response("%PDF-1.4\n", {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="invoice.pdf"',
        },
      });
    }
    if (Str.startsWith("/api/")(url.pathname)) {
      const found = match(demoRoutes, request.method, url.pathname);
      if (found === undefined) {
        return Response.json(
          { _tag: "NotFound", entity: "Route", id: url.pathname },
          { status: 404 },
        );
      }
      const body =
        request.method === "GET" || request.method === "HEAD" ? null : await request.json();
      const result = found.route.respond({
        method: request.method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams,
        body,
      });
      if (isStatus(result)) {
        return Response.json(result.body, { status: result.status });
      }
      return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);
    }

    const path = paths.resolve(dist, `.${url.pathname}`);
    if (Str.startsWith(dist + paths.sep)(path)) {
      const asset = Bun.file(path);
      if (await asset.exists()) return new Response(asset);
      if (Str.startsWith("/assets/")(url.pathname) || Str.startsWith("/fonts/")(url.pathname)) {
        return new Response(null, { status: 404 });
      }
    }
    return new Response(Bun.file(paths.resolve(dist, "index.html")));
  },
});
