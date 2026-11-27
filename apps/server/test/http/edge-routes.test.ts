import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "@kvitbit/adapters/auth";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { RequestIdsLive } from "../../src/http/edge/requestId";
import { captureAnalytics, posthogSettings } from "../analytics-fixture";
import { as, type Harness, json, makeHarness } from "./harness";

describe("Edge routes: health, config, botProtection, invitations, oauthConsent, static", () => {
  let harness: Harness | undefined;
  const tempDirs: Array<string> = [];

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(missing.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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
      ...json({ name: "x".repeat(1024 * 1024) }),
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: "1.2.3",
      botProtection: "none",
      analytics: { posthog: null },
      features: { signUp: false, mcp: true, apiKeys: true },
    });
  });

  test("GET /api/v1/config exposes the configured PostHog project", async () => {
    harness = makeHarness({ config: { posthog: posthogSettings } });
    const response = await harness.fetch("/api/v1/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ analytics: { posthog: posthogSettings } });
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
    const workspace = (await response.json()) as { id: string };
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

    const rawQuery = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "kvitbit:read offline_access",
      state: "xyz",
      exp: String(Math.floor(Date.now() / 1000) + 600),
    }).toString();
    const consentId = Buffer.from(rawQuery, "utf8").toString("base64url");

    const getRes = await harness.fetch(`/api/v1/oauth/consents/${consentId}`, {
      headers: as.web(owner),
    });
    expect(getRes.status).toBe(404);
  });

  test("Static mounts serve web (/) and PWA (/app/) with SPA fallback and cache headers", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "kvitbit-web-"));
    const pwaDir = mkdtempSync(join(tmpdir(), "kvitbit-pwa-"));
    tempDirs.push(webDir, pwaDir);

    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<html>web-spa</html>");
    writeFileSync(join(webDir, "assets", "main-deadbeef.js"), "console.log('web');");

    mkdirSync(join(pwaDir, "assets"), { recursive: true });
    writeFileSync(join(pwaDir, "index.html"), "<html>pwa-spa</html>");
    writeFileSync(join(pwaDir, "sw.js"), "self.addEventListener('fetch', () => {});");
    writeFileSync(join(pwaDir, "manifest.webmanifest"), '{"name":"Kvitbit"}');
    writeFileSync(join(pwaDir, "assets", "bundle-cafebabe.js"), "console.log('pwa');");

    harness = makeHarness({
      config: { webDir: Option.some(webDir), pwaDir: Option.some(pwaDir) },
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
