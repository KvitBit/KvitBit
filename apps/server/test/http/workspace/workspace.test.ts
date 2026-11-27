import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TestClock } from "effect/testing";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;
let workspaceId: string;
let base: string;

const req = (
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
      ...as.mobile(owner),
      ...headers,
    },
  });
};

beforeEach(async () => {
  h = makeHarness();
  await h.run(TestClock.setTime(TEST_NOW));
  owner = h.addUser("Olga");
  const member = await h.createWorkspace(owner, { name: "Alfa s.r.o." });
  workspaceId = member.workspaceId;
  base = `/api/v1/workspaces/${workspaceId}`;
});

afterEach(async () => {
  await h.dispose();
});

describe("workspace group", () => {
  test("current returns WorkspaceView with ETag", async () => {
    const res = await req("", "GET");
    expect(res.status).toBe(200);
    const view = (await res.json()) as { id: string; name: string; revision: number };
    expect(view.id).toBe(workspaceId);
    expect(view.name).toBe("Alfa s.r.o.");
    expect(res.headers.get("etag")).toBe(`"${view.revision}"`);
  });

  test("updateIssuingEntity enforces If-Match (428 / 412 / 200)", async () => {
    const cur = (await (await req("", "GET")).json()) as { revision: number };
    const patch = {
      name: "Alfa Nová s.r.o.",
      address: { street: "Vodičkova 1", city: "Praha", postalCode: "11000", country: "CZ" },
    };

    const missing = await req("/issuing-entity", "PATCH", patch);
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({ _tag: "PreconditionRequired" });

    const stale = await req("/issuing-entity", "PATCH", patch, {
      "if-match": `"${cur.revision + 9}"`,
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({
      _tag: "PreconditionFailed",
      currentRevision: cur.revision,
    });
    expect(stale.headers.get("etag")).toBe(`"${cur.revision}"`);

    const ok = await req("/issuing-entity", "PATCH", patch, { "if-match": `"${cur.revision}"` });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as {
      issuingEntity: { name: string };
      revision: number;
    };
    expect(updated.issuingEntity.name).toBe("Alfa Nová s.r.o.");
    expect(ok.headers.get("etag")).toBe(`"${updated.revision}"`);
  });

  test("updateSettings enforces If-Match and updates defaults", async () => {
    const cur = (await (await req("", "GET")).json()) as { revision: number };
    const missing = await req("/settings", "PATCH", { defaults: { dueDays: 30 } });
    expect(missing.status).toBe(428);

    const ok = await req(
      "/settings",
      "PATCH",
      { defaults: { dueDays: 30 } },
      { "if-match": `"${cur.revision}"` },
    );
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as { defaults: { dueDays: number }; revision: number };
    expect(updated.defaults.dueDays).toBe(30);
    expect(ok.headers.get("etag")).toBe(`"${updated.revision}"`);
  });

  test("bank accounts: create (201 + Location + Idempotency-Key), list, update, remove with replacement", async () => {
    const acc1Input = {
      name: "Provozní CZK",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
      currency: "CZK",
      isDefault: true,
    };
    const create1 = await req("/bank-accounts", "POST", acc1Input, {
      "idempotency-key": "bank-key-0001",
    });
    expect(create1.status).toBe(201);
    const acc1 = (await create1.json()) as { id: string; name: string; isDefault: boolean };
    expect(create1.headers.get("location")).toBe(`${base}/bank-accounts/${acc1.id}`);
    expect(create1.headers.get("idempotent-replayed")).toBeNull();

    // Replay returns the same account with Idempotent-Replayed: true
    const replay = await req("/bank-accounts", "POST", acc1Input, {
      "idempotency-key": "bank-key-0001",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(acc1);

    // Mismatch on same key -> 409
    const mismatch = await req(
      "/bank-accounts",
      "POST",
      { ...acc1Input, name: "Jiný název" },
      { "idempotency-key": "bank-key-0001" },
    );
    expect(mismatch.status).toBe(409);

    // List returns the created account
    const listed = await req("/bank-accounts", "GET");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Array<{ id: string }>).map((a) => a.id)).toContain(acc1.id);

    // Update account
    const updatedRes = await req(`/bank-accounts/${acc1.id}`, "PUT", {
      ...acc1Input,
      name: "Hlavní CZK",
    });
    expect(updatedRes.status).toBe(200);
    expect(((await updatedRes.json()) as { name: string }).name).toBe("Hlavní CZK");

    // Removing the currency default without replacement fails 409
    const blocked = await req(`/bank-accounts/${acc1.id}`, "DELETE");
    expect(blocked.status).toBe(409);

    // Create second CZK account and remove first with ?replacement=
    const create2 = await req("/bank-accounts", "POST", {
      name: "Záložní CZK",
      iban: "CZ5855000000001265098001",
      currency: "CZK",
    });
    expect(create2.status).toBe(201);
    const acc2 = (await create2.json()) as { id: string };

    const removed = await req(`/bank-accounts/${acc1.id}?replacement=${acc2.id}`, "DELETE");
    expect(removed.status).toBe(204);

    const after = (await (await req("/bank-accounts", "GET")).json()) as Array<{
      id: string;
      isDefault: boolean;
    }>;
    expect(after.map((a) => a.id)).toEqual([acc2.id]);
    expect(after[0]?.isDefault).toBe(true);
  });

  test("numbering series: list, create (201 + Location + Idempotency-Key), update", async () => {
    const listRes = await req("/numbering-series", "GET");
    expect(listRes.status).toBe(200);
    const defaults = (await listRes.json()) as Array<{ id: string; kind: string }>;
    expect(defaults.length).toBeGreaterThanOrEqual(3);

    const seriesInput = {
      kind: "invoice",
      name: "Exportní faktury",
      pattern: "EX-YYYY-NNNN",
      nextNumber: 1,
      isDefault: false,
    };
    const createRes = await req("/numbering-series", "POST", seriesInput, {
      "idempotency-key": "series-key-001",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string; pattern: string };
    expect(createRes.headers.get("location")).toBe(`${base}/numbering-series/${created.id}`);

    const replay = await req("/numbering-series", "POST", seriesInput, {
      "idempotency-key": "series-key-001",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(created);

    const updateRes = await req(`/numbering-series/${created.id}`, "PUT", {
      ...seriesInput,
      name: "Exportní faktury EU",
    });
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as { name: string }).name).toBe("Exportní faktury EU");
  });

  test("close enforces A6 fresh session (API key 401, stale session 401, wrong name 422, fresh 204)", async () => {
    // API key cannot close (not a session)
    const apiKeyRes = await h.fetch(`${base}/close`, {
      ...json({ confirmName: "Alfa s.r.o." }),
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...as.apiKey(owner, workspaceId, ["workspace:write", "workspace:read"]),
      },
    });
    expect(apiKeyRes.status).toBe(401);
    expect(await apiKeyRes.json()).toEqual({
      _tag: "Unauthorized",
      reason: "credential_not_allowed",
    });

    // Stale session (> 5 min old) -> 401 reauthentication_required
    await h.run(TestClock.setTime(TEST_NOW + 5 * 60 * 1000 + 1));
    const staleRes = await req("/close", "POST", { confirmName: "Alfa s.r.o." });
    expect(staleRes.status).toBe(401);
    expect(await staleRes.json()).toEqual({
      _tag: "Unauthorized",
      reason: "reauthentication_required",
    });

    // Fresh session (within 5 min)
    await h.run(TestClock.setTime(TEST_NOW + 4 * 60 * 1000));
    const wrongName = await req("/close", "POST", { confirmName: "Wrong" });
    expect(wrongName.status).toBe(422);

    const closedRes = await req("/close", "POST", { confirmName: "Alfa s.r.o." });
    expect(closedRes.status).toBe(204);

    const after = (await (await req("", "GET")).json()) as { closed: boolean };
    expect(after.closed).toBe(true);
  });
});
