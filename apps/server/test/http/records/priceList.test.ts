import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { as, type Harness, json, makeHarness, type TestUser } from "../harness";

const decodeIds = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String }))),
  Effect.runSync,
);

let h: Harness;
let owner: TestUser;
let workspaceId: string;
let base: string;

const item = {
  name: "Konzultace",
  description: "Hodinová sazba",
  unit: "hod",
  unitPrice: "1500.00",
  currency: "CZK",
  vat: "standard",
};

beforeEach(async () => {
  h = makeHarness();
  owner = h.addUser("Olga");
  const member = await h.createWorkspace(owner);
  workspaceId = member.workspaceId;
  base = `/api/v1/workspaces/${workspaceId}/price-list-items`;
});

afterEach(async () => {
  await h.dispose();
});

const post = (body: typeof item, headers: Record<string, string> = {}) => {
  const init = json(body);
  return h.fetch(base, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...as.mobile(owner), ...headers },
  });
};

describe("priceList group", () => {
  test("create returns 201 with Location and ETag; list filters by text and includeArchived", async () => {
    const created = await post(item);
    expect(created.status).toBe(201);
    const view = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, revision: Schema.Finite, name: Schema.String }),
    )(await created.json()).pipe(Effect.runSync);
    expect(created.headers.get("etag")).toBe(`"${view.revision}"`);
    expect(created.headers.get("location")).toBe(`${base}/${view.id}`);

    const second = await post({ ...item, name: "Hosting" });
    expect(second.status).toBe(201);

    const all = await h.fetch(base, { headers: as.mobile(owner) });
    expect(all.status).toBe(200);
    expect(decodeIds(await all.json()).length).toBe(2);

    const filtered = await h.fetch(`${base}?text=Host`, { headers: as.mobile(owner) });
    expect(filtered.status).toBe(200);
    const filteredItems = Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ name: Schema.String })),
    )(await filtered.json()).pipe(Effect.runSync);
    expect(Arr.map(filteredItems, (i) => i.name)).toEqual(["Hosting"]);
  });

  test("Idempotency-Key replays stored create with Idempotent-Replayed and rejects mismatch", async () => {
    const first = await post(item, { "idempotency-key": "pl-key-0001" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();

    const replay = await post(item, { "idempotency-key": "pl-key-0001" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());

    const mismatch = await post({ ...item, name: "Jiná" }, { "idempotency-key": "pl-key-0001" });
    expect(mismatch.status).toBe(409);
  });

  test("update enforces If-Match (428 missing, 412 stale + ETag, 200 current + incremented ETag)", async () => {
    const created = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, revision: Schema.Finite }),
    )(await (await post(item)).json()).pipe(Effect.runSync);
    const put = (headers: Record<string, string>, body = { ...item, name: "Upraveno" }) => {
      const init = json(body);
      return h.fetch(`${base}/${created.id}`, {
        ...init,
        method: "PUT",
        headers: { "content-type": "application/json", ...as.mobile(owner), ...headers },
      });
    };

    const missing = await put({});
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({ _tag: "PreconditionRequired" });

    const stale = await put({ "if-match": `"${created.revision + 3}"` });
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe(`"${created.revision}"`);
    expect(await stale.json()).toEqual({
      _tag: "PreconditionFailed",
      currentRevision: created.revision,
    });

    const ok = await put({ "if-match": `"${created.revision}"` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe(`"${created.revision + 1}"`);
    expect(
      Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(await ok.json()).pipe(
        Effect.runSync,
      ).name,
    ).toBe("Upraveno");
  });

  test("archive returns 204, hides item by default, and surfaces it with includeArchived=true", async () => {
    const created = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
      await (await post(item)).json(),
    ).pipe(Effect.runSync);
    const archived = await h.fetch(`${base}/${created.id}/archive`, {
      method: "POST",
      headers: as.mobile(owner),
    });
    expect(archived.status).toBe(204);

    const active = await (await h.fetch(base, { headers: as.mobile(owner) })).json();
    expect(active).toEqual([]);

    const withArchived = decodeIds(
      await (await h.fetch(`${base}?includeArchived=true`, { headers: as.mobile(owner) })).json(),
    );
    expect(Arr.map(withArchived, (i) => i.id)).toEqual([created.id]);

    const missing = await h.fetch(`${base}/01900000-0000-7000-8000-000000000099/archive`, {
      method: "POST",
      headers: as.mobile(owner),
    });
    expect(missing.status).toBe(404);
  });

  test("enforces scope and workspace isolation", async () => {
    const readOnly = await post(item, as.apiKey(owner, workspaceId, ["contacts:read"]));
    expect(readOnly.status).toBe(403);

    const stranger = h.addUser("Petr");
    const foreign = await h.fetch(base, { headers: as.mobile(stranger) });
    expect(foreign.status).toBe(404);
  });
});
