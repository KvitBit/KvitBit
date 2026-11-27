import { withoutStackTrace } from "../../helpers/run";
/**
 * Payments (core-ports 4.5) through the `Payments` service on real layers: documents' payments
 * seam, the memory repos and the port fakes (`PaymentsTestLayer`).
 */

import { describe, expect, test } from "bun:test";
import type { Action, DocumentView, PaymentId, PaymentView } from "@kvitbit/domain/contract";
import {
  Conflict,
  CurrencyCode,
  DocumentId,
  Documents,
  ExpenseId,
  Forbidden,
  Invalid,
  IsoDate,
  MoneyMath,
  NotFound,
  Payments,
  RequestKey,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PaymentFixtures,
  PaymentsRepo,
  PaymentViewData,
  reportPayment,
} from "../../../src/modules/payments";
import { CoreStore } from "../../../src/store/CoreStore";
import { account, member, WORKSPACE_B, WORKSPACE_A as WS } from "../../helpers";
import { as, CZK, dec, EUR, fixing, invoiceInput, str } from "../documents/fixtures";
import { run } from "./fixtures";

const TODAY = IsoDate.make("2026-11-23");
const EXPENSE = ExpenseId.make("01900000-0000-7000-8000-0000ee000001");
const EXPENSE_B = ExpenseId.make("01900000-0000-7000-8000-0000ee0000b1");

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const malformed = (path: string, reason: string) =>
  Invalid.make({ issues: [{ path: [path], code: "request.malformed", params: { reason } }] });
const mismatch = (expected: string) =>
  Invalid.make({
    issues: [
      { path: ["amount", "currency"], code: "payment.currency_mismatch", params: { expected } },
    ],
  });
const hasTaxDocument = Conflict.make({
  reason: "illegal_transition",
  detail: "payment.has_tax_document",
});

const czk = (amount: string) => MoneyMath.make(dec(amount), CZK);
const view = (value: PaymentView) =>
  Schema.decodeUnknownOption(PaymentViewData)(value).pipe(Option.getOrThrow);
const docId = (d: DocumentView) => DocumentId.make(d.id);

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

const pay = (document: DocumentId, amount?: string, extra: { paidOn?: IsoDate } = {}) => {
  const target = { document };
  const input =
    amount === undefined ? { target, ...extra } : { target, amount: czk(amount), ...extra };
  return Effect.flatMap(Payments, (payments) => payments.record(input));
};

const settlementOf = (id: DocumentId) =>
  Effect.map(
    Effect.flatMap(Documents, (d) => d.get(id)),
    (v) => v.settlement,
  );

describe("record on documents", () => {
  test("partial, paid and overpaid; the default amount is what is outstanding", async () => {
    const result = ok(
      await run({
        body: Effect.gen(function* () {
          const inv = yield* issueInvoice();
          const first = yield* pay(inv.id, "1000");
          const rest = yield* pay(inv.id);
          const extra = yield* pay(inv.id, "1", { paidOn: IsoDate.make("2026-11-20") });
          const list = yield* Effect.flatMap(Payments, (p) => p.listFor({ document: inv.id }));
          return { first, rest, extra, list, settlement: yield* settlementOf(inv.id) };
        }),
      }),
    );
    expect(result.first.settlement).toBe("partially_paid");
    expect(result.first.issued).toEqual([]);
    expect(result.rest.settlement).toBe("paid");
    view(result.rest.payment).amount.amount.pipe(str, expect).toBe("1980");
    expect(view(result.rest.payment).paidOn).toBe(TODAY);
    expect(view(result.rest.payment).method).toBe("bank_transfer");
    expect(result.extra.settlement).toBe("overpaid");
    expect(result.settlement).toBe("overpaid");
    // Oldest paidOn first.
    expect(EffectArray.map(result.list, (p) => str(view(p).amount.amount))).toEqual([
      "1",
      "1000",
      "1980",
    ]);
  });

  test("P1 currency, positive amounts, and nothing outstanding", async () => {
    const [currency, zero, negative, nothingDue] = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const currencyResult = yield* Effect.flip(
            p.record({ target: { document: inv.id }, amount: MoneyMath.make(dec("10"), EUR) }),
          );
          const zeroResult = yield* Effect.flip(pay(inv.id, "0"));
          const negativeResult = yield* Effect.flip(pay(inv.id, "-5"));
          yield* pay(inv.id);
          const nothingDueResult = yield* Effect.flip(pay(inv.id));
          return [currencyResult, zeroResult, negativeResult, nothingDueResult] as const;
        }),
      }),
    );
    expect(currency).toEqual(mismatch("CZK"));
    expect(zero).toEqual(malformed("amount", "out_of_range"));
    expect(negative).toEqual(malformed("amount", "out_of_range"));
    expect(nothingDue).toEqual(malformed("amount", "required"));
  });

  test("drafts, credit notes and cancelled documents take no payments", async () => {
    const [draft, creditNote] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const draftResult = yield* d.createDraft(invoiceInput());
          const inv = yield* issueInvoice();
          const cn = yield* d.correct(inv.id, { reason: "storno", lines: "full" });
          return [
            yield* Effect.flip(pay(draftResult.id, "10")),
            yield* Effect.flip(pay(cn.id, "10")),
          ] as const;
        }),
      }),
    );
    expect(draft).toBeInstanceOf(Conflict);
    expect(creditNote).toEqual(Conflict.make({ reason: "illegal_transition" }));
  });

  test("state before amounts: credited and cancelled targets conflict; a locked one takes payments (P4)", async () => {
    const [credited, cancelled, locked] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const a = yield* issueInvoice();
          yield* d.correct(a.id, { reason: "storno", lines: "full" });
          const b = yield* issueInvoice();
          yield* d.cancel(b.id, { reason: "chyba" });
          const c = yield* issueInvoice();
          yield* d.lock(c.id);
          return [
            yield* Effect.flip(pay(a.id)),
            yield* Effect.flip(pay(b.id, "10")),
            yield* pay(c.id),
          ] as const;
        }),
      }),
    );
    expect(credited).toEqual(Conflict.make({ reason: "illegal_transition" }));
    expect(cancelled).toEqual(Conflict.make({ reason: "illegal_transition" }));
    expect(locked.settlement).toBe("paid");
  });

  test("amount bounds: minor unit scale and the numeric(18,2) range, checked under the key", async () => {
    const key = { requestKey: RequestKey.make("bank-tx-2") };
    const [fraction, huge, replayInvalid] = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const fractionResult = yield* Effect.flip(pay(inv.id, "0.001"));
          const hugeResult = yield* Effect.flip(pay(inv.id, "10000000000000000"));
          yield* p.record({ target: { document: inv.id }, amount: czk("10") }, key);
          const replayInvalidResult = yield* Effect.flip(
            p.record({ target: { document: inv.id }, amount: czk("0.001") }, key),
          );
          return [fractionResult, hugeResult, replayInvalidResult] as const;
        }),
      }),
    );
    expect(fraction).toEqual(malformed("amount", "out_of_range"));
    expect(huge).toEqual(malformed("amount", "out_of_range"));
    expect(replayInvalid).toEqual(Conflict.make({ reason: "idempotency_mismatch" }));
  });

  test("the method defaults to the document's printed payment method (C4)", async () => {
    const result = ok(
      await run({
        body: Effect.flatMap(issueInvoice({ paymentMethod: "cash" }), (inv) => pay(inv.id)),
      }),
    );
    expect(view(result.payment).method).toBe("cash");
  });

  test("audit: one entry on the Document with the payment's particulars; revision bumps (C2)", async () => {
    const [history, stale, payment] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const result = yield* pay(inv.id, "100");
          const staleResult = yield* Effect.flip(d.edit(inv.id, { note: "x" }, inv.revision));
          return [yield* d.history(inv.id), staleResult, view(result.payment)] as const;
        }),
      }),
    );
    const entries = EffectArray.filter(history, (e) => e.action === "payment.record");
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
      },
    });
    expect(stale).toBeInstanceOf(Conflict);
    expect(Schema.is(Conflict)(stale) && stale.reason).toBe("revision_changed");
  });

  test("idempotency (C3): a replay returns the stored result; another payload is a mismatch", async () => {
    const key = { requestKey: RequestKey.make("bank-tx-1") };
    const [first, replay, mismatched, rows] = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const input = { target: { document: inv.id }, amount: czk("500") };
          const firstResult = yield* p.record(input, key);
          const replayResult = yield* p.record(input, key);
          const mismatchedResult = yield* Effect.flip(
            p.record({ ...input, amount: czk("501") }, key),
          );
          return [
            firstResult,
            replayResult,
            mismatchedResult,
            yield* p.listFor({ document: inv.id }),
          ] as const;
        }),
      }),
    );
    expect(view(replay.payment).id).toBe(view(first.payment).id);
    expect(replay.settlement).toBe(first.settlement);
    expect(mismatched).toEqual(Conflict.make({ reason: "idempotency_mismatch" }));
    expect(rows).toHaveLength(1);
  });
});

describe("authorization and tenancy", () => {
  test("payment.write for record/remove, payment.read for listFor, per role and scope", async () => {
    const results = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const inv = yield* issueInvoice();
          const paid = yield* pay(inv.id, "10");
          const id = view(paid.payment).id;
          const attempt = (caller: Parameters<typeof as>[0]) =>
            Effect.all(
              {
                record: Effect.exit(as(caller, pay(inv.id, "1"))),
                remove: Effect.exit(as(caller, p.remove(id, "x"))),
                list: Effect.exit(as(caller, p.listFor({ document: inv.id }))),
              },
              { concurrency: 1 },
            );
          return {
            accountant: yield* attempt(member("accountant")),
            readToken: yield* attempt(member("member", { scopes: ["payments:read"] })),
            documentsToken: yield* attempt(member("admin", { scopes: ["documents:write"] })),
            account: yield* attempt(account()),
          };
        }),
      }),
    );
    const forbidden = (action: Action) => Exit.fail(Forbidden.make({ action }));
    expect(results.accountant.record.pipe(withoutStackTrace)).toEqual(forbidden("payment.write"));
    expect(results.accountant.remove.pipe(withoutStackTrace)).toEqual(forbidden("payment.write"));
    expect(Exit.isSuccess(results.accountant.list)).toBe(true);
    expect(results.readToken.record.pipe(withoutStackTrace)).toEqual(forbidden("payment.write"));
    expect(Exit.isSuccess(results.readToken.list)).toBe(true);
    expect(results.documentsToken.record.pipe(withoutStackTrace)).toEqual(
      forbidden("payment.write"),
    );
    expect(results.documentsToken.list.pipe(withoutStackTrace)).toEqual(forbidden("payment.read"));
    expect(results.account.record.pipe(withoutStackTrace)).toEqual(forbidden("payment.write"));
    expect(results.account.list.pipe(withoutStackTrace)).toEqual(forbidden("payment.read"));
  });

  test("a payments-scoped token may record", async () => {
    const result = ok(
      await run({
        body: Effect.gen(function* () {
          const inv = yield* issueInvoice();
          return yield* as(member("member", { scopes: ["payments:write"] }), pay(inv.id, "10"));
        }),
      }),
    );
    expect(result.settlement).toBe("partially_paid");
  });

  test("another Workspace's document, expense and payment are NotFound", async () => {
    const other = member("owner", { workspaceId: WORKSPACE_B });
    const results = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const f = yield* PaymentFixtures;
          yield* f.putExpense({ workspaceId: WS, id: EXPENSE, currency: CZK, gross: dec("100") });
          const inv = yield* issueInvoice();
          const paid = yield* pay(inv.id, "10");
          const id = view(paid.payment).id;
          return yield* as(
            other,
            Effect.all(
              [
                Effect.flip(pay(inv.id, "1")),
                Effect.flip(p.listFor({ document: inv.id })),
                Effect.flip(p.remove(id, "x")),
                Effect.flip(p.record({ target: { expense: EXPENSE }, amount: czk("1") })),
                Effect.flip(p.listFor({ expense: EXPENSE })),
              ],
              { concurrency: 1 },
            ),
          );
        }),
      }),
    );
    expect(results[0]).toBeInstanceOf(NotFound);
    expect(Schema.is(NotFound)(results[0]) && results[0].entity).toBe("Document");
    expect(results[1]).toBeInstanceOf(NotFound);
    const removal = results[2];
    if (!Schema.is(NotFound)(removal)) throw new Error("Expected removal to fail with NotFound");
    expect(removal).toEqual(NotFound.make({ entity: "Payment", id: removal.id }));
    expect(Schema.is(NotFound)(results[3]) && results[3].entity).toBe("Expense");
    expect(Schema.is(NotFound)(results[4]) && results[4].entity).toBe("Expense");
  });
});

describe("Proformas: Payment Tax Documents (P2) and the Final Invoice (D8)", () => {
  test("a vat_payer Proforma payment issues a PTD in the same transaction, linked to the payment", async () => {
    const [result, rows, sent, history] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const pf = yield* issueProforma();
          const resultResult = yield* pay(pf.id, "1000");
          const repo = yield* PaymentsRepo;
          const store = yield* CoreStore;
          const rowsResult = yield* store.transaction(repo.liveFor(WS, { document: pf.id }));
          const id = view(resultResult.payment).id;
          yield* d.correct(docId(EffectArray.getUnsafe(resultResult.issued, 0)), {
            reason: "x",
            lines: "full",
          });
          yield* (yield* Payments).remove(id, "chyba");
          const historyResult = yield* d.history(pf.id);
          return [
            resultResult,
            rowsResult,
            yield* (yield* PaymentFixtures).sent(WS),
            historyResult,
          ] as const;
        }),
      }),
    );
    expect(result.issued).toHaveLength(1);
    const ptd = EffectArray.getUnsafe(result.issued, 0);
    expect(ptd.kind).toBe("payment_tax_document");
    expect(view(result.payment).taxDocument).toBe(docId(ptd));
    expect(rows[0]?.taxDocumentId).toBe(docId(ptd));
    expect(result.settlement).toBe("partially_paid");
    // autoSendPaymentTaxDocument is off by default.
    expect(sent).toEqual([]);
    // record's particulars precede the PTD; remove's name it.
    const particularsOf = (action: string) =>
      EffectArray.findFirst(history, (e) => e.action === action).pipe(
        Option.flatMap((entry) =>
          EffectArray.findFirst(entry.changes, (change) => change.path === "payment"),
        ),
        Option.getOrUndefined,
      );
    expect(particularsOf("payment.record")?.after).not.toHaveProperty("taxDocument");
    expect(particularsOf("payment.remove")?.before).toMatchObject({ taxDocument: docId(ptd) });
  });

  test("auto-send: on, the PTD is sent in the transaction; a caller who may not send still records", async () => {
    const [own, token, sent] = ok(
      await run({
        body: Effect.gen(function* () {
          const f = yield* PaymentFixtures;
          yield* f.setAutoSend(WS, true);
          const pf = yield* issueProforma();
          const ownResult = yield* pay(pf.id, "100");
          const tokenResult = yield* as(
            member("member", { scopes: ["payments:write"] }),
            pay(pf.id, "100"),
          );
          return [ownResult, tokenResult, yield* f.sent(WS)] as const;
        }),
      }),
    );
    expect(sent).toEqual([docId(EffectArray.getUnsafe(own.issued, 0))]);
    expect(token.issued).toHaveLength(1);
  });

  test("one transaction: a PTD that cannot be issued rolls the payment back", async () => {
    const [failed, list, settlement] = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const pf = yield* issueInvoice({ kind: "proforma", currency: EUR });
          // No CNB fixing on or before paidOn: the PTD's fx is unavailable.
          const failedResult = yield* Effect.flip(
            p.record({
              target: { document: pf.id },
              amount: MoneyMath.make(dec("10"), EUR),
              paidOn: IsoDate.make("2026-11-01"),
            }),
          );
          return [
            failedResult,
            yield* p.listFor({ document: pf.id }),
            yield* settlementOf(pf.id),
          ] as const;
        }),
        fixings: [fixing("2026-11-23", "25.000")],
      }),
    );
    expect(failed).toEqual(Unavailable.make({ dependency: "exchange_rates" }));
    expect(list).toEqual([]);
    expect(settlement).toBe("unpaid");
  });

  test("auto-send skips are audited on the PTD; a refused send keeps the payment and its PTD", async () => {
    const [token, refused, illegal, sent, tokenHistory, refusedHistory, illegalHistory, list] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const f = yield* PaymentFixtures;
          yield* f.setAutoSend(WS, true);
          const pf = yield* issueProforma();
          const tokenResult = yield* as(
            member("member", { scopes: ["payments:write"] }),
            pay(pf.id, "100"),
          );
          yield* f.failSends(
            Invalid.make({
              issues: [{ path: ["to"], code: "request.malformed", params: { reason: "required" } }],
            }),
          );
          const refusedResult = yield* pay(pf.id, "100");
          yield* f.failSends(Conflict.make({ reason: "illegal_transition" }));
          const illegalResult = yield* pay(pf.id, "100");
          const ptdOf = (r: typeof tokenResult) => docId(EffectArray.getUnsafe(r.issued, 0));
          return [
            tokenResult,
            refusedResult,
            illegalResult,
            yield* f.sent(WS),
            yield* d.history(ptdOf(tokenResult)),
            yield* d.history(ptdOf(refusedResult)),
            yield* d.history(ptdOf(illegalResult)),
            yield* (yield* Payments).listFor({ document: pf.id }),
          ] as const;
        }),
      }),
    );
    const skip = (h: typeof tokenHistory) =>
      Option.getOrUndefined(
        EffectArray.findFirst(h, (e) => e.action === "payment.autoSendSkipped"),
      );
    expect(skip(tokenHistory)?.reason).toBe("caller_cannot_send");
    expect(skip(refusedHistory)?.reason).toBe("Invalid:to:request.malformed");
    expect(skip(illegalHistory)?.reason).toBe("Conflict:illegal_transition");
    expect(refused.issued).toHaveLength(1);
    expect(illegal.issued).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(list).toHaveLength(3);
    expect(token.settlement).toBe("partially_paid");
  });

  test("auto-send: an invariant failure of the sender rolls the whole payment back", async () => {
    const [missing, stale, invalid, linesInvalid, list, sent, ptds] = ok(
      await run({
        body: Effect.gen(function* () {
          const f = yield* PaymentFixtures;
          yield* f.setAutoSend(WS, true);
          const pf = yield* issueProforma();
          yield* f.failSends(NotFound.make({ entity: "Document", id: pf.id }));
          const missingResult = yield* Effect.flip(pay(pf.id, "100"));
          yield* f.failSends(Conflict.make({ reason: "revision_changed", currentRevision: 9 }));
          const staleResult = yield* Effect.flip(pay(pf.id, "100"));
          // An Invalid that is not (only) about recipients is a document failure, not a skip.
          const linesInvalidResult = Invalid.make({
            issues: [
              { path: ["to"], code: "request.malformed" },
              { path: ["lines"], code: "document.lines_required" },
            ],
          });
          yield* f.failSends(linesInvalidResult);
          const invalidResult = yield* Effect.flip(pay(pf.id, "100"));
          return [
            missingResult,
            staleResult,
            invalidResult,
            linesInvalidResult,
            yield* (yield* Payments).listFor({ document: pf.id }),
            yield* f.sent(WS),
            yield* (yield* Documents).list({ kind: "payment_tax_document", limit: 10 }),
          ] as const;
        }),
      }),
    );
    // No orphaned Payment Tax Document either.
    expect(ptds.items).toEqual([]);
    expect(missing).toBeInstanceOf(NotFound);
    expect(stale).toEqual(Conflict.make({ reason: "revision_changed", currentRevision: 9 }));
    expect(invalid).toEqual(linesInvalid);
    expect(list).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a keyed replay on a vat_payer Proforma returns the same PTD and sends once", async () => {
    const key = { requestKey: RequestKey.make("bank-tx-3") };
    const [first, replay, sent] = ok(
      await run({
        body: Effect.gen(function* () {
          const f = yield* PaymentFixtures;
          const p = yield* Payments;
          yield* f.setAutoSend(WS, true);
          const pf = yield* issueProforma();
          const input = { target: { document: pf.id }, amount: czk("100") };
          const firstResult = yield* p.record(input, key);
          const replayResult = yield* p.record(input, key);
          return [firstResult, replayResult, yield* f.sent(WS)] as const;
        }),
      }),
    );
    const ptd = docId(EffectArray.getUnsafe(first.issued, 0));
    expect(docId(EffectArray.getUnsafe(replay.issued, 0))).toBe(ptd);
    expect(view(replay.payment).taxDocument).toBe(ptd);
    expect(sent).toEqual([ptd]);
  });

  test("non_vat_payer: no Payment Tax Document", async () => {
    const result = ok(
      await run({
        body: Effect.flatMap(issuePlainProforma(), (pf) => pay(pf.id, "1000")),
        regimeA: "non_vat_payer",
      }),
    );
    expect(result.issued).toEqual([]);
    expect(view(result.payment).taxDocument).toBeNull();
  });

  test("D8: a payment on a Proforma with a Final Invoice settles the Final Invoice", async () => {
    const [result, fi, finalSettlement, proformaList, fiList] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* Payments;
          const pf = yield* issuePlainProforma();
          yield* pay(pf.id, "1000");
          const fiResult = yield* d.issueFinalInvoice(pf.id);
          const resultResult = yield* pay(pf.id);
          return [
            resultResult,
            fiResult,
            yield* settlementOf(fiResult.id),
            yield* p.listFor({ document: pf.id }),
            yield* p.listFor({ document: fiResult.id }),
          ] as const;
        }),
        regimeA: "non_vat_payer",
      }),
    );
    expect(view(result.payment).target).toEqual({ document: fi.id });
    // The Final Invoice owes 2980 - 1000 deducted; the default amount pays it.
    view(result.payment).amount.amount.pipe(str, expect).toBe("1980");
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
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const d = yield* Documents;
          const inv = yield* issueInvoice();
          const paid = yield* pay(inv.id);
          const id = view(paid.payment).id;
          const beforeResult = yield* settlementOf(inv.id);
          yield* p.remove(id, " duplicate import ");
          const afterResult = yield* settlementOf(inv.id);
          const againResult = yield* Effect.exit(p.remove(id, "again"));
          const blankResult = yield* Effect.flip(p.remove(id, "  "));
          return [
            beforeResult,
            afterResult,
            againResult,
            blankResult,
            yield* d.history(inv.id),
            yield* p.listFor({ document: inv.id }),
          ] as const;
        }),
      }),
    );
    expect(before).toBe("paid");
    expect(after).toBe("unpaid");
    expect(Exit.isSuccess(again)).toBe(true);
    // A blank reason fails with Invalid.
    expect(blank).toEqual(malformed("reason", "required"));
    const removals = EffectArray.filter(history, (e) => e.action === "payment.remove");
    expect(removals).toHaveLength(1);
    expect(removals[0]?.reason).toBe("duplicate import");
    expect(list).toEqual([]);
  });

  test("P3 order: reverse the Final Invoice first, then credit the PTD", async () => {
    const steps = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* Payments;
          const attempt = (idInput: PaymentId) => Effect.exit(p.remove(idInput, "chyba"));
          const pf = yield* issueProforma();
          const paid = yield* pay(pf.id, "500");
          const id = view(paid.payment).id;
          const ptd = docId(EffectArray.getUnsafe(paid.issued, 0));
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
      }),
    );
    expect(steps[0].pipe(withoutStackTrace)).toEqual(Exit.fail(hasTaxDocument));
    expect(steps[1].pipe(withoutStackTrace)).toEqual(Exit.fail(hasTaxDocument));
    expect(steps[2].pipe(withoutStackTrace)).toEqual(Exit.fail(hasTaxDocument));
    expect(Exit.isSuccess(steps[3])).toBe(true);
    expect(steps[4]).toBe("unpaid");
  });

  test("a cancelled Final Invoice releases a non-payer's advance", async () => {
    const [blocked, released] = ok(
      await run({
        body: Effect.gen(function* () {
          const d = yield* Documents;
          const p = yield* Payments;
          const pf = yield* issuePlainProforma();
          const id = view((yield* pay(pf.id, "500")).payment).id;
          const fi = yield* d.issueFinalInvoice(pf.id);
          const blockedResult = yield* Effect.exit(p.remove(id, "x"));
          yield* d.cancel(fi.id, { reason: "storno" });
          return [blockedResult, yield* Effect.exit(p.remove(id, "x"))] as const;
        }),
        regimeA: "non_vat_payer",
      }),
    );
    expect(blocked.pipe(withoutStackTrace)).toEqual(Exit.fail(hasTaxDocument));
    expect(Exit.isSuccess(released)).toBe(true);
  });
});

describe("expense targets", () => {
  test("record, settle, list, remove; audit on the Expense", async () => {
    const result = ok(
      await run({
        body: Effect.gen(function* () {
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
      }),
    );
    expect(result.partial.settlement).toBe("partially_paid");
    expect(result.rest.settlement).toBe("paid");
    view(result.rest.payment).amount.amount.pipe(str, expect).toBe("600");
    expect(view(result.rest.payment).target).toEqual({ expense: EXPENSE });
    expect(view(result.rest.payment).method).toBe("card");
    expect(result.list).toHaveLength(2);
    expect(result.afterRemove.payments).toBe(1);
    expect(result.afterRemove.settlement).toBe("partially_paid");
    expect(EffectArray.map(result.history, (e) => e.action)).toEqual([
      "payment.record",
      "payment.record",
      "payment.remove",
    ]);
    expect(result.history[2]?.reason).toBe("wrong card");
  });

  test("amounts never exceed the column's two decimals, even for a three-decimal currency", async () => {
    const KWD = CurrencyCode.make("KWD");
    const [tooFine, ok2] = ok(
      await run({
        body: Effect.gen(function* () {
          const p = yield* Payments;
          const f = yield* PaymentFixtures;
          yield* f.putExpense({ workspaceId: WS, id: EXPENSE, currency: KWD, gross: dec("10") });
          const record = (amount: string) =>
            p.record({ target: { expense: EXPENSE }, amount: MoneyMath.make(dec(amount), KWD) });
          return [yield* Effect.flip(record("1.001")), yield* record("1.01")] as const;
        }),
      }),
    );
    expect(tooFine).toEqual(malformed("amount", "out_of_range"));
    expect(ok2.settlement).toBe("partially_paid");
  });

  test("incomplete -> expense.incomplete; currency mismatch -> payment.currency_mismatch", async () => {
    const [incomplete, currency] = ok(
      await run({
        body: Effect.gen(function* () {
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
            currency: CurrencyCode.make("EUR"),
            gross: dec("10"),
          });
          return [
            yield* Effect.flip(p.record({ target: { expense: EXPENSE } })),
            yield* Effect.flip(p.record({ target: { expense: EXPENSE_B }, amount: czk("1") })),
          ] as const;
        }),
      }),
    );
    expect(incomplete).toEqual(
      Invalid.make({ issues: [{ path: ["target"], code: "expense.incomplete" }] }),
    );
    expect(currency).toEqual(mismatch("EUR"));
  });
});

describe("reports read", () => {
  test("paidBetween: live payments in range, both directions, mapped with the target's fx", async () => {
    const rows = ok(
      await run({
        body: Effect.gen(function* () {
          const f = yield* PaymentFixtures;
          const p = yield* Payments;
          yield* f.putExpense({ workspaceId: WS, id: EXPENSE, currency: CZK, gross: dec("1000") });
          const inv = yield* issueInvoice();
          yield* pay(inv.id, "10", { paidOn: IsoDate.make("2026-11-01") });
          const removed = yield* pay(inv.id, "20", { paidOn: IsoDate.make("2026-11-02") });
          yield* p.remove(view(removed.payment).id, "x");
          yield* pay(inv.id, "30", { paidOn: IsoDate.make("2026-10-31") });
          yield* p.record({ target: { expense: EXPENSE }, amount: czk("5"), paidOn: TODAY });
          const store = yield* CoreStore;
          const repo = yield* PaymentsRepo;
          const live = yield* store.transaction(
            repo.paidBetween(WS, { from: IsoDate.make("2026-11-01"), to: TODAY }),
          );
          return EffectArray.map(live, (row) => reportPayment(row, null));
        }),
      }),
    );
    expect(EffectArray.map(rows, (r) => [r.direction, r.paidOn, str(r.amount.amount)])).toEqual([
      ["in", "2026-11-01", "10"],
      ["out", TODAY, "5"],
    ]);
  });
});
