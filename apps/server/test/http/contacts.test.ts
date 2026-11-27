import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { as, type Harness, json, makeHarness, type TestUser } from "./harness";

const decodeRevisionedId = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String, revision: Schema.Finite })),
  Effect.runSync,
);

let h: Harness;
let owner: TestUser;
let base: string;

const contact = {
  name: "Odběratel a.s.",
  ico: "25596641",
  address: { city: "Brno", country: "CZ" },
  roles: ["customer"],
};

beforeEach(async () => {
  h = makeHarness();
  owner = h.addUser("Olga");
  const member = await h.createWorkspace(owner);
  base = `/api/v1/workspaces/${member.workspaceId}/contacts`;
});
afterEach(async () => {
  await h.dispose();
});

const post = (body: typeof contact, headers: Record<string, string> = {}) => {
  const init = json(body);
  return h.fetch(base, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...as.mobile(owner), ...headers },
  });
};

describe("contacts group", () => {
  test("oversized JSON without Content-Length returns 413", async () => {
    const res = await post({ ...contact, name: Str.repeat(1024 * 1024)("x") });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ _tag: "PayloadTooLarge", limitBytes: 1024 * 1024 });
  });

  test("create answers 201 with ETag and Location; get echoes the ETag", async () => {
    const res = await post(contact);
    expect(res.status).toBe(201);
    const view = decodeRevisionedId(await res.json());
    expect(res.headers.get("etag")).toBe(`"${view.revision}"`);
    expect(res.headers.get("location")).toBe(`${base}/${view.id}`);
    const got = await h.fetch(`${base}/${view.id}`, { headers: as.mobile(owner) });
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe(`"${view.revision}"`);
  });

  test("Idempotency-Key replay answers the stored result with Idempotent-Replayed", async () => {
    const first = await post(contact, { "idempotency-key": "key-00000001" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const again = await post(contact, { "idempotency-key": "key-00000001" });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
    const other = await post({ ...contact, name: "Jiný" }, { "idempotency-key": "key-00000001" });
    expect(other.status).toBe(409);
  });

  test("update needs If-Match: 428 without, 412 when stale, 200 when current", async () => {
    const created = decodeRevisionedId(await (await post(contact)).json());
    const put = (headers: Record<string, string>) => {
      const init = json({ ...contact, name: "Přejmenováno" });
      return h.fetch(`${base}/${created.id}`, {
        ...init,
        method: "PUT",
        headers: { "content-type": "application/json", ...as.mobile(owner), ...headers },
      });
    };
    const missing = await put({});
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({ _tag: "PreconditionRequired" });
    const stale = await put({ "if-match": `"${created.revision + 5}"` });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({
      _tag: "PreconditionFailed",
      currentRevision: created.revision,
    });
    expect(stale.headers.get("etag")).toBe(`"${created.revision}"`);
    const ok = await put({ "if-match": `"${created.revision}"` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe(`"${created.revision + 1}"`);
  });

  test("malformed query is 422 request.malformed", async () => {
    const res = await h.fetch(`${base}?limit=0`, { headers: as.mobile(owner) });
    expect(res.status).toBe(422);
    const body = Schema.decodeUnknownEffect(
      Schema.Struct({ _tag: Schema.String, issues: Schema.Array(Schema.Unknown) }),
    )(await res.json()).pipe(Effect.runSync);
    expect(body._tag).toBe("Invalid");
    expect(body.issues[0]).toEqual({ path: ["query", "limit"], code: "request.malformed" });
  });

  test("returns 404 for another user's workspace", async () => {
    const stranger = h.addUser("Petr");
    const res = await h.fetch(base, { headers: as.mobile(stranger) });
    expect(res.status).toBe(404);
    expect(
      Schema.decodeUnknownEffect(Schema.Struct({ entity: Schema.String }))(await res.json()).pipe(
        Effect.runSync,
      ).entity,
    ).toBe("Workspace");
  });
});
