import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Redacted } from "effect";
import { type BotProtection, type BotScope, makeAltchaBotProtection } from "../../src/altcha";
import {
  API_KEY_PLUGIN_PATHS,
  type AuthConfig,
  authOptions,
  type EmailRateLimiter,
  makeAuth,
  makeEmailRateLimiter,
  OAUTH_SCOPES,
} from "../../src/auth";
import { layerFromPglite, makeMigratedPglite } from "../../src/testing";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = "http://localhost:3000";
const MCP = `${BASE}/mcp`;
const REDIRECT = "https://client.example/callback";
const CIMD_CLIENT_ID = "https://client.example/oauth-client.json";
const cimdFetches: Array<string> = [];
const fetchClientMetadata = async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  cimdFetches.push(url);
  if (url !== CIMD_CLIENT_ID) return new Response("not found", { status: 404 });
  return Response.json({
    client_id: CIMD_CLIENT_ID,
    client_name: "Metadata document client",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
};

let pg: PGlite;
let botProtection: BotProtection["Service"];
let emailRateLimiter: EmailRateLimiter;
let auth: ReturnType<typeof makeAuth>;
const sent: Array<{ kind: string; to: string; url: string }> = [];

const config = (): AuthConfig => ({
  baseURL: BASE,
  secret: Redacted.make("test-better-auth-secret-0123456789abcdef"),
  db: drizzle({ client: pg }),
  rpID: "localhost",
  sendVerificationEmail: async ({ user, url }) => {
    sent.push({ kind: "verify", to: user.email, url });
  },
  sendResetPassword: async ({ user, url }) => {
    sent.push({ kind: "reset", to: user.email, url });
  },
  sendMagicLink: async ({ email, url }) => {
    sent.push({ kind: "magic", to: email, url });
  },
  sendChangeEmailConfirmation: async ({ user, url }) => {
    sent.push({ kind: "change", to: user.email, url });
  },
  beforeDeleteUser: async () => {},
  oauthLoginPage: "/sign-in",
  oauthConsentPage: "/oauth/consent",
  mcpResource: MCP,
  botProtection,
  emailRateLimiter,
  fetchClientMetadata,
  beforeHooks: [
    {
      matcher: (ctx) => ctx.path === "/sign-up/email",
      handler: createAuthMiddleware(async (ctx) => {
        if (String(ctx.body?.email).endsWith("@blocked.test")) {
          throw new APIError("FORBIDDEN", { code: "InvitationLocked" });
        }
      }),
    },
  ],
});

beforeAll(async () => {
  pg = await makeMigratedPglite();
  const services = await Effect.runPromise(
    Effect.all({
      bp: makeAltchaBotProtection({
        hmacKey: Redacted.make("altcha-secret-0123456789"),
        algorithm: "PBKDF2/SHA-256",
        cost: 1,
        keyPrefix: "0",
      }),
      limiter: makeEmailRateLimiter(),
    }).pipe(Effect.provide(layerFromPglite(pg))),
  );
  botProtection = services.bp;
  emailRateLimiter = services.limiter;
  auth = makeAuth(config());
});
afterAll(async () => {
  await pg.close();
});

const proof = async (scope: BotScope = "sign_up") => {
  const challenge = await Effect.runPromise(botProtection.issue(scope));
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify(body),
    }),
  );

const signUp = (email: string, altcha?: string) =>
  post(
    "/sign-up/email",
    { email, password: "correct horse battery staple", name: "Test" },
    altcha === undefined ? {} : { "x-altcha": altcha },
  );

describe("makeAuth configuration", () => {
  test("installs the plugins, scopes and account options the spec asks for", () => {
    const ids = (auth.options.plugins ?? []).map((plugin) => plugin.id);
    expect(ids).toEqual([
      "kvitbit-edge-guards",
      "magic-link",
      "passkey",
      "bearer",
      "api-key",
      "oauth-provider",
      "cimd",
      "kvitbit-edge-hooks",
    ]);
    const options = authOptions(config());
    expect(options.emailAndPassword.requireEmailVerification).toBe(true);
    expect(options.advanced.cookiePrefix).toBe("kvitbit");
    expect(options.user.changeEmail.enabled).toBe(true);
    expect(options.user.deleteUser.enabled).toBe(true);
    expect(OAUTH_SCOPES).toContain("kvitbit:read");
    expect(OAUTH_SCOPES).toContain("kvitbit:documents:write");
    expect(OAUTH_SCOPES).toContain("offline_access");
    expect(OAUTH_SCOPES).toHaveLength(2 + 20 + 1);
    expect(API_KEY_PLUGIN_PATHS).toContain("/api-key/create");
    expect(options.disabledPaths).toEqual([...API_KEY_PLUGIN_PATHS]);
  });

  test("the api-key plugin exposes no routes", async () => {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/api-key/list`, { headers: { origin: BASE } }),
    );
    expect(response.status).toBe(404);
  });
});

describe("bot-protected endpoints", () => {
  test("sign-up without a bot proof is refused before any row is written", async () => {
    const response = await signUp("nobot@example.com");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "InvalidBotProof" });
    const users = await pg.query("select 1 from auth.user where email = 'nobot@example.com'");
    expect(users.rows).toHaveLength(0);
  });

  test("sign-up with a proof creates a UUIDv7 user and sends verification, no session", async () => {
    const response = await signUp("ok@example.com", await proof());
    expect(response.status).toBe(200);
    const users = await pg.query<{ id: string; email_verified: boolean }>(
      "select id, email_verified from auth.user where email = 'ok@example.com'",
    );
    expect(users.rows[0]?.id).toMatch(UUID_V7);
    expect(users.rows[0]?.email_verified).toBe(false);
    expect(sent.some((m) => m.kind === "verify" && m.to === "ok@example.com")).toBe(true);
    const sessions = await pg.query("select 1 from auth.session");
    expect(sessions.rows).toHaveLength(0);
  });

  test("a replayed proof is refused", async () => {
    const payload = await proof();
    expect((await signUp("first@example.com", payload)).status).toBe(200);
    const replay = await signUp("second@example.com", payload);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "InvalidBotProof" });
  });

  test("extra before hooks run after the bot proof with native semantics", async () => {
    expect((await signUp("someone@blocked.test")).status).toBe(400);
    const blocked = await signUp("someone@blocked.test", await proof());
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "InvitationLocked" });
  });

  test("rejected proofs spend no email allowance; valid ones share it across routes", async () => {
    const email = "Limit@Example.com";
    const signIn = async (withProof: boolean) =>
      post(
        "/sign-in/email",
        { email, password: "whatever-password" },
        withProof ? { "x-altcha": await proof("sign_in") } : {},
      );
    // Bots without a proof cannot exhaust the address's quota.
    for (let i = 0; i < 6; i++) expect((await signIn(false)).status).toBe(400);
    // Four proven sign-ins (wrong password) and one proven reset use the five allowed.
    for (let i = 0; i < 4; i++) expect((await signIn(true)).status).toBe(401);
    const reset = await post(
      "/request-password-reset",
      { email: "limit@example.com" },
      { "x-altcha": await proof("password_reset") },
    );
    expect(reset.status).toBe(200);
    const limited = await signIn(true);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ _tag: "RateLimited" });
    // Another address is unaffected.
    const other = await post(
      "/sign-in/email",
      { email: "other@example.com", password: "whatever-password" },
      { "x-altcha": await proof("sign_in") },
    );
    expect(other.status).toBe(401);
  });
});

describe("OAuth 2.1 for MCP", () => {
  test("discovery advertises the specified grants, methods, PKCE and scopes", async () => {
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/.well-known/oauth-authorization-server`),
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_basic"]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining([...OAUTH_SCOPES]));
  });

  const register = (body: Record<string, unknown>) =>
    post("/oauth2/register", {
      client_name: "Test MCP client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...body,
    });

  test("a public client registers for an area scope and reaches sign-in for /mcp", async () => {
    const registered = await register({ scope: "kvitbit:documents:read offline_access" });
    expect(registered.status).toBeLessThan(300);
    const client = (await registered.json()) as { client_id: string };
    expect(typeof client.client_id).toBe("string");

    const authorize = (params: Record<string, string>) => {
      const url = new URL(`${BASE}/api/auth/oauth2/authorize`);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        scope: "kvitbit:documents:read",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        ...params,
      })) {
        if (v !== "") url.searchParams.set(k, v);
      }
      return auth.handler(new Request(url.toString(), { redirect: "manual" }));
    };

    const ok = await authorize({ state: "s1", resource: MCP });
    expect([302, 303]).toContain(ok.status);
    expect(ok.headers.get("location")).toContain("/sign-in");

    const noState = await authorize({ state: "", resource: MCP });
    expect(noState.status).toBe(400);
    const noResource = await authorize({ state: "s2", resource: "" });
    expect(noResource.status).toBe(400);
    const otherResource = await authorize({ state: "s3", resource: `${BASE}/api/v1` });
    expect(otherResource.status).toBe(400);
  });

  test("an HTTPS client_id resolves through its metadata document and reaches sign-in", async () => {
    const url = new URL(`${BASE}/api/auth/oauth2/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: CIMD_CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: "kvitbit:read",
      state: "cimd-state",
      resource: MCP,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(k, v);
    }
    const response = await auth.handler(new Request(url.toString(), { redirect: "manual" }));
    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toContain("/sign-in");
    expect(cimdFetches).toContain(CIMD_CLIENT_ID);
  });

  test("registration refuses unadvertised client authentication methods", async () => {
    const response = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(response.status).toBe(400);
  });
});
