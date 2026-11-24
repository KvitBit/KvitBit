/**
 * `ReportsSourceLive` over the real module layers on in-memory ports: documents, payments and
 * expenses built through their services (an Expense payment row through `PaymentsRepo`).
 */
import { describe, expect, test } from "bun:test";
import type {
  CurrencyCode,
  CurrentCaller,
  DocumentId,
  DocumentView,
  ExpenseId,
  ExpenseView,
  IsoDate,
  PaymentId,
} from "@kvitbit/domain/contract";
import { Documents, MoneyMath, Payments, Workspaces } from "@kvitbit/domain/contract";
import { BigDecimal, Cause, Effect, Exit, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { ReportsSourceLive } from "../../src/compose/reportsSource";
import {
  DocumentFixtures,
  DocumentPayments,
  DocumentsRepo,
  DocumentsRepoMemory,
} from "../../src/modules/documents";
import type { DocumentRecord } from "../../src/modules/documents/record";
import {
  ExpenseRecordsLive,
  ExpensesRepoMemory,
  ExpensesTestLayer,
  FakeSupplierDirectory,
} from "../../src/modules/expenses";
import { NumberingSeries } from "../../src/modules/numbering";
import { PaymentsRepo, PaymentsRepoMemory, PaymentsTestLayer } from "../../src/modules/payments";
import { ReportCompute } from "../../src/modules/reports";
import type { DateRange, ReportDocument, StoredFx } from "../../src/modules/reports/source";
import { ReportsSource } from "../../src/modules/reports/source";
import { WorkspacesTestLayer } from "../../src/modules/workspaces";
import { WorkspacesRepoMemory } from "../../src/modules/workspaces/repo";
import { CoreStore } from "../../src/store/CoreStore";
import { InMemoryPortsLive } from "../../src/testing";
import { member, runTest, TEST_NOW, WORKSPACE_A, WORKSPACE_B } from "../helpers";
import {
  as,
  B_BUYER,
  dec,
  EUR,
  fixing,
  invoiceInput,
  issuer,
  seed,
  str,
} from "../modules/documents/fixtures";
import {
  czkInput,
  EUR_FIXING,
  fields,
  record,
  SUPPLIER_CONTACT,
} from "../modules/expenses/fixtures";
import { accountOf, OWNER, USERS } from "../modules/workspaces/harness";

const NOV: DateRange = { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate };
const OCT_31: DateRange = { from: "2026-10-31" as IsoDate, to: "2026-10-31" as IsoDate };
const OUT_PAYMENT = "01900000-0000-7000-8000-00000000f001" as PaymentId;
const ownerB = member("owner", { workspaceId: WORKSPACE_B });

const series = Effect.flatMap(CoreStore, (store) =>
  store.transaction(
    Effect.flatMap(NumberingSeries, (n) =>
      Effect.andThen(
        n.ensureDefaults(WORKSPACE_A, [
          "invoice",
          "proforma",
          "credit_note",
          "payment_tax_document",
        ]),
        n.ensureDefaults(WORKSPACE_B, ["invoice", "proforma", "credit_note"]),
      ),
    ),
  ),
).pipe(Effect.orDie);

/** Workspace B's issuer numbers from its default series too. */
const issuerB = Effect.flatMap(DocumentFixtures, (f) =>
  f.putIssuer(issuer(WORKSPACE_B, "non_vat_payer", { seriesByKind: {} })),
);

const suppliers = Effect.flatMap(FakeSupplierDirectory, (dir) =>
  Ref.set(dir.contacts, [
    {
      workspaceId: WORKSPACE_A,
      contactId: SUPPLIER_CONTACT,
      name: "Dodavatel s.r.o.",
      ico: "27074358",
      dic: "CZ27074358",
    },
  ]),
);

const layer = ReportsSourceLive.pipe(
  Layer.provideMerge(Layer.mergeAll(PaymentsTestLayer, ExpensesTestLayer, WorkspacesRepoMemory)),
);

/** Workspace A (vat_payer) and B seeded with Contacts, series and one supplier, as A's owner. */
const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Layer.Success<typeof layer>
    | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
    | CurrentCaller
  >,
) =>
  runTest(
    member("owner"),
    Effect.andThen(
      Effect.andThen(
        Effect.andThen(seed("vat_payer", { seriesByKind: {} }), issuerB),
        Effect.andThen(series, suppliers),
      ),
      body,
    ).pipe(Effect.provide(layer)),
    { fixings: [fixing("2026-11-23", "25.000"), EUR_FIXING] },
  );

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (exit._tag === "Failure")
    throw new Error(
      `expected success, got ${JSON.stringify(exit.cause, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
    );
  return exit.value;
};

/** Runs a ReportsSource read inside a CoreStore transaction, as callers do. */
const read = <A, E, R>(f: (s: ReportsSource["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const source = yield* ReportsSource;
    return yield* store.transaction(f(source));
  });

/** A stored fixing's rate as a string; null without one. */
const rateOf = (fx: StoredFx | null | undefined) => (fx == null ? null : str(fx.rate));

const id = (v: DocumentView) => v.id as DocumentId;
const issue = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.flatMap(Documents, (d) => d.issue({ input: invoiceInput(extra) }));
const pay = (document: DocumentId, amount: string, currency = "CZK" as CurrencyCode) =>
  Effect.flatMap(Payments, (p) =>
    p.record({ target: { document }, amount: MoneyMath.make(dec(amount), currency) }),
  );
const recordExpense = (input: Record<string, unknown>) =>
  Effect.map(record(input), (v: ExpenseView) => fields(v).id as ExpenseId);

const MISSING = "01900000-0000-7000-8000-00000000dead" as DocumentId;

const grossOf = (buckets: ReadonlyArray<{ readonly gross: BigDecimal.BigDecimal }>) =>
  str(buckets.reduce((sum, b) => BigDecimal.sum(sum, b.gross), BigDecimal.fromBigInt(0n)));

/** A Proforma paid 1000 with a PTD plus 400 recorded without one (user-flows 3.8: unticked). */
const finalInvoiceWithUncoveredCash = Effect.gen(function* () {
  const d = yield* Documents;
  const store = yield* CoreStore;
  const seam = yield* DocumentPayments;
  const proforma = yield* issue({ kind: "proforma" });
  yield* pay(id(proforma), "1000");
  yield* store.transaction(
    Effect.andThen(seam.lock(WORKSPACE_A, id(proforma)), () =>
      seam.settle(
        WORKSPACE_A,
        id(proforma),
        { amount: dec("1400"), payments: 2 },
        { action: "payment.record" },
      ),
    ),
  );
  const fi = yield* d.issueFinalInvoice(id(proforma));
  const cn = yield* d.correct(id(fi), { reason: "storno", lines: "full" });
  return { fi: id(fi), cn: id(cn) };
});

/** Rewrites a stored document inside a transaction (simulating a dangling reference). */
const corrupt = (target: DocumentId, edit: (row: DocumentRecord) => DocumentRecord) =>
  Effect.flatMap(CoreStore, (store) =>
    store.transaction(
      Effect.flatMap(DocumentsRepo, (repo) =>
        Effect.flatMap(repo.get(WORKSPACE_A, target), (row) =>
          repo.update(edit(row), row.revision),
        ),
      ),
    ),
  ).pipe(Effect.orDie);

describe("ReportsSourceLive", () => {
  test("documents, receivables, payments and expenses from the module repositories", async () => {
    const r = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const draft = yield* d.createDraft(invoiceInput());
          const inv = yield* issue();
          yield* pay(id(inv), "1000");
          const early = yield* issue({
            issuedOn: "2026-11-02" as IsoDate,
            taxableSupplyOn: "2026-10-31" as IsoDate,
          });
          const credited = yield* issue();
          const cn = yield* d.correct(id(credited), { reason: "sleva", lines: "full" });
          // Storno of a non-tax document: the Proforma itself becomes cancelled (D6).
          const cancelled = yield* issue({ kind: "proforma" });
          yield* d.cancel(id(cancelled), { reason: "chyba" });
          const proforma = yield* issue({ kind: "proforma" });
          yield* pay(id(proforma), "2980");
          const fi = yield* d.issueFinalInvoice(id(proforma));
          // After the Final Invoice, a Proforma payment is stored against it (D8).
          const late = yield* pay(id(proforma), "10");
          const eur = yield* issue({
            currency: EUR,
            lines: [{ description: "Služba", unitPrice: dec("100") }],
          });
          yield* pay(id(eur), "10", EUR);
          const other = yield* as(
            ownerB,
            issue({ contact: B_BUYER, lines: [{ description: "Služby", unitPrice: dec("100") }] }),
          );

          const expense = yield* recordExpense({
            ...czkInput,
            currency: "EUR",
            taxableSupplyOn: "2026-11-22",
          });
          yield* recordExpense({ status: "incomplete" });
          const store = yield* CoreStore;
          yield* store.transaction(
            Effect.flatMap(PaymentsRepo, (repo) =>
              repo.insert({
                id: OUT_PAYMENT,
                workspaceId: WORKSPACE_A,
                revision: 1,
                documentId: null,
                expenseId: expense,
                amount: dec("121"),
                currency: EUR,
                paidOn: "2026-11-23" as IsoDate,
                method: "bank_transfer",
                note: null,
                taxDocumentId: null,
                removedAt: null,
                createdAt: "2026-11-23T09:00:00.000Z",
                updatedAt: "2026-11-23T09:00:00.000Z",
              }),
            ),
          );

          return {
            ids: { draft, inv, early, credited, cn, cancelled, proforma, fi, eur, other, expense },
            late,
            byIssued: yield* read((s) => s.documents(WORKSPACE_A, { ...NOV, field: "issuedOn" })),
            byTaxNov: yield* read((s) => s.documents(WORKSPACE_A, { ...NOV, field: "taxPoint" })),
            byTaxOct: yield* read((s) =>
              s.documents(WORKSPACE_A, { ...OCT_31, field: "taxPoint" }),
            ),
            byIssuedOct: yield* read((s) =>
              s.documents(WORKSPACE_A, { ...OCT_31, field: "issuedOn" }),
            ),
            ofB: yield* read((s) => s.documents(WORKSPACE_B, { ...NOV, field: "issuedOn" })),
            open: yield* read((s) => s.openReceivables(WORKSPACE_A)),
            payments: yield* read((s) => s.payments(WORKSPACE_A, NOV)),
            paymentsB: yield* read((s) => s.payments(WORKSPACE_B, NOV)),
            paymentsOct: yield* read((s) => s.payments(WORKSPACE_A, OCT_31)),
            expenses: yield* read((s) => s.expenses(WORKSPACE_A, { ...NOV, field: "taxPoint" })),
            expensesB: yield* read((s) => s.expenses(WORKSPACE_B, { ...NOV, field: "taxPoint" })),
            incomplete: yield* read((s) => s.incompleteExpenses(WORKSPACE_A)),
            incompleteB: yield* read((s) => s.incompleteExpenses(WORKSPACE_B)),
            regimes: yield* read((s) => s.taxRegimes(WORKSPACE_A)),
          };
        }),
      ),
    );
    const { ids } = r;
    const byId = new Map(r.byIssued.map((doc) => [doc.id, doc] as const));
    const doc = (v: DocumentView) => {
      const found = byId.get(id(v));
      if (found === undefined) throw new Error(`missing ${v.kind} ${v.id}`);
      return found;
    };

    // Issued and cancelled, never drafts; other Workspaces never.
    expect(byId.has(id(ids.draft))).toBe(false);
    expect(byId.has(id(ids.other))).toBe(false);
    expect(r.byIssued.every((row) => row.workspaceId === WORKSPACE_A)).toBe(true);
    expect(r.ofB.map((row) => row.id)).toEqual([id(ids.other)]);
    expect(doc(ids.cancelled).status).toBe("cancelled");
    expect(doc(ids.inv)).toMatchObject({ status: "issued", kind: "invoice", finalInvoice: false });
    expect(doc(ids.inv).number).toBe(ids.inv.number);
    expect(doc(ids.inv).correctsKind).toBeNull();

    // issuedOn vs tax point, both inclusive.
    expect(doc(ids.early)).toMatchObject({ issuedOn: "2026-11-02", taxPoint: "2026-10-31" });
    expect(r.byTaxOct.map((row) => row.id)).toEqual([id(ids.early)]);
    expect(r.byIssuedOct).toEqual([]);
    expect(r.byTaxNov.some((row) => row.id === id(ids.early))).toBe(false);
    // A Proforma has no tax point: in the issuedOn range only.
    expect(doc(ids.proforma).taxPoint).toBeNull();
    expect(r.byTaxNov.some((row) => row.id === id(ids.proforma))).toBe(false);
    expect(r.byTaxNov.some((row) => row.id === id(ids.inv))).toBe(true);

    // Final Invoice: full supply plus the deducted advance.
    const fi = doc(ids.fi);
    expect(fi.finalInvoice).toBe(true);
    expect(str(fi.totals.gross.amount)).toBe("2980");
    expect(fi.advanceDeductions.length).toBeGreaterThan(0);
    const deducted = fi.advanceDeductions.reduce(
      (sum, b) => BigDecimal.sum(sum, b.gross),
      BigDecimal.fromBigInt(0n),
    );
    expect(str(deducted)).toBe("2980");
    expect(doc(ids.inv).advanceDeductions).toEqual([]);

    // Credit Note: negative totals, the corrected kind; the credited invoice owes nothing.
    const cn = doc(ids.cn);
    expect(cn.kind).toBe("credit_note");
    expect(cn.correctsKind).toBe("invoice");
    expect(str(cn.totals.gross.amount)).toBe("-2980");
    expect(str(doc(ids.credited).outstanding)).toBe("0");

    // Outstanding and open receivables.
    expect(str(doc(ids.inv).outstanding)).toBe("1980");
    expect(str(doc(ids.proforma).outstanding)).toBe("0");
    expect(str(doc(ids.fi).outstanding)).toBe("0");
    // Unpaid `early`, part-paid `inv` and the EUR invoice (121 EUR, 10 paid).
    expect(r.open.map((row) => row.id).sort()).toEqual(
      [id(ids.early), id(ids.inv), id(ids.eur)].sort(),
    );
    expect(str(doc(ids.eur).outstanding)).toBe("111");
    expect(str(r.open.find((row) => row.id === id(ids.inv))?.outstanding ?? dec("-1"))).toBe(
      "1980",
    );

    // Payments: both directions, the target's stored fixing.
    expect(r.payments.every((p) => p.workspaceId === WORKSPACE_A)).toBe(true);
    const into = (target: DocumentView) =>
      r.payments.filter((p) => "document" in p.target && p.target.document === id(target));
    expect(into(ids.inv).map((p) => [p.direction, str(p.amount.amount), p.fx])).toEqual([
      ["in", "1000", null],
    ]);
    expect(into(ids.fi).map((p) => str(p.amount.amount))).toEqual(["10"]);
    expect(into(ids.proforma).map((p) => str(p.amount.amount))).toEqual(["2980"]);
    const eurIn = into(ids.eur);
    expect(eurIn.length).toBe(1);
    expect(eurIn[0]?.amount.currency).toBe(EUR);
    expect(rateOf(eurIn[0]?.fx)).toBe("25");
    expect(rateOf(doc(ids.eur).fx)).toBe("25");
    const out = r.payments.filter((p) => p.direction === "out");
    expect(out.map((p) => [p.id, p.target, str(p.amount.amount), p.paidOn])).toEqual([
      [OUT_PAYMENT, { expense: ids.expense }, "121", "2026-11-23"],
    ]);
    expect(rateOf(out[0]?.fx)).toBe("25.125");
    expect(out[0]?.fx?.quantity).toBe(1);
    expect(r.paymentsB).toEqual([]);
    expect(r.paymentsOct).toEqual([]);

    // Expenses: complete ones in range; the incomplete one is counted.
    expect(r.expenses.map((e) => [e.id, e.workspaceId, e.taxPoint, e.currency])).toEqual([
      [ids.expense, WORKSPACE_A, "2026-11-22" as IsoDate, EUR],
    ]);
    expect(rateOf(r.expenses[0]?.fx)).toBe("25.125");
    expect(r.expensesB).toEqual([]);
    expect(r.incomplete).toBe(1);
    expect(r.incompleteB).toBe(0);

    // No Workspace row in this setup: no regime history.
    expect(r.regimes).toEqual([]);
  });

  test("advance deductions are the PTD-backed lines only; the full supply adds back all", async () => {
    const r = ok(
      await run(
        Effect.gen(function* () {
          const ids = yield* finalInvoiceWithUncoveredCash;
          const docs = yield* read((s) => s.documents(WORKSPACE_A, { ...NOV, field: "issuedOn" }));
          const doc = (docId: DocumentId) => docs.find((x) => x.id === docId) as ReportDocument;
          return { fi: doc(ids.fi), cn: doc(ids.cn) };
        }),
      ),
    );
    const treatments = (buckets: ReadonlyArray<{ readonly treatment: string }>) =>
      buckets.map((b) => b.treatment);
    // The Final Invoice deducts 1000 from its PTD and 400 of uncovered cash (outside_scope).
    expect(r.fi.finalInvoice).toBe(true);
    expect(str(r.fi.totals.gross.amount)).toBe("2980");
    expect(treatments(r.fi.totals.buckets)).toEqual(["standard", "reduced"]);
    expect(treatments(r.fi.advanceDeductions)).toEqual(["standard", "reduced"]);
    expect(grossOf(r.fi.advanceDeductions)).toBe("1000");
    // No negative outside_scope tax base: the cash deduction is not netted (it was never taxed).
    const taxable = ReportCompute.taxableBucketsCzk(r.fi);
    expect(treatments(taxable)).toEqual(["standard", "reduced"]);
    // The Credit Note reversing it keeps the deducts targets, so it classifies the same way.
    expect(r.cn.correctsKind).toBe("invoice");
    expect(str(r.cn.totals.gross.amount)).toBe("-2980");
    expect(treatments(r.cn.totals.buckets)).toEqual(["standard", "reduced"]);
    expect(treatments(r.cn.advanceDeductions)).toEqual(["standard", "reduced"]);
    expect(grossOf(r.cn.advanceDeductions)).toBe("-1000");
  });

  const dangling: ReadonlyArray<
    readonly [string, (ids: { fi: DocumentId; cn: DocumentId }) => Effect.Effect<unknown>]
  > = [
    [
      "corrects",
      (ids) =>
        corrupt(ids.cn, (row) => ({
          ...row,
          links: row.links.map((l) => (l.relation === "corrects" ? { ...l, id: MISSING } : l)),
        })),
    ],
    [
      "corrected_by",
      (ids) =>
        corrupt(ids.fi, (row) => ({
          ...row,
          links: [...row.links, { relation: "corrected_by", id: MISSING }],
        })),
    ],
    [
      "deducts",
      (ids) =>
        corrupt(ids.fi, (row) => ({
          ...row,
          lines: row.lines.map((l) => (l.deducts === null ? l : { ...l, deducts: MISSING })),
        })),
    ],
  ];
  for (const [reference, breakIt] of dangling) {
    test(`a missing ${reference} target is a defect, not a silently dropped document`, async () => {
      const exit = await run(
        Effect.gen(function* () {
          const ids = yield* finalInvoiceWithUncoveredCash;
          yield* breakIt(ids);
          return yield* read((s) => s.documents(WORKSPACE_A, { ...NOV, field: "issuedOn" }));
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.pretty(exit.cause)).toContain(`${reference} target ${MISSING} not found`);
      }
    });
  }

  test("taxRegimes: the Workspace's regime history, Workspace-scoped", async () => {
    const reports = ReportsSourceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          DocumentsRepoMemory,
          PaymentsRepoMemory,
          ExpenseRecordsLive.pipe(Layer.provideMerge(ExpensesRepoMemory)),
          WorkspacesRepoMemory,
        ),
      ),
    );
    // Built without an outer caller (like the workspaces harness): WorkspacesLive keeps the
    // context it was built in.
    const env = Layer.merge(InMemoryPortsLive(), TestClock.layer());
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const ws = yield* Workspaces;
        const owner = yield* as(accountOf(OWNER), ws.create({ name: "Acme s.r.o." } as never));
        const change = { taxRegime: { regime: "vat_payer", effectiveFrom: "2027-01-01" } } as never;
        yield* as(owner, ws.updateIssuingEntity(change, 1));
        return {
          mine: yield* read((s) => s.taxRegimes(owner.workspaceId)),
          other: yield* read((s) => s.taxRegimes(WORKSPACE_B)),
        };
      }).pipe(
        Effect.provide(
          Layer.merge(reports, WorkspacesTestLayer(USERS)).pipe(Layer.provideMerge(env)),
        ),
      ),
    );
    expect(ok(exit)).toEqual({
      mine: [
        { regime: "non_vat_payer", effectiveFrom: "2026-11-23" as IsoDate },
        { regime: "vat_payer", effectiveFrom: "2027-01-01" as IsoDate },
      ],
      other: [],
    });
  });
});
