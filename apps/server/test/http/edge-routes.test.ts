import { afterEach, describe, expect, mock, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { generateId } from "@kvitbit/adapters/auth";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { POSTHOG_PROXY_PATH } from "../../src/http/analyticsProxy";
import { RequestIdsLive } from "../../src/http/edge/requestId";
import { captureAnalytics, posthogSettings } from "../analytics-fixture";
import { as, type Harness, json, makeHarness } from "./harness";

const decodeWorkspace = Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String }));

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const randomRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Edge routes: health, config, botProtection, invitations, oauthConsent, static", () => {
  let harness: Harness | undefined;
  const tempDirs: Array<string> = [];

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.forEach(
        tempDirs.splice(0),
        (dir) => fs.remove(dir, { recursive: true, force: true }),
        { concurrency: 1 },
      );
    }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
  });

  test("GET /healthz and GET /readyz return 200 ok", async () => {
    harness = makeHarness();

    const health = await harness.fetch("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const ready = await harness.fetch("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok" });
  });

  test("echoes UUID request IDs and generates one for errors without a valid ID", async () => {
    harness = makeHarness();

    const id = "01950000-0000-7000-8000-000000000001";
    const health = await harness.fetch("/healthz", { headers: { "X-Request-Id": id } });
    expect(health.headers.get("x-request-id")).toBe(id);

    const missing = await harness.fetch("/api/v1/unknown", {
      headers: { "X-Request-Id": "untrusted" },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-request-id")).toMatch(randomRequestId);
  });

  test("serves the public Scalar API reference", async () => {
    harness = makeHarness();
    const response = await harness.fetch("/api/v1/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Scalar.createApiReference");
  });

  test("the Better Auth route bounds JSON bodies without Content-Length", async () => {
    harness = makeHarness();
    const response = await harness.fetch("/api/auth/sign-up/email", {
      ...json({ name: EffectString.repeat(1024 * 1024)("x") }),
      method: "POST",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ _tag: "PayloadTooLarge", limitBytes: 1024 * 1024 });
  });

  test("a route defect returns a correlated error without its cause", async () => {
    const routes = HttpRouter.add("GET", "/broken", Effect.die(new Error("fixture detail")));
    const app = HttpRouter.toWebHandler(Layer.merge(routes, RequestIdsLive), {
      disableLogger: true,
    });
    try {
      const response = await app.handler(new Request("https://kvitbit.test/broken"));
      const requestId = response.headers.get("x-request-id");
      expect(response.status).toBe(500);
      expect(requestId).toBeTruthy();
      expect(await response.json()).toEqual({ _tag: "InternalError", requestId });
    } finally {
      await app.dispose();
    }
  });

  test("grants cross-origin calls only to configured API origins", async () => {
    const browser = "https://self-hosted.example";
    harness = makeHarness({ config: { corsOrigins: [browser] } });

    const preflight = await harness.fetch("/api/v1/config", {
      method: "OPTIONS",
      headers: {
        Origin: browser,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(browser);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const allowed = await harness.fetch("/api/v1/config", { headers: { Origin: browser } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(browser);
    const unlisted = await harness.fetch("/api/v1/config", {
      headers: { Origin: "https://unlisted.example" },
    });
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("GET /api/v1/config returns version, botProtection, upload limits, and features", async () => {
    harness = makeHarness({
      config: { version: "1.2.3", botProtection: "none", signUp: false },
    });

    const res = await harness.fetch("/api/v1/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: "1.2.3",
      botProtection: "none",
      analytics: { posthog: null },
      features: { signUp: false, mcp: true, apiKeys: true },
    });
  });

  test("GET /api/v1/config exposes the configured PostHog project via the first-party proxy path", async () => {
    harness = makeHarness({ config: { posthog: posthogSettings } });
    const response = await harness.fetch("/api/v1/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      analytics: { posthog: { apiKey: posthogSettings.apiKey, host: POSTHOG_PROXY_PATH } },
    });
  });

  test("POST /_kvb/* proxies allowlisted PostHog ingestion with credentials stripped and visitor IP forwarded", async () => {
    const upstreamCalls: Array<{
      readonly url: string;
      readonly method: string | undefined;
      readonly headers: Headers;
      readonly body: string;
      readonly redirect: string | undefined;
    }> = [];
    const proxyFetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = Predicate.isString(input) ? input : input instanceof URL ? input.href : input.url;
      const body =
        init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : String(init?.body ?? "");
      upstreamCalls.push({
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body,
        redirect: init?.redirect,
      });
      return Promise.resolve(
        new Response(encodeJson({ status: 1 }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "ph_session=should-not-leak",
          },
        }),
      );
    });

    harness = makeHarness({
      config: { posthog: posthogSettings, trustedProxyHops: 2 },
      feedbackFetch: Object.assign(proxyFetch, { preconnect: () => undefined }),
    });

    const payload = encodeJson({ event: "$pageview", properties: { $pathname: "/" } });
    const ok = await harness.fetch(
      `${POSTHOG_PROXY_PATH}/e/?ip=0&ver=1.455.4&compression=gzip-js&extra=dropped`,
      {
        method: "POST",
        headers: {
          host: "kvitbit.com",
          origin: "https://kvitbit.com",
          "content-type": "application/json",
          "user-agent": "KvitbitTestBrowser/1.0",
          cookie: "__Secure-kvitbit.session_token=secret-session",
          authorization: "Bearer kvb_secret_token",
          "x-api-key": "secret-key",
          referer: "https://kvitbit.com/i/private-share-token",
          "x-forwarded-for": "198.51.100.7, 203.0.113.9",
        },
        body: payload,
      },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 1 });
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");

    expect(upstreamCalls).toHaveLength(1);
    const forwarded = upstreamCalls[0];
    if (forwarded === undefined) throw new Error("Expected upstream proxy call");
    expect(forwarded.url).toBe(`${posthogSettings.host}/e/?ip=0&ver=1.455.4&compression=gzip-js`);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.redirect).toBe("manual");
    expect(forwarded.body).toBe(payload);
    expect(forwarded.headers.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(forwarded.headers.get("user-agent")).toBe("KvitbitTestBrowser/1.0");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("x-api-key")).toBeNull();
    expect(forwarded.headers.get("referer")).toBeNull();
    expect(forwarded.headers.get("origin")).toBeNull();

    // Disallowed subpaths, third-party origins, and oversized payloads are rejected before upstream fetch.
    expect(
      (await harness.fetch(`${POSTHOG_PROXY_PATH}/flags/`, { method: "POST", body: "{}" })).status,
    ).toBe(404);
    expect(
      (
        await harness.fetch(`${POSTHOG_PROXY_PATH}/e/`, {
          method: "POST",
          headers: { host: "kvitbit.com", origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.fetch(`${POSTHOG_PROXY_PATH}/e/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: EffectString.repeat(64 * 1024 + 1)("x"),
        })
      ).status,
    ).toBe(413);
    expect(upstreamCalls).toHaveLength(1);

    // Upstream redirects and network errors fail closed as 502.
    proxyFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254" } }),
    );
    expect(
      (await harness.fetch(`${POSTHOG_PROXY_PATH}/e/`, { method: "POST", body: "{}" })).status,
    ).toBe(502);

    proxyFetch.mockRejectedValueOnce(new Error("upstream unreachable"));
    expect(
      (await harness.fetch(`${POSTHOG_PROXY_PATH}/e/`, { method: "POST", body: "{}" })).status,
    ).toBe(502);
  });

  test("POST /_kvb/e/ returns 404 when PostHog is disabled", async () => {
    harness = makeHarness({ config: { posthog: null } });
    const response = await harness.fetch(`${POSTHOG_PROXY_PATH}/e/`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  test("workspace creation succeeds when PostHog capture throws", async () => {
    const analytics = captureAnalytics();
    analytics.capture.mockImplementation(() => {
      throw new Error("test SDK failure");
    });
    const app = makeHarness({ analytics: analytics.layer });
    harness = app;
    const owner = app.addUser("Private owner name");
    const create = () =>
      app.fetch("/api/v1/workspaces", {
        ...json({ name: "Private workspace name" }),
        method: "POST",
        headers: {
          ...as.mobile(owner),
          "content-type": "application/json",
          "idempotency-key": "analytics-ws-1",
        },
      });
    const response = await create();
    expect(response.status).toBe(201);
    const workspace = decodeWorkspace(await response.json()).pipe(Result.getOrThrow);
    expect((await create()).headers.get("idempotent-replayed")).toBe("true");
    expect(analytics.capture.mock.calls).toEqual([
      [
        {
          event: "workspace_created",
          distinctId: owner.id,
          properties: { workspaceId: workspace.id },
        },
      ],
    ]);
  });

  test("GET /api/v1/bot-protection/challenges/sign_up returns 204 when NoopBotProtection is active", async () => {
    harness = makeHarness();
    const res = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("OAuth consent rejects an unsigned request for a registered client", async () => {
    harness = makeHarness();
    const owner = harness.addUser("Lukas");
    const clientId = "https://client.example/oauth.json";
    const redirectUri = "http://127.0.0.1:4321/callback";

    await harness.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          insert into auth.oauth_client (id, client_id, name, redirect_uris)
          values (${generateId()}, ${clientId}, 'Test MCP Client', ${["http://127.0.0.1/callback"]}::text[])`;
      }),
    );

    const now = Effect.runSync(Clock.currentTimeMillis);
    const rawQuery = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "kvitbit:read offline_access",
      state: "xyz",
      exp: String(Math.floor(now / 1000) + 600),
    }).toString();
    const consentId = Buffer.from(rawQuery, "utf8").toString("base64url");

    const getRes = await harness.fetch(`/api/v1/oauth/consents/${consentId}`, {
      headers: as.web(owner),
    });
    expect(getRes.status).toBe(404);
  });

  test("Static mounts serve web (/) and PWA (/app/) with SPA fallback and cache headers", async () => {
    const mounts = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const webDir = yield* fs.makeTempDirectory({ prefix: "kvitbit-web-" });
      tempDirs.push(webDir);
      const pwaDir = yield* fs.makeTempDirectory({ prefix: "kvitbit-pwa-" });
      tempDirs.push(pwaDir);

      yield* fs.makeDirectory(path.join(webDir, "assets"), { recursive: true });
      yield* fs.writeFileString(path.join(webDir, "index.html"), "<html>web-spa</html>");
      yield* fs.writeFileString(
        path.join(webDir, "assets", "main-deadbeef.js"),
        "console.log('web');",
      );

      yield* fs.makeDirectory(path.join(pwaDir, "assets"), { recursive: true });
      yield* fs.writeFileString(path.join(pwaDir, "index.html"), "<html>pwa-spa</html>");
      yield* fs.writeFileString(
        path.join(pwaDir, "sw.js"),
        "self.addEventListener('fetch', () => {});",
      );
      yield* fs.writeFileString(path.join(pwaDir, "manifest.webmanifest"), '{"name":"Kvitbit"}');
      yield* fs.writeFileString(
        path.join(pwaDir, "assets", "bundle-cafebabe.js"),
        "console.log('pwa');",
      );
      return { webDir, pwaDir };
    }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

    harness = makeHarness({
      config: { webDir: Option.some(mounts.webDir), pwaDir: Option.some(mounts.pwaDir) },
    });

    // Web SPA fallback on client route
    const webSpa = await harness.fetch("/w/some-ws/documents");
    expect(webSpa.status).toBe(200);
    expect(await webSpa.text()).toBe("<html>web-spa</html>");
    expect(webSpa.headers.get("cache-control")).toBe("no-cache");

    const sharePage = await harness.fetch("/i/some-token");
    expect(sharePage.headers.get("cache-control")).toBe("private, no-store");
    expect(sharePage.headers.get("referrer-policy")).toBe("no-referrer");
    expect(sharePage.headers.get("x-robots-tag")).toBe("noindex");

    // Web hashed asset is immutable
    const webAsset = await harness.fetch("/assets/main-deadbeef.js");
    expect(webAsset.status).toBe(200);
    expect(webAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // Excluded paths do NOT fall back to index.html
    expect((await harness.fetch("/assets/missing.js")).status).toBe(404);
    expect((await harness.fetch("/.well-known/unknown")).status).toBe(404);
    expect((await harness.fetch("/api/does-not-exist")).status).toBe(404);
    expect((await harness.fetch(`${POSTHOG_PROXY_PATH}/e/`)).status).toBe(404);

    // PWA routes under /app/
    const pwaSpa = await harness.fetch("/app/w/123/invoices");
    expect(pwaSpa.status).toBe(200);
    expect(await pwaSpa.text()).toBe("<html>pwa-spa</html>");
    expect(pwaSpa.headers.get("cache-control")).toBe("no-cache");

    const sw = await harness.fetch("/app/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("cache-control")).toBe("no-cache");

    const manifest = await harness.fetch("/app/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("no-cache");

    const pwaAsset = await harness.fetch("/app/assets/bundle-cafebabe.js");
    expect(pwaAsset.status).toBe(200);
    expect(pwaAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
