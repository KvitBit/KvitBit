/**
 * Payments (core-ports 4.5) through the `Payments` service on real layers: documents' payments
 * seam, the memory repos and the port fakes (`PaymentsTestLayer`).
 */
import { describe, expect, test } from "bun:test";
import type {
  CurrencyCode,
  DocumentId,
  DocumentView,
  ExpenseId,
  IsoDate,
  PaymentId,
  RequestKey,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  Invalid,
  MoneyMath,
  NotFound,
  Payments,
  Unavailable,
} from "@kvitbit/domain/contract";
import { Effect, Exit } from "effect";
import type { PaymentViewData } from "../../../src/modules/payments";
import { PaymentFixtures, PaymentsRepo, reportPayment } from "../../../src/modules/payments";
import { CoreStore } from "../../../src/store/CoreStore";
import { account, member, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { as, CZK, dec, EUR, fixing, invoiceInput, str } from "../documents/fixtures";
import { run } from "./fixtures";

const WS = WORKSPACE_A;
const TODAY = "2026-11-23" as IsoDate;
const EXPENSE = "01900000-0000-7000-8000-0000ee000001" as ExpenseId;
const EXPENSE_B = "01900000-0000-7000-8000-0000ee0000b1" as ExpenseId;

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const malformed = (path: string, reason: string) =>
  new Invalid({ issues: [{ path: [path], code: "request.malformed", params: { reason } }] });
const mismatch = (expected: string) =>
  new Invalid({
    issues: [
      { path: ["amount", "currency"], code: "payment.currency_mismatch", params: { expected } },
    ],
  });
const hasTaxDocument = new Conflict({
  reason: "illegal_transition",
  detail: "payment.has_tax_document",
});

const czk = (amount: string) => MoneyMath.make(dec(amount), CZK);
const view = (p: unknown) => p as PaymentViewData;
const docId = (d: DocumentView) => d.id as DocumentId;

/** 2 x 1000 standard + 500 reduced: gross 2980 CZK. */
const issueInvoice = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.flatMap(Documents, (d) => d.issue({ input: invoiceInput(extra) }));
const issueProforma = () => issueInvoice({ kind: "proforma" });
/** Outside vat_payer: one line without VAT, gross 2980 CZK. */
const issuePlainProforma = () =>
  issueInvoice({
    kind: "proforma",
    lines: [{ description: "Služby", unitPrice: dec("2980") }],
  });

const pay = (document: DocumentId, amount?: string, extra: { paidOn?: IsoDate } = {}) =>
  Effect.flatMap(Payments, (p) =>
    p.record({
      target: { document },
      ...(amount === undefined ? {} : { amount: czk(amount) }),
      ...extra,
    }),
  );

const settlementOf = (id: DocumentId) =>
  Effect.map(
    Effect.flatMap(Documents, (d) => d.get(id)),
    (v) => v.settlement,
  );

describe("record on documents", () => {
  test("partial, paid and overpaid; the default amount is what is outstanding", async () => {
    const result = ok(
      await run(
        Effect.gen(function* () {
          const inv = yield* issueInvoice();
          const first = yield* pay(inv.id, "1000");
          const rest = yield* pay(inv.id);
          const extra = yield* pay(inv.id, "1", { paidOn: "2026-11-20" as IsoDate });
          const list = yield* Effect.flatMap(Payments, (p) => p.listFor({ document: inv.id }));
          return { first, rest, extra, list, settlement: yield* settlementOf(inv.id) };
        }),
      ),
    );
    expect(result.first.settlement).toBe("partially_paid");
    expect(result.first.issued).toEqual([]);
    expect(result.rest.settlement).toBe("paid");
    expect(str(view(result.rest.payment).amount.amount)).toBe("1980");
    expect(view(result.rest.payment).paidOn).toBe(TODAY);
    expect(view(result.rest.payment).method).toBe("bank_transfer");
    expect(result.extra.settlement).toBe("overpaid");
    expect(result.settlement).toBe("overpaid");
    // Oldest paidOn first.
    expect(result.list.map((p) => str(view(p).amount.amount))).toEqual(["1", "1000", "1980"]);
  });

  test("P1 currency, positive amounts, and nothing outstanding", async () => {
    const [currency, zero, negative, nothingDue] = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const currency = yield* Effect.flip(
            p.record({ target: { document: inv.id }, amount: MoneyMath.make(dec("10"), EUR) }),
          );
          const zero = yield* Effect.flip(pay(inv.id, "0"));
          const negative = yield* Effect.flip(pay(inv.id, "-5"));
          yield* pay(inv.id);
          const nothingDue = yield* Effect.flip(pay(inv.id));
          return [currency, zero, negative, nothingDue] as const;
        }),
      ),
    );
    expect(currency).toEqual(mismatch("CZK"));
    expect(zero).toEqual(malformed("amount", "out_of_range"));
    expect(negative).toEqual(malformed("amount", "out_of_range"));
    expect(nothingDue).toEqual(malformed("amount", "required"));
  });

  test("drafts, credit notes and cancelled documents take no payments", async () => {
    const [draft, creditNote] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const draft = yield* d.createDraft(invoiceInput());
          const inv = yield* issueInvoice();
          const cn = yield* d.correct(inv.id, { reason: "storno", lines: "full" });
          return [
            yield* Effect.flip(pay(draft.id, "10")),
            yield* Effect.flip(pay(cn.id, "10")),
          ] as const;
        }),
      ),
    );
    expect(draft).toBeInstanceOf(Conflict);
    expect(creditNote).toEqual(new Conflict({ reason: "illegal_transition" }));
  });

  test("audit: one entry on the Document with the payment's particulars; revision bumps (C2)", async () => {
    const [history, stale, payment] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const result = yield* pay(inv.id, "100");
          const stale = yield* Effect.flip(d.edit(inv.id, { note: "x" }, inv.revision));
          return [yield* d.history(inv.id), stale, view(result.payment)] as const;
        }),
      ),
    );
    const entries = history.filter((e) => e.action === "payment.record");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changes).toContainEqual({
      path: "payment",
      before: null,
      after: {
        id: payment.id,
        amount: "100",
        currency: "CZK",
        paidOn: TODAY,
        method: "bank_transfer",
        note: null,
        taxDocument: null,
      },
    });
    expect(stale).toBeInstanceOf(Conflict);
    expect((stale as Conflict).reason).toBe("revision_changed");
  });

  test("idempotency (C3): a replay returns the stored result; another payload is a mismatch", async () => {
    const key = { requestKey: "bank-tx-1" as RequestKey };
    const [first, replay, mismatched, rows] = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const input = { target: { document: inv.id }, amount: czk("500") };
          const first = yield* p.record(input, key);
          const replay = yield* p.record(input, key);
          const mismatched = yield* Effect.flip(p.record({ ...input, amount: czk("501") }, key));
          return [first, replay, mismatched, yield* p.listFor({ document: inv.id })] as const;
        }),
      ),
    );
    expect(view(replay.payment).id).toBe(view(first.payment).id);
    expect(replay.settlement).toBe(first.settlement);
    expect(mismatched).toEqual(new Conflict({ reason: "idempotency_mismatch" }));
    expect(rows).toHaveLength(1);
  });
});

describe("authorization and tenancy", () => {
  test("payment.write for record/remove, payment.read for listFor, per role and scope", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const paid = yield* pay(inv.id, "10");
          const id = view(paid.payment).id;
          const attempt = (caller: Parameters<typeof as>[0]) =>
            Effect.all({
              record: Effect.exit(as(caller, pay(inv.id, "1"))),
              remove: Effect.exit(as(caller, p.remove(id, "x"))),
              list: Effect.exit(as(caller, p.listFor({ document: inv.id }))),
            });
          return {
            accountant: yield* attempt(member("accountant")),
            readToken: yield* attempt(member("member", { scopes: ["payments:read"] })),
            documentsToken: yield* attempt(member("admin", { scopes: ["documents:write"] })),
            account: yield* attempt(account()),
          };
        }),
      ),
    );
    const forbidden = (action: string) => Exit.fail(new Forbidden({ action: action as never }));
    expect(results.accountant.record).toEqual(forbidden("payment.write"));
    expect(results.accountant.remove).toEqual(forbidden("payment.write"));
    expect(Exit.isSuccess(results.accountant.list)).toBe(true);
    expect(results.readToken.record).toEqual(forbidden("payment.write"));
    expect(Exit.isSuccess(results.readToken.list)).toBe(true);
    expect(results.documentsToken.record).toEqual(forbidden("payment.write"));
    expect(results.documentsToken.list).toEqual(forbidden("payment.read"));
    expect(results.account.record).toEqual(forbidden("payment.write"));
    expect(results.account.list).toEqual(forbidden("payment.read"));
  });

  test("a payments-scoped token may record", async () => {
    const result = ok(
      await run(
        Effect.gen(function* () {
          const inv = yield* issueInvoice();
          return yield* as(member("member", { scopes: ["payments:write"] }), pay(inv.id, "10"));
        }),
      ),
    );
    expect(result.settlement).toBe("partially_paid");
  });

  test("another Workspace's document, expense and payment are NotFound", async () => {
    const other = member("owner", { workspaceId: WORKSPACE_B });
    const results = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const f = yield* PaymentFixtures;
          yield* f.putExpense({ workspaceId: WS, id: EXPENSE, currency: CZK, gross: dec("100") });
          const inv = yield* issueInvoice();
          const paid = yield* pay(inv.id, "10");
          const id = view(paid.payment).id;
          return yield* as(
            other,
            Effect.all([
              Effect.flip(pay(inv.id, "1")),
              Effect.flip(p.listFor({ document: inv.id })),
              Effect.flip(p.remove(id, "x")),
              Effect.flip(p.record({ target: { expense: EXPENSE }, amount: czk("1") })),
              Effect.flip(p.listFor({ expense: EXPENSE })),
            ]),
          );
        }),
      ),
    );
    expect(results[0]).toBeInstanceOf(NotFound);
    expect((results[0] as NotFound).entity).toBe("Document");
    expect(results[1]).toBeInstanceOf(NotFound);
    expect(results[2]).toEqual(
      new NotFound({ entity: "Payment", id: (results[2] as NotFound).id }),
    );
    expect((results[3] as NotFound).entity).toBe("Expense");
    expect((results[4] as NotFound).entity).toBe("Expense");
  });
});

describe("Proformas: Payment Tax Documents (P2) and the Final Invoice (D8)", () => {
  test("a vat_payer Proforma payment issues a PTD in the same transaction, linked to the payment", async () => {
    const [result, rows, sent] = ok(
      await run(
        Effect.gen(function* () {
          const pf = yield* issueProforma();
          const result = yield* pay(pf.id, "1000");
          const repo = yield* PaymentsRepo;
          const store = yield* CoreStore;
          const rows = yield* store.transaction(repo.liveFor(WS, { document: pf.id }));
          return [result, rows, yield* (yield* PaymentFixtures).sent(WS)] as const;
        }),
      ),
    );
    expect(result.issued).toHaveLength(1);
    const ptd = result.issued[0] as DocumentView;
    expect(ptd.kind).toBe("payment_tax_document");
    expect(view(result.payment).taxDocument).toBe(docId(ptd));
    expect(rows[0]?.taxDocumentId).toBe(docId(ptd));
    expect(result.settlement).toBe("partially_paid");
    // autoSendPaymentTaxDocument is off by default.
    expect(sent).toEqual([]);
  });

  test("auto-send: on, the PTD is sent in the transaction; a caller who may not send still records", async () => {
    const [own, token, sent] = ok(
      await run(
        Effect.gen(function* () {
          const f = yield* PaymentFixtures;
          yield* f.setAutoSend(WS, true);
          const pf = yield* issueProforma();
          const own = yield* pay(pf.id, "100");
          const token = yield* as(
            member("member", { scopes: ["payments:write"] }),
            pay(pf.id, "100"),
          );
          return [own, token, yield* f.sent(WS)] as const;
        }),
      ),
    );
    expect(sent).toEqual([docId(own.issued[0] as DocumentView)]);
    expect(token.issued).toHaveLength(1);
  });

  test("one transaction: a PTD that cannot be issued rolls the payment back", async () => {
    const [failed, list, settlement] = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const pf = yield* issueInvoice({ kind: "proforma", currency: EUR });
          // No CNB fixing on or before paidOn: the PTD's fx is unavailable.
          const failed = yield* Effect.flip(
            p.record({
              target: { document: pf.id },
              amount: MoneyMath.make(dec("10"), EUR),
              paidOn: "2026-11-01" as IsoDate,
            }),
          );
          return [
            failed,
            yield* p.listFor({ document: pf.id }),
            yield* settlementOf(pf.id),
          ] as const;
        }),
        { fixings: [fixing("2026-11-23", "25.000")] },
      ),
    );
    expect(failed).toEqual(new Unavailable({ dependency: "exchange_rates" }));
    expect(list).toEqual([]);
    expect(settlement).toBe("unpaid");
  });

  test("non_vat_payer: no Payment Tax Document", async () => {
    const result = ok(
      await run(
        Effect.flatMap(issuePlainProforma(), (pf) => pay(pf.id, "1000")),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(result.issued).toEqual([]);
    expect(view(result.payment).taxDocument).toBeNull();
  });

  test("D8: a payment on a Proforma with a Final Invoice settles the Final Invoice", async () => {
    const [result, fi, finalSettlement, proformaList, fiList] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* Payments;
          const pf = yield* issuePlainProforma();
          yield* pay(pf.id, "1000");
          const fi = yield* d.issueFinalInvoice(pf.id);
          const result = yield* pay(pf.id);
          return [
            result,
            fi,
            yield* settlementOf(fi.id),
            yield* p.listFor({ document: pf.id }),
            yield* p.listFor({ document: fi.id }),
          ] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(view(result.payment).target).toEqual({ document: fi.id });
    // The Final Invoice owes 2980 - 1000 deducted; the default amount pays it.
    expect(str(view(result.payment).amount.amount)).toBe("1980");
    expect(result.settlement).toBe("paid");
    expect(result.issued).toEqual([]);
    expect(finalSettlement).toBe("paid");
    expect(proformaList).toHaveLength(1);
    expect(fiList).toHaveLength(1);
  });
});

describe("remove", () => {
  test("soft delete: settlement follows, repeat succeeds, reason required and audited", async () => {
    const [before, after, again, blank, history, list] = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const paid = yield* pay(inv.id);
          const id = view(paid.payment).id;
          const before = yield* settlementOf(inv.id);
          yield* p.remove(id, " duplicate import ");
          const after = yield* settlementOf(inv.id);
          const again = yield* Effect.exit(p.remove(id, "again"));
          const blank = yield* Effect.flip(p.remove(id, "  "));
          return [
            before,
            after,
            again,
            blank,
            yield* d.history(inv.id),
            yield* p.listFor({ document: inv.id }),
          ] as const;
        }),
      ),
    );
    expect(before).toBe("paid");
    expect(after).toBe("unpaid");
    expect(Exit.isSuccess(again)).toBe(true);
    // Invalid is missing from the domain `remove` signature (contract gap).
    expect(blank as unknown).toEqual(malformed("reason", "required"));
    const removals = history.filter((e) => e.action === "payment.remove");
    expect(removals).toHaveLength(1);
    expect(removals[0]?.reason).toBe("duplicate import");
    expect(list).toEqual([]);
  });

  test("P3 order: reverse the Final Invoice first, then credit the PTD", async () => {
    const steps = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* Payments;
          const attempt = (id: PaymentId) => Effect.exit(p.remove(id, "chyba"));
          const pf = yield* issueProforma();
          const paid = yield* pay(pf.id, "500");
          const id = view(paid.payment).id;
          const ptd = docId(paid.issued[0] as DocumentView);
          const open = yield* attempt(id);
          const fi = yield* d.issueFinalInvoice(pf.id);
          yield* d.correct(ptd, { reason: "x", lines: "full" }).pipe(Effect.exit);
          const deducted = yield* attempt(id);
          yield* d.correct(fi.id, { reason: "x", lines: "full" });
          const ptdOpen = yield* attempt(id);
          yield* d.correct(ptd, { reason: "x", lines: "full" });
          const done = yield* attempt(id);
          return [open, deducted, ptdOpen, done, yield* settlementOf(pf.id)] as const;
        }),
      ),
    );
    expect(steps[0]).toEqual(Exit.fail(hasTaxDocument));
    expect(steps[1]).toEqual(Exit.fail(hasTaxDocument));
    expect(steps[2]).toEqual(Exit.fail(hasTaxDocument));
    expect(Exit.isSuccess(steps[3])).toBe(true);
    expect(steps[4]).toBe("unpaid");
  });

  test("a cancelled Final Invoice releases a non-payer's advance", async () => {
    const [blocked, released] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* Payments;
          const pf = yield* issuePlainProforma();
          const id = view((yield* pay(pf.id, "500")).payment).id;
          const fi = yield* d.issueFinalInvoice(pf.id);
          const blocked = yield* Effect.exit(p.remove(id, "x"));
          yield* d.cancel(fi.id, { reason: "storno" });
          return [blocked, yield* Effect.exit(p.remove(id, "x"))] as const;
        }),
        { regimeA: "non_vat_payer" },
      ),
    );
    expect(blocked).toEqual(Exit.fail(hasTaxDocument));
    expect(Exit.isSuccess(released)).toBe(true);
  });
});

describe("expense targets", () => {
  test("record, settle, list, remove; audit on the Expense", async () => {
    const result = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const f = yield* PaymentFixtures;
          const store = yield* CoreStore;
          yield* f.putExpense({ workspaceId: WS, id: EXPENSE, currency: CZK, gross: dec("1000") });
          const partial = yield* p.record({ target: { expense: EXPENSE }, amount: czk("400") });
          const rest = yield* p.record({ target: { expense: EXPENSE }, method: "card" });
          const list = yield* p.listFor({ expense: EXPENSE });
          yield* p.remove(view(rest.payment).id, "wrong card");
          const afterRemove = yield* f.expense(WS, EXPENSE);
          const history = yield* store.audit.history(WS, { entity: "Expense", id: EXPENSE });
          return { partial, rest, list, afterRemove, history };
        }),
      ),
    );
    expect(result.partial.settlement).toBe("partially_paid");
    expect(result.rest.settlement).toBe("paid");
    expect(str(view(result.rest.payment).amount.amount)).toBe("600");
    expect(view(result.rest.payment).target).toEqual({ expense: EXPENSE });
    expect(view(result.rest.payment).method).toBe("card");
    expect(result.list).toHaveLength(2);
    expect(result.afterRemove.payments).toBe(1);
    expect(result.afterRemove.settlement).toBe("partially_paid");
    expect(result.history.map((e) => e.action)).toEqual([
      "payment.record",
      "payment.record",
      "payment.remove",
    ]);
    expect(result.history[2]?.reason).toBe("wrong card");
  });

  test("incomplete -> expense.incomplete; currency mismatch -> payment.currency_mismatch", async () => {
    const [incomplete, currency] = ok(
      await run(
        Effect.gen(function* () {
          const p = yield* Payments;
          const f = yield* PaymentFixtures;
          yield* f.putExpense({
            workspaceId: WS,
            id: EXPENSE,
            status: "incomplete",
            currency: null,
            gross: null,
          });
          yield* f.putExpense({
            workspaceId: WS,
            id: EXPENSE_B,
            currency: "EUR" as CurrencyCode,
            gross: dec("10"),
          });
          return [
            yield* Effect.flip(p.record({ target: { expense: EXPENSE } })),
            yield* Effect.flip(p.record({ target: { expense: EXPENSE_B }, amount: czk("1") })),
          ] as const;
        }),
      ),
    );
    expect(incomplete).toEqual(
      new Invalid({ issues: [{ path: ["target"], code: "expense.incomplete" }] }),
    );
    expect(currency).toEqual(mismatch("EUR"));
  });
});

describe("reports read", () => {
  test("paidBetween: live payments in range, both directions, mapped with the target's fx", async () => {
    const rows = ok(
      await run(
        Effect.gen(function* () {
          const f = yield* PaymentFixtures;
          const p = yield* Payments;
          yield* f.putExpense({ workspaceId: WS, id: EXPENSE, currency: CZK, gross: dec("1000") });
          const inv = yield* issueInvoice();
          yield* pay(inv.id, "10", { paidOn: "2026-11-01" as IsoDate });
          const removed = yield* pay(inv.id, "20", { paidOn: "2026-11-02" as IsoDate });
          yield* p.remove(view(removed.payment).id, "x");
          yield* pay(inv.id, "30", { paidOn: "2026-10-31" as IsoDate });
          yield* p.record({ target: { expense: EXPENSE }, amount: czk("5"), paidOn: TODAY });
          const store = yield* CoreStore;
          const repo = yield* PaymentsRepo;
          const live = yield* store.transaction(
            repo.paidBetween(WS, { from: "2026-11-01" as IsoDate, to: TODAY }),
          );
          return live.map((row) => reportPayment(row, null));
        }),
      ),
    );
    expect(rows.map((r) => [r.direction, r.paidOn, str(r.amount.amount)])).toEqual([
      ["in", "2026-11-01", "10"],
      ["out", TODAY, "5"],
    ]);
  });
});
