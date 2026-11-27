import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ContactId,
  Contacts,
  CurrentCaller,
  type DocumentId,
  Documents,
  IsoDate,
  type MemberCaller,
} from "@kvitbit/domain/contract";
import { BigDecimal, Effect } from "effect";
import { as, type Harness, json, makeHarness, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;
let member: MemberCaller;
let wsBase: string;
let documentId: DocumentId;
let expenseId: string;

beforeEach(async () => {
  h = makeHarness();
  owner = h.addUser("Olga");
  member = await h.createWorkspace(owner);
  wsBase = `/api/v1/workspaces/${member.workspaceId}`;

  const seeded = await h.run(
    Effect.gen(function* () {
      const contacts = yield* Contacts;
      const documents = yield* Documents;
      const contact = yield* contacts.save({
        name: "Odběratel a.s.",
        ico: "25596641",
        address: { city: "Brno", country: "CZ" },
        roles: ["customer", "supplier"],
      });
      const contactId = contact.id as ContactId;
      const doc = yield* documents.issue({
        input: {
          kind: "invoice",
          contact: contactId,
          issuedOn: IsoDate.make("2026-11-20"),
          due: { inDays: 14 },
          lines: [
            {
              description: "Služba",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("1000.00"),
            },
          ],
        },
      });
      return { contactId, documentId: doc.id };
    }).pipe(Effect.provideService(CurrentCaller, member)),
  );
  documentId = seeded.documentId;

  const expInit = json({
    supplier: { contact: seeded.contactId },
    supplierDocumentNumber: "N-2026-01",
    issuedOn: "2026-11-20",
    taxableSupplyOn: "2026-11-20",
    dueOn: "2026-12-04",
    currency: "CZK",
    total: "500.00",
    vat: [{ treatment: "outside_scope", base: "500.00", vat: "0.00" }],
  });
  const expRes = await h.fetch(`${wsBase}/expenses`, {
    ...expInit,
    method: "POST",
    headers: { ...(expInit.headers as Record<string, string>), ...as.mobile(owner) },
  });
  expect(expRes.status).toBe(201);
  expenseId = ((await expRes.json()) as { id: string }).id;
});

afterEach(async () => {
  await h.dispose();
});

const postPayment = (body: unknown, headers: Record<string, string> = {}) => {
  const init = json(body);
  return h.fetch(`${wsBase}/payments`, {
    ...init,
    method: "POST",
    headers: { ...(init.headers as Record<string, string>), ...as.mobile(owner), ...headers },
  });
};

describe("payments group", () => {
  test("record for document returns 201 + Location, replays Idempotency-Key, and lists via listForDocument", async () => {
    const first = await postPayment(
      {
        target: { document: documentId },
        amount: { amount: "400.00", currency: "CZK" },
        paidOn: "2026-11-21",
        method: "bank_transfer",
        note: "Záloha",
      },
      { "idempotency-key": "pay-doc-0001" },
    );
    expect(first.status).toBe(201);
    const body = (await first.json()) as {
      payment: { id: string };
      settlement: string;
      issued: unknown[];
    };
    expect(body.settlement).toBe("partially_paid");
    expect(first.headers.get("location")).toBe(`${wsBase}/payments/${body.payment.id}`);

    const replay = await postPayment(
      {
        target: { document: documentId },
        amount: { amount: "400.00", currency: "CZK" },
        paidOn: "2026-11-21",
        method: "bank_transfer",
        note: "Záloha",
      },
      { "idempotency-key": "pay-doc-0001" },
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(body);

    const listed = await h.fetch(`${wsBase}/documents/${documentId}/payments`, {
      headers: as.mobile(owner),
    });
    expect(listed.status).toBe(200);
    const items = (await listed.json()) as Array<{ id: string }>;
    expect(items.map((p) => p.id)).toEqual([body.payment.id]);
  });

  test("record for expense, listForExpense, and remove returns 204", async () => {
    const res = await postPayment({
      target: { expense: expenseId },
      paidOn: "2026-11-22",
      method: "card",
    });
    expect(res.status).toBe(201);
    const recorded = (await res.json()) as { payment: { id: string }; settlement: string };
    expect(recorded.settlement).toBe("paid");

    const listed = await h.fetch(`${wsBase}/expenses/${expenseId}/payments`, {
      headers: as.mobile(owner),
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Array<{ id: string }>).map((p) => p.id)).toEqual([
      recorded.payment.id,
    ]);

    const removeInit = json({ reason: "Zadáno omylem" });
    const removed = await h.fetch(`${wsBase}/payments/${recorded.payment.id}/remove`, {
      ...removeInit,
      method: "POST",
      headers: { ...(removeInit.headers as Record<string, string>), ...as.mobile(owner) },
    });
    expect(removed.status).toBe(204);

    const afterRemove = await h.fetch(`${wsBase}/expenses/${expenseId}/payments`, {
      headers: as.mobile(owner),
    });
    expect(afterRemove.status).toBe(200);
    expect(await afterRemove.json()).toEqual([]);
  });

  test("remove rejects empty reason with 422 and unknown payment with 404", async () => {
    const emptyInit = json({ reason: "" });
    const emptyRes = await h.fetch(
      `${wsBase}/payments/01900000-0000-7000-8000-000000000099/remove`,
      {
        ...emptyInit,
        method: "POST",
        headers: { ...(emptyInit.headers as Record<string, string>), ...as.mobile(owner) },
      },
    );
    expect(emptyRes.status).toBe(422);

    const validInit = json({ reason: "Storno" });
    const missing = await h.fetch(
      `${wsBase}/payments/01900000-0000-7000-8000-000000000099/remove`,
      {
        ...validInit,
        method: "POST",
        headers: { ...(validInit.headers as Record<string, string>), ...as.mobile(owner) },
      },
    );
    expect(missing.status).toBe(404);
  });
});
