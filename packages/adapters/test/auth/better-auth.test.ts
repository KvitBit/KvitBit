import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Redacted } from "effect";
import { type BotProtection, makeAltchaBotProtection } from "../../src/altcha";
import {
  API_KEY_PLUGIN_PATHS,
  type AuthConfig,
  authOptions,
  makeAuth,
  OAUTH_SCOPES,
} from "../../src/auth";
import { layerFromPglite, makeMigratedPglite } from "../../src/testing";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE = "http://localhost:3000";

let pg: PGlite;
let botProtection: BotProtection["Service"];
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
  oauthLoginPage: "/sign-in",
  oauthConsentPage: "/oauth/consent",
  botProtection,
});

beforeAll(async () => {
  pg = await makeMigratedPglite();
  botProtection = await Effect.runPromise(
    makeAltchaBotProtection({
      hmacKey: Redacted.make("altcha-secret-0123456789"),
      algorithm: "PBKDF2/SHA-256",
      cost: 1,
      keyPrefix: "0",
    }).pipe(Effect.provide(layerFromPglite(pg))),
  );
});
afterAll(async () => {
  await pg.close();
});

const proof = async () => {
  const challenge = await Effect.runPromise(botProtection.issue("sign_up"));
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
};

const signUp = (auth: ReturnType<typeof makeAuth>, email: string, altcha?: string) =>
  auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(altcha === undefined ? {} : { "x-altcha": altcha }),
      },
      body: JSON.stringify({ email, password: "correct horse battery staple", name: "Test" }),
    }),
  );

describe("makeAuth", () => {
  test("configures the plugins, scopes and PKCE the spec asks for", () => {
    const auth = makeAuth(config());
    const ids = (auth.options.plugins ?? []).map((plugin) => plugin.id);
    expect(ids).toEqual(["magic-link", "passkey", "bearer", "api-key", "oauth-provider"]);
    const options = authOptions(config());
    expect(options.emailAndPassword.requireEmailVerification).toBe(true);
    expect(options.advanced.cookiePrefix).toBe("kvitbit");
    expect(OAUTH_SCOPES).toContain("kvitbit:read");
    expect(OAUTH_SCOPES).toContain("kvitbit:documents:write");
    expect(OAUTH_SCOPES).toContain("offline_access");
    expect(OAUTH_SCOPES).toHaveLength(2 + 20 + 1);
    expect(API_KEY_PLUGIN_PATHS).toContain("/api-key/create");
    expect(options.disabledPaths).toEqual([...API_KEY_PLUGIN_PATHS]);
  });

  test("sign-up without a bot proof is refused before any row is written", async () => {
    const auth = makeAuth(config());
    const response = await signUp(auth, "nobot@example.com");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "InvalidBotProof" });
    const users = await pg.query("select 1 from auth.user where email = 'nobot@example.com'");
    expect(users.rows).toHaveLength(0);
  });

  test("sign-up with a proof creates a UUIDv7 user and sends verification, no session", async () => {
    const auth = makeAuth(config());
    const response = await signUp(auth, "ok@example.com", await proof());
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
    const auth = makeAuth(config());
    const payload = await proof();
    expect((await signUp(auth, "first@example.com", payload)).status).toBe(200);
    const replay = await signUp(auth, "second@example.com", payload);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "InvalidBotProof" });
  });

  test("the api-key plugin exposes no routes", async () => {
    const auth = makeAuth(config());
    const response = await auth.handler(
      new Request(`${BASE}/api/auth/api-key/list`, { headers: { origin: BASE } }),
    );
    expect(response.status).toBe(404);
  });
});
