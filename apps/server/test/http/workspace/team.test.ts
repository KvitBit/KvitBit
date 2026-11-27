import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InvitationTokens } from "@kvitbit/core";
import { CaptureInvitationDelivery } from "@kvitbit/core/testing";
import {
  Caller,
  CurrentCaller,
  type InvitationId,
  type InvitationToken,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect, Ref } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { captureAnalytics } from "../../analytics-fixture";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;
let teammate: TestUser;
let workspaceId: string;
let base: string;
let analytics: ReturnType<typeof captureAnalytics>;

const req = (
  user: TestUser,
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const init = body === undefined ? {} : json(body);
  return h.fetch(`${base}${path}`, {
    ...init,
    method,
    headers: {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      ...as.mobile(user),
      ...headers,
    },
  });
};

/** Invites `user` via HTTP and accepts the invitation in core so they become a member. */
const addMemberViaInvite = async (user: TestUser, role: "admin" | "member" | "accountant") => {
  const res = await req(owner, "/invitations", "POST", { email: user.email, role });
  expect(res.status).toBe(201);
  const inv = (await res.json()) as { id: string };
  await h.run(
    Effect.gen(function* () {
      const ws = yield* Workspaces;
      const tokens = yield* InvitationTokens;
      const token = (yield* tokens.token(inv.id as InvitationId, 0)) as InvitationToken;
      yield* ws.acceptInvitation(token);
    }).pipe(
      Effect.provideService(
        CurrentCaller,
        Caller.account({ userId: user.id, email: user.email, locale: "cs", channel: "web" }),
      ),
    ),
  );
  return inv.id;
};

/** Seeds an API key and an OAuth grant (with access/refresh tokens) for `user` in PGlite. */
const seedEdgeCredentials = async (user: TestUser) => {
  await h.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO auth."user" (id, name, email, email_verified)
        VALUES (${user.id}, ${user.name}, ${user.email}, true)
        ON CONFLICT (id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO public.workspaces (id, slug, name)
        VALUES (${workspaceId}, ${`ws-${workspaceId.slice(-6)}`}, 'Alfa s.r.o.')
        ON CONFLICT (id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO auth.apikey (id, key, reference_id, workspace_id, created_by, access, scopes)
        VALUES (${`key-${user.id}`}, ${`hash-${user.id}`}, ${user.id}, ${workspaceId}, ${user.id}, 'read', ARRAY['documents:read'])
      `;
      yield* sql`
        INSERT INTO auth.oauth_client (id, client_id, name, redirect_uris)
        VALUES ('client-1', 'client-1', 'MCP Client', ARRAY['https://client.test/cb'])
        ON CONFLICT (id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO auth.oauth_consent (id, client_id, user_id, scopes, workspace_id, access, granted_scopes)
        VALUES (${`consent-${user.id}`}, 'client-1', ${user.id}, ARRAY['kvitbit:read'], ${workspaceId}, 'read', ARRAY['documents:read'])
      `;
      yield* sql`
        INSERT INTO auth.oauth_access_token (id, token, client_id, user_id, consent_id, scopes)
        VALUES (${`at-${user.id}`}, ${`tok-${user.id}`}, 'client-1', ${user.id}, ${`consent-${user.id}`}, ARRAY['kvitbit:read'])
      `;
    }),
  );
};

const countEdgeCredentials = async (user: TestUser) =>
  h.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const keys = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM auth.apikey WHERE workspace_id = ${workspaceId} AND created_by = ${user.id}
      `;
      const consents = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM auth.oauth_consent WHERE workspace_id = ${workspaceId} AND user_id = ${user.id}
      `;
      const tokens = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM auth.oauth_access_token WHERE user_id = ${user.id}
      `;
      return {
        keys: Number(keys[0]?.count ?? 0),
        consents: Number(consents[0]?.count ?? 0),
        tokens: Number(tokens[0]?.count ?? 0),
      };
    }),
  );

beforeEach(async () => {
  analytics = captureAnalytics();
  h = makeHarness({
    analytics: analytics.layer,
    users: [
      {
        userId: "01900000-0000-7000-8000-000000000001" as never,
        name: "Olga",
        email: "olga@example.cz",
      },
      {
        userId: "01900000-0000-7000-8000-000000000002" as never,
        name: "Petr",
        email: "petr@example.cz",
      },
    ],
  });
  await h.run(TestClock.setTime(TEST_NOW));
  owner = h.addUser("Olga");
  teammate = h.addUser("Petr");
  const member = await h.createWorkspace(owner, { name: "Alfa s.r.o." });
  workspaceId = member.workspaceId;
  base = `/api/v1/workspaces/${workspaceId}`;
});

afterEach(async () => {
  await h.dispose();
});

describe("team group", () => {
  test("listMembers returns current members", async () => {
    const res = await req(owner, "/members", "GET");
    expect(res.status).toBe(200);
    const members = (await res.json()) as Array<{ userId: string; role: string }>;
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(owner.id);
    expect(members[0]?.role).toBe("owner");
  });

  test("invitations: invite (201 + Location + Idempotency-Key), list, resend (202), revoke (204)", async () => {
    const inviteRes = await req(
      owner,
      "/invitations",
      "POST",
      { email: teammate.email, role: "member" },
      { "idempotency-key": "invite-key-0001" },
    );
    expect(inviteRes.status).toBe(201);
    const inv = (await inviteRes.json()) as { id: string; email: string; status: string };
    expect(inviteRes.headers.get("location")).toBe(`${base}/invitations/${inv.id}`);
    expect(inv.status).toBe("pending");

    const replay = await req(
      owner,
      "/invitations",
      "POST",
      { email: teammate.email, role: "member" },
      { "idempotency-key": "invite-key-0001" },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(inv);
    expect(analytics.capture.mock.calls).toEqual([
      [
        {
          event: "team_invitation_sent",
          distinctId: owner.id,
          properties: { workspaceId, role: "member" },
        },
      ],
    ]);

    const listRes = await req(owner, "/invitations", "GET");
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as Array<{ id: string }>).map((i) => i.id)).toContain(inv.id);

    // Advance past resend cooldown (60s)
    await h.run(TestClock.setTime(TEST_NOW + 61_000));
    const resendRes = await req(owner, `/invitations/${inv.id}/resend`, "POST");
    expect(resendRes.status).toBe(202);

    const sent = await h.run(Effect.flatMap(CaptureInvitationDelivery, (d) => Ref.get(d.sent)));
    expect(sent.length).toBeGreaterThanOrEqual(2);

    const revokeRes = await req(owner, `/invitations/${inv.id}`, "DELETE");
    expect(revokeRes.status).toBe(204);
  });

  test("setRole and removeMember revoke member API keys and OAuth grants", async () => {
    await addMemberViaInvite(teammate, "member");
    await seedEdgeCredentials(teammate);
    expect(await countEdgeCredentials(teammate)).toEqual({ keys: 1, consents: 1, tokens: 1 });

    const roleRes = await req(owner, `/members/${teammate.id}/role`, "PUT", { role: "accountant" });
    expect(roleRes.status).toBe(204);

    const members = (await (await req(owner, "/members", "GET")).json()) as Array<{
      userId: string;
      role: string;
    }>;
    expect(members.find((m) => m.userId === teammate.id)?.role).toBe("accountant");

    const removeRes = await req(owner, `/members/${teammate.id}`, "DELETE");
    expect(removeRes.status).toBe(204);
    expect(await countEdgeCredentials(teammate)).toEqual({ keys: 0, consents: 0, tokens: 0 });
  });

  test("leave: owner cannot leave (409); member leaves (204) and credentials are revoked", async () => {
    await addMemberViaInvite(teammate, "member");
    await seedEdgeCredentials(teammate);

    const ownerLeave = await req(owner, "/members/me/leave", "POST");
    expect(ownerLeave.status).toBe(409);

    const memberLeave = await req(teammate, "/members/me/leave", "POST");
    expect(memberLeave.status).toBe(204);
    expect(await countEdgeCredentials(teammate)).toEqual({ keys: 0, consents: 0, tokens: 0 });
  });

  test("transferOwnership enforces A6 fresh session and transfers ownership", async () => {
    await addMemberViaInvite(teammate, "admin");

    // API key -> 401 credential_not_allowed
    const keyRes = await h.fetch(`${base}/ownership-transfer`, {
      ...json({ to: teammate.id }),
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...as.apiKey(owner, workspaceId, ["members:write", "members:read"]),
      },
    });
    expect(keyRes.status).toBe(401);
    expect(await keyRes.json()).toEqual({
      _tag: "Unauthorized",
      reason: "credential_not_allowed",
    });

    // Stale session (> 5 min) -> 401 reauthentication_required
    await h.run(TestClock.setTime(TEST_NOW + 6 * 60 * 1000));
    const staleRes = await req(owner, "/ownership-transfer", "POST", { to: teammate.id });
    expect(staleRes.status).toBe(401);
    expect(await staleRes.json()).toEqual({
      _tag: "Unauthorized",
      reason: "reauthentication_required",
    });

    // Fresh session -> 204
    await h.run(TestClock.setTime(TEST_NOW + 60 * 1000));
    const okRes = await req(owner, "/ownership-transfer", "POST", { to: teammate.id });
    expect(okRes.status).toBe(204);

    const members = (await (await req(teammate, "/members", "GET")).json()) as Array<{
      userId: string;
      role: string;
    }>;
    expect(members.find((m) => m.userId === teammate.id)?.role).toBe("owner");
    expect(members.find((m) => m.userId === owner.id)?.role).toBe("admin");
  });
});
