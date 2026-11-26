import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "@kvitbit/adapters/auth";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
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
      features: { signUp: false, mcp: true, apiKeys: true },
    });
  });

  test("GET /api/v1/bot-protection/challenges/sign_up returns 204 when NoopBotProtection is active", async () => {
    harness = makeHarness();
    const res = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("GET /api/v1/oauth/consents/:consentId returns client and role-capped workspaces; widening is 403", async () => {
    harness = makeHarness();
    const owner = harness.addUser("Lukas");
    const ws = await harness.createWorkspace(owner, { name: "Atelier s.r.o." });
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
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as {
      client: { id: string; name: string; redirectHost: string };
      requestedAccess: string;
      requestedScopes: Array<string>;
      workspaces: Array<{ id: string; role: string; offerableScopes: Array<string> }>;
    };
    expect(view.client.id).toBe(clientId);
    expect(view.client.name).toBe("Test MCP Client");
    expect(view.client.redirectHost).toBe("127.0.0.1:4321");
    expect(view.requestedAccess).toBe("read");
    expect(view.workspaces).toHaveLength(1);
    expect(view.workspaces[0]?.id).toBe(ws.workspaceId);
    expect(view.workspaces[0]?.offerableScopes).toHaveLength(10);

    // Attempting to widen to read_write when only read was requested -> 403 Forbidden
    const widen = await harness.fetch(`/api/v1/oauth/consents/${consentId}`, {
      method: "POST",
      ...json({
        _tag: "Approve",
        workspace: ws.workspaceId,
        grant: { access: "read_write" },
      }),
      headers: { ...as.web(owner), "content-type": "application/json" },
    });
    expect(widen.status).toBe(403);

    // Unknown consentId -> 404
    const missing = await harness.fetch("/api/v1/oauth/consents/not-a-valid-consent", {
      headers: as.web(owner),
    });
    expect(missing.status).toBe(404);
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
