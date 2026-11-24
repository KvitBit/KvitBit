/**
 * Cross-module access and request-safety scenarios on TestCore (all modules on real layers).
 * (h) workspace isolation and API-key scopes; (i) stale revision and requestKey replay.
 */
import { describe, expect, test } from "bun:test";
import type {
  Caller,
  ContactId,
  DocumentId,
  ExpenseId,
  IsoDate,
  MemberCaller,
  RequestKey,
  TemplateId,
  UserId,
} from "@kvitbit/domain/contract";
import {
  Contacts,
  Documents,
  Expenses,
  Payments,
  Reports,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Effect, Exit } from "effect";
import { makeRequestOutcome } from "../../src/shared/requestOutcome";
import { account, asCaller, runCore } from "../helpers";
import { dec } from "../modules/documents/fixtures";
import { templateInput } from "../modules/recurring/fixtures";

const USER_B = "01900000-0000-7000-8000-00000000c002" as UserId;
const NOV = { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate };

const idOf = (view: unknown): string => (view as { readonly id: string }).id;
const contactIdOf = (view: unknown) => idOf(view) as ContactId;
const ids = (views: ReadonlyArray<unknown>) => views.map(idOf);

/** The failure's tag and conflict reason, or "ok" when `effect` succeeds. */
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, {
    onFailure: (e) => ({ _tag: e._tag, reason: (e as { readonly reason?: string }).reason }),
    onSuccess: () => ({ _tag: "ok", reason: undefined }),
  });

/** Opens a workspace as a fresh Account and returns its owner. */
const openWorkspace = (name: string, userId?: UserId) =>
  asCaller(
    account(userId === undefined ? {} : { userId, email: `${name}@example.cz` }),
    Effect.flatMap(Workspaces, (ws) => ws.create({ name } as never)),
  );

const contactInput = (name: string) => ({ name, billingEmails: ["fakturace@acme.cz"] }) as never;

const invoiceInput = (contact: ContactId) =>
  ({
    kind: "invoice",
    contact,
    lines: [{ description: "Konzultace", quantity: dec("2"), unitPrice: dec("1000") }],
    issuedOn: "2026-11-23",
  }) as never;

const expenseInput = (contact: ContactId) =>
  ({
    supplier: { contact },
    supplierDocumentNumber: "FV-2026-001",
    issuedOn: "2026-11-20",
    taxableSupplyOn: "2026-11-19",
    dueOn: "2026-12-04",
    currency: "CZK",
    total: "121.00",
    vat: [{ treatment: "standard", base: "100.00", vat: "21.00" }],
    category: "software",
  }) as never;

/** Workspace B with one row in every module: contact, issued invoice + payment, expense, template. */
const seedWorkspaceB = (ownerB: Caller) =>
  asCaller(
    ownerB,
    Effect.gen(function* () {
      const contact = yield* Effect.flatMap(Contacts, (c) => c.save(contactInput("Beta s.r.o.")));
      const doc = yield* Effect.flatMap(Documents, (d) =>
        d.issue({ input: invoiceInput(contactIdOf(contact)) }),
      );
      yield* Effect.flatMap(Payments, (p) => p.record({ target: { document: doc.id } }));
      const expense = yield* Effect.flatMap(Expenses, (e) =>
        e.record(expenseInput(contactIdOf(contact))),
      );
      const template = yield* Effect.flatMap(Templates, (t) =>
        t.save(templateInput({ contact: contactIdOf(contact) })),
      );
      return {
        contact: contactIdOf(contact),
        document: doc.id,
        expense: idOf(expense) as ExpenseId,
        template: idOf(template) as TemplateId,
      };
    }),
  );

/** What a caller of workspace A sees of every module's lists. */
const listEverything = Effect.gen(function* () {
  return {
    contacts: ids((yield* Effect.flatMap(Contacts, (c) => c.search({}))).items),
    documents: ids((yield* Effect.flatMap(Documents, (d) => d.list({}))).items),
    expenses: ids((yield* Effect.flatMap(Expenses, (e) => e.list({}))).items),
    templates: ids(yield* Effect.flatMap(Templates, (t) => t.list)),
  };
});

const revenue = Effect.flatMap(Reports, (r) => r.run({ report: "revenue", period: NOV }));

describe("(h) workspace isolation", () => {
  test("a member of A gets NotFound for B's records in every module and lists never include B's rows", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const ownerA = yield* openWorkspace("Alfa s.r.o.");
        const ownerB = yield* openWorkspace("Beta s.r.o.", USER_B);
        const reportBefore = yield* asCaller(ownerA, revenue);
        const b = yield* seedWorkspaceB(ownerB);
        // A has its own row in each list, so "excludes B" is not just "empty".
        const ownA = yield* asCaller(
          ownerA,
          Effect.gen(function* () {
            const contact = yield* Effect.flatMap(Contacts, (c) => c.save(contactInput("Alfa")));
            const draft = yield* Effect.flatMap(Documents, (d) =>
              d.createDraft(invoiceInput(contactIdOf(contact))),
            );
            return { contact: contactIdOf(contact), document: draft.id };
          }),
        );
        return yield* asCaller(
          ownerA,
          Effect.gen(function* () {
            const contacts = yield* Contacts;
            const docs = yield* Documents;
            const payments = yield* Payments;
            const expenses = yield* Expenses;
            const templates = yield* Templates;
            return {
              reads: {
                contact: yield* outcome(contacts.get(b.contact)),
                document: yield* outcome(docs.get(b.document)),
                documentHistory: yield* outcome(docs.history(b.document)),
                payments: yield* outcome(payments.listFor({ document: b.document })),
                expense: yield* outcome(expenses.get(b.expense)),
                template: yield* outcome(templates.get(b.template)),
              },
              writes: {
                contactSave: yield* outcome(
                  contacts.save({
                    ...(contactInput("Hijack") as object),
                    id: b.contact,
                    expectedRevision: 1,
                  } as never),
                ),
                paymentRecord: yield* outcome(
                  payments.record({ target: { document: b.document } }),
                ),
              },
              lists: yield* listEverything,
              reportUnchanged: JSON.stringify(yield* revenue) === JSON.stringify(reportBefore),
              ownA,
            };
          }),
        );
      }),
    );
    const notFound = { _tag: "NotFound", reason: undefined };
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const { reads, writes, lists, reportUnchanged, ownA } = exit.value;
    expect(reads).toEqual({
      contact: notFound,
      document: notFound,
      documentHistory: notFound,
      payments: notFound,
      expense: notFound,
      template: notFound,
    });
    expect(writes).toEqual({ contactSave: notFound, paymentRecord: notFound });
    expect(lists).toEqual({
      contacts: [ownA.contact],
      documents: [ownA.document],
      expenses: [],
      templates: [],
    });
    expect(reportUnchanged).toBe(true);
  });

  test("an API key with only documents:read reads documents, and every write is Forbidden", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* openWorkspace("Alfa s.r.o.");
        const seeded = yield* asCaller(
          owner,
          Effect.gen(function* () {
            const contact = yield* Effect.flatMap(Contacts, (c) => c.save(contactInput("Acme")));
            const doc = yield* Effect.flatMap(Documents, (d) =>
              d.issue({ input: invoiceInput(contactIdOf(contact)) }),
            );
            return { contact, doc };
          }),
        );
        const apiKey: MemberCaller = {
          ...owner,
          scopes: ["documents:read"],
          channel: "api",
          client: { kind: "api_key", id: "key-1", name: "Read-only key" },
        };
        const result = yield* asCaller(
          apiKey,
          Effect.gen(function* () {
            const docs = yield* Documents;
            const got = yield* docs.get(seeded.doc.id);
            const listed = ids((yield* docs.list({})).items);
            return {
              read: { get: got.id, list: listed },
              writes: {
                createDraft: yield* outcome(
                  docs.createDraft(invoiceInput(contactIdOf(seeded.contact))),
                ),
                issue: yield* outcome(
                  docs.issue({ input: invoiceInput(contactIdOf(seeded.contact)) }),
                ),
                lock: yield* outcome(docs.lock(seeded.doc.id)),
                contactSave: yield* outcome(
                  Effect.flatMap(Contacts, (c) => c.save(contactInput("Nope"))),
                ),
                paymentRecord: yield* outcome(
                  Effect.flatMap(Payments, (p) =>
                    p.record({ target: { document: seeded.doc.id } }),
                  ),
                ),
                expenseRecord: yield* outcome(
                  Effect.flatMap(Expenses, (e) =>
                    e.record(expenseInput(contactIdOf(seeded.contact))),
                  ),
                ),
              },
              // Read scopes are per area: documents:read does not open contacts.
              contactGet: yield* outcome(
                Effect.flatMap(Contacts, (c) => c.get(contactIdOf(seeded.contact))),
              ),
            };
          }),
        );
        // No write landed: the owner still sees one document, unpaid, and one contact.
        const after = yield* asCaller(
          owner,
          Effect.gen(function* () {
            return {
              documents: ids((yield* Effect.flatMap(Documents, (d) => d.list({}))).items),
              payments: (yield* Effect.flatMap(Payments, (p) =>
                p.listFor({ document: seeded.doc.id }),
              )).length,
              contacts: ids((yield* Effect.flatMap(Contacts, (c) => c.search({}))).items),
              expenses: (yield* Effect.flatMap(Expenses, (e) => e.list({}))).items.length,
            };
          }),
        );
        return {
          result,
          after,
          seeded: { doc: seeded.doc.id, contact: contactIdOf(seeded.contact) },
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const { result, after, seeded } = exit.value;
    expect(result.read).toEqual({ get: seeded.doc, list: [seeded.doc] });
    for (const [name, o] of Object.entries(result.writes)) {
      expect({ name, tag: o._tag }).toEqual({ name, tag: "Forbidden" });
    }
    expect(result.contactGet._tag).toBe("Forbidden");
    expect(after).toEqual({
      documents: [seeded.doc],
      payments: 0,
      contacts: [seeded.contact],
      expenses: 0,
    });
  });
});

/** Runs `effect` with its own RequestOutcome and returns the result with the replay flag. */
const withOutcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const requestOutcome = yield* makeRequestOutcome;
    const value = yield* Effect.provideService(effect, RequestOutcome, requestOutcome);
    return { value, replayed: yield* requestOutcome.replayed };
  });

describe("(i) stale revision and requestKey on Documents.issue from a draft", () => {
  test("stale expectedRevision is revision_changed with no state change; same requestKey replays; another payload is idempotency_mismatch", async () => {
    const key = "issue-draft-1" as RequestKey;
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* openWorkspace("Alfa s.r.o.");
        return yield* asCaller(
          owner,
          Effect.gen(function* () {
            const docs = yield* Documents;
            const contact = yield* Effect.flatMap(Contacts, (c) => c.save(contactInput("Acme")));
            const draft = yield* docs.createDraft(invoiceInput(contactIdOf(contact)));
            const edited = yield* docs.edit(draft.id, { note: "Edited" } as never, draft.revision);
            const staleRevision = draft.revision;

            const stale = yield* outcome(
              docs.issue({ draft: draft.id, expectedRevision: staleRevision }, { requestKey: key }),
            );
            const afterStale = yield* docs.get(draft.id);

            const payload = { draft: draft.id, expectedRevision: edited.revision };
            const first = yield* withOutcome(docs.issue(payload, { requestKey: key }));
            const replay = yield* withOutcome(docs.issue(payload, { requestKey: key }));

            const other = yield* docs.createDraft(invoiceInput(contactIdOf(contact)));
            const mismatch = yield* outcome(
              docs.issue(
                { draft: other.id, expectedRevision: other.revision },
                { requestKey: key },
              ),
            );
            const otherAfter = yield* docs.get(other.id);

            const issueAudits = (yield* docs.history(draft.id)).filter(
              (e) => (e as { readonly action: string }).action === "document.issue",
            ).length;
            const issuedCount = (yield* docs.list({ status: "issued" } as never)).items.length;
            return {
              stale,
              afterStale: {
                status: afterStale.status,
                number: afterStale.number,
                revision: afterStale.revision,
              },
              editedRevision: edited.revision,
              first: {
                id: first.value.id,
                number: first.value.number,
                revision: first.value.revision,
                status: first.value.status,
                replayed: first.replayed,
              },
              replay: {
                id: replay.value.id,
                number: replay.value.number,
                revision: replay.value.revision,
                replayed: replay.replayed,
              },
              mismatch,
              otherAfter: { status: otherAfter.status, number: otherAfter.number },
              issueAudits,
              issuedCount,
              draftId: draft.id as DocumentId,
            };
          }),
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const r = exit.value;
    expect(r.stale).toEqual({ _tag: "Conflict", reason: "revision_changed" });
    expect(r.afterStale).toEqual({ status: "draft", number: null, revision: r.editedRevision });
    expect(r.first.status).toBe("issued");
    expect(r.first.id).toBe(r.draftId);
    expect(r.first.number).not.toBeNull();
    expect(r.first.replayed).toBe(false);
    expect(r.replay).toEqual({
      id: r.first.id,
      number: r.first.number,
      revision: r.first.revision,
      replayed: true,
    });
    expect(r.mismatch).toEqual({ _tag: "Conflict", reason: "idempotency_mismatch" });
    expect(r.otherAfter).toEqual({ status: "draft", number: null });
    expect(r.issueAudits).toBe(1);
    expect(r.issuedCount).toBe(1);
  });
});
