import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const fingerprint = Array(32).fill("AB").join(":");
const immutable = "public, max-age=31536000, immutable";
const databaseUrl = process.env.KVITBIT_SMOKE_DATABASE_URL;
let origin = process.env.KVITBIT_SMOKE_ORIGIN;
let server: Bun.Subprocess | undefined;
let blobDir: string | undefined;

beforeAll(async () => {
  if (!origin) {
    if (!databaseUrl)
      throw new Error("Set KVITBIT_SMOKE_DATABASE_URL to a disposable Postgres database.");

    const migration = Bun.spawn([process.execPath, "--no-env-file", "apps/server/src/migrate.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL_UNPOOLED: databaseUrl },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await migration.exited) !== 0) throw new Error("Smoke database migration failed.");

    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = String(listener.port);
    await listener.stop();
    origin = `http://127.0.0.1:${port}`;
    blobDir = await mkdtemp(join(tmpdir(), "kvitbit-static-smoke-"));
    server = Bun.spawn([process.execPath, "--no-env-file", "apps/server/src/main.ts"], {
      cwd: root,
      env: {
        NODE_ENV: "production",
        KVITBIT_ENV: "preview",
        HOST: "127.0.0.1",
        PORT: port,
        APP_ORIGIN: origin,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: "static-mount-smoke-test-only-secret",
        KVITBIT_RUNNER_MODE: "single",
        KVITBIT_EMAIL_MODE: "capture",
        KVITBIT_BLOB_DRIVER: "local",
        KVITBIT_BLOB_DIR: blobDir,
        KVITBIT_CHROMIUM_PATH: process.env.KVITBIT_CHROMIUM_PATH ?? "/usr/bin/chromium",
        KVITBIT_WEB_DIR: join(root, "apps/web/dist"),
        KVITBIT_PWA_DIR: join(root, "apps/mobile/dist"),
        KVITBIT_ANDROID_ASSETLINKS_SHA256: fingerprint,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  const waitUntil = Date.now() + 15_000;
  while (Date.now() < waitUntil && server?.exitCode == null) {
    const ready = await fetch(new URL("/readyz", origin), {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    await ready?.body?.cancel();
    if (ready?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `Kvitbit did not become ready at ${origin} (exit: ${server?.exitCode ?? "running"}).`,
  );
}, 30_000);

afterAll(async () => {
  if (server) {
    server.kill();
    await server.exited;
  }
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

const request = (path: string, init?: RequestInit) => {
  if (!origin) throw new Error("The smoke server has no origin.");
  return fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000), ...init });
};

const get = async (path: string, contentType: string, cache?: string) => {
  const response = await request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")?.split(";")[0]).toBe(contentType);
  if (cache) expect(response.headers.get("cache-control")).toBe(cache);
  return response;
};

const checkBundle = async (html: string, script: RegExp) => {
  const path = html.match(script)?.[1];
  if (!path) throw new Error(`The built HTML has no script matching ${script}.`);
  const bundle = await get(path, "application/javascript", immutable);
  expect((await bundle.arrayBuffer()).byteLength).toBeGreaterThan(0);
};

test("serves the built web shell and its hashed JavaScript", async () => {
  const html = await (await get("/", "text/html", "no-cache")).text();
  await checkBundle(html, /src="(\/assets\/[^"]+\.js)"/);
});

test("serves the built PWA at /app/, with a separate shell for nested routes and cached bundles", async () => {
  const html = await (await get("/app/", "text/html", "no-cache")).text();
  expect(html).toContain('href="/app/manifest.webmanifest"');
  expect(await (await get("/app/documents/new", "text/html", "no-cache")).text()).toBe(html);
  await checkBundle(html, /src="(\/app\/_expo\/static\/[^"]+\.js)"/);
});

test("revalidates the PWA manifest and service worker", async () => {
  const manifest = await get("/app/manifest.webmanifest", "application/manifest+json", "no-cache");
  expect(await manifest.json()).toMatchObject({ scope: "/app/", start_url: "/app/" });
  const sw = await get("/app/sw.js", "application/javascript", "no-cache");
  expect(await sw.text()).toContain('"/app/index.html"');
});

test.each(["/healthz", "/readyz"])("%s returns an uncached status", async (path) => {
  expect(await (await get(path, "application/json", "no-store")).json()).toEqual({ status: "ok" });
});

test("serves Android App Links alongside the PWA", async () => {
  const links = await get(
    "/.well-known/assetlinks.json",
    "application/json",
    "public, max-age=3600",
  );
  expect(await links.json()).toMatchObject([
    { target: { package_name: "cz.kvitbit.app", sha256_cert_fingerprints: [fingerprint] } },
  ]);
});

test("keeps API routes outside the web fallback", async () => {
  const config = await get("/api/v1/config", "application/json");
  expect(await config.json()).toMatchObject({ features: { mcp: true } });
  expect((await request("/api/v1/nonexistent")).status).toBe(404);
});

test("serves MCP discovery and routes /mcp through its own method and auth checks", async () => {
  const metadata = await get(
    "/.well-known/oauth-protected-resource/mcp",
    "application/json",
    "public, max-age=300",
  );
  expect(await metadata.json()).toMatchObject({ resource: `${origin}/mcp` });
  const method = await request("/mcp");
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("POST");
  await method.body?.cancel();
  const auth = await request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  expect(auth.status).toBe(401);
  expect(auth.headers.get("cache-control")).toBe("no-store");
  expect(auth.headers.get("www-authenticate")).toContain(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect(await auth.json()).toEqual({ error: "unauthorized", reason: "missing" });
});

test("answers an authenticated MCP ping over HTTP", async () => {
  if (!databaseUrl)
    throw new Error("Set KVITBIT_SMOKE_DATABASE_URL to seed a disposable MCP grant.");
  const db = new Bun.SQL(databaseUrl);
  const id = Bun.randomUUIDv7();
  const bearer = crypto.randomUUID();
  const hash = new Bun.CryptoHasher("sha256").update(bearer).digest("base64url");
  try {
    // The OAuth workspace tests exercise grant issuance. Here the fixture isolates the
    // live HTTP and persistence boundary by seeding a short-lived, workspace-bound grant.
    await db.begin(async (tx) => {
      await tx`insert into workspaces (id, slug, name) values (${id}, ${id}, 'Static smoke')`;
      await tx`insert into auth."user" (id, name, email, email_verified)
        values (${id}, 'Static smoke', ${`${id}@example.test`}, true)`;
      await tx`insert into memberships (workspace_id, user_id, role)
        values (${id}, ${id}, 'owner')`;
      await tx`insert into auth.oauth_client (id, client_id, redirect_uris)
        values (${id}, ${id}, array['https://example.test/callback'])`;
      await tx`insert into auth.oauth_consent
        (id, client_id, user_id, workspace_id, access, scopes, granted_scopes)
        values (${id}, ${id}, ${id}, ${id}, 'custom',
          array['kvitbit:workspace:read'], array['workspace:read'])`;
      await tx`insert into auth.oauth_access_token
        (id, token, client_id, user_id, consent_id, resources, scopes, expires_at)
        values (${id}, ${hash}, ${id}, ${id}, ${id}, array[${`${origin}/mcp`}::text],
          array['kvitbit:workspace:read'], now() + interval '1 minute')`;
    });
    const response = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  } finally {
    try {
      await db.begin(async (tx) => {
        await tx`delete from auth.oauth_client where client_id = ${id}`;
        await tx`delete from workspaces where id = ${id}`;
        await tx`delete from auth."user" where id = ${id}`;
      });
    } finally {
      await db.close();
    }
  }
});
