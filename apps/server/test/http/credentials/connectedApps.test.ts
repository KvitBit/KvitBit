import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { READ_SCOPES } from "@kvitbit/api-contract";
import { CoreStore } from "@kvitbit/core/ports";
import type { MemberCaller } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { as, type Harness, makeHarness, TEST_NOW, type TestUser } from "../harness";
import {
  createSeededWorkspace,
  joinMember,
  seedOAuthClient,
  seedOAuthGrant,
  seedOAuthTokens,
} from "./seed";

let h: Harness;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let accountant: TestUser;
let ownerCaller: MemberCaller;
let base: string;

beforeEach(async () => {
  h = makeHarness();
  await h.run(TestClock.setTime(TEST_NOW));
  owner = h.addUser("Olga");
  admin = h.addUser("Adam");
  member = h.addUser("Marie");
  accountant = h.addUser("Alena");
  ownerCaller = await createSeededWorkspace(h, owner, "alfa-sro", "Alfa s.r.o.");
  await joinMember(h, ownerCaller, admin, "admin");
  await joinMember(h, ownerCaller, member, "member");
  await joinMember(h, ownerCaller, accountant, "accountant");
  base = `/api/v1/workspaces/${ownerCaller.workspaceId}/connected-apps`;

  await seedOAuthClient(h, {
    clientId: "claude-desktop",
    name: "Claude Desktop",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  });
  await seedOAuthClient(h, {
    clientId: "cursor-mcp",
    name: null,
    redirectUris: ["http://127.0.0.1:4321/callback"],
  });
}, 20_000);

afterEach(async () => {
  await h.dispose();
});

const countRows = (
  table: "oauth_consent" | "oauth_access_token" | "oauth_refresh_token",
  id: string,
) =>
  h.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows =
        table === "oauth_consent"
          ? yield* sql<{ count: string }>`
              select count(*)::text as count from auth.oauth_consent where id = ${id}
            `
          : table === "oauth_access_token"
            ? yield* sql<{ count: string }>`
                select count(*)::text as count from auth.oauth_access_token where consent_id = ${id}
              `
            : yield* sql<{ count: string }>`
                select count(*)::text as count from auth.oauth_refresh_token where consent_id = ${id}
              `;
      return Number(rows[0]?.count ?? "0");
    }),
  );

describe("connectedApps group", () => {
  test("owner and admin see all workspace grants; member and accountant see only their own", async () => {
    await seedOAuthGrant(h, {
      id: "grant-owner",
      clientId: "claude-desktop",
      userId: owner.id,
      workspaceId: ownerCaller.workspaceId,
      access: "read",
      grantedScopes: READ_SCOPES,
      createdAt: new Date("2026-11-21T10:00:00.000Z"),
      lastUsedAt: new Date("2026-11-22T12:30:00.000Z"),
    });
    await seedOAuthGrant(h, {
      id: "grant-member",
      clientId: "cursor-mcp",
      userId: member.id,
      workspaceId: ownerCaller.workspaceId,
      access: "custom",
      grantedScopes: ["documents:write"],
      createdAt: new Date("2026-11-22T10:00:00.000Z"),
    });

    // Owner sees both, newest first
    const ownerRes = await h.fetch(base, { headers: as.mobile(owner) });
    expect(ownerRes.status).toBe(200);
    const ownerList = (await ownerRes.json()) as Array<{
      grantId: string;
      client: { id: string; name: string; redirectHost: string };
      member: { userId: string; name: string };
      access: string;
      scopes: string[];
      lastUsedAt: string | null;
    }>;
    expect(ownerList.map((g) => g.grantId)).toEqual(["grant-member", "grant-owner"]);
    expect(ownerList[0]).toMatchObject({
      grantId: "grant-member",
      client: { id: "cursor-mcp", name: "cursor-mcp", redirectHost: "127.0.0.1:4321" },
      member: { userId: member.id, name: member.name },
      access: "custom",
      scopes: ["documents:read", "documents:write"],
      lastUsedAt: null,
    });
    expect(ownerList[1]).toMatchObject({
      grantId: "grant-owner",
      client: { id: "claude-desktop", name: "Claude Desktop", redirectHost: "claude.ai" },
      member: { userId: owner.id, name: owner.name },
      access: "read",
      scopes: [...READ_SCOPES],
      lastUsedAt: "2026-11-22T12:30:00.000Z",
    });

    // Admin also sees both
    const adminList = (await (await h.fetch(base, { headers: as.mobile(admin) })).json()) as Array<{
      grantId: string;
    }>;
    expect(adminList.map((g) => g.grantId)).toEqual(["grant-member", "grant-owner"]);

    // Member sees only their own grant
    const memberList = (await (
      await h.fetch(base, { headers: as.mobile(member) })
    ).json()) as Array<{ grantId: string }>;
    expect(memberList.map((g) => g.grantId)).toEqual(["grant-member"]);

    // Accountant has no grants -> empty list
    const accountantList = (await (
      await h.fetch(base, { headers: as.mobile(accountant) })
    ).json()) as Array<{ grantId: string }>;
    expect(accountantList).toEqual([]);
  });

  test("member can self-revoke their own grant (deleting access & refresh tokens) but gets 403 revoking someone else's", async () => {
    await seedOAuthGrant(h, {
      id: "grant-owner",
      clientId: "claude-desktop",
      userId: owner.id,
      workspaceId: ownerCaller.workspaceId,
      access: "read",
      grantedScopes: READ_SCOPES,
    });
    await seedOAuthTokens(h, {
      consentId: "grant-owner",
      clientId: "claude-desktop",
      userId: owner.id,
      suffix: "owner",
    });

    await seedOAuthGrant(h, {
      id: "grant-member",
      clientId: "claude-desktop",
      userId: member.id,
      workspaceId: ownerCaller.workspaceId,
      access: "read",
      grantedScopes: READ_SCOPES,
    });
    await seedOAuthTokens(h, {
      consentId: "grant-member",
      clientId: "claude-desktop",
      userId: member.id,
      suffix: "member",
    });

    // Member cannot revoke owner's grant -> 403 Forbidden{grant.revoke.all}
    const forbiddenRes = await h.fetch(`${base}/grant-owner`, {
      method: "DELETE",
      headers: as.mobile(member),
    });
    expect(forbiddenRes.status).toBe(403);
    expect(await forbiddenRes.json()).toEqual({ _tag: "Forbidden", action: "grant.revoke.all" });
    expect(await countRows("oauth_consent", "grant-owner")).toBe(1);
    expect(await countRows("oauth_access_token", "grant-owner")).toBe(1);
    expect(await countRows("oauth_refresh_token", "grant-owner")).toBe(1);

    // Member revokes their own grant -> 204, tokens and consent removed, owner's grant untouched
    const selfRes = await h.fetch(`${base}/grant-member`, {
      method: "DELETE",
      headers: as.mobile(member),
    });
    expect(selfRes.status).toBe(204);
    expect(await countRows("oauth_consent", "grant-member")).toBe(0);
    expect(await countRows("oauth_access_token", "grant-member")).toBe(0);
    expect(await countRows("oauth_refresh_token", "grant-member")).toBe(0);
    expect(await countRows("oauth_consent", "grant-owner")).toBe(1);
    expect(await countRows("oauth_access_token", "grant-owner")).toBe(1);
    expect(await countRows("oauth_refresh_token", "grant-owner")).toBe(1);
  });

  test("admin can revoke another member's grant and audits with onBehalfOf", async () => {
    await seedOAuthGrant(h, {
      id: "grant-acct",
      clientId: "claude-desktop",
      userId: accountant.id,
      workspaceId: ownerCaller.workspaceId,
      access: "read",
      grantedScopes: READ_SCOPES,
    });
    await seedOAuthTokens(h, {
      consentId: "grant-acct",
      clientId: "claude-desktop",
      userId: accountant.id,
      suffix: "acct",
    });

    const res = await h.fetch(`${base}/grant-acct`, {
      method: "DELETE",
      headers: as.mobile(admin),
    });
    expect(res.status).toBe(204);
    expect(await countRows("oauth_consent", "grant-acct")).toBe(0);
    expect(await countRows("oauth_access_token", "grant-acct")).toBe(0);
    expect(await countRows("oauth_refresh_token", "grant-acct")).toBe(0);

    const entries = await h.run(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        return yield* store.audit.history(ownerCaller.workspaceId, {
          entity: "McpGrant",
          id: "grant-acct",
        });
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("grant.revoke");
    expect(entries[0]?.changes).toContainEqual({
      path: "onBehalfOf",
      before: null,
      after: accountant.id,
    });
  });

  test("cross-workspace isolation: foreign and unknown grantId answer 404 NotFound{McpGrant}", async () => {
    const otherOwner = h.addUser("Petr");
    const otherWs = await createSeededWorkspace(h, otherOwner, "beta-sro", "Beta s.r.o.");
    await seedOAuthGrant(h, {
      id: "grant-beta",
      clientId: "claude-desktop",
      userId: otherOwner.id,
      workspaceId: otherWs.workspaceId,
      access: "read",
      grantedScopes: READ_SCOPES,
    });

    const listRes = await h.fetch(base, { headers: as.mobile(owner) });
    expect(await listRes.json()).toEqual([]);

    const delForeign = await h.fetch(`${base}/grant-beta`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(delForeign.status).toBe(404);
    expect(await delForeign.json()).toEqual({
      _tag: "NotFound",
      entity: "McpGrant",
      id: "grant-beta",
    });
    expect(await countRows("oauth_consent", "grant-beta")).toBe(1);
  });

  test("SessionOnly rejects API Key credentials with 401 credential_not_allowed", async () => {
    const res = await h.fetch(base, {
      headers: as.apiKey(owner, ownerCaller.workspaceId, ["members:read"]),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ _tag: "Unauthorized", reason: "credential_not_allowed" });
  });
});
