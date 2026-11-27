import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DocumentFixtures } from "@kvitbit/core/testing";
import {
  ContactId,
  Contacts,
  CurrencyCode,
  CurrentCaller,
  DocumentId,
  IsoDate,
  type MemberCaller,
  Payments,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";

const decodeRevisionedId = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String, revision: Schema.Finite })),
  Effect.runSync,
);
const decodeLock = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Struct({ locked: Schema.Boolean, revision: Schema.Finite })),
  Effect.runSync,
);
const decodeDocumentKind = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.String, kind: Schema.String, revision: Schema.Finite }),
  ),
  Effect.runSync,
);
const decodeId = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String })),
  Effect.runSync,
);
const decodeIssuedDocument = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      number: Schema.NullOr(Schema.String),
      revision: Schema.Finite,
    }),
  ),
  Effect.runSync,
);

let h: Harness;
let owner: TestUser;
let member: MemberCaller;
let contactId: ContactId;
let base: string;

const invoiceInput = (overrides: { kind?: "proforma"; note?: string } = {}) => ({
  kind: "invoice",
  contact: contactId,
  lines: [
    {
      description: "Konzultace",
      quantity: "2",
      unit: "hod",
      unitPrice: "1500",
    },
  ],
  ...overrides,
});

const req = (
  path: string,
  init: RequestInit & { readonly headers?: Record<string, string> } = {},
) =>
  h.fetch(path, {
    ...init,
    headers: { ...as.mobile(owner), ...(init.headers ?? {}) },
  });

const postJson = (path: string, body: Schema.Json, headers: Record<string, string> = {}) => {
  const init = json(body);
  return req(path, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
};

const patchJson = (path: string, body: Schema.Json, headers: Record<string, string> = {}) => {
  const init = json(body);
  return req(path, {
    ...init,
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
  });
};

beforeEach(async () => {
  h = makeHarness();
  await h.run(TestClock.setTime(TEST_NOW));
  owner = h.addUser("Olga");
  member = await h.createWorkspace(owner);
  base = `/api/v1/workspaces/${member.workspaceId}/documents`;
  const contact = await h.run(
    Effect.flatMap(Contacts, (c) =>
      c.save({
        name: "Odběratel a.s.",
        ico: "25596641",
        address: { city: "Brno", country: "CZ" },
        roles: ["customer"],
        billingEmails: ["fakturace@odberatel.cz"],
      }),
    ).pipe(Effect.provideService(CurrentCaller, member)),
  );
  contactId = Schema.decodeUnknownEffect(ContactId)(contact.id).pipe(Effect.runSync);
});

afterEach(async () => {
  await h.dispose();
});

describe("documents group", () => {
  test("preview computes a DocumentView without persisting it", async () => {
    const res = await postJson(`${base}/preview`, invoiceInput());
    expect(res.status).toBe(200);
    const view = Schema.decodeUnknownEffect(
      Schema.Struct({ status: Schema.String, number: Schema.NullOr(Schema.String) }),
    )(await res.json()).pipe(Effect.runSync);
    expect(view.status).toBe("draft");
    expect(view.number).toBeNull();

    const list = await req(base);
    expect(list.status).toBe(200);
    expect(
      Schema.decodeUnknownEffect(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))(
        await list.json(),
      ).pipe(Effect.runSync).items,
    ).toHaveLength(0);
  });

  test("createDraft answers 201 with Location and ETag; Idempotency-Key replays and rejects mismatches", async () => {
    const first = await postJson(base, invoiceInput(), { "idempotency-key": "draft-key-0001" });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const firstBody = await first.json();
    const view = Schema.decodeUnknownEffect(
      Schema.Struct({ id: Schema.String, revision: Schema.Finite, status: Schema.String }),
    )(firstBody).pipe(Effect.runSync);
    expect(view.status).toBe("draft");
    expect(first.headers.get("etag")).toBe(`"${view.revision}"`);
    expect(first.headers.get("location")).toBe(`${base}/${view.id}`);

    const replay = await postJson(base, invoiceInput(), { "idempotency-key": "draft-key-0001" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("location")).toBe(`${base}/${view.id}`);
    expect(await replay.json()).toEqual(firstBody);

    const mismatch = await postJson(base, invoiceInput({ note: "Jiná poznámka" }), {
      "idempotency-key": "draft-key-0001",
    });
    expect(mismatch.status).toBe(409);

    const got = await req(`${base}/${view.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe(`"${view.revision}"`);
  });

  test("edit requires If-Match: 428 missing, 422 weak tag, 412 stale with ETag, 200 current", async () => {
    const created = decodeRevisionedId(await (await postJson(base, invoiceInput())).json());

    const missing = await patchJson(`${base}/${created.id}`, { note: "Upraveno" });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({ _tag: "PreconditionRequired" });

    const weak = await patchJson(
      `${base}/${created.id}`,
      { note: "Upraveno" },
      { "if-match": `W/"${created.revision}"` },
    );
    expect(weak.status).toBe(422);

    const stale = await patchJson(
      `${base}/${created.id}`,
      { note: "Upraveno" },
      { "if-match": `"${created.revision + 9}"` },
    );
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe(`"${created.revision}"`);
    expect(await stale.json()).toEqual({
      _tag: "PreconditionFailed",
      currentRevision: created.revision,
    });

    const ok = await patchJson(
      `${base}/${created.id}`,
      { note: "Upraveno" },
      { "if-match": `"${created.revision}"` },
    );
    expect(ok.status).toBe(200);
    const updated = Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Finite }))(
      await ok.json(),
    ).pipe(Effect.runSync);
    expect(updated.revision).toBe(created.revision + 1);
    expect(ok.headers.get("etag")).toBe(`"${updated.revision}"`);
  });

  test("discardDraft enforces If-Match and hard-deletes drafts", async () => {
    const created = decodeRevisionedId(await (await postJson(base, invoiceInput())).json());

    const missing = await req(`${base}/${created.id}`, { method: "DELETE" });
    expect(missing.status).toBe(428);

    const stale = await req(`${base}/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": `"${created.revision + 1}"` },
    });
    expect(stale.status).toBe(412);

    const ok = await req(`${base}/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": `"${created.revision}"` },
    });
    expect(ok.status).toBe(204);

    const after = await req(`${base}/${created.id}`);
    expect(after.status).toBe(404);
  });

  test("issueDraft enforces If-Match and supports Idempotency-Key replay", async () => {
    const created = decodeRevisionedId(await (await postJson(base, invoiceInput())).json());

    const missing = await postJson(`${base}/${created.id}/issue`, {});
    expect(missing.status).toBe(428);

    const stale = await postJson(
      `${base}/${created.id}/issue`,
      {},
      { "if-match": `"${created.revision + 3}"` },
    );
    expect(stale.status).toBe(412);

    const issued = await postJson(
      `${base}/${created.id}/issue`,
      {},
      { "if-match": `"${created.revision}"`, "idempotency-key": "issue-draft-0001" },
    );
    expect(issued.status).toBe(200);
    const issuedBody = await issued.json();
    const view = decodeIssuedDocument(issuedBody);
    expect(view.status).toBe("issued");
    expect(view.number).not.toBeNull();
    expect(issued.headers.get("etag")).toBe(`"${view.revision}"`);

    const replay = await postJson(
      `${base}/${created.id}/issue`,
      {},
      { "if-match": `"${created.revision}"`, "idempotency-key": "issue-draft-0001" },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(issuedBody);

    // Issued document cannot be discarded
    const discardIssued = await req(`${base}/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": `"${view.revision}"` },
    });
    expect(discardIssued.status).toBe(409);
  });

  test("issueFromInput answers 201 with Location, ETag, Idempotency-Key replay, and optional send", async () => {
    const payload = { input: invoiceInput(), send: { language: "en" } };
    const res = await postJson(`${base}/issue`, payload, {
      "idempotency-key": "issue-direct-0001",
    });
    expect(res.status).toBe(201);
    const issueBody = await res.json();
    const view = decodeIssuedDocument(issueBody);
    expect(view.status).toBe("issued");
    expect(view.number).not.toBeNull();
    expect(res.headers.get("location")).toBe(`${base}/${view.id}`);
    expect(res.headers.get("etag")).toBe(`"${view.revision}"`);

    const replay = await postJson(`${base}/issue`, payload, {
      "idempotency-key": "issue-direct-0001",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(issueBody);
  });

  test("lock, unlock, cancel, correct, send, pdf, list, and history work end-to-end", async () => {
    const issued = decodeId(
      await (await postJson(`${base}/issue`, { input: invoiceInput() })).json(),
    );

    // Lock
    const lockedRes = await req(`${base}/${issued.id}/lock`, { method: "POST" });
    expect(lockedRes.status).toBe(200);
    const locked = decodeLock(await lockedRes.json());
    expect(locked.locked).toBe(true);
    expect(lockedRes.headers.get("etag")).toBe(`"${locked.revision}"`);

    // Edit while locked -> 409 Conflict{document_locked}
    const editLocked = await patchJson(
      `${base}/${issued.id}`,
      { note: "Nelze" },
      { "if-match": `"${locked.revision}"` },
    );
    expect(editLocked.status).toBe(409);

    // Unlock
    const unlockedRes = await postJson(`${base}/${issued.id}/unlock`, {
      reason: "Oprava poznámky",
    });
    expect(unlockedRes.status).toBe(200);
    const unlocked = decodeLock(await unlockedRes.json());
    expect(unlocked.locked).toBe(false);
    expect(unlockedRes.headers.get("etag")).toBe(`"${unlocked.revision}"`);

    // Send -> 202 DeliveryQueued + Idempotency-Key replay
    const sendRes = await postJson(
      `${base}/${issued.id}/deliveries`,
      { purpose: "document" },
      { "idempotency-key": "send-key-0001" },
    );
    expect(sendRes.status).toBe(202);
    const queuedBody = await sendRes.json();
    const queued = Schema.decodeUnknownEffect(
      Schema.Struct({ deliveryId: Schema.String, status: Schema.String }),
    )(queuedBody).pipe(Effect.runSync);
    expect(queued.status).toBe("queued");

    const sendReplay = await postJson(
      `${base}/${issued.id}/deliveries`,
      { purpose: "document" },
      { "idempotency-key": "send-key-0001" },
    );
    expect(sendReplay.status).toBe(202);
    expect(sendReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(await sendReplay.json()).toEqual(queuedBody);

    // PDF download: attachment default + inline override + template/language forwarded
    const pdfDefault = await req(`${base}/${issued.id}/pdf`);
    expect(pdfDefault.status).toBe(200);
    expect(pdfDefault.headers.get("content-type")).toBe("application/pdf");
    expect(pdfDefault.headers.get("content-disposition")).toStartWith("attachment; filename=");
    expect(pdfDefault.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdfDefault.headers.get("cache-control")).toBe("private, no-store");
    expect((await pdfDefault.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const pdfInline = await req(
      `${base}/${issued.id}/pdf?template=modern_minimal&language=en&disposition=inline`,
    );
    expect(pdfInline.status).toBe(200);
    expect(pdfInline.headers.get("content-disposition")).toStartWith("inline; filename=");

    const renders = await h.run(Effect.flatMap(DocumentFixtures, (f) => Ref.get(f.renders)));
    expect(renders.at(-1)?.options).toEqual({ template: "modern_minimal", language: "en" });

    // Correct -> 201 Credit Note with Location + ETag + Idempotency-Key replay
    const cnRes = await postJson(
      `${base}/${issued.id}/credit-notes`,
      { reason: "Reklamace", lines: "full" },
      { "idempotency-key": "correct-key-0001" },
    );
    expect(cnRes.status).toBe(201);
    const creditNoteBody = await cnRes.json();
    const creditNote = decodeDocumentKind(creditNoteBody);
    expect(creditNote.kind).toBe("credit_note");
    expect(cnRes.headers.get("location")).toBe(`${base}/${creditNote.id}`);
    expect(cnRes.headers.get("etag")).toBe(`"${creditNote.revision}"`);

    const cnReplay = await postJson(
      `${base}/${issued.id}/credit-notes`,
      { reason: "Reklamace", lines: "full" },
      { "idempotency-key": "correct-key-0001" },
    );
    expect(cnReplay.status).toBe(201);
    expect(cnReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(await cnReplay.json()).toEqual(creditNoteBody);

    // List with filters + paging
    const listRes = await req(`${base}?kind=credit_note&limit=10`);
    expect(listRes.status).toBe(200);
    const page = Schema.decodeUnknownEffect(
      Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    )(await listRes.json()).pipe(Effect.runSync);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(creditNote.id);

    const badQuery = await req(`${base}?limit=0`);
    expect(badQuery.status).toBe(422);

    // History
    const historyRes = await req(`${base}/${issued.id}/history`);
    expect(historyRes.status).toBe(200);
    const entries = Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ action: Schema.String })),
    )(await historyRes.json()).pipe(Effect.runSync);
    expect(Arr.some(entries, (e) => e.action === "document.lock")).toBe(true);
    expect(Arr.some(entries, (e) => e.action === "document.unlock")).toBe(true);

    // Cancel a fresh issued invoice -> 200 CancelResult + Idempotency-Key replay
    const second = decodeId(
      await (await postJson(`${base}/issue`, { input: invoiceInput() })).json(),
    );
    const cancelRes = await postJson(
      `${base}/${second.id}/cancel`,
      { reason: "Omyl" },
      { "idempotency-key": "cancel-key-0001" },
    );
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json();
    const cancelled = Schema.decodeUnknownEffect(
      Schema.Struct({ document: Schema.Struct({ status: Schema.String }) }),
    )(cancelBody).pipe(Effect.runSync);
    expect(cancelled.document.status).toBe("cancelled");

    const cancelReplay = await postJson(
      `${base}/${second.id}/cancel`,
      { reason: "Omyl" },
      { "idempotency-key": "cancel-key-0001" },
    );
    expect(cancelReplay.status).toBe(200);
    expect(cancelReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(await cancelReplay.json()).toEqual(cancelBody);
  });

  test("issueFinalInvoice creates a 201 Final Invoice for a paid proforma with Location and replay", async () => {
    const proformaRes = await postJson(`${base}/issue`, {
      input: invoiceInput({ kind: "proforma" }),
    });
    expect(proformaRes.status).toBe(201);
    const proforma = decodeId(await proformaRes.json());

    // Record payment against the proforma directly via core
    await h.run(
      Effect.flatMap(Payments, (p) =>
        p.record({
          target: { document: DocumentId.make(proforma.id) },
          amount: {
            amount: BigDecimal.fromStringUnsafe("3000"),
            currency: CurrencyCode.make("CZK"),
          },
          paidOn: IsoDate.make("2026-11-23"),
        }),
      ).pipe(Effect.provideService(CurrentCaller, member)),
    );

    const fiRes = await postJson(
      `${base}/${proforma.id}/final-invoice`,
      { patch: { note: "Vyúčtování zálohy" } },
      { "idempotency-key": "fi-key-0001" },
    );
    expect(fiRes.status).toBe(201);
    const finalInvoiceBody = await fiRes.json();
    const fi = decodeDocumentKind(finalInvoiceBody);
    expect(fi.kind).toBe("invoice");
    expect(fiRes.headers.get("location")).toBe(`${base}/${fi.id}`);
    expect(fiRes.headers.get("etag")).toBe(`"${fi.revision}"`);

    const fiReplay = await postJson(
      `${base}/${proforma.id}/final-invoice`,
      { patch: { note: "Vyúčtování zálohy" } },
      { "idempotency-key": "fi-key-0001" },
    );
    expect(fiReplay.status).toBe(201);
    expect(fiReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(await fiReplay.json()).toEqual(finalInvoiceBody);
  });

  test("enforces workspace isolation and API key scopes", async () => {
    const stranger = h.addUser("Petr");
    const foreign = await h.fetch(base, { headers: as.mobile(stranger) });
    expect(foreign.status).toBe(404);

    const readOnly = as.apiKey(owner, member.workspaceId, ["documents:read"]);
    expect((await h.fetch(base, { headers: readOnly })).status).toBe(200);
    const unrelatedScope = as.apiKey(owner, member.workspaceId, ["contacts:read"]);
    expect((await h.fetch(base, { headers: unrelatedScope })).status).toBe(403);

    const readOnlyRes = await h.fetch(base, {
      ...json(invoiceInput()),
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...readOnly,
      },
    });
    expect(readOnlyRes.status).toBe(403);
  });
});
