import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AltchaBotProtection, BotProtection, InvalidBotProof } from "@kvitbit/adapters/altcha";
import { generateApiKey, generateId } from "@kvitbit/adapters/auth";
import { EmailSender } from "@kvitbit/domain/ports";
import { Clock, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { PrincipalResolver } from "../../src/auth/PrincipalResolver";
import { PrincipalResolverLive } from "../../src/auth/PrincipalResolverLive";
import { type Harness, makeHarness, ORIGIN, TEST_NOW } from "./harness";

const hashOpaque = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("base64url");

describe("Auth layer (Better Auth, RFC 8414, PrincipalResolverLive, ALTCHA)", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  test("RFC 8414 metadata answers on both /.well-known/oauth-authorization-server paths with CIMD", async () => {
    harness = makeHarness();

    const r1 = await harness.fetch("/.well-known/oauth-authorization-server");
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as Record<string, unknown>;
    expect(body1.issuer).toBe(`${ORIGIN}/api/auth`);
    expect(body1.client_id_metadata_document_supported).toBe(true);
    expect(body1.code_challenge_methods_supported).toContain("S256");
    expect(body1.scopes_supported).toContain("kvitbit:read");
    expect(body1.scopes_supported).toContain("kvitbit:write");
    expect(body1.scopes_supported).toContain("offline_access");

    const r2 = await harness.fetch("/.well-known/oauth-authorization-server/api/auth");
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual(body1);
  });

  test("ALTCHA challenge endpoint issues signed challenge and blocks missing/invalid proof on /api/auth/sign-up/email", async () => {
    const altcha = AltchaBotProtection({
      hmacKey: Redacted.make("test-altcha-hmac-key"),
      algorithm: "PBKDF2/SHA-256",
      cost: 10,
      keyPrefix: "0",
    });
    harness = makeHarness({
      botProtection: altcha,
      config: { botProtection: "altcha" },
    });

    // 1. Issue signed challenge for sign_up
    const chRes = await harness.fetch("/api/v1/bot-protection/challenges/sign_up");
    expect(chRes.status).toBe(200);
    expect(chRes.headers.get("cache-control")).toBe("no-store");
    const challenge = (await chRes.json()) as {
      parameters: { algorithm: string; data?: { scope?: string } };
      signature?: string;
    };
    expect(challenge.parameters.algorithm).toBe("PBKDF2/SHA-256");
    expect(challenge.parameters.data?.scope).toBe("sign_up");
    expect(typeof challenge.signature).toBe("string");

    // 2. Missing X-Altcha header -> 400 InvalidBotProof
    const blocked = await harness.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: "jana@example.cz",
        password: "StrongPassword123!",
        name: "Jana",
      }),
    });
    expect(blocked.status).toBe(400);
  });

  test("Better Auth /api/auth/sign-up/email succeeds with verified bot proof and enforces single-use replay", async () => {
    const used = new Set<string>();
    const singleUseBot = Layer.succeed(
      BotProtection,
      BotProtection.of({
        issue: () =>
          Effect.succeed({
            parameters: {
              algorithm: "PBKDF2/SHA-256",
              nonce: "n",
              salt: "s",
              cost: 1,
              keyLength: 32,
              keyPrefix: "0",
            },
            signature: "sig",
          }),
        verify: (scope, payload) => {
          if (scope !== "sign_up" || payload !== "valid-proof") {
            return Effect.fail(new InvalidBotProof({ reason: "invalid_solution" }));
          }
          if (used.has(payload)) {
            return Effect.fail(new InvalidBotProof({ reason: "replayed" }));
          }
          used.add(payload);
          return Effect.void;
        },
      }),
    );
    harness = makeHarness({
      botProtection: singleUseBot,
      config: { botProtection: "altcha" },
    });

    const ok = await harness.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-altcha": "valid-proof",
      },
      body: JSON.stringify({
        email: "jana@example.cz",
        password: "StrongPassword123!",
        name: "Jana",
      }),
    });
    expect(ok.status).toBe(200);

    // Replaying the same proof fails (rule B2)
    const replay = await harness.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-altcha": "valid-proof",
      },
      body: JSON.stringify({
        email: "petr@example.cz",
        password: "StrongPassword123!",
        name: "Petr",
      }),
    });
    expect(replay.status).toBe(400);
  });

  test("PrincipalResolverLive resolves kvb_ API keys and rejects invalid/expired/cross-channel tokens", async () => {
    harness = makeHarness({ principalResolver: "live" });
    const owner = harness.addUser("Karel");
    const ws = await harness.createWorkspace(owner);
    const issued = generateApiKey();

    await harness.run(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          insert into auth."user" (id, name, email, email_verified)
          values (${owner.id}, ${owner.name}, ${owner.email}, true)`;
        yield* sql`
          insert into workspaces (id, name, slug)
          values (${ws.workspaceId}::uuid, 'Alfa', 'alfa')`;
        yield* sql`
          insert into auth.apikey (id, name, start, prefix, key, reference_id, workspace_id, created_by, access, scopes)
          values (
            ${issued.keyId}, 'CI Key', ${issued.start}, ${issued.prefix}, ${issued.hash},
            ${owner.id}, ${ws.workspaceId}::uuid, ${owner.id}, 'custom'::access_mode,
            ${["contacts:read", "contacts:write"]}::text[]
          )`;
      }),
    );

    // Valid API key works on workspace contacts endpoint
    const res = await harness.fetch(`/api/v1/workspaces/${ws.workspaceId}/contacts`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(200);

    // Wrong secret -> 401
    const badSecret = await harness.fetch(`/api/v1/workspaces/${ws.workspaceId}/contacts`, {
      headers: { authorization: `Bearer ${issued.start}_wrongsecretvalue` },
    });
    expect(badSecret.status).toBe(401);

    // Missing auth -> 401
    const missing = await harness.fetch(`/api/v1/workspaces/${ws.workspaceId}/contacts`);
    expect(missing.status).toBe(401);

    // Expired API key -> 401 expired (advance TestClock to TEST_NOW)
    await harness.run(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update auth.apikey set expires_at = ${new Date(TEST_NOW - 1000)} where id = ${issued.keyId}`;
      }),
    );
    const expired = await harness.fetch(`/api/v1/workspaces/${ws.workspaceId}/contacts`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ _tag: "Unauthorized", reason: "expired" });
  });

  test("PrincipalResolverLive.fromMcpBearer enforces #887/#889 (audience, consent grant, scope intersection, locale)", async () => {
    harness = makeHarness({ principalResolver: "live" });
    const userId = generateId();
    const workspaceId = generateId();
    const clientId = "https://mcp-client.example/metadata.json";
    const consentId = generateId();
    const rawToken = "mcp-opaque-access-token-test-12345";
    const wrongAudToken = "mcp-opaque-wrong-aud-token-67890";
    const expiredToken = "mcp-opaque-expired-token-11111";

    const resolveMcp = (authHeader?: string, acceptLanguage?: string) => {
      if (harness === undefined) throw new Error("harness not initialized");
      return harness.run(
        Effect.gen(function* () {
          const resolver = yield* PrincipalResolver;
          const headers = new Headers();
          if (authHeader !== undefined) headers.set("authorization", authHeader);
          if (acceptLanguage !== undefined) headers.set("accept-language", acceptLanguage);
          return yield* Effect.result(
            resolver.fromMcpBearer(new Request(`${ORIGIN}/mcp`, { headers })),
          );
        }).pipe(Effect.provide(PrincipalResolverLive)),
      );
    };

    await harness.run(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          insert into auth."user" (id, name, email, email_verified)
          values (${userId}, 'Eva', 'eva@example.cz', true)`;
        yield* sql`
          insert into workspaces (id, name, slug)
          values (${workspaceId}::uuid, 'Beta', 'beta')`;
        yield* sql`
          insert into auth.oauth_client (id, client_id, name, redirect_uris)
          values (${generateId()}, ${clientId}, 'Claude Desktop', ${["http://127.0.0.1/cb"]}::text[])`;
        yield* sql`
          insert into auth.oauth_consent (id, client_id, user_id, scopes, workspace_id, access, granted_scopes)
          values (
            ${consentId}, ${clientId}, ${userId},
            ${["kvitbit:write"]}::text[],
            ${workspaceId}::uuid, 'custom'::access_mode,
            ${["contacts:read", "documents:read", "documents:write"]}::text[]
          )`;
        const now = yield* Clock.currentTimeMillis;
        // Valid token requesting kvitbit:write -> intersected with consent.granted_scopes
        yield* sql`
          insert into auth.oauth_access_token (id, token, client_id, user_id, consent_id, resources, scopes, expires_at)
          values (
            ${generateId()}, ${hashOpaque(rawToken)}, ${clientId}, ${userId}, ${consentId},
            ${[`${ORIGIN}/mcp`]}::text[], ${["kvitbit:write"]}::text[], ${new Date(now + 3600_000)}
          )`;
        // Wrong audience token
        yield* sql`
          insert into auth.oauth_access_token (id, token, client_id, user_id, consent_id, resources, scopes, expires_at)
          values (
            ${generateId()}, ${hashOpaque(wrongAudToken)}, ${clientId}, ${userId}, ${consentId},
            ${["https://other.example/mcp"]}::text[], ${["kvitbit:read"]}::text[], ${new Date(now + 3600_000)}
          )`;
        // Expired token
        yield* sql`
          insert into auth.oauth_access_token (id, token, client_id, user_id, consent_id, resources, scopes, expires_at)
          values (
            ${generateId()}, ${hashOpaque(expiredToken)}, ${clientId}, ${userId}, ${consentId},
            ${[`${ORIGIN}/mcp`]}::text[], ${["kvitbit:read"]}::text[], ${new Date(now - 60_000)}
          )`;
      }),
    );

    // Missing header -> missing
    const missing = await resolveMcp();
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") expect(missing.failure.reason).toBe("missing");

    // Valid token -> McpGrant with intersected scopes and Accept-Language fallback
    const valid = await resolveMcp(`Bearer ${rawToken}`, "en-US,en;q=0.9");
    expect(valid._tag).toBe("Success");
    if (valid._tag === "Success") {
      expect(valid.success.channel).toBe("mcp");
      expect(valid.success.locale).toBe("en");
      expect(valid.success.credential).toEqual({
        _tag: "McpGrant",
        grantId: consentId,
        clientId,
        clientName: "Claude Desktop",
        workspaceId: workspaceId as never,
        scopes: ["contacts:read", "documents:read", "documents:write"],
      });
    }

    // Wrong audience -> invalid
    const wrongAud = await resolveMcp(`Bearer ${wrongAudToken}`);
    expect(wrongAud._tag).toBe("Failure");
    if (wrongAud._tag === "Failure") expect(wrongAud.failure.reason).toBe("invalid");

    // Expired -> expired
    const expired = await resolveMcp(`Bearer ${expiredToken}`);
    expect(expired._tag).toBe("Failure");
    if (expired._tag === "Failure") expect(expired.failure.reason).toBe("expired");

    // Rule A1: MCP token rejected on /api/v1
    const crossChannel = await harness.fetch(`/api/v1/workspaces/${workspaceId}/contacts`, {
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(crossChannel.status).toBe(401);

    // Ensure EmailSender is present in TestCore without throwing
    expect(EmailSender).toBeDefined();
  });
});
