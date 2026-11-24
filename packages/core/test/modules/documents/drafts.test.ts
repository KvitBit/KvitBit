import { describe, expect, test } from "bun:test";
import type { DocumentId, DocumentView, IsoDate, RequestKey } from "@kvitbit/domain/contract";
import { Conflict, Documents, Forbidden, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Exit, Ref, Schema, Stream } from "effect";
import type { ContactSnapshotRecord, LineViewData } from "../../../src/modules/documents";
import {
  DocumentFixtures,
  DocumentsRepo,
  DocumentViewData,
  fakePdfBytes,
} from "../../../src/modules/documents";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, WORKSPACE_B } from "../../helpers";
import {
  as,
  B_BUYER,
  CZ_BUYER,
  CZ_NO_DIC,
  CZK_ACCOUNT,
  contact,
  DE_BUYER,
  dec,
  EUR,
  EUR_ACCOUNT,
  fixing,
  ITEM,
  invoiceInput,
  scenario,
  str,
} from "./fixtures";

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const lines = (view: DocumentView) => view.lines as unknown as ReadonlyArray<LineViewData>;
const buyer = (view: DocumentView) => view.contact as unknown as ContactSnapshotRecord;
const codes = (view: DocumentView) => view.statutoryNotes.map((n) => n.code as unknown as string);

describe("createDraft", () => {
  test("stores an unnumbered draft with VatMath totals and audits its creation", async () => {
    const [view, got, history] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput());
          return [view, yield* docs.get(view.id), yield* docs.history(view.id)] as const;
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
      issuedOn: "2026-11-23" as IsoDate,
      taxableSupplyOn: "2026-11-23" as IsoDate,
      dueOn: "2026-12-07" as IsoDate,
    });
    expect(lines(view).map((l) => [l.treatment, str(l.ratePercent)])).toEqual([
      ["standard", "21"],
      ["reduced", "12"],
    ]);
    expect(str(view.totals.net.amount)).toBe("2500");
    expect(str(view.totals.vat.amount)).toBe("480");
    expect(str(view.totals.gross.amount)).toBe("2980");
    expect(view.totals.vatCzk).toBeNull();
    expect(view.fx).toBeNull();
    expect(buyer(view).name).toBe("Odběratel a.s.");
    expect(got).toEqual(view);
    expect(history.map((e) => [e.action, e.revision])).toEqual([["document.create", 1]]);
  });

  test("defaults resolve Document → Contact → Workspace", async () => {
    const view = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* DocumentFixtures;
          yield* f.putContact(
            member("owner").workspaceId,
            contact(CZ_BUYER, {
              defaults: { language: "en", dueDays: 30, defaultNote: "Contact" },
            }),
          );
          const docs = yield* Documents;
          const a = yield* docs.createDraft(invoiceInput());
          const b = yield* docs.createDraft(invoiceInput({ due: { inDays: 7 }, note: "Document" }));
          return [a, b] as const;
        }),
        { billingA: { defaultNote: "Workspace", paymentMethod: "card" } },
      ),
    );
    const [fromContact, fromDocument] = view;
    expect(fromContact.dates.dueOn).toBe("2026-12-23" as IsoDate);
    expect(fromContact.paymentMethod).toBe("card");
    expect(fromDocument.dates.dueOn).toBe("2026-11-30" as IsoDate);
    const repoRows = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* DocumentFixtures;
          yield* f.putContact(
            member("owner").workspaceId,
            contact(CZ_BUYER, { defaults: { language: "en", defaultNote: "Contact" } }),
          );
          const created = yield* (yield* Documents).createDraft(invoiceInput({ note: "Document" }));
          const plain = yield* (yield* Documents).createDraft(invoiceInput({ contact: CZ_NO_DIC }));
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
    const exit = await scenario(
      Effect.flip(
        Effect.flatMap(Documents, (d) =>
          d.createDraft(invoiceInput({ due: { on: "2026-11-01" as IsoDate } })),
        ),
      ),
    );
    expect(ok(exit)).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["due"], code: "document.due_before_issue" }],
    });
  });

  test("Price List Items fill description, unit, price and (vat_payer) treatment", async () => {
    const view = ok(
      await scenario(
        Effect.gen(function* () {
          yield* (yield* DocumentFixtures).putItem(member("owner").workspaceId, {
            id: ITEM,
            name: "Hodina",
            description: "Hodina práce",
            unit: "h",
            unitPrice: dec("850"),
            currency: "CZK" as never,
            vat: "reduced",
            archived: false,
            revision: 1,
          });
          return yield* (yield* Documents).createDraft(
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
    expect(str(view.totals.gross.amount)).toBe("2856");
  });

  test("a requestKey replays the first result; another payload is Conflict", async () => {
    const key = "req-1" as RequestKey;
    const [first, second, mismatch, all] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const first = yield* docs.createDraft(invoiceInput(), { requestKey: key });
          const second = yield* docs.createDraft(invoiceInput(), { requestKey: key });
          const mismatch = yield* Effect.flip(
            docs.createDraft(invoiceInput({ note: "other" }), { requestKey: key }),
          );
          return [first, second, mismatch, yield* docs.list({})] as const;
        }),
      ),
    );
    const json = Schema.encodeSync(Schema.toCodecJson(DocumentViewData));
    expect(json(second as never)).toEqual(json(first as never));
    expect(all.items).toHaveLength(1);
    expect(mismatch as unknown).toEqual(new Conflict({ reason: "idempotency_mismatch" }));
  });
});

describe("nesting", () => {
  test("createDraft inside a caller's transaction rolls back with it (no request key)", async () => {
    const [failed, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const store = yield* CoreStore;
          const failed = yield* Effect.flip(
            store.transaction(
              Effect.andThen(docs.createDraft(invoiceInput()), Effect.fail("abort" as const)),
            ),
          );
          return [failed, (yield* docs.list({})).items.length] as const;
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
        const docs = yield* Documents;
        const view = yield* docs.createDraft(invoiceInput());
        const accountant = member("accountant");
        const reader = member("member", { scopes: ["documents:read"] });
        return [
          yield* Effect.flip(as(accountant, docs.createDraft(invoiceInput()))),
          yield* Effect.flip(as(reader, docs.createDraft(invoiceInput()))),
          yield* Effect.flip(as(accountant, docs.edit(view.id, { note: "x" }, 1))),
          yield* Effect.flip(as(accountant, docs.discardDraft(view.id, 1))),
          yield* Effect.flip(as(accountant, docs.preview(invoiceInput()))),
          (yield* as(accountant, docs.get(view.id))).id === view.id,
          (yield* as(reader, docs.list({}))).items.length,
          (yield* as(reader, docs.history(view.id))).length,
        ] as const;
      }),
    );
    const [draft, token, edit, discard, preview, read, listed, history] = ok(exit);
    expect(draft).toEqual(new Forbidden({ action: "document.draft" }));
    expect(token).toEqual(new Forbidden({ action: "document.draft" }));
    expect(edit).toEqual(new Forbidden({ action: "document.edit" }));
    expect(discard).toEqual(new Forbidden({ action: "document.draft" }));
    expect(preview).toEqual(new Forbidden({ action: "document.draft" }));
    expect([read, listed, history]).toEqual([true, 1, 1]);
  });

  test("another Workspace's documents and Contacts are NotFound", async () => {
    const otherMember = member("owner", { workspaceId: WORKSPACE_B });
    const [contactMiss, getMiss, editMiss, discardMiss, pdfMiss, historyMiss, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput());
          return [
            yield* Effect.flip(docs.createDraft(invoiceInput({ contact: B_BUYER }))),
            yield* Effect.flip(as(otherMember, docs.get(view.id))),
            yield* Effect.flip(as(otherMember, docs.edit(view.id, { note: "x" }, 1))),
            yield* Effect.flip(as(otherMember, docs.discardDraft(view.id, 1))),
            yield* Effect.flip(as(otherMember, docs.pdf(view.id))),
            yield* Effect.flip(as(otherMember, docs.history(view.id))),
            (yield* as(otherMember, docs.list({}))).items.length,
          ] as const;
        }),
      ),
    );
    expect(contactMiss).toEqual(new NotFound({ entity: "Contact", id: B_BUYER }));
    for (const miss of [getMiss, editMiss, discardMiss, pdfMiss, historyMiss]) {
      expect(miss).toMatchObject({ _tag: "NotFound", entity: "Document" });
    }
    expect(listed).toBe(0);
  });

  test("preview reports an unknown Contact as NotFound and stores nothing", async () => {
    const [miss, view, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            yield* Effect.flip(docs.preview(invoiceInput({ contact: B_BUYER }))),
            yield* docs.preview(invoiceInput()),
            (yield* docs.list({})).items.length,
          ] as const;
        }),
      ),
    );
    expect(miss as unknown).toEqual(new NotFound({ entity: "Contact", id: B_BUYER }));
    expect(view.number).toBeNull();
    expect(str(view.totals.gross.amount)).toBe("2980");
    expect(listed).toBe(0);
  });
});

describe("VAT regimes (rule D9)", () => {
  test("vat_payer + EU business Contact with VAT ID defaults to reverse charge", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) =>
          d.createDraft(
            invoiceInput({
              contact: DE_BUYER,
              lines: [{ description: "Vývoj", unitPrice: dec("1000") }],
            }),
          ),
        ),
      ),
    );
    expect(lines(view)[0]?.treatment).toBe("reverse_charge");
    expect(str(view.totals.vat.amount)).toBe("0");
    expect(str(view.totals.gross.amount)).toBe("1000");
    expect(view.taxDocument).toBe(true);
    expect(codes(view)).toContain("reverse_charge");
  });

  test("reverse charge without the buyer's VAT ID is Invalid", async () => {
    const err = ok(
      await scenario(
        Effect.flip(
          Effect.flatMap(Documents, (d) =>
            d.createDraft(
              invoiceInput({
                contact: CZ_NO_DIC,
                lines: [{ description: "Stavba", unitPrice: dec("1"), vat: "reverse_charge" }],
              }),
            ),
          ),
        ),
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
          const docs = yield* Documents;
          const view = yield* docs.createDraft(
            invoiceInput({ lines: [{ description: "Služba", unitPrice: dec("1000") }] }),
          );
          const err = yield* Effect.flip(docs.createDraft(invoiceInput()));
          return [view, err] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(lines(view)[0]?.treatment).toBe("outside_scope");
    expect(str(view.totals.gross.amount)).toBe("1000");
    expect(view.taxDocument).toBe(false);
    expect(codes(view)).toContain("not_vat_payer");
    expect(err).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["lines", 1, "vat"], code: "vat.not_allowed_for_regime" }],
    });
  });

  test("an identified person: domestic supplies outside scope only, EU services reverse charge", async () => {
    const [domestic, eu, rejected] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const one = [{ description: "Služba", unitPrice: dec("100") }] as const;
          return [
            yield* docs.createDraft(invoiceInput({ lines: one })),
            yield* docs.createDraft(
              invoiceInput({
                contact: DE_BUYER,
                lines: [{ description: "Služba", unitPrice: dec("100"), vat: "reverse_charge" }],
              }),
            ),
            yield* Effect.flip(
              docs.createDraft(
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
    expect(codes(domestic)).toContain("identified_person");
    expect([lines(eu)[0]?.treatment, eu.taxDocument]).toEqual(["reverse_charge", true]);
    expect(rejected).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
  });

  test("a Proforma is never a tax document; its tax point defaults to issuedOn", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) => d.createDraft(invoiceInput({ kind: "proforma" }))),
      ),
    );
    expect(view.taxDocument).toBe(false);
    expect(view.dates.taxableSupplyOn).toBe(view.dates.issuedOn);
    expect(codes(view)).toContain("proforma_not_tax_document");
  });
});

describe("FX (rule D11)", () => {
  const fixings = [fixing("2026-11-20", "25.125"), fixing("2026-11-23", "26")];
  const eurInput = invoiceInput({
    currency: EUR,
    taxableSupplyOn: "2026-11-22" as IsoDate,
    lines: [{ description: "Služba", unitPrice: dec("100") }],
  });

  test("takes the CNB fixing carried back to the tax point and shows CZK VAT per bucket", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) => d.createDraft(eurInput)),
        { fixings },
      ),
    );
    expect(view.fx).toEqual({
      rate: dec("25.125"),
      quantity: 1,
      fixingDate: "2026-11-20" as IsoDate,
      source: "cnb",
    });
    expect(str(view.totals.vat.amount)).toBe("21");
    expect(view.totals.buckets.map((b) => str(b.vatCzk ?? dec("-1")))).toEqual(["527.63"]);
    expect(str(view.totals.vatCzk?.amount ?? dec("-1"))).toBe("527.63");
    expect((view.issuer as unknown as { bankAccount: { id: string } }).bankAccount.id).toBe(
      EUR_ACCOUNT,
    );
  });

  test("a manual rate overrides the fixing; fx: null returns to it", async () => {
    const [manual, back] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const manual = yield* docs.createDraft({
            ...eurInput,
            fx: { manual: { rate: dec("24.5"), quantity: 1 } },
          });
          const back = yield* docs.edit(manual.id, { fx: null }, manual.revision);
          return [manual, back] as const;
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
    expect(str(manual.totals.vatCzk?.amount ?? dec("-1"))).toBe("514.5");
    expect(back.fx?.source).toBe("cnb");
    expect(back.revision).toBe(2);
  });

  test("a manual rate on a CZK document or a bad rate is Invalid; a missing fixing Unavailable", async () => {
    const [czk, bad, missing] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            yield* Effect.flip(
              docs.createDraft(invoiceInput({ fx: { manual: { rate: dec("1"), quantity: 1 } } })),
            ),
            yield* Effect.flip(
              docs.createDraft({ ...eurInput, fx: { manual: { rate: dec("0"), quantity: 1 } } }),
            ),
            yield* Effect.flip(
              docs.createDraft({ ...eurInput, taxableSupplyOn: "2026-11-01" as IsoDate }),
            ),
          ] as const;
        }),
        { fixings },
      ),
    );
    expect(czk).toMatchObject({ issues: [{ code: "fx.manual_not_allowed_for_czk" }] });
    expect(bad).toMatchObject({ issues: [{ code: "fx.manual_rate_invalid" }] });
    expect(missing).toEqual(new Unavailable({ dependency: "exchange_rates" }));
  });
});

describe("edit and discard of drafts", () => {
  test("edit recomputes, bumps the revision and checks expectedRevision", async () => {
    const [edited, stale, czkAccount] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput());
          const edited = yield* docs.edit(
            view.id,
            { lines: [{ description: "Jiné", unitPrice: dec("100") }], contact: DE_BUYER },
            1,
          );
          const stale = yield* Effect.flip(docs.edit(view.id, { note: "late" }, 1));
          return [
            edited,
            stale,
            (edited.issuer as unknown as { bankAccount: { id: string } }).bankAccount.id,
          ] as const;
        }),
      ),
    );
    expect(edited.revision).toBe(2);
    expect(lines(edited)[0]?.treatment).toBe("reverse_charge");
    expect(buyer(edited).contactId).toBe(DE_BUYER);
    expect(str(edited.totals.gross.amount)).toBe("100");
    expect(stale).toEqual(new Conflict({ reason: "revision_changed", currentRevision: 2 }));
    expect(czkAccount).toBe(CZK_ACCOUNT);
  });

  test("a number on a draft is an illegal transition", async () => {
    const err = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput());
          return yield* Effect.flip(docs.edit(view.id, { number: "2026-0001" }, 1));
        }),
      ),
    );
    expect(err).toEqual(new Conflict({ reason: "illegal_transition" }));
  });

  test("discardDraft deletes a draft, audits it, and refuses issued documents", async () => {
    const [gone, stale, issuedDiscard, cancelledEdit, history] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const ws = member("owner").workspaceId;
          const a = yield* docs.createDraft(invoiceInput());
          const stale = yield* Effect.flip(docs.discardDraft(a.id, 7));
          yield* docs.discardDraft(a.id, 1);
          const gone = yield* Effect.flip(docs.get(a.id));
          const b = yield* docs.createDraft(invoiceInput());
          const row = yield* repo.get(ws, b.id);
          const issued = yield* store.transaction(
            repo.update({ ...row, status: "issued", number: "2026-0001" }, 1),
          );
          const issuedDiscard = yield* Effect.flip(docs.discardDraft(b.id, issued.revision));
          const c = yield* docs.createDraft(invoiceInput());
          const cRow = yield* repo.get(ws, c.id);
          yield* store.transaction(repo.update({ ...cRow, status: "cancelled", locked: true }, 1));
          const cancelledEdit = yield* Effect.flip(docs.edit(c.id, { note: "x" }, 2));
          const history = yield* store.audit.history(ws, { entity: "Document", id: a.id });
          return [gone, stale, issuedDiscard, cancelledEdit, history] as const;
        }),
      ),
    );
    expect(gone).toMatchObject({ _tag: "NotFound", entity: "Document" });
    expect(stale).toEqual(new Conflict({ reason: "revision_changed", currentRevision: 1 }));
    expect(issuedDiscard).toEqual(new Conflict({ reason: "illegal_transition" }));
    expect(cancelledEdit).toEqual(new Conflict({ reason: "illegal_transition" }));
    expect(history.map((e) => e.action)).toEqual(["document.create", "document.discard"]);
  });
});

describe("list and pdf", () => {
  test("filters by kind and contact, pages by cursor bound to the filter", async () => {
    const [invoices, page1, page2, mismatch, byText] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          yield* docs.createDraft(invoiceInput({ issuedOn: "2026-11-01" as IsoDate }));
          yield* docs.createDraft(
            invoiceInput({ issuedOn: "2026-11-02" as IsoDate, kind: "proforma" }),
          );
          yield* docs.createDraft(
            invoiceInput({
              issuedOn: "2026-11-03" as IsoDate,
              contact: DE_BUYER,
              lines: [{ description: "x", unitPrice: dec("1") }],
            }),
          );
          const invoices = yield* docs.list({ kind: "invoice" });
          const page1 = yield* docs.list({ kind: "invoice", limit: 1 });
          const page2 = yield* docs.list({
            kind: "invoice",
            limit: 1,
            cursor: page1.nextCursor ?? "",
          });
          const mismatch = yield* Effect.flip(
            docs.list({ kind: "proforma", limit: 1, cursor: page1.nextCursor ?? "" }),
          );
          const byText = yield* docs.list({ text: "ODBĚRATEL", contact: CZ_BUYER });
          return [invoices, page1, page2, mismatch, byText] as const;
        }),
      ),
    );
    const issuedOn = (p: typeof invoices) =>
      p.items.map((i) => (i as unknown as { issuedOn: string }).issuedOn);
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
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput());
          const download = yield* docs.pdf(view.id, { template: "modern_minimal" });
          const chunks = yield* Stream.runCollect(download.bytes);
          const renders = yield* Ref.get((yield* DocumentFixtures).renders);
          return [view, download, Array.from(chunks), renders] as const;
        }),
      ),
    );
    expect(download.filename).toBe(`draft-${view.id}.pdf`);
    expect(download.contentType).toBe("application/pdf");
    expect(bytes).toEqual([fakePdfBytes(view, { template: "modern_minimal", language: "cs" })]);
    expect(renders.map((r) => [r.view.id, r.options])).toEqual([
      [view.id, { template: "modern_minimal", language: "cs" }],
    ]);
  });
});

describe("later phases", () => {
  test("correct dies with a clear not-implemented defect until P3", async () => {
    const exit = await scenario(
      Effect.flatMap(Documents, (d) =>
        d.correct("01900000-0000-7000-8000-000000000000" as DocumentId, {
          reason: "x",
          lines: "full",
        }),
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not implemented (P3)");
  });
});
