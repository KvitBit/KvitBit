import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Config from "effect/Config";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const root = new URL("../../../../", import.meta.url);
const fingerprint = `${Str.repeat(31)("AB:")}AB`;
const immutable = "public, max-age=31536000, immutable";
const webBundleScript = /src="(\/assets\/[^"]+\.js)"/;
const pwaBundleScript = /src="(\/app\/_expo\/static\/[^"]+\.js)"/;
const pingBody = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
const smokeConfig = Effect.runSync(
  Config.all({
    databaseUrl: Config.option(Config.String("KVITBIT_SMOKE_DATABASE_URL")),
    origin: Config.option(Config.String("KVITBIT_SMOKE_ORIGIN")),
    chromiumPath: Config.String("KVITBIT_CHROMIUM_PATH").pipe(
      Config.withDefault("/usr/bin/chromium"),
    ),
  }),
);
const databaseUrl = Option.getOrUndefined(smokeConfig.databaseUrl);
let origin = Option.getOrUndefined(smokeConfig.origin);
let server: Bun.Subprocess | undefined;
let blobDir: string | undefined;

class SmokeRequestError extends Schema.TaggedError<
  SmokeRequestError,
  { readonly brand: unique symbol }
>()("SmokeRequestError", { path: Schema.String, cause: Schema.Unknown }) {}

const requestEffect = Effect.fnUntraced(function* (path: string, init?: RequestInit) {
  if (origin === undefined || origin === "") {
    return yield* SmokeRequestError.make({ path, cause: "The smoke server has no origin." });
  }
  const url = new URL(path, origin);
  const send = yield* FetchHttpClient.Fetch;
  return yield* Effect.tryPromise({
    try: () => send(url, { signal: AbortSignal.timeout(5000), ...init }),
    catch: (cause) => SmokeRequestError.make({ path, cause }),
  });
});

const request = (path: string, init?: RequestInit) => Effect.runPromise(requestEffect(path, init));

const waitForServer = Effect.gen(function* () {
  const waitUntil = performance.now() + 15_000;
  while (performance.now() < waitUntil && (server === undefined || server.exitCode === null)) {
    const ready = yield* requestEffect("/readyz", {
      signal: AbortSignal.timeout(1000),
    }).pipe(Effect.option);
    if (Option.isSome(ready)) {
      const response = ready.value;
      const body = response.body;
      if (body !== null) yield* Effect.promise(() => body.cancel());
      if (response.ok) return true;
    }
    yield* Effect.sleep(100);
  }
  return false;
});

beforeAll(async () => {
  if (origin === undefined || origin === "") {
    if (databaseUrl === undefined || databaseUrl === "")
      throw new Error("Set KVITBIT_SMOKE_DATABASE_URL to a disposable Postgres database.");

    const migration = Bun.spawn([process.execPath, "--no-env-file", "apps/server/src/migrate.ts"], {
      cwd: fileURLToPath(root),
      env: { ...Bun.env, DATABASE_URL_UNPOOLED: databaseUrl },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await migration.exited) !== 0) throw new Error("Smoke database migration failed.");

    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = String(listener.port);
    await listener.stop();
    origin = `http://127.0.0.1:${port}`;
    blobDir = await Effect.runPromise(
      FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectory({ prefix: "kvitbit-static-smoke-" }),
      ).pipe(Effect.provide(BunFileSystem.layer)),
    );
    server = Bun.spawn([process.execPath, "--no-env-file", "apps/server/src/main.ts"], {
      cwd: fileURLToPath(root),
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
        KVITBIT_BOT_PROTECTION_MODE: "none",
        KVITBIT_BLOB_DIR: blobDir,
        KVITBIT_CHROMIUM_PATH: smokeConfig.chromiumPath,
        KVITBIT_WEB_DIR: fileURLToPath(new URL("apps/web/dist", root)),
        KVITBIT_PWA_DIR: fileURLToPath(new URL("apps/mobile/dist", root)),
        KVITBIT_ANDROID_ASSETLINKS_SHA256: fingerprint,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
  }

  if (await Effect.runPromise(waitForServer)) return;
  throw new Error(
    `Kvitbit did not become ready at ${origin} (exit: ${server?.exitCode ?? "running"}).`,
  );
}, 30_000);

afterAll(async () => {
  if (server !== undefined) {
    server.kill();
    await server.exited;
  }
  const dir = blobDir;
  if (dir !== undefined) {
    await Effect.runPromise(
      FileSystem.FileSystem.use((fs) => fs.remove(dir, { recursive: true, force: true })).pipe(
        Effect.provide(BunFileSystem.layer),
      ),
    );
  }
});

const responseContentType = (response: Response) => {
  const header = response.headers.get("content-type");
  return header === null ? undefined : Str.split(";")(header)[0];
};

const get = async (path: string, contentType: string, cache?: string) => {
  const response = await request(path);
  const actualType = responseContentType(response);
  const actualCache = response.headers.get("cache-control");
  if (
    response.status !== 200 ||
    actualType !== contentType ||
    (cache !== undefined && actualCache !== cache)
  ) {
    throw new Error(
      `GET ${path} returned ${response.status}, ${actualType}, ${actualCache}. Expected 200, ${contentType}, ${cache ?? "any cache policy"}.`,
    );
  }
  return response;
};

const bundleByteLength = async (html: string, script: RegExp) => {
  const path = Option.getOrUndefined(Str.match(script)(html))?.[1];
  if (path === undefined) throw new Error(`The built HTML has no script matching ${script}.`);
  const bundle = await get(path, "application/javascript", immutable);
  return (await bundle.arrayBuffer()).byteLength;
};

test("serves the built web shell and its hashed JavaScript", async () => {
  const html = await (await get("/", "text/html", "no-cache")).text();
  expect(await bundleByteLength(html, webBundleScript)).toBeGreaterThan(0);
});

test("serves the built PWA at /app/, with a separate shell for nested routes and cached bundles", async () => {
  const html = await (await get("/app/", "text/html", "no-cache")).text();
  expect(html).toContain('href="/app/manifest.webmanifest"');
  expect(await (await get("/app/documents/new", "text/html", "no-cache")).text()).toBe(html);
  expect(await bundleByteLength(html, pwaBundleScript)).toBeGreaterThan(0);
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
    body: pingBody,
  });
  expect(auth.status).toBe(401);
  expect(auth.headers.get("cache-control")).toBe("no-store");
  expect(auth.headers.get("www-authenticate")).toContain(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect(await auth.json()).toEqual({ error: "unauthorized", reason: "missing" });
});

test("answers an authenticated MCP ping over HTTP", async () => {
  if (databaseUrl === undefined || databaseUrl === "")
    throw new Error("Set KVITBIT_SMOKE_DATABASE_URL to seed a disposable MCP grant.");
  const db = new Bun.SQL(databaseUrl);
  const id = Bun.randomUUIDv7();
  const bearer = SecureRandom.uuidV4Unsafe();
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
      body: pingBody,
    });
    expect(response.status).toBe(200);
    expect(responseContentType(response)).toBe("application/json");
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
