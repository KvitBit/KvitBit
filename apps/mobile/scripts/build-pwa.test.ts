import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as EffectString from "effect/String";
import appJson from "../app.json" with { type: "json" };
import { decorateExport, exportVersion, pwaEntryFiles } from "./build-pwa";
import { assetUrls, injectPwaHead, staticAssetUrls, urlsOutsideBase } from "./pwa/html";
import { appleTouchIcon, pwaColors, pwaIcons, pwaManifest } from "./pwa/manifest";
import { CACHE_PREFIX, serviceWorkerSource } from "./pwa/service-worker";

const { fs, path } = Effect.runSync(
  Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }, { concurrency: 1 }).pipe(
    Effect.provide(BunServices.layer),
  ),
);
const { join, resolve } = path;

const brandWebAssets = resolve(import.meta.dir, "../../../assets/brand/web");

/** Width and height from a PNG's IHDR chunk. */
const pngSize = async (pngPath: string) => {
  const view = new DataView(await Bun.file(pngPath).arrayBuffer());
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
};

/** The shape `expo export --platform web` writes with `experiments.baseUrl: "/app"`. */
const expoShell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Kvitbit</title>
  <meta name="theme-color" content="#000000">
<link rel="icon" href="/app/favicon.ico"/></head>
  <body>
    <div id="root"></div>
  <script src="/app/_expo/static/js/web/__common-ef16.js" defer></script><script src="/app/_expo/static/js/web/index-fc40.js" defer></script>
</body>
</html>`;

describe("manifest", () => {
  test("keeps the installed app's identity and scope on /app/", () => {
    const manifest = pwaManifest();
    expect(manifest).toMatchObject({
      id: "/app/",
      name: "Kvitbit",
      short_name: "Kvitbit",
      start_url: "/app/",
      scope: "/app/",
      display: "standalone",
    });
  });

  test("uses the app.json web colours from the brand tokens", () => {
    expect<string>(pwaManifest().theme_color).toBe(appJson.expo.web.themeColor);
    expect<string>(pwaManifest().background_color).toBe(appJson.expo.web.backgroundColor);
  });

  test("declares 192 and 512 px icons plus a maskable 512 that match the brand PNGs", async () => {
    const { icons } = pwaManifest();
    expect(EffectArray.map(icons, (icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    const pngSizes = await Promise.all(
      EffectArray.map(pwaIcons, (icon) => pngSize(join(brandWebAssets, icon.file))),
    );
    expect(EffectArray.map(icons, (icon) => icon.src)).toEqual(
      EffectArray.map(pwaIcons, (icon) => `/app/icons/${icon.file}`),
    );
    expect(EffectArray.map(icons, (icon) => icon.sizes)).toEqual(pngSizes);
  });
});

describe("index.html injection", () => {
  const injected = injectPwaHead(expoShell, { themeColor: pwaColors.theme });

  test("links the manifest and the apple-touch-icon under /app/", () => {
    expect(injected).toContain('<link rel="manifest" href="/app/manifest.webmanifest">');
    expect(injected).toContain(`<link rel="apple-touch-icon" href="/app/icons/${appleTouchIcon}">`);
  });

  test("replaces Expo's theme-color with exactly one brand theme-color", () => {
    expect(EffectString.match(/name="theme-color"/g)(injected).pipe(Option.getOrNull)).toHaveLength(
      1,
    );
    expect(injected).toContain(`<meta name="theme-color" content="${pwaColors.theme}">`);
  });

  test("registers the worker with scope /app/ inside the head", () => {
    const head = EffectString.slice(
      0,
      Option.getOrThrow(EffectString.indexOf("</head>")(injected)),
    )(injected);
    expect(head).toContain('navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" })');
  });

  test("keeps the body and its bundles untouched", () => {
    expect(
      EffectString.slice(Option.getOrThrow(EffectString.indexOf("</head>")(injected)))(injected),
    ).toBe(
      EffectString.slice(Option.getOrThrow(EffectString.indexOf("</head>")(expoShell)))(expoShell),
    );
  });

  test("refuses a shell without </head> or one injected twice", () => {
    expect(() => injectPwaHead("<html><body></body></html>", { themeColor: "#111111" })).toThrow(
      "</head>",
    );
    expect(() => injectPwaHead(injected, { themeColor: "#111111" })).toThrow("already");
  });
});

describe("asset URL verification", () => {
  test("lists every src and href in order", () => {
    expect(assetUrls(expoShell)).toEqual([
      "/app/favicon.ico",
      "/app/_expo/static/js/web/__common-ef16.js",
      "/app/_expo/static/js/web/index-fc40.js",
    ]);
  });

  test("accepts a shell whose URLs all sit under /app/", () => {
    expect(urlsOutsideBase(injectPwaHead(expoShell, { themeColor: "#111111" }))).toEqual([]);
  });

  test("flags root-relative, relative, sibling-prefix and cross-origin URLs", () => {
    const html = `<head><script src="/_expo/static/js/a.js"></script><link href='favicon.ico'><img src="/application/x.png"><script src="https://cdn.example/x.js"></script><img src="data:image/png;base64,AA"></head>`;
    expect(urlsOutsideBase(html)).toEqual([
      "/_expo/static/js/a.js",
      "favicon.ico",
      "/application/x.png",
      "https://cdn.example/x.js",
    ]);
  });

  test("precaches only the hashed static bundles", () => {
    expect(staticAssetUrls(expoShell)).toEqual([
      "/app/_expo/static/js/web/__common-ef16.js",
      "/app/_expo/static/js/web/index-fc40.js",
    ]);
  });
});

describe("service worker", () => {
  const source = serviceWorkerSource({
    version: "abc123",
    precache: ["/app/_expo/static/js/web/index-1.js"],
    integrity: {
      "/app/_expo/static/js/web/index-1.js": "sha256-bundle",
      "/app/index.html": "sha256-shell",
    },
  });

  test("versions its cache and drops older kvitbit caches on activate", () => {
    expect(source).toContain(`const CACHE = "${CACHE_PREFIX}abc123";`);
    expect(source).toContain("key.startsWith(PREFIX) && key !== CACHE");
    expect(source).toContain("caches.delete(key)");
  });

  test("is valid JavaScript", () => {
    expect(() => new Function(source)).not.toThrow();
  });

  /** Runs the generated worker against stand-in globals and returns how it answers fetches. */
  interface WorkerEvent {
    readonly request?: Request;
    readonly waitUntil?: (pending: Promise<unknown>) => void;
    readonly respondWith?: (response: Promise<Response>) => void;
  }

  const loadWorker = (respond?: (pathname: string, request: Request) => Response) => {
    const listeners = new Map<string, (event: WorkerEvent) => void>();
    const store = new Map<string, Response>();
    const network: string[] = [];
    const requests: RequestInit[] = [];
    class WorkerRequest extends Request {
      constructor(input: string, init: RequestInit) {
        super(input, init);
        requests.push(init);
      }
    }
    let online = true;
    const cachePath = (request: string | Request) =>
      Predicate.isString(request) ? request : new URL(request.url).pathname;
    const cache = {
      match: (request: Request | string) => Promise.resolve(store.get(cachePath(request))?.clone()),
      put: (request: Request | string, response: Response) => {
        store.set(cachePath(request), response);
        return Promise.resolve();
      },
      addAll: () => Promise.resolve(),
    };
    const self = {
      location: { origin: "https://kvitbit.cz" },
      addEventListener: (type: string, listener: (event: WorkerEvent) => void) =>
        listeners.set(type, listener),
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    };
    const fetchStub = (request: Request) => {
      const pathname = new URL(request.url).pathname;
      network.push(pathname);
      if (!online) return Promise.reject(new TypeError("offline"));
      if (respond !== undefined) return Promise.resolve(respond(pathname, request));
      const response = new Response(`net ${pathname}`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "url", { value: request.url });
      return Promise.resolve(response);
    };
    const caches = {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    };
    new Function("self", "caches", "fetch", "Request", source)(
      self,
      caches,
      fetchStub,
      WorkerRequest,
    );

    const install = async () => {
      let pending: Promise<unknown> | undefined;
      listeners.get("install")?.({
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise;
        },
      });
      if (pending !== undefined) await pending;
    };

    const dispatch = async (url: string, init: { mode?: string; method?: string } = {}) => {
      let answer: Promise<Response> | undefined;
      const request = Object.assign(new Request(url, { method: init.method ?? "GET" }), {});
      Object.defineProperty(request, "mode", { value: init.mode ?? "cors" });
      listeners.get("fetch")?.({
        request,
        respondWith: (response: Promise<Response>) => {
          answer = response;
        },
      });
      return answer === undefined ? undefined : (await answer).text();
    };
    return {
      install,
      dispatch,
      network,
      requests,
      store,
      goOffline: () => {
        online = false;
      },
    };
  };

  test("leaves /api/**, /mcp/**, cross-origin, non-GET and non-/app/ requests to the network", async () => {
    const worker = loadWorker();
    expect(await worker.dispatch("https://kvitbit.cz/api/documents")).toBeUndefined();
    expect(await worker.dispatch("https://kvitbit.cz/mcp/tools")).toBeUndefined();
    expect(
      await worker.dispatch("https://kvitbit.cz/api/auth/session", { mode: "navigate" }),
    ).toBeUndefined();
    expect(await worker.dispatch("https://cdn.example/app/_expo/static/x.js")).toBeUndefined();
    expect(
      await worker.dispatch("https://kvitbit.cz/app/_expo/static/x.js", { method: "POST" }),
    ).toBeUndefined();
    expect(worker.store.size).toBe(0);
  });

  test("serves hashed static assets cache-first", async () => {
    const worker = loadWorker();
    expect(await worker.dispatch("https://kvitbit.cz/app/_expo/static/js/web/index-1.js")).toBe(
      "net /app/_expo/static/js/web/index-1.js",
    );
    worker.goOffline();
    expect(await worker.dispatch("https://kvitbit.cz/app/_expo/static/js/web/index-1.js")).toBe(
      "net /app/_expo/static/js/web/index-1.js",
    );
    expect(worker.network).toEqual(["/app/_expo/static/js/web/index-1.js"]);
    expect(worker.requests[0]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      integrity: "sha256-bundle",
    });
  });

  test("serves navigations network-first and falls back to the cached public shell offline", async () => {
    const worker = loadWorker();
    await worker.install();
    expect(
      await worker.dispatch("https://kvitbit.cz/app/w/acme/documents", { mode: "navigate" }),
    ).toBe("net /app/w/acme/documents");
    worker.goOffline();
    expect(
      await worker.dispatch("https://kvitbit.cz/app/w/acme/contacts", { mode: "navigate" }),
    ).toBe("net /app/index.html");
  });

  test("never caches private, no-store, or Set-Cookie HTML responses into the offline shell", async () => {
    const worker = loadWorker((pathname, request) => {
      if (pathname === "/app/index.html") {
        const res = new Response("PUBLIC-SHELL", {
          status: 200,
          headers: { "content-type": "text/html", "cache-control": "public, max-age=60" },
        });
        Object.defineProperty(res, "url", { value: request.url });
        return res;
      }
      if (pathname === "/app/") {
        const res = new Response("PRIVATE-ROOT-BODY", {
          status: 200,
          headers: { "content-type": "text/html", "cache-control": "private, no-store" },
        });
        Object.defineProperty(res, "url", { value: request.url });
        return res;
      }
      const res = new Response("PRIVATE-ROUTE-SENTINEL", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "cache-control": "private, no-store",
          "set-cookie": "session=secret",
        },
      });
      Object.defineProperty(res, "url", { value: request.url });
      return res;
    });

    await worker.install();
    expect(
      await worker.dispatch("https://kvitbit.cz/app/w/acme/invoices", { mode: "navigate" }),
    ).toBe("PRIVATE-ROUTE-SENTINEL");
    expect(await worker.dispatch("https://kvitbit.cz/app/", { mode: "navigate" })).toBe(
      "PRIVATE-ROOT-BODY",
    );

    worker.goOffline();
    const offlineAnswer = await worker.dispatch("https://kvitbit.cz/app/", { mode: "navigate" });
    expect(offlineAnswer).toBe("PUBLIC-SHELL");
    expect(offlineAnswer).not.toContain("PRIVATE-");
  });

  test.each([
    { "cache-control": "private, max-age=60" },
    { "cache-control": "no-store" },
    { "set-cookie": "session=example" },
    { vary: "Accept-Language, Cookie" },
  ])(
    "checks cache eligibility during installation and on static cache misses (%j)",
    async (headers) => {
      const worker = loadWorker((_pathname, request) => {
        const response = new Response("uncacheable", {
          headers: { "content-type": "text/html", ...headers },
        });
        Object.defineProperty(response, "url", { value: request.url });
        return response;
      });
      await worker.install();
      expect(worker.store.size).toBe(0);
      await worker.dispatch("https://kvitbit.cz/app/_expo/static/js/web/index-1.js");
      expect(worker.store.size).toBe(0);
    },
  );

  test("rejects a final URL outside the artifact path and ignores unlisted assets", async () => {
    const worker = loadWorker(() => {
      const response = new Response("API data", { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: "https://kvitbit.cz/api/private" });
      return response;
    });
    await worker.install();
    expect(worker.store.size).toBe(0);
    expect(
      await worker.dispatch("https://kvitbit.cz/app/_expo/static/unlisted.js"),
    ).toBeUndefined();
  });
});

describe("decorateExport", () => {
  let dist: string;
  const decorate = (iconSource: string) =>
    decorateExport({ dist, iconSource }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        dist = yield* fs.makeTempDirectory({ prefix: "kvitbit-pwa-" });
        yield* fs.writeFileString(join(dist, "index.html"), expoShell);
        yield* Effect.forEach(
          staticAssetUrls(expoShell),
          (url) => {
            const file = join(dist, EffectString.slice("/app/".length)(url));
            return fs
              .makeDirectory(path.dirname(file), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(file, "exported bundle")));
          },
          { concurrency: "unbounded", discard: true },
        );
      }),
    ),
  );

  afterEach(() => Effect.runPromise(fs.remove(dist, { recursive: true, force: true })));

  test("writes the manifest, worker, icons and injected shell", async () => {
    await decorate(brandWebAssets);

    const entries = await Effect.runPromise(
      Effect.forEach(pwaEntryFiles, (file) => fs.exists(join(dist, file)), {
        concurrency: "unbounded",
      }),
    );
    expect(entries).toEqual(EffectArray.map(pwaEntryFiles, () => true));
    expect(await Bun.file(join(dist, "manifest.webmanifest")).json()).toEqual(pwaManifest());
    const worker = await Bun.file(join(dist, "sw.js")).text();
    expect(worker).toContain(`${CACHE_PREFIX}${exportVersion(expoShell)}`);
    expect(worker).toContain("/app/_expo/static/js/web/index-fc40.js");
    expect(await Bun.file(join(dist, "index.html")).text()).toContain('rel="manifest"');
  });

  test("fails when the export loads a URL outside /app/", async () => {
    await Bun.write(
      join(dist, "index.html"),
      EffectString.replace("/app/_expo", "/_expo")(expoShell),
    );
    await expect(decorate(brandWebAssets)).rejects.toThrow("outside /app/");
  });

  test("fails when a brand icon is missing", async () => {
    const empty = join(dist, "no-icons");
    await Effect.runPromise(fs.makeDirectory(empty));
    await expect(decorate(empty)).rejects.toThrow();
  });
});
