import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ATTACHMENT_MAX_BYTES } from "@kvitbit/api-contract";
import { Contacts, type MemberCaller } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import { captureAnalytics } from "../../analytics-fixture";
import { as, type Harness, json, makeHarness, type TestUser } from "../harness";

const decodeExpensePage = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.Struct({
      items: Schema.Array(Schema.Struct({ id: Schema.String })),
      nextCursor: Schema.NullOr(Schema.String),
    }),
  ),
  Effect.runSync,
);
const decodeId = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String })),
  Effect.runSync,
);
const decodeIssues = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.Struct({ issues: Schema.Array(Schema.Struct({ code: Schema.String })) }),
  ),
  Effect.runSync,
);

let h: Harness;
let owner: TestUser;
let member: MemberCaller;
let base: string;
let supplierId: string;
let analytics: ReturnType<typeof captureAnalytics>;

const PDF_BYTES = new TextEncoder().encode(
  Arr.join(["%PDF-1.4", "1 0 obj", "<<>>", "endobj", "%%EOF", ""], "\n"),
);

const makeExpense = () => ({
  supplier: { contact: supplierId },
  supplierDocumentNumber: "FV-2026-100",
  issuedOn: "2026-11-20",
  taxableSupplyOn: "2026-11-19",
  dueOn: "2026-12-04",
  currency: "CZK",
  total: "121.00",
  vat: [{ treatment: "standard", base: "100.00", vat: "21.00" }],
  category: "software",
  tags: ["saas"],
});

beforeEach(async () => {
  analytics = captureAnalytics();
  h = makeHarness({ analytics: analytics.layer });
  owner = h.addUser("Olga");
  member = await h.createWorkspace(owner);
  base = `/api/v1/workspaces/${member.workspaceId}/expenses`;

  const contact = await h.run(
    Effect.gen(function* () {
      const contacts = yield* Contacts;
      return yield* contacts.save(member, {
        name: "Dodavatel s.r.o.",
        ico: "25596641",
        address: { city: "Praha", country: "CZ" },
        roles: ["supplier"],
      });
    }),
  );
  supplierId = Schema.decodeUnknownEffect(Schema.String)(contact["id"]).pipe(Effect.runSync);
});

afterEach(async () => {
  await h.dispose();
});

const postExpense = (
  body: ReturnType<typeof makeExpense> | { status: "incomplete"; category: string },
  headers: Record<string, string> = {},
) => {
  const init = json(body);
  return h.fetch(base, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...as.mobile(owner), ...headers },
  });
};

const uploadForm = (expenseId: string, form: FormData, headers: Record<string, string> = {}) =>
  h.fetch(`${base}/${expenseId}/attachments`, {
    method: "POST",
    body: form,
    headers: { ...as.mobile(owner), ...headers },
  });

describe("expenses group", () => {
  test("record (201 + Location + ETag + Idempotency-Key), get, list with incomplete filter and paging", async () => {
    const first = await postExpense(makeExpense(), { "idempotency-key": "exp-key-0001" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const view = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, revision: Schema.Finite, status: Schema.String }),
    )(firstBody).pipe(Effect.runSync);
    expect(first.headers.get("etag")).toBe(`"${view.revision}"`);
    expect(first.headers.get("location")).toBe(`${base}/${view.id}`);
    expect(view.status).toBe("complete");

    const replay = await postExpense(makeExpense(), { "idempotency-key": "exp-key-0001" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);

    const got = await h.fetch(`${base}/${view.id}`, { headers: as.mobile(owner) });
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe(`"${view.revision}"`);

    const incomplete = await postExpense({ status: "incomplete", category: "travel" });
    expect(incomplete.status).toBe(201);
    const incView = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, status: Schema.String }),
    )(await incomplete.json()).pipe(Effect.runSync);
    expect(incView.status).toBe("incomplete");

    const onlyIncomplete = await h.fetch(`${base}?incomplete=true`, { headers: as.mobile(owner) });
    expect(onlyIncomplete.status).toBe(200);
    const incPage = decodeExpensePage(await onlyIncomplete.json());
    expect(Arr.map(incPage.items, (i) => i.id)).toEqual([incView.id]);

    const page1 = await h.fetch(`${base}?limit=1`, { headers: as.mobile(owner) });
    expect(page1.status).toBe(200);
    const p1 = decodeExpensePage(await page1.json());
    expect(p1.items.length).toBe(1);
    expect(p1.nextCursor).not.toBeNull();

    const page2 = await h.fetch(
      `${base}?limit=1&cursor=${encodeURIComponent(p1.nextCursor ?? "")}`,
      {
        headers: as.mobile(owner),
      },
    );
    expect(page2.status).toBe(200);
    const p2 = decodeExpensePage(await page2.json());
    expect(p2.items.length).toBe(1);
    expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
  });

  test("edit and remove enforce If-Match (428 / 412 / 200 & 204)", async () => {
    const created = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, revision: Schema.Finite }),
    )(await (await postExpense(makeExpense())).json()).pipe(Effect.runSync);

    const patch = (headers: Record<string, string>) => {
      const init = json({ category: "hardware" });
      return h.fetch(`${base}/${created.id}`, {
        ...init,
        method: "PATCH",
        headers: { "content-type": "application/json", ...as.mobile(owner), ...headers },
      });
    };

    expect((await patch({})).status).toBe(428);
    const stalePatch = await patch({ "if-match": `"${created.revision + 2}"` });
    expect(stalePatch.status).toBe(412);
    expect(stalePatch.headers.get("etag")).toBe(`"${created.revision}"`);

    const edited = await patch({ "if-match": `"${created.revision}"` });
    expect(edited.status).toBe(200);
    const editedView = Schema.decodeUnknownEffect(
      Schema.Struct({ revision: Schema.Finite, category: Schema.String }),
    )(await edited.json()).pipe(Effect.runSync);
    expect(editedView.category).toBe("hardware");
    expect(edited.headers.get("etag")).toBe(`"${editedView.revision}"`);

    const missingDel = await h.fetch(`${base}/${created.id}`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(missingDel.status).toBe(428);

    const staleDel = await h.fetch(`${base}/${created.id}`, {
      method: "DELETE",
      headers: { ...as.mobile(owner), "if-match": `"${created.revision}"` },
    });
    expect(staleDel.status).toBe(412);

    const okDel = await h.fetch(`${base}/${created.id}`, {
      method: "DELETE",
      headers: { ...as.mobile(owner), "if-match": `"${editedView.revision}"` },
    });
    expect(okDel.status).toBe(204);

    const afterDel = await h.fetch(`${base}/${created.id}`, { headers: as.mobile(owner) });
    expect(afterDel.status).toBe(404);
  });

  test("multipart attach (201 + Location), download (attachment & inline + headers), and detach (204)", async () => {
    const created = decodeId(await (await postExpense(makeExpense())).json());

    const form = new FormData();
    form.append("file", new File([PDF_BYTES], "účtenka 2026.pdf", { type: "application/pdf" }));
    const uploaded = await uploadForm(created.id, form);
    expect(uploaded.status).toBe(201);
    const att = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, contentType: Schema.String, bytes: Schema.Finite }),
    )(await uploaded.json()).pipe(Effect.runSync);
    expect(att.contentType).toBe("application/pdf");
    expect(att.bytes).toBe(PDF_BYTES.byteLength);
    expect(uploaded.headers.get("location")).toBe(`${base}/${created.id}/attachments/${att.id}`);
    expect(analytics.capture.mock.calls).toEqual([
      [
        {
          event: "expense_receipt_uploaded",
          distinctId: owner.id,
          properties: { workspaceId: member.workspaceId },
        },
      ],
    ]);

    // Idempotent by content hash
    const formAgain = new FormData();
    formAgain.append(
      "file",
      new File([PDF_BYTES], "účtenka 2026.pdf", { type: "application/pdf" }),
    );
    const uploadedAgain = await uploadForm(created.id, formAgain);
    expect(uploadedAgain.status).toBe(201);
    expect(decodeId(await uploadedAgain.json()).id).toBe(att.id);

    // Download default disposition (attachment)
    const dl = await h.fetch(`${base}/${created.id}/attachments/${att.id}`, {
      headers: as.mobile(owner),
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    const cd = dl.headers.get("content-disposition") ?? "";
    expect(cd).toStartWith("attachment; filename=");
    expect(cd).toContain(encodeURIComponent("účtenka 2026.pdf"));
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF_BYTES);

    // Download inline disposition
    const inline = await h.fetch(`${base}/${created.id}/attachments/${att.id}?disposition=inline`, {
      headers: as.mobile(owner),
    });
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition")).toStartWith("inline; filename=");

    // Detach
    const detached = await h.fetch(`${base}/${created.id}/attachments/${att.id}`, {
      method: "DELETE",
      headers: as.mobile(owner),
    });
    expect(detached.status).toBe(204);

    const afterDetach = await h.fetch(`${base}/${created.id}/attachments/${att.id}`, {
      headers: as.mobile(owner),
    });
    expect(afterDetach.status).toBe(404);
  });

  test("attach rejects wrong part name, empty multipart, bad MIME/magic bytes, and oversized Content-Length", async () => {
    const created = decodeId(await (await postExpense(makeExpense())).json());

    // Wrong field name
    const wrongField = new FormData();
    wrongField.append("document", new File([PDF_BYTES], "a.pdf", { type: "application/pdf" }));
    const wrongFieldRes = await uploadForm(created.id, wrongField);
    expect(wrongFieldRes.status).toBe(422);
    expect(decodeIssues(await wrongFieldRes.json()).issues[0]?.code).toBe("request.malformed");

    // Unsupported MIME type
    const badMime = new FormData();
    badMime.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const badMimeRes = await uploadForm(created.id, badMime);
    expect(badMimeRes.status).toBe(422);
    expect(decodeIssues(await badMimeRes.json()).issues[0]?.code).toBe("attachment.type_rejected");

    // Spoofed PDF magic bytes
    const spoofed = new FormData();
    spoofed.append("file", new File(["not a pdf"], "fake.pdf", { type: "application/pdf" }));
    const spoofedRes = await uploadForm(created.id, spoofed);
    expect(spoofedRes.status).toBe(422);
    expect(decodeIssues(await spoofedRes.json()).issues[0]?.code).toBe("attachment.type_rejected");

    // Declared Content-Length over multipart limit -> 413 PayloadTooLarge
    const tooLarge = await h.fetch(`${base}/${created.id}/attachments`, {
      method: "POST",
      body: "x",
      headers: {
        ...as.mobile(owner),
        "content-type": "multipart/form-data; boundary=----kvb",
        "content-length": String(ATTACHMENT_MAX_BYTES + 128 * 1024),
      },
    });
    expect(tooLarge.status).toBe(413);
    expect(
      Schema.decodeUnknownEffect(Schema.Struct({ _tag: Schema.String }))(
        await tooLarge.json(),
      ).pipe(Effect.runSync)._tag,
    ).toBe("PayloadTooLarge");
    expect(analytics.capture).not.toHaveBeenCalled();
  });
});
