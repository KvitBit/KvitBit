import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Contacts, CurrentCaller, type MemberCaller } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;
let member: MemberCaller;
let wsBase: string;
let base: string;
let contactId: string;

const makeTemplate = (overrides: Record<string, unknown> = {}) => ({
  name: "Měsíční hosting",
  kind: "invoice",
  contact: contactId,
  lines: [{ description: "Hosting", quantity: "1", unitPrice: "1250.50" }],
  due: { inDays: 14 },
  ...overrides,
});

const schedule = {
  every: { months: 1 },
  startOn: "2026-12-01",
  issueAs: "invoice",
  autoSend: false,
};

beforeEach(async () => {
  h = makeHarness();
  await h.run(TestClock.setTime(TEST_NOW));
  owner = h.addUser("Olga");
  member = await h.createWorkspace(owner);
  wsBase = `/api/v1/workspaces/${member.workspaceId}`;
  base = `${wsBase}/templates`;

  const contact = await h.run(
    Effect.gen(function* () {
      const contacts = yield* Contacts;
      return yield* contacts.save({
        name: "Klient s.r.o.",
        ico: "25596641",
        address: { city: "Brno", country: "CZ" },
        roles: ["customer"],
      });
    }).pipe(Effect.provideService(CurrentCaller, member)),
  );
  contactId = contact.id as string;
});

afterEach(async () => {
  await h.dispose();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const init = json(body);
  return h.fetch(path, {
    ...init,
    method: "POST",
    headers: { ...(init.headers as Record<string, string>), ...as.mobile(owner), ...headers },
  });
};

const put = (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const init = json(body);
  return h.fetch(path, {
    ...init,
    method: "PUT",
    headers: { ...(init.headers as Record<string, string>), ...as.mobile(owner), ...headers },
  });
};

describe("templates group", () => {
  test("create (201 + Location + ETag + Idempotency-Key), list, get, update (If-Match), and archive", async () => {
    const created = await post(base, makeTemplate(), { "idempotency-key": "tpl-key-0001" });
    expect(created.status).toBe(201);
    const view = (await created.json()) as { id: string; revision: number; name: string };
    expect(created.headers.get("etag")).toBe(`"${view.revision}"`);
    expect(created.headers.get("location")).toBe(`${base}/${view.id}`);

    const replay = await post(base, makeTemplate(), { "idempotency-key": "tpl-key-0001" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(view);

    const listed = await h.fetch(base, { headers: as.mobile(owner) });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Array<{ id: string }>).map((t) => t.id)).toEqual([view.id]);

    const got = await h.fetch(`${base}/${view.id}`, { headers: as.mobile(owner) });
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe(`"${view.revision}"`);

    expect((await put(`${base}/${view.id}`, makeTemplate({ name: "Nový" }))).status).toBe(428);
    const stale = await put(`${base}/${view.id}`, makeTemplate({ name: "Nový" }), {
      "if-match": `"${view.revision + 4}"`,
    });
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe(`"${view.revision}"`);

    const updated = await put(`${base}/${view.id}`, makeTemplate({ name: "Nový" }), {
      "if-match": `"${view.revision}"`,
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe(`"${view.revision + 1}"`);

    const archived = await h.fetch(`${base}/${view.id}/archive`, {
      method: "POST",
      headers: as.mobile(owner),
    });
    expect(archived.status).toBe(204);
  });

  test("schedule set/remove (If-Match), runs listing, resume (409 when not paused), and use (201 Document Location)", async () => {
    const created = (await (await post(base, makeTemplate())).json()) as {
      id: string;
      revision: number;
    };

    // setSchedule requires If-Match
    expect((await put(`${base}/${created.id}/schedule`, schedule)).status).toBe(428);
    const scheduled = await put(`${base}/${created.id}/schedule`, schedule, {
      "if-match": `"${created.revision}"`,
    });
    expect(scheduled.status).toBe(200);
    const scheduledView = (await scheduled.json()) as {
      revision: number;
      schedule: { pausedReason: string | null } | null;
    };
    expect(scheduledView.schedule).not.toBeNull();
    expect(scheduled.headers.get("etag")).toBe(`"${scheduledView.revision}"`);

    // runs listing
    const runs = await h.fetch(`${base}/${created.id}/runs?limit=10`, {
      headers: as.mobile(owner),
    });
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual({ items: [], nextCursor: null });

    // resume on an active schedule is idempotent (200 + ETag)
    const resumeActive = await h.fetch(`${base}/${created.id}/resume`, {
      method: "POST",
      headers: as.mobile(owner),
    });
    expect(resumeActive.status).toBe(200);
    expect(resumeActive.headers.get("etag")).toBe(`"${scheduledView.revision}"`);

    // removeSchedule requires If-Match
    const missingDel = await h.fetch(`${base}/${created.id}/schedule`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(missingDel.status).toBe(428);

    const staleDel = await h.fetch(`${base}/${created.id}/schedule`, {
      method: "DELETE",
      headers: { ...as.mobile(owner), "if-match": `"${created.revision}"` },
    });
    expect(staleDel.status).toBe(412);

    const removed = await h.fetch(`${base}/${created.id}/schedule`, {
      method: "DELETE",
      headers: { ...as.mobile(owner), "if-match": `"${scheduledView.revision}"` },
    });
    expect(removed.status).toBe(200);
    const removedView = (await removed.json()) as { revision: number; schedule: null };
    expect(removedView.schedule).toBeNull();
    expect(removed.headers.get("etag")).toBe(`"${removedView.revision}"`);

    // resume without a schedule -> 409 Conflict
    const resumeNoSchedule = await h.fetch(`${base}/${created.id}/resume`, {
      method: "POST",
      headers: as.mobile(owner),
    });
    expect(resumeNoSchedule.status).toBe(409);

    // use template -> creates document with Location pointing to /documents/:id
    const used = await post(
      `${base}/${created.id}/documents`,
      { as: "draft" },
      { "idempotency-key": "tpl-use-0001" },
    );
    expect(used.status).toBe(201);
    const doc = (await used.json()) as { id: string; revision: number; status: string };
    expect(doc.status).toBe("draft");
    expect(used.headers.get("etag")).toBe(`"${doc.revision}"`);
    expect(used.headers.get("location")).toBe(`${wsBase}/documents/${doc.id}`);

    const usedReplay = await post(
      `${base}/${created.id}/documents`,
      { as: "draft" },
      { "idempotency-key": "tpl-use-0001" },
    );
    expect(usedReplay.status).toBe(201);
    expect(usedReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(await usedReplay.json()).toEqual(doc);
  });
});
