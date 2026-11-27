import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decorateExport, exportVersion, pwaEntryFiles } from "./build-pwa";
import { assetUrls, injectPwaHead, staticAssetUrls, urlsOutsideBase } from "./pwa/html";
import { appleTouchIcon, pwaColors, pwaIcons, pwaManifest } from "./pwa/manifest";
import { CACHE_PREFIX, serviceWorkerSource } from "./pwa/service-worker";

const brandWebAssets = resolve(import.meta.dir, "../../../assets/brand/web");

/** Width and height from a PNG's IHDR chunk. */
const pngSize = async (path: string) => {
  const view = new DataView(await Bun.file(path).arrayBuffer());
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

  test("uses the app.json web colours from the brand tokens", async () => {
    const { expo } = (await Bun.file(resolve(import.meta.dir, "../app.json")).json()) as {
      expo: { web: { themeColor: string; backgroundColor: string } };
    };
    expect<string>(pwaManifest().theme_color).toBe(expo.web.themeColor);
    expect<string>(pwaManifest().background_color).toBe(expo.web.backgroundColor);
  });

  test("declares 192 and 512 px icons plus a maskable 512 that match the brand PNGs", async () => {
    const { icons } = pwaManifest();
    expect(icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const [index, icon] of icons.entries()) {
      expect(icon.src).toBe(`/app/icons/${pwaIcons[index]?.file}`);
      expect(await pngSize(join(brandWebAssets, pwaIcons[index]?.file ?? ""))).toBe(icon.sizes);
    }
  });
});

describe("index.html injection", () => {
  const injected = injectPwaHead(expoShell, { themeColor: pwaColors.theme });

  test("links the manifest and the apple-touch-icon under /app/", () => {
    expect(injected).toContain('<link rel="manifest" href="/app/manifest.webmanifest">');
    expect(injected).toContain(`<link rel="apple-touch-icon" href="/app/icons/${appleTouchIcon}">`);
  });

  test("replaces Expo's theme-color with exactly one brand theme-color", () => {
    expect(injected.match(/name="theme-color"/g)).toHaveLength(1);
    expect(injected).toContain(`<meta name="theme-color" content="${pwaColors.theme}">`);
  });

  test("registers the worker with scope /app/ inside the head", () => {
    const head = injected.slice(0, injected.indexOf("</head>"));
    expect(head).toContain('navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" })');
  });

  test("keeps the body and its bundles untouched", () => {
    expect(injected.slice(injected.indexOf("</head>"))).toBe(
      expoShell.slice(expoShell.indexOf("</head>")),
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
  const loadWorker = (respond?: (pathname: string, request: Request) => Response) => {
    const listeners = new Map<string, (event: unknown) => void>();
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
    const cache = {
      match: async (request: Request | string) =>
        store.get(typeof request === "string" ? request : new URL(request.url).pathname)?.clone(),
      put: async (request: Request | string, response: Response) => {
        store.set(typeof request === "string" ? request : new URL(request.url).pathname, response);
      },
      addAll: async () => {},
    };
    const self = {
      location: { origin: "https://kvitbit.cz" },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      skipWaiting: () => {},
      clients: { claim: () => {} },
    };
    const fetchStub = async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      network.push(pathname);
      if (!online) throw new TypeError("offline");
      if (respond) return respond(pathname, request);
      const response = new Response(`net ${pathname}`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "url", { value: request.url });
      return response;
    };
    const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
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
      if (pending) await pending;
    };

    const dispatch = async (url: string, init: { mode?: string; method?: string } = {}) => {
      let answer: Promise<Response> | undefined;
      const request = Object.assign(new Request(url, { method: init.method ?? "GET" }), {});
      Object.defineProperty(request, "mode", { value: init.mode ?? "cors" });
      listeners.get("fetch")?.({
        request,
        respondWith: (response: Promise<Response>) => (answer = response),
      });
      return answer ? await (await answer).text() : undefined;
    };
    return { install, dispatch, network, requests, store, goOffline: () => (online = false) };
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

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "kvitbit-pwa-"));
    await writeFile(join(dist, "index.html"), expoShell);
    for (const url of staticAssetUrls(expoShell)) {
      const file = join(dist, url.slice("/app/".length));
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "exported bundle");
    }
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  test("writes the manifest, worker, icons and injected shell", async () => {
    await decorateExport({ dist, iconSource: brandWebAssets });

    for (const file of pwaEntryFiles) expect(await Bun.file(join(dist, file)).exists()).toBe(true);
    expect(await Bun.file(join(dist, "manifest.webmanifest")).json()).toEqual(pwaManifest());
    const worker = await readFile(join(dist, "sw.js"), "utf8");
    expect(worker).toContain(`${CACHE_PREFIX}${exportVersion(expoShell)}`);
    expect(worker).toContain("/app/_expo/static/js/web/index-fc40.js");
    expect(await readFile(join(dist, "index.html"), "utf8")).toContain('rel="manifest"');
  });

  test("fails when the export loads a URL outside /app/", async () => {
    await writeFile(join(dist, "index.html"), expoShell.replace("/app/_expo", "/_expo"));
    await expect(decorateExport({ dist, iconSource: brandWebAssets })).rejects.toThrow(
      "outside /app/",
    );
  });

  test("fails when a brand icon is missing", async () => {
    const empty = join(dist, "no-icons");
    await mkdir(empty);
    await expect(decorateExport({ dist, iconSource: empty })).rejects.toThrow();
  });
});
