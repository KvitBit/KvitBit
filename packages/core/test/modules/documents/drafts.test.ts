import { describe, expect, test } from "bun:test";
import type { DocumentView } from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  IsoDate,
  NotFound,
  RequestKey,
  StatutoryCode,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DocumentFixtures,
  DocumentSummaryData,
  DocumentsRepo,
  fakePdfBytes,
} from "../../../src/modules/documents";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, WORKSPACE_B } from "../../helpers";
import { TestCaller } from "../../helpers/callerContext";
import {
  as,
  B_BUYER,
  CZ_BUYER,
  CZ_NO_DIC,
  CZK,
  CZK_ACCOUNT,
  concreteView,
  contact,
  DE_BUYER,
  dec,
  EUR,
  EUR_ACCOUNT,
  encodedView,
  fixing,
  ITEM,
  invoiceInput,
  present,
  scenario,
  str,
} from "./fixtures";

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const lines = (view: DocumentView) => concreteView(view).lines;
const buyer = (view: DocumentView) => concreteView(view).contact;
const codes = (view: DocumentView) => EffectArray.map(view.statutoryNotes, (n) => n.code);

describe("createDraft", () => {
  test("stores an unnumbered draft with VatMath totals and audits its creation", async () => {
    const [view, got, history] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const documentView = yield* docs.createDraft(testCaller, invoiceInput());
          return [
            documentView,
            yield* docs.get(testCaller, documentView.id),
            yield* docs.history(testCaller, documentView.id),
          ] as const;
        }),
      ),
    );
    expect(view.status).toBe("draft");
    expect(view.number).toBeNull();
    expect(view.revision).toBe(1);
    expect(view.locked).toBe(false);
    expect(view.settlement).toBe("unpaid");
    expect(view.taxDocument).toBe(true);
    expect(view.dates).toEqual({
      issuedOn: IsoDate.make("2026-11-23"),
      taxableSupplyOn: IsoDate.make("2026-11-23"),
      dueOn: IsoDate.make("2026-12-07"),
    });
    expect(EffectArray.map(lines(view), (l) => [l.treatment, str(l.ratePercent)])).toEqual([
      ["standard", "21"],
      ["reduced", "12"],
    ]);
    view.totals.net.amount.pipe(str, expect).toBe("2500");
    view.totals.vat.amount.pipe(str, expect).toBe("480");
    view.totals.gross.amount.pipe(str, expect).toBe("2980");
    expect(view.totals.vatCzk).toBeNull();
    expect(view.fx).toBeNull();
    expect(buyer(view).name).toBe("Odběratel a.s.");
    expect(got).toEqual(view);
    expect(EffectArray.map(history, (e) => [e.action, e.revision])).toEqual([
      ["document.create", 1],
    ]);
  });

  test("defaults resolve Document → Contact → Workspace", async () => {
    const view = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const f = yield* DocumentFixtures;
          yield* f.putContact(
            member("owner").workspaceId,
            contact(CZ_BUYER, {
              defaults: { language: "en", dueDays: 30, defaultNote: "Contact" },
            }),
          );
          const docs = yield* Documents;
          const a = yield* docs.createDraft(testCaller, invoiceInput());
          const b = yield* docs.createDraft(
            testCaller,
            invoiceInput({ due: { inDays: 7 }, note: "Document" }),
          );
          return [a, b] as const;
        }),
        { billingA: { defaultNote: "Workspace", paymentMethod: "card" } },
      ),
    );
    const [fromContact, fromDocument] = view;
    expect(fromContact.dates.dueOn).toBe(IsoDate.make("2026-12-23"));
    expect(fromContact.paymentMethod).toBe("card");
    expect(fromDocument.dates.dueOn).toBe(IsoDate.make("2026-11-30"));
    const repoRows = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const f = yield* DocumentFixtures;
          yield* f.putContact(
            member("owner").workspaceId,
            contact(CZ_BUYER, { defaults: { language: "en", defaultNote: "Contact" } }),
          );
          const created = yield* (yield* Documents).createDraft(
            testCaller,
            invoiceInput({ note: "Document" }),
          );
          const plain = yield* (yield* Documents).createDraft(
            testCaller,
            invoiceInput({ contact: CZ_NO_DIC }),
          );
          const repo = yield* DocumentsRepo;
          return [
            yield* repo.get(member("owner").workspaceId, created.id),
            yield* repo.get(member("owner").workspaceId, plain.id),
          ] as const;
        }),
        { billingA: { defaultNote: "Workspace" } },
      ),
    );
    expect([repoRows[0].language, repoRows[0].note]).toEqual(["en", "Document"]);
    expect([repoRows[1].language, repoRows[1].note]).toEqual(["cs", "Workspace"]);
  });

  test("a due date before the issue date is Invalid", async () => {
    const exit = await Documents.pipe(
      Effect.flatMap((d) =>
        Effect.flatMap(TestCaller, (caller) =>
          d.createDraft(caller, invoiceInput({ due: { on: IsoDate.make("2026-11-01") } })),
        ),
      ),
      Effect.flip,
      present,
      scenario,
    );
    const failure = ok(exit);
    expect(failure).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["due"], code: "document.due_before_issue" }],
    });
  });

  test("Price List Items fill description, unit, price and (vat_payer) treatment", async () => {
    const view = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          yield* (yield* DocumentFixtures).putItem(member("owner").workspaceId, {
            id: ITEM,
            name: "Hodina",
            description: "Hodina práce",
            unit: "h",
            unitPrice: dec("850"),
            currency: CZK,
            vat: "reduced",
            archived: false,
            revision: 1,
          });
          return yield* (yield* Documents).createDraft(
            testCaller,
            invoiceInput({ lines: [{ item: ITEM, quantity: dec("3") }] }),
          );
        }),
      ),
    );
    const [line] = lines(view);
    expect([line?.description, line?.unit, str(line?.unitPrice ?? dec("0"))]).toEqual([
      "Hodina práce",
      "h",
      "850",
    ]);
    expect(line?.treatment).toBe("reduced");
    view.totals.gross.amount.pipe(str, expect).toBe("2856");
  });

  test("a requestKey replays the first result; another payload is Conflict", async () => {
    const key = RequestKey.make("req-1");
    const [first, second, mismatch, all] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const firstResult = yield* docs.createDraft(testCaller, invoiceInput(), {
            requestKey: key,
          });
          const secondResult = yield* docs.createDraft(testCaller, invoiceInput(), {
            requestKey: key,
          });
          const mismatchResult = yield* Effect.flip(
            docs.createDraft(testCaller, invoiceInput({ note: "other" }), { requestKey: key }),
          );
          return [
            firstResult,
            secondResult,
            mismatchResult,
            yield* docs.list(testCaller, {}),
          ] as const;
        }),
      ),
    );
    expect(await encodedView(second)).toEqual(await encodedView(first));
    expect(all.items).toHaveLength(1);
    expect(mismatch).toEqual(Conflict.make({ reason: "idempotency_mismatch" }));
  });
});

describe("nesting", () => {
  test("createDraft inside a caller's transaction rolls back with it (no request key)", async () => {
    const [failed, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const store = yield* CoreStore;
          const failedResult = yield* Effect.flip(
            store.transaction(
              Effect.andThen(
                docs.createDraft(testCaller, invoiceInput()),
                Effect.fail("abort" as const),
              ),
            ),
          );
          return [failedResult, (yield* docs.list(testCaller, {})).items.length] as const;
        }),
      ),
    );
    expect(failed).toBe("abort");
    expect(listed).toBe(0);
  });
});

describe("authorization and tenancy", () => {
  test("accountants and read-only tokens cannot draft; they can read", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const docs = yield* Documents;
        const view = yield* docs.createDraft(testCaller, invoiceInput());
        const accountant = member("accountant");
        const reader = member("member", { scopes: ["documents:read"] });
        return [
          yield* Effect.flip(as(accountant, docs.createDraft(accountant, invoiceInput()))),
          yield* Effect.flip(as(reader, docs.createDraft(reader, invoiceInput()))),
          yield* Effect.flip(as(accountant, docs.edit(accountant, view.id, { note: "x" }, 1))),
          yield* Effect.flip(as(accountant, docs.discardDraft(accountant, view.id, 1))),
          yield* Effect.flip(as(accountant, docs.preview(accountant, invoiceInput()))),
          (yield* as(accountant, docs.get(accountant, view.id))).id === view.id,
          (yield* as(reader, docs.list(reader, {}))).items.length,
          (yield* as(reader, docs.history(reader, view.id))).length,
        ] as const;
      }),
    );
    const [draft, token, edit, discard, preview, read, listed, history] = ok(exit);
    expect(draft).toEqual(Forbidden.make({ action: "document.draft" }));
    expect(token).toEqual(Forbidden.make({ action: "document.draft" }));
    expect(edit).toEqual(Forbidden.make({ action: "document.edit" }));
    expect(discard).toEqual(Forbidden.make({ action: "document.draft" }));
    expect(preview).toEqual(Forbidden.make({ action: "document.draft" }));
    expect([read, listed, history]).toEqual([true, 1, 1]);
  });

  test("another Workspace's documents and Contacts are NotFound", async () => {
    const otherMember = member("owner", { workspaceId: WORKSPACE_B });
    const [contactMiss, getMiss, editMiss, discardMiss, pdfMiss, historyMiss, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const view = yield* docs.createDraft(testCaller, invoiceInput());
          return [
            yield* Effect.flip(docs.createDraft(testCaller, invoiceInput({ contact: B_BUYER }))),
            yield* Effect.flip(as(otherMember, docs.get(otherMember, view.id))),
            yield* Effect.flip(as(otherMember, docs.edit(otherMember, view.id, { note: "x" }, 1))),
            yield* Effect.flip(as(otherMember, docs.discardDraft(otherMember, view.id, 1))),
            yield* Effect.flip(as(otherMember, docs.pdf(otherMember, view.id))),
            yield* Effect.flip(as(otherMember, docs.history(otherMember, view.id))),
            (yield* as(otherMember, docs.list(otherMember, {}))).items.length,
          ] as const;
        }),
      ),
    );
    expect(contactMiss).toEqual(NotFound.make({ entity: "Contact", id: B_BUYER }));
    for (const miss of [getMiss, editMiss, discardMiss, pdfMiss, historyMiss]) {
      expect(miss).toMatchObject({ _tag: "NotFound", entity: "Document" });
    }
    expect(listed).toBe(0);
  });

  test("preview reports an unknown Contact as NotFound and stores nothing", async () => {
    const [miss, view, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          return [
            yield* Effect.flip(docs.preview(testCaller, invoiceInput({ contact: B_BUYER }))),
            yield* docs.preview(testCaller, invoiceInput()),
            (yield* docs.list(testCaller, {})).items.length,
          ] as const;
        }),
      ),
    );
    expect(miss).toEqual(NotFound.make({ entity: "Contact", id: B_BUYER }));
    expect(view.number).toBeNull();
    view.totals.gross.amount.pipe(str, expect).toBe("2980");
    expect(listed).toBe(0);
  });
});

describe("VAT regimes (rule D9)", () => {
  test("vat_payer + EU business Contact with VAT ID defaults to reverse charge", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) =>
          Effect.flatMap(TestCaller, (caller) =>
            d.createDraft(
              caller,
              invoiceInput({
                contact: DE_BUYER,
                lines: [{ description: "Vývoj", unitPrice: dec("1000") }],
              }),
            ),
          ),
        ),
      ),
    );
    expect(lines(view)[0]?.treatment).toBe("reverse_charge");
    view.totals.vat.amount.pipe(str, expect).toBe("0");
    view.totals.gross.amount.pipe(str, expect).toBe("1000");
    expect(view.taxDocument).toBe(true);
    expect(codes(view)).toContain(StatutoryCode.make("reverse_charge"));
  });

  test("reverse charge without the buyer's VAT ID is Invalid", async () => {
    const err = ok(
      await Documents.pipe(
        Effect.flatMap((d) =>
          Effect.flatMap(TestCaller, (caller) =>
            d.createDraft(
              caller,
              invoiceInput({
                contact: CZ_NO_DIC,
                lines: [{ description: "Stavba", unitPrice: dec("1"), vat: "reverse_charge" }],
              }),
            ),
          ),
        ),
        Effect.flip,
        present,
        scenario,
      ),
    );
    expect(err).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["lines", 0, "vat"], code: "document.buyer_vat_id_required" }],
    });
  });

  test("a non-payer accepts only outside_scope and is not a tax document", async () => {
    const [view, err] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const documentView = yield* docs.createDraft(
            testCaller,
            invoiceInput({ lines: [{ description: "Služba", unitPrice: dec("1000") }] }),
          );
          const failure = yield* Effect.flip(docs.createDraft(testCaller, invoiceInput()));
          return [documentView, failure] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(lines(view)[0]?.treatment).toBe("outside_scope");
    view.totals.gross.amount.pipe(str, expect).toBe("1000");
    expect(view.taxDocument).toBe(false);
    expect(codes(view)).toContain(StatutoryCode.make("not_vat_payer"));
    expect(err).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["lines", 1, "vat"], code: "vat.not_allowed_for_regime" }],
    });
  });

  test("an identified person: domestic supplies outside scope only, EU services reverse charge", async () => {
    const [domestic, eu, rejected] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const one = [{ description: "Služba", unitPrice: dec("100") }] as const;
          return [
            yield* docs.createDraft(testCaller, invoiceInput({ lines: one })),
            yield* docs.createDraft(
              testCaller,
              invoiceInput({
                contact: DE_BUYER,
                lines: [{ description: "Služba", unitPrice: dec("100"), vat: "reverse_charge" }],
              }),
            ),
            yield* Effect.flip(
              docs.createDraft(
                testCaller,
                invoiceInput({
                  lines: [{ description: "Služba", unitPrice: dec("100"), vat: "reverse_charge" }],
                }),
              ),
            ),
          ] as const;
        }),
        { regimeA: "identified_person" },
      ),
    );
    expect([lines(domestic)[0]?.treatment, domestic.taxDocument]).toEqual(["outside_scope", false]);
    expect(codes(domestic)).toContain(StatutoryCode.make("identified_person"));
    expect([lines(eu)[0]?.treatment, eu.taxDocument]).toEqual(["reverse_charge", true]);
    expect(rejected).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
  });

  test("a Proforma is never a tax document; its tax point defaults to issuedOn", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) =>
          Effect.flatMap(TestCaller, (caller) =>
            d.createDraft(caller, invoiceInput({ kind: "proforma" })),
          ),
        ),
      ),
    );
    expect(view.taxDocument).toBe(false);
    expect(view.dates.taxableSupplyOn).toBe(view.dates.issuedOn);
    expect(codes(view)).toContain(StatutoryCode.make("proforma_not_tax_document"));
  });
});

describe("FX (rule D11)", () => {
  const fixings = [fixing("2026-11-20", "25.125"), fixing("2026-11-23", "26")];
  const eurInput = invoiceInput({
    currency: EUR,
    taxableSupplyOn: IsoDate.make("2026-11-22"),
    lines: [{ description: "Služba", unitPrice: dec("100") }],
  });

  test("takes the CNB fixing carried back to the tax point and shows CZK VAT per bucket", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) =>
          Effect.flatMap(TestCaller, (caller) => d.createDraft(caller, eurInput)),
        ),
        { fixings },
      ),
    );
    expect(view.fx).toEqual({
      rate: dec("25.125"),
      quantity: 1,
      fixingDate: IsoDate.make("2026-11-20"),
      source: "cnb",
    });
    view.totals.vat.amount.pipe(str, expect).toBe("21");
    expect(EffectArray.map(view.totals.buckets, (b) => str(b.vatCzk ?? dec("-1")))).toEqual([
      "527.63",
    ]);
    (view.totals.vatCzk?.amount ?? dec("-1")).pipe(str, expect).toBe("527.63");
    expect(present(concreteView(view).issuer.bankAccount).id).toBe(EUR_ACCOUNT);
  });

  test("a manual rate overrides the fixing; fx: null returns to it", async () => {
    const [manual, back] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const manualResult = yield* docs.createDraft(testCaller, {
            ...eurInput,
            fx: { manual: { rate: dec("24.5"), quantity: 1 } },
          });
          const backResult = yield* docs.edit(
            testCaller,
            manualResult.id,
            { fx: null },
            manualResult.revision,
          );
          return [manualResult, backResult] as const;
        }),
        { fixings },
      ),
    );
    expect(manual.fx).toEqual({
      rate: dec("24.5"),
      quantity: 1,
      fixingDate: null,
      source: "manual",
    });
    (manual.totals.vatCzk?.amount ?? dec("-1")).pipe(str, expect).toBe("514.5");
    expect(back.fx?.source).toBe("cnb");
    expect(back.revision).toBe(2);
  });

  test("a manual rate on a CZK document or a bad rate is Invalid; a missing fixing Unavailable", async () => {
    const [czk, bad, missing] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          return [
            yield* Effect.flip(
              docs.createDraft(
                testCaller,
                invoiceInput({ fx: { manual: { rate: dec("1"), quantity: 1 } } }),
              ),
            ),
            yield* Effect.flip(
              docs.createDraft(testCaller, {
                ...eurInput,
                fx: { manual: { rate: dec("0"), quantity: 1 } },
              }),
            ),
            yield* Effect.flip(
              docs.createDraft(testCaller, {
                ...eurInput,
                taxableSupplyOn: IsoDate.make("2026-11-01"),
              }),
            ),
          ] as const;
        }),
        { fixings },
      ),
    );
    expect(czk).toMatchObject({ issues: [{ code: "fx.manual_not_allowed_for_czk" }] });
    expect(bad).toMatchObject({ issues: [{ code: "fx.manual_rate_invalid" }] });
    expect(missing).toEqual(Unavailable.make({ dependency: "exchange_rates" }));
  });
});

describe("edit and discard of drafts", () => {
  test("edit recomputes, bumps the revision and checks expectedRevision", async () => {
    const [edited, stale, czkAccount] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const view = yield* docs.createDraft(testCaller, invoiceInput());
          const editedResult = yield* docs.edit(
            testCaller,
            view.id,
            { lines: [{ description: "Jiné", unitPrice: dec("100") }], contact: DE_BUYER },
            1,
          );
          const staleResult = yield* Effect.flip(
            docs.edit(testCaller, view.id, { note: "late" }, 1),
          );
          return [
            editedResult,
            staleResult,
            present(concreteView(editedResult).issuer.bankAccount).id,
          ] as const;
        }),
      ),
    );
    expect(edited.revision).toBe(2);
    expect(lines(edited)[0]?.treatment).toBe("reverse_charge");
    expect(buyer(edited).contactId).toBe(DE_BUYER);
    edited.totals.gross.amount.pipe(str, expect).toBe("100");
    expect(stale).toEqual(Conflict.make({ reason: "revision_changed", currentRevision: 2 }));
    expect(czkAccount).toBe(CZK_ACCOUNT);
  });

  test("a number on a draft is an illegal transition", async () => {
    const err = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const view = yield* docs.createDraft(testCaller, invoiceInput());
          return yield* Effect.flip(docs.edit(testCaller, view.id, { number: "2026-0001" }, 1));
        }),
      ),
    );
    expect(err).toEqual(Conflict.make({ reason: "illegal_transition" }));
  });

  test("discardDraft deletes a draft, audits it, and refuses issued documents", async () => {
    const [gone, stale, issuedDiscard, cancelledEdit, history] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const ws = member("owner").workspaceId;
          const a = yield* docs.createDraft(testCaller, invoiceInput());
          const staleResult2 = yield* Effect.flip(docs.discardDraft(testCaller, a.id, 7));
          yield* docs.discardDraft(testCaller, a.id, 1);
          const removedDocument = yield* Effect.flip(docs.get(testCaller, a.id));
          const b = yield* docs.createDraft(testCaller, invoiceInput());
          const row = yield* repo.get(ws, b.id);
          const issued = yield* store.transaction(
            repo.update({ ...row, status: "issued", number: "2026-0001" }, 1),
          );
          const issuedDiscardResult = yield* Effect.flip(
            docs.discardDraft(testCaller, b.id, issued.revision),
          );
          const c = yield* docs.createDraft(testCaller, invoiceInput());
          const cRow = yield* repo.get(ws, c.id);
          yield* store.transaction(repo.update({ ...cRow, status: "cancelled", locked: true }, 1));
          const cancelledEditResult = yield* Effect.flip(
            docs.edit(testCaller, c.id, { note: "x" }, 2),
          );
          const historyResult = yield* store.audit.history(ws, { entity: "Document", id: a.id });
          return [
            removedDocument,
            staleResult2,
            issuedDiscardResult,
            cancelledEditResult,
            historyResult,
          ] as const;
        }),
      ),
    );
    expect(gone).toMatchObject({ _tag: "NotFound", entity: "Document" });
    expect(stale).toEqual(Conflict.make({ reason: "revision_changed", currentRevision: 1 }));
    expect(issuedDiscard).toEqual(Conflict.make({ reason: "illegal_transition" }));
    expect(cancelledEdit).toEqual(Conflict.make({ reason: "illegal_transition" }));
    expect(EffectArray.map(history, (e) => e.action)).toEqual([
      "document.create",
      "document.discard",
    ]);
  });
});

describe("list and pdf", () => {
  test("filters by kind and contact, pages by cursor bound to the filter", async () => {
    const [invoices, page1, page2, mismatch, byText] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          yield* docs.createDraft(
            testCaller,
            invoiceInput({ issuedOn: IsoDate.make("2026-11-01") }),
          );
          yield* docs.createDraft(
            testCaller,
            invoiceInput({ issuedOn: IsoDate.make("2026-11-02"), kind: "proforma" }),
          );
          yield* docs.createDraft(
            testCaller,
            invoiceInput({
              issuedOn: IsoDate.make("2026-11-03"),
              contact: DE_BUYER,
              lines: [{ description: "x", unitPrice: dec("1") }],
            }),
          );
          const invoicesResult = yield* docs.list(testCaller, { kind: "invoice" });
          const firstPage = yield* docs.list(testCaller, { kind: "invoice", limit: 1 });
          const secondPage = yield* docs.list(testCaller, {
            kind: "invoice",
            limit: 1,
            cursor: firstPage.nextCursor ?? "",
          });
          const mismatchResult = yield* Effect.flip(
            docs.list(testCaller, {
              kind: "proforma",
              limit: 1,
              cursor: firstPage.nextCursor ?? "",
            }),
          );
          const byTextResult = yield* docs.list(testCaller, {
            text: "ODBĚRATEL",
            contact: CZ_BUYER,
          });
          return [invoicesResult, firstPage, secondPage, mismatchResult, byTextResult] as const;
        }),
      ),
    );
    const issuedOn = (p: typeof invoices): ReadonlyArray<string> =>
      EffectArray.map(p.items, (item) => {
        Schema.asserts(DocumentSummaryData, item);
        return item.issuedOn;
      });
    expect(issuedOn(invoices)).toEqual(["2026-11-03", "2026-11-01"]);
    expect(issuedOn(page1)).toEqual(["2026-11-03"]);
    expect(page1.nextCursor).not.toBeNull();
    expect(issuedOn(page2)).toEqual(["2026-11-01"]);
    expect(page2.nextCursor).toBeNull();
    expect(mismatch).toMatchObject({ _tag: "Invalid", issues: [{ code: "page.cursor_mismatch" }] });
    expect(issuedOn(byText)).toEqual(["2026-11-02", "2026-11-01"]);
  });

  test("pdf renders the current view through DocumentRenderer", async () => {
    const [view, download, bytes, renders] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const documentView = yield* docs.createDraft(testCaller, invoiceInput());
          const downloadResult = yield* docs.pdf(testCaller, documentView.id, {
            template: "modern_minimal",
          });
          const chunks = yield* Stream.runCollect(downloadResult.bytes);
          const rendersResult = yield* Ref.get((yield* DocumentFixtures).renders);
          return [documentView, downloadResult, Array.from(chunks), rendersResult] as const;
        }),
      ),
    );
    expect(download.filename).toBe(`draft-${view.id}.pdf`);
    expect(download.contentType).toBe("application/pdf");
    expect(bytes).toEqual([fakePdfBytes(view, { template: "modern_minimal", language: "cs" })]);
    expect(EffectArray.map(renders, (r) => [r.view.id, r.options])).toEqual([
      [view.id, { template: "modern_minimal", language: "cs" }],
    ]);
  });
});
