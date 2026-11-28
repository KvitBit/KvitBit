import { TestCaller } from "../helpers/callerContext";
/**
 * Cross-module access and request-safety scenarios on TestCore (all modules on real layers).
 * (h) workspace isolation and API-key scopes; (i) stale revision and requestKey replay.
 */

import { describe, expect, test } from "bun:test";
import type { Caller, ContactView, DocumentInput, MemberCaller } from "@kvitbit/domain/contract";
import {
  ContactId,
  Contacts,
  DocumentId,
  Documents,
  ExpenseId,
  Expenses,
  IsoDate,
  Payments,
  PublicShareLinks,
  Reports,
  RequestKey,
  TemplateId,
  Templates,
  UserId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { makeRequestOutcome } from "../../src/shared/requestOutcome";
import { account, asCaller, runCore } from "../helpers";
import { dec } from "../modules/documents/fixtures";
import { templateInput } from "../modules/recurring/fixtures";

const USER_B = UserId.make("01900000-0000-7000-8000-00000000c002");
const NOV = { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") };

const decodeId = Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String }));
const idOf = <A>(view: A): string => Result.getOrThrow(decodeId(view)).id;
const contactIdOf = (view: ContactView) => ContactId.make(idOf(view));
const ids = <A>(views: ReadonlyArray<A>) => EffectArray.map(views, idOf);

/** The failure's tag and conflict reason, or "ok" when `effect` succeeds. */
const outcome = <A, E extends { readonly _tag: string; readonly reason?: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.match(effect, {
    onFailure: (e) => ({ _tag: e._tag, reason: e.reason }),
    onSuccess: () => ({ _tag: "ok", reason: undefined }),
  });

/** Opens a workspace as a fresh Account and returns its owner. */
const openWorkspace = (name: string, userId?: UserId) =>
  asCaller(
    account(userId === undefined ? {} : { userId, email: `${name}@example.cz` }),
    Effect.flatMap(Workspaces, (ws) =>
      ws.create(account(userId === undefined ? {} : { userId, email: `${name}@example.cz` }), {
        name,
      }),
    ),
  );

const contactInput = (name: string) => ({ name, billingEmails: ["fakturace@acme.cz"] });

const invoiceInput = (contact: ContactId): DocumentInput => ({
  kind: "invoice",
  contact,
  lines: [{ description: "Konzultace", quantity: dec("2"), unitPrice: dec("1000") }],
  issuedOn: IsoDate.make("2026-11-23"),
});

const expenseInput = (contact: ContactId) => ({
  supplier: { contact },
  supplierDocumentNumber: "FV-2026-001",
  issuedOn: "2026-11-20",
  taxableSupplyOn: "2026-11-19",
  dueOn: "2026-12-04",
  currency: "CZK",
  total: "121.00",
  vat: [{ treatment: "standard", base: "100.00", vat: "21.00" }],
  category: "software",
});

/** Workspace B with one row in every module: contact, issued invoice + payment, expense, template. */
const seedWorkspaceB = (ownerB: Caller) =>
  asCaller(
    ownerB,
    Effect.gen(function* () {
      const contact = yield* Effect.flatMap(Contacts, (c) =>
        c.save(ownerB, contactInput("Beta s.r.o.")),
      );
      const doc = yield* Effect.flatMap(Documents, (d) =>
        d.issue(ownerB, { input: invoiceInput(contactIdOf(contact)) }),
      );
      yield* Effect.flatMap(Payments, (p) => p.record(ownerB, { target: { document: doc.id } }));
      const expense = yield* Effect.flatMap(Expenses, (e) =>
        e.record(ownerB, expenseInput(contactIdOf(contact))),
      );
      const template = yield* Effect.flatMap(Templates, (t) =>
        t.save(ownerB, templateInput({ contact: contactIdOf(contact) })),
      );
      return {
        contact: contactIdOf(contact),
        document: doc.id,
        expense: ExpenseId.make(idOf(expense)),
        template: TemplateId.make(idOf(template)),
      };
    }),
  );

/** What a caller of workspace A sees of every module's lists. */
const listEverything = Effect.gen(function* () {
  const contacts = yield* Effect.flatMap(Contacts, (c) =>
    Effect.flatMap(TestCaller, (caller) => c.search(caller, {})),
  );
  const documents = yield* Effect.flatMap(Documents, (d) =>
    Effect.flatMap(TestCaller, (caller) => d.list(caller, {})),
  );
  const expenses = yield* Effect.flatMap(Expenses, (e) =>
    Effect.flatMap(TestCaller, (caller) => e.list(caller, {})),
  );
  const templates = yield* Effect.flatMap(Templates, (t) =>
    Effect.flatMap(TestCaller, (caller) => t.list(caller)),
  );
  return {
    contacts: ids(contacts.items),
    documents: ids(documents.items),
    expenses: ids(expenses.items),
    templates: ids(templates),
  };
});

const revenue = Effect.flatMap(Reports, (r) =>
  Effect.flatMap(TestCaller, (caller) => r.run(caller, { report: "revenue", period: NOV })),
);

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
            const contact = yield* Effect.flatMap(Contacts, (c) =>
              c.save(ownerA, contactInput("Alfa")),
            );
            const draft = yield* Effect.flatMap(Documents, (d) =>
              d.createDraft(ownerA, invoiceInput(contactIdOf(contact))),
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
            const reads = {
              contact: yield* outcome(contacts.get(ownerA, b.contact)),
              document: yield* outcome(docs.get(ownerA, b.document)),
              documentHistory: yield* outcome(docs.history(ownerA, b.document)),
              payments: yield* outcome(payments.listFor(ownerA, { document: b.document })),
              expense: yield* outcome(expenses.get(ownerA, b.expense)),
              template: yield* outcome(templates.get(ownerA, b.template)),
            };
            const writes = {
              contactSave: yield* outcome(
                contacts.save(ownerA, {
                  ...contactInput("Hijack"),
                  id: b.contact,
                  expectedRevision: 1,
                }),
              ),
              paymentRecord: yield* outcome(
                payments.record(ownerA, { target: { document: b.document } }),
              ),
            };
            const lists = yield* listEverything;
            const reportAfter = yield* revenue;
            return {
              reads,
              writes,
              lists,
              reportUnchanged: Formatter.format(reportAfter) === Formatter.format(reportBefore),
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

  test("an API key with only documents:read reads documents without the share link, and every write is Forbidden", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* openWorkspace("Alfa s.r.o.");
        const seeded = yield* asCaller(
          owner,
          Effect.gen(function* () {
            const contact = yield* Effect.flatMap(Contacts, (c) =>
              c.save(owner, contactInput("Acme")),
            );
            const doc = yield* Effect.flatMap(Documents, (d) =>
              d.issue(owner, { input: invoiceInput(contactIdOf(contact)) }),
            );
            // An active bearer share link: only share.read may see its URL (get_share_link).
            const { url } = yield* Effect.flatMap(PublicShareLinks, (s) => s.create(owner, doc.id));
            return { contact, doc, url };
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
            const got = yield* docs.get(apiKey, seeded.doc.id);
            const listed = ids((yield* docs.list(apiKey, {})).items);
            return {
              read: { get: got.id, list: listed },
              share: got.share,
              writes: {
                createDraft: yield* outcome(
                  docs.createDraft(apiKey, invoiceInput(contactIdOf(seeded.contact))),
                ),
                issue: yield* outcome(
                  docs.issue(apiKey, { input: invoiceInput(contactIdOf(seeded.contact)) }),
                ),
                lock: yield* outcome(docs.lock(apiKey, seeded.doc.id)),
                contactSave: yield* outcome(
                  Effect.flatMap(Contacts, (c) => c.save(apiKey, contactInput("Nope"))),
                ),
                paymentRecord: yield* outcome(
                  Effect.flatMap(Payments, (p) =>
                    p.record(apiKey, { target: { document: seeded.doc.id } }),
                  ),
                ),
                expenseRecord: yield* outcome(
                  Effect.flatMap(Expenses, (e) =>
                    e.record(apiKey, expenseInput(contactIdOf(seeded.contact))),
                  ),
                ),
              },
              // Read scopes are per area: documents:read does not open contacts.
              contactGet: yield* outcome(
                Effect.flatMap(Contacts, (c) => c.get(apiKey, contactIdOf(seeded.contact))),
              ),
            };
          }),
        );
        // share.read sees the URL: a key holding share:read, and the owner's session.
        const shareKey: MemberCaller = { ...apiKey, scopes: ["documents:read", "share:read"] };
        const shareRead = {
          key: (yield* asCaller(
            shareKey,
            Effect.flatMap(Documents, (d) => d.get(shareKey, seeded.doc.id)),
          )).share?.url,
          owner: (yield* asCaller(
            owner,
            Effect.flatMap(Documents, (d) => d.get(owner, seeded.doc.id)),
          )).share?.url,
        };
        // No write landed: the owner still sees one document, unpaid, and one contact.
        const after = yield* asCaller(
          owner,
          Effect.gen(function* () {
            return {
              documents: ids((yield* Effect.flatMap(Documents, (d) => d.list(owner, {}))).items),
              payments: (yield* Effect.flatMap(Payments, (p) =>
                p.listFor(owner, { document: seeded.doc.id }),
              )).length,
              contacts: ids((yield* Effect.flatMap(Contacts, (c) => c.search(owner, {}))).items),
              expenses: (yield* Effect.flatMap(Expenses, (e) => e.list(owner, {}))).items.length,
            };
          }),
        );
        return {
          result,
          after,
          shareRead,
          seeded: { doc: seeded.doc.id, contact: contactIdOf(seeded.contact), url: seeded.url },
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const { result, after, shareRead, seeded } = exit.value;
    expect(result.read).toEqual({ get: seeded.doc, list: [seeded.doc] });
    expect(result.share).toBeNull();
    expect(shareRead).toEqual({ key: seeded.url, owner: seeded.url });
    for (const [name, o] of EffectRecord.toEntries(result.writes)) {
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
    const key = RequestKey.make("issue-draft-1");
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* openWorkspace("Alfa s.r.o.");
        return yield* asCaller(
          owner,
          Effect.gen(function* () {
            const docs = yield* Documents;
            const contact = yield* Effect.flatMap(Contacts, (c) =>
              c.save(owner, contactInput("Acme")),
            );
            const draft = yield* docs.createDraft(owner, invoiceInput(contactIdOf(contact)));
            const edited = yield* docs.edit(owner, draft.id, { note: "Edited" }, draft.revision);
            const staleRevision = draft.revision;

            const stale = yield* outcome(
              docs.issue(
                owner,
                { draft: draft.id, expectedRevision: staleRevision },
                { requestKey: key },
              ),
            );
            const afterStale = yield* docs.get(owner, draft.id);

            const payload = { draft: draft.id, expectedRevision: edited.revision };
            const first = yield* withOutcome(docs.issue(owner, payload, { requestKey: key }));
            const replay = yield* withOutcome(docs.issue(owner, payload, { requestKey: key }));

            const other = yield* docs.createDraft(owner, invoiceInput(contactIdOf(contact)));
            const mismatch = yield* outcome(
              docs.issue(
                owner,
                { draft: other.id, expectedRevision: other.revision },
                { requestKey: key },
              ),
            );
            const otherAfter = yield* docs.get(owner, other.id);

            const history = yield* docs.history(owner, draft.id);
            const issueAudits = EffectArray.filter(
              history,
              (entry) => entry.action === "document.issue",
            ).length;
            const issuedCount = (yield* docs.list(owner, { status: "issued" })).items.length;
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
              draftId: DocumentId.make(draft.id),
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
