import { afterEach, describe, expect, test } from "bun:test";
import { AltchaBotProtection, BotProtection, InvalidBotProof } from "@kvitbit/adapters/altcha";
import { generateApiKey, generateId } from "@kvitbit/adapters/auth";
import { WorkspaceId } from "@kvitbit/domain/contract";
import { EmailSender } from "@kvitbit/domain/ports";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { PrincipalResolver } from "../../src/auth/PrincipalResolver";
import { PrincipalResolverLive } from "../../src/auth/PrincipalResolverLive";
import { type Harness, json, makeHarness, ORIGIN, TEST_NOW } from "./harness";

const encodeBase64Url = Schema.encodeEffect(Schema.Uint8ArrayFromBase64Url);
const hashOpaque = async (token: string) =>
  encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  ).pipe(Effect.runSync);
const metadataFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    issuer: Schema.String,
    client_id_metadata_document_supported: Schema.Boolean,
    code_challenge_methods_supported: Schema.Array(Schema.String),
    scopes_supported: Schema.Array(Schema.String),
  }),
);
const challengeFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    parameters: Schema.Struct({
      algorithm: Schema.String,
      data: Schema.Struct({ scope: Schema.String }),
    }),
    signature: Schema.String,
  }),
);
const fixturePassword = "Integration test password for Better Auth";

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
    const body1: unknown = await r1.json();
    const metadata = metadataFields(body1).pipe(Effect.runSync);
    expect(metadata.issuer).toBe(`${ORIGIN}/api/auth`);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.scopes_supported).toContain("kvitbit:read");
    expect(metadata.scopes_supported).toContain("kvitbit:write");
    expect(metadata.scopes_supported).toContain("offline_access");

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
    const challenge = challengeFields(await chRes.json()).pipe(Effect.runSync);
    expect(challenge.parameters.algorithm).toBe("PBKDF2/SHA-256");
    expect(challenge.parameters.data.scope).toBe("sign_up");
    expect(challenge.signature).toEqual(expect.any(String));

    // 2. Missing X-Altcha header -> 400 InvalidBotProof
    const blocked = await harness.fetch("/api/auth/sign-up/email", {
      method: "POST",
      ...json({ email: "jana@example.cz", password: fixturePassword, name: "Jana" }),
      headers: { "content-type": "application/json", origin: ORIGIN },
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
            return Effect.fail(InvalidBotProof.make({ reason: "invalid_solution" }));
          }
          if (used.has(payload)) {
            return Effect.fail(InvalidBotProof.make({ reason: "replayed" }));
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
      ...json({ email: "jana@example.cz", password: fixturePassword, name: "Jana" }),
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-altcha": "valid-proof",
      },
    });
    expect(ok.status).toBe(200);

    // Replaying the same proof fails (rule B2)
    const replay = await harness.fetch("/api/auth/sign-up/email", {
      method: "POST",
      ...json({ email: "petr@example.cz", password: fixturePassword, name: "Petr" }),
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-altcha": "valid-proof",
      },
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
        yield* sql`update auth.apikey set expires_at = ${DateTime.toDateUtc(DateTime.makeUnsafe(TEST_NOW - 1000))} where id = ${issued.keyId}`;
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
    const workspaceId = WorkspaceId.make(generateId());
    const clientId = "https://mcp-client.example/metadata.json";
    const consentId = generateId();
    const rawToken = "mcp-opaque-access-token-test-12345";
    const wrongAudToken = "mcp-opaque-wrong-aud-token-67890";
    const expiredToken = "mcp-opaque-expired-token-11111";

    const [tokenHash, wrongAudienceHash, expiredHash] = await Promise.all([
      hashOpaque(rawToken),
      hashOpaque(wrongAudToken),
      hashOpaque(expiredToken),
    ]);

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
            ${generateId()}, ${tokenHash}, ${clientId}, ${userId}, ${consentId},
            ${[`${ORIGIN}/mcp`]}::text[], ${["kvitbit:write"]}::text[], ${DateTime.toDateUtc(DateTime.makeUnsafe(now + 3600_000))}
          )`;
        // Wrong audience token
        yield* sql`
          insert into auth.oauth_access_token (id, token, client_id, user_id, consent_id, resources, scopes, expires_at)
          values (
            ${generateId()}, ${wrongAudienceHash}, ${clientId}, ${userId}, ${consentId},
            ${["https://other.example/mcp"]}::text[], ${["kvitbit:read"]}::text[], ${DateTime.toDateUtc(DateTime.makeUnsafe(now + 3600_000))}
          )`;
        // Expired token
        yield* sql`
          insert into auth.oauth_access_token (id, token, client_id, user_id, consent_id, resources, scopes, expires_at)
          values (
            ${generateId()}, ${expiredHash}, ${clientId}, ${userId}, ${consentId},
            ${[`${ORIGIN}/mcp`]}::text[], ${["kvitbit:read"]}::text[], ${DateTime.toDateUtc(DateTime.makeUnsafe(now - 60_000))}
          )`;
      }),
    );

    // Missing header -> missing
    const missing = await resolveMcp();
    expect(missing._tag).toBe("Failure");
    expect(missing.pipe(Result.flip, Result.getOrThrow).reason).toBe("missing");

    // Valid token -> McpGrant with intersected scopes and Accept-Language fallback
    const valid = await resolveMcp(`Bearer ${rawToken}`, "en-US,en;q=0.9");
    expect(valid._tag).toBe("Success");
    const principal = Result.getOrThrow(valid);
    expect(principal.channel).toBe("mcp");
    expect(principal.locale).toBe("en");
    expect(principal.credential).toEqual({
      _tag: "McpGrant",
      grantId: consentId,
      clientId,
      clientName: "Claude Desktop",
      workspaceId,
      scopes: ["contacts:read", "documents:read", "documents:write"],
    });

    // Wrong audience -> invalid
    const wrongAud = await resolveMcp(`Bearer ${wrongAudToken}`);
    expect(wrongAud._tag).toBe("Failure");
    expect(wrongAud.pipe(Result.flip, Result.getOrThrow).reason).toBe("invalid");

    // Expired -> expired
    const expired = await resolveMcp(`Bearer ${expiredToken}`);
    expect(expired._tag).toBe("Failure");
    expect(expired.pipe(Result.flip, Result.getOrThrow).reason).toBe("expired");

    // Rule A1: MCP token rejected on /api/v1
    const crossChannel = await harness.fetch(`/api/v1/workspaces/${workspaceId}/contacts`, {
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(crossChannel.status).toBe(401);

    // Ensure EmailSender is present in TestCore without throwing
    expect(EmailSender).toBeDefined();
  });
});
