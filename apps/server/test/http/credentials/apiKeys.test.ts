import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiKeyMatches } from "@kvitbit/adapters/auth";
import { ALL_SCOPES, ApiKeyCreated, ApiKeyView, READ_SCOPES } from "@kvitbit/api-contract";
import { CoreStore } from "@kvitbit/core/ports";
import { Invalid, type MemberCaller, OpenStruct, Workspaces } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { captureAnalytics } from "../../analytics-fixture";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";
import { createSeededWorkspace, joinMember } from "./seed";

let h: Harness;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let accountant: TestUser;
let ownerCaller: MemberCaller;
let base: string;
let analytics: ReturnType<typeof captureAnalytics>;

beforeEach(async () => {
  analytics = captureAnalytics();
  h = makeHarness({ analytics: analytics.layer });
  await h.run(TestClock.setTime(TEST_NOW));
  owner = h.addUser("Olga");
  admin = h.addUser("Adam");
  member = h.addUser("Marie");
  accountant = h.addUser("Alena");
  ownerCaller = await createSeededWorkspace(h, owner, "alfa-sro", "Alfa s.r.o.");
  await joinMember(h, ownerCaller, admin, "admin");
  await joinMember(h, ownerCaller, member, "member");
  await joinMember(h, ownerCaller, accountant, "accountant");
  base = `/api/v1/workspaces/${ownerCaller.workspaceId}/api-keys`;
}, 20_000);

afterEach(async () => {
  await h.dispose();
});

const decodeCreatedKey = Fn.flow(Schema.decodeUnknownEffect(ApiKeyCreated), Effect.runSync);
// Preserve every creator field for wire equality.
const decodeWireKeyCreator = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.Struct({ key: Schema.Struct({ createdBy: Schema.JsonObject }) }),
  ),
  Effect.runSync,
  ({ key }) => key.createdBy,
);
// Keep any extra fields so the list assertion can detect a leaked secret.
const decodeKeyList = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Array(OpenStruct({ id: ApiKeyView.fields.id }))),
  Effect.runSync,
);
const decodeInvalid = Fn.flow(
  Schema.decodeUnknownEffect(Schema.toEncoded(Invalid)),
  Effect.runSync,
);

const postKey = (user: TestUser, body: Schema.Json, path = base) =>
  h.fetch(path, {
    ...json(body),
    method: "POST",
    headers: { "content-type": "application/json", ...as.mobile(user) },
  });

describe("apiKeys group", () => {
  test("owner creates a read_write key (201, Location, secret hashed in auth.apikey), lists and revokes it", async () => {
    const createRes = await postKey(owner, {
      name: "  CI Integration  ",
      access: "read_write",
      expiresOn: "2026-12-31",
    });
    expect(createRes.status).toBe(201);
    const wireCreated = await createRes.json();
    const created = decodeCreatedKey(wireCreated);

    expect(createRes.headers.get("location")).toBe(`${base}/${created.key.id}`);
    expect(created.key.name).toBe("CI Integration");
    expect(created.key.prefix).toBe(`kvb_${created.key.id}`);
    expect(created.key.access).toBe("read_write");
    expect(created.key.scopes).toEqual([...ALL_SCOPES]);
    expect(decodeWireKeyCreator(wireCreated)).toEqual({ userId: owner.id, name: owner.name });
    expect(created.key.lastUsedAt).toBeNull();
    expect(created.key.expiresAt).toBe("2026-12-31T23:59:59.999Z");
    expect(Str.startsWith(`kvb_${created.key.id}_`)(created.secret)).toBe(true);

    // Stored row holds only the SHA-256 hash, never the raw secret.
    const stored = await h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ key: string; start: string; prefix: string }>`
          select key, start, prefix from auth.apikey where id = ${created.key.id}
        `;
        return rows[0];
      }),
    );
    expect(stored).toBeDefined();
    expect(stored?.key).not.toBe(created.secret);
    expect(apiKeyMatches(created.secret, stored?.key ?? "")).toBe(true);
    expect(stored?.start).toBe(`kvb_${created.key.id}`);
    expect(stored?.prefix).toBe("kvb_");

    // List returns the key without the secret.
    const listRes = await h.fetch(base, { headers: as.mobile(owner) });
    expect(listRes.status).toBe(200);
    const wireList = Fn.flow(
      Schema.decodeUnknownEffect(Schema.Array(Schema.JsonObject)),
      Effect.runSync,
    )(await listRes.json());
    const listed = decodeKeyList(wireList);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.key.id);
    expect(listed[0]).not.toHaveProperty("secret");

    // Revoke returns 204 and removes the row.
    const delRes = await h.fetch(`${base}/${created.key.id}`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(delRes.status).toBe(204);

    const afterList = await (await h.fetch(base, { headers: as.mobile(owner) })).json();
    expect(afterList).toEqual([]);

    // Core audit log captured both apiKey.create and apiKey.revoke.
    const auditActions = await h.run(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const entries = yield* store.audit.history(ownerCaller.workspaceId, {
          entity: "ApiKey",
          id: created.key.id,
        });
        return Arr.map(entries, (e) => e.action);
      }),
    );
    expect(auditActions).toEqual(["apiKey.create", "apiKey.revoke"]);
    expect(analytics.capture.mock.calls).toEqual([
      [
        {
          event: "api_key_created",
          distinctId: owner.id,
          properties: { workspaceId: ownerCaller.workspaceId, access: "read_write" },
        },
      ],
      [
        {
          event: "api_key_revoked",
          distinctId: owner.id,
          properties: { workspaceId: ownerCaller.workspaceId, access: "read_write" },
        },
      ],
    ]);
  });

  test("admin can create custom-scoped key (write implies read) and read preset key", async () => {
    const customRes = await postKey(admin, {
      name: "Billing Bot",
      access: "custom",
      scopes: ["documents:write", "contacts:read"],
    });
    expect(customRes.status).toBe(201);
    const wireCustom = await customRes.json();
    const customBody = decodeCreatedKey(wireCustom);
    expect(customBody.key.access).toBe("custom");
    expect(customBody.key.scopes).toEqual(["contacts:read", "documents:read", "documents:write"]);
    expect(decodeWireKeyCreator(wireCustom)).toEqual({ userId: admin.id, name: admin.name });

    const readRes = await postKey(admin, { name: "Read-only Sync", access: "read" });
    expect(readRes.status).toBe(201);
    const readBody = decodeCreatedKey(await readRes.json());
    expect(readBody.key.access).toBe("read");
    expect(readBody.key.scopes).toEqual([...READ_SCOPES]);
  });

  test("member and accountant are forbidden (403 apiKey.manage) on list, create, and revoke", async () => {
    const created = decodeCreatedKey(
      await (await postKey(owner, { name: "Owner Key", access: "read" })).json(),
    );

    const expectForbidden = async (nonManager: TestUser) => {
      const listRes = await h.fetch(base, { headers: as.mobile(nonManager) });
      expect(listRes.status).toBe(403);
      expect(await listRes.json()).toEqual({ _tag: "Forbidden", action: "apiKey.manage" });

      const createRes = await postKey(nonManager, { name: "Nope", access: "read" });
      expect(createRes.status).toBe(403);
      expect(await createRes.json()).toEqual({ _tag: "Forbidden", action: "apiKey.manage" });

      const delRes = await h.fetch(`${base}/${created.key.id}`, {
        method: "DELETE",
        headers: as.mobile(nonManager),
      });
      expect(delRes.status).toBe(403);
      expect(await delRes.json()).toEqual({ _tag: "Forbidden", action: "apiKey.manage" });
    };
    await expectForbidden(member);
    await expectForbidden(accountant);
  });

  test("SessionOnly rejects API Key credentials with 401 credential_not_allowed", async () => {
    const res = await h.fetch(base, {
      headers: as.apiKey(owner, ownerCaller.workspaceId, ["members:write"]),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ _tag: "Unauthorized", reason: "credential_not_allowed" });
  });

  test("validation rejects blank name and past expiresOn with 422 Invalid", async () => {
    const blank = await postKey(owner, { name: "   ", access: "read" });
    expect(blank.status).toBe(422);
    expect(decodeInvalid(await blank.json()).issues[0].path).toEqual(["name"]);

    const past = await postKey(owner, {
      name: "Expired",
      access: "read",
      expiresOn: "2026-11-22",
    });
    expect(past.status).toBe(422);
    expect(decodeInvalid(await past.json()).issues[0].path).toEqual(["expiresOn"]);
  });

  test("lists workspace keys only and returns 404 for foreign or missing keys", async () => {
    const otherOwner = h.addUser("Petr");
    const otherWs = await createSeededWorkspace(h, otherOwner, "beta-sro", "Beta s.r.o.");
    const otherBase = `/api/v1/workspaces/${otherWs.workspaceId}/api-keys`;

    const otherCreated = decodeCreatedKey(
      await (await postKey(otherOwner, { name: "Beta Key", access: "read" }, otherBase)).json(),
    );

    // Not visible in owner's workspace
    const listRes = await h.fetch(base, { headers: as.mobile(owner) });
    expect(await listRes.json()).toEqual([]);

    // Revoking Beta's key from Alfa returns 404 NotFound{ApiKey}
    const delForeign = await h.fetch(`${base}/${otherCreated.key.id}`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(delForeign.status).toBe(404);
    expect(await delForeign.json()).toEqual({
      _tag: "NotFound",
      entity: "ApiKey",
      id: otherCreated.key.id,
    });

    // Revoking an unknown valid ApiKeyId returns 404 NotFound{ApiKey}
    const missingId = "01900000-0000-7000-8000-999999999999";
    const delMissing = await h.fetch(`${base}/${missingId}`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(delMissing.status).toBe(404);
    expect(await delMissing.json()).toEqual({
      _tag: "NotFound",
      entity: "ApiKey",
      id: missingId,
    });
  });

  test("creating a key in a closed workspace fails 403 and rolls back the SQL insert", async () => {
    await h.run(
      Effect.gen(function* () {
        const ws = yield* Workspaces;
        yield* ws.close(ownerCaller, "Alfa s.r.o.");
      }),
    );

    const res = await postKey(owner, { name: "After Close", access: "read" });
    expect(res.status).toBe(403);

    const count = await h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ count: string }>`
          select count(*)::text as count from auth.apikey where workspace_id = ${ownerCaller.workspaceId}
        `;
        return Number(rows[0]?.count ?? "0");
      }),
    );
    expect(count).toBe(0);
  });
});
