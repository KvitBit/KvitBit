import { describe, expect, test } from "bun:test";
import type { AttachmentId, ExpenseId, IsoDate } from "@kvitbit/domain/contract";
import {
  Conflict,
  Expenses,
  Forbidden,
  Invalid,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit, Ref } from "effect";
import { decodeSummary } from "../../../src/modules/expenses";
import { CoreStore } from "../../../src/store/CoreStore";
import { FixtureRates, member, WORKSPACE_A } from "../../helpers";
import {
  as,
  bytesOf,
  czkInput,
  expenseId,
  fields,
  ownerB,
  record,
  SUPPLIER_CONTACT,
  SUPPLIER_CONTACT_B,
  scenario,
} from "./fixtures";

const svc = Expenses;
const fmt = (d: BigDecimal.BigDecimal | null | undefined) =>
  d == null ? String(d) : BigDecimal.format(BigDecimal.normalize(d));

const issuesOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((r) => r._tag === "Fail");
  return error?._tag === "Fail" && error.error instanceof Invalid ? error.error.issues : [];
};

describe("Expenses.record", () => {
  test("a complete CZK Expense: supplier Contact link, VAT buckets checked not recalculated, audit", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const view = fields(yield* record(czkInput));
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id: view.id });
        return { view, audit };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const { view, audit } = exit.value;
    expect(view.status).toBe("complete");
    expect(view.revision).toBe(1);
    expect(view.supplier).toEqual({
      contactId: SUPPLIER_CONTACT,
      name: "Dodavatel s.r.o.",
      ico: "27074358",
      dic: "CZ27074358",
    });
    expect(view.totals?.buckets.map((b) => [b.treatment, fmt(b.ratePercent), fmt(b.vat)])).toEqual([
      ["standard", "21", "21"],
    ]);
    expect(fmt(view.totals?.gross.amount)).toBe("121");
    expect(view.fx).toBeNull();
    expect(fmt(view.totalCzk)).toBe("121");
    expect(view.deductibility).toBe("full");
    expect(fmt(view.deductibleVat?.amount)).toBe("21");
    expect(view.payment).toEqual({ settlement: "unpaid", paid: null, payments: 0 });
    expect(audit.map((e) => [e.action, e.revision])).toEqual([["expense.record", 1]]);
  });

  test("status defaults to complete and runs the required-field checks", async () => {
    const exit = await scenario(record({ note: "only a note" }));
    expect(issuesOf(exit).map((i) => [i.code, i.path.join("."), i.params?.reason])).toEqual([
      ["request.malformed", "issuedOn", "required"],
      ["request.malformed", "currency", "required"],
      ["request.malformed", "total", "required"],
    ]);
  });

  test("incomplete skips every check: an empty Expense is valid", async () => {
    const exit = await scenario(
      Effect.map(
        record({ status: "incomplete", vat: [{ treatment: "standard", base: "1", vat: "999" }] }),
        fields,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.status).toBe("incomplete");
    expect(exit.value.totals).toBeNull();
    expect(exit.value.payment.settlement).toBe("unpaid");
  });

  test("the VAT breakdown must add up to the gross", async () => {
    const exit = await scenario(record({ ...czkInput, total: "122.00" }));
    expect(issuesOf(exit)).toEqual([
      {
        path: ["vat"],
        code: "request.malformed",
        params: { reason: "vat_total_mismatch", expected: "122", actual: "121" },
      },
    ]);
  });

  test("non-rated lines carry no supplier VAT; amounts keep the currency's precision", async () => {
    const exit = await scenario(
      record({
        ...czkInput,
        total: "50.005",
        vat: [{ treatment: "outside_scope", base: "45.005", vat: "5" }],
      }),
    );
    expect(issuesOf(exit).map((i) => [i.path.join("."), i.params?.reason])).toEqual([
      ["total", "precision"],
      ["vat.0.base", "precision"],
      ["vat.0.vat", "vat_not_allowed"],
    ]);
  });

  test("a receipt with a single total is one outside_scope bucket", async () => {
    const { vat: _vat, ...input } = czkInput;
    const exit = await scenario(Effect.map(record({ ...input, total: "99.90" }), fields));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.totals?.buckets.map((b) => [b.treatment, fmt(b.base), fmt(b.vat)])).toEqual([
      ["outside_scope", "99.9", "0"],
    ]);
    expect(fmt(exit.value.deductibleVat?.amount)).toBe("0");
  });

  test("malformed open fields are request.malformed", async () => {
    const exit = await scenario(record({ ...czkInput, total: 121 }));
    expect(issuesOf(exit).map((i) => i.code)).toEqual(["request.malformed"]);
  });

  test("idempotency: same key and input replays; a different input conflicts", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const first = yield* record(czkInput, "key-1");
        const again = yield* record(czkInput, "key-1");
        const other = yield* Effect.exit(record({ ...czkInput, note: "changed" }, "key-1"));
        const s = yield* svc;
        const page = yield* s.list({});
        return { first, again, other, count: page.items.length };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.again).toEqual(exit.value.first);
    expect(exit.value.count).toBe(1);
    // The domain tag's `record` omits Conflict; idempotency_mismatch is a domain signature gap.
    expect(exit.value.other as Exit.Exit<unknown, unknown>).toEqual(
      Exit.fail(new Conflict({ reason: "idempotency_mismatch" })),
    );
  });
});

describe("input decoding", () => {
  test("unknown keys and wrong types are request.malformed at their paths", async () => {
    const exit = await scenario(record({ ...czkInput, total: 121, bogus: true }));
    expect(issuesOf(exit).map((i) => [i.code, i.path.join(".")])).toEqual(
      expect.arrayContaining([
        ["request.malformed", "total"],
        ["request.malformed", "bogus"],
      ]),
    );
  });

  test("open fields must be plain JSON", async () => {
    const exit = await scenario(record({ ...czkInput, total: BigDecimal.fromStringUnsafe("121") }));
    expect(issuesOf(exit).map((i) => [i.code, i.path.length])).toEqual([["request.malformed", 0]]);
  });

  test("a reused key with a changed payload conflicts even when the new payload is invalid", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        yield* record(czkInput, "key-2");
        return yield* Effect.exit(record({ ...czkInput, total: "nope" }, "key-2"));
      }),
    );
    expect(exit as Exit.Exit<unknown, unknown>).toEqual(
      Exit.succeed(Exit.fail(new Conflict({ reason: "idempotency_mismatch" }))),
    );
  });

  test("an incomplete Expense shows its total before a currency is chosen", async () => {
    const exit = await scenario(
      Effect.map(record({ status: "incomplete", total: "99.90" }), fields),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(fmt(exit.value.total)).toBe("99.9");
    expect(exit.value.currency).toBeNull();
  });
});

describe("authorization and Workspace scoping", () => {
  test("accountants read but never write", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const view = yield* record(czkInput);
        const id = expenseId(view);
        const s = yield* svc;
        const accountant = member("accountant");
        const read = yield* as(accountant, s.get(id));
        const write = yield* Effect.exit(as(accountant, record(czkInput)));
        const edit = yield* Effect.exit(as(accountant, s.edit(id, { note: "x" }, 1)));
        const remove = yield* Effect.exit(as(accountant, s.remove(id, 1)));
        return { read: fields(read).id === id, write, edit, remove };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        read: true,
        write: Exit.fail(new Forbidden({ action: "expense.write" })),
        edit: Exit.fail(new Forbidden({ action: "expense.write" })),
        remove: Exit.fail(new Forbidden({ action: "expense.write" })),
      }),
    );
  });

  test("a token scoped to expenses:read reads, lists and downloads but cannot write", async () => {
    const reader = member("member", { scopes: ["expenses:read"] });
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record(czkInput));
        const s = yield* svc;
        const att = (yield* s.attach(id, {
          name: "a.pdf",
          contentType: "application/pdf",
          bytes: bytesOf("%PDF-1.7"),
        })) as unknown as { readonly id: AttachmentId };
        yield* as(reader, s.get(id));
        yield* as(reader, s.list({}));
        const download = yield* as(reader, s.attachment(id, att.id));
        expect(download.filename).toBe("a.pdf");
        return yield* Effect.exit(
          as(
            reader,
            s.attach(id, { name: "a.pdf", contentType: "application/pdf", bytes: bytesOf("%PDF") }),
          ),
        );
      }),
    );
    expect(exit).toEqual(Exit.succeed(Exit.fail(new Forbidden({ action: "expense.write" }))));
  });

  test("a token without the expenses scope is Forbidden even for reads", async () => {
    const outsider = member("member", { scopes: ["contacts:read"] });
    const exit = await scenario(
      Effect.gen(function* () {
        const s = yield* svc;
        return yield* as(outsider, s.list({}));
      }),
    );
    expect(exit).toEqual(Exit.fail(new Forbidden({ action: "expense.read" })));
  });

  test("another Workspace's Expense is NotFound for every method", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record(czkInput));
        const s = yield* svc;
        const results = yield* Effect.all(
          [
            s.get(id),
            s.edit(id, { note: "x" }, 1),
            s.remove(id, 1),
            s.attachment(id, id as never),
            s.detach(id, id as never),
          ].map((e) => Effect.exit(as(ownerB, e as Effect.Effect<unknown, unknown, never>))),
        );
        const list = yield* as(ownerB, s.list({}));
        return { results, listed: list.items.length };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    for (const r of exit.value.results) {
      expect(Exit.isFailure(r)).toBe(true);
      expect(JSON.stringify(r)).toContain('"entity":"Expense"');
    }
    expect(exit.value.listed).toBe(0);
  });

  test("a token scoped to expenses links a typed supplier but needs contacts scopes for Contacts", async () => {
    const token = member("member", { scopes: ["expenses:write", "expenses:read"] });
    const exit = await scenario(
      Effect.gen(function* () {
        const byIco = yield* Effect.exit(
          as(token, record({ ...czkInput, supplier: { ico: "27074358" } })),
        );
        const byContact = yield* Effect.exit(as(token, record(czkInput)));
        const manual = yield* Effect.exit(
          as(token, record({ ...czkInput, supplier: { manual: { name: "Shop" } } })),
        );
        return { byIco, byContact, manual: Exit.isSuccess(manual) };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        byIco: Exit.fail(new Forbidden({ action: "contact.write" })),
        byContact: Exit.fail(new Forbidden({ action: "contact.read" })),
        manual: true,
      }),
    );
  });

  test("a supplier Contact of another Workspace is NotFound", async () => {
    const exit = await scenario(record({ ...czkInput, supplier: { contact: SUPPLIER_CONTACT_B } }));
    expect(exit).toEqual(Exit.fail(new NotFound({ entity: "Contact", id: SUPPLIER_CONTACT_B })));
  });

  test("supplier by IČO resolves the supplier Contact; a manual supplier links none", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const byIco = fields(yield* record({ ...czkInput, supplier: { ico: "27074358" } }));
        const manual = fields(
          yield* record({
            ...czkInput,
            supplier: { manual: { name: "Foreign GmbH", dic: "DE123" } },
          }),
        );
        return [byIco.supplier, manual.supplier];
      }),
    );
    expect(exit).toEqual(
      Exit.succeed([
        {
          contactId: SUPPLIER_CONTACT,
          name: "Dodavatel s.r.o.",
          ico: "27074358",
          dic: "CZ27074358",
        },
        { contactId: null, name: "Foreign GmbH", ico: null, dic: "DE123" },
      ]),
    );
  });
});

describe("Expenses.edit and remove", () => {
  test("optimistic revision: a stale expectedRevision is Conflict{revision_changed}", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record(czkInput));
        const s = yield* svc;
        const edited = fields(yield* s.edit(id, { note: "first" }, 1));
        const staleEdit = yield* Effect.exit(s.edit(id, { note: "second" }, 1));
        const staleRemove = yield* Effect.exit(s.remove(id, 1));
        return { revision: edited.revision, note: edited.note, staleEdit, staleRemove };
      }),
    );
    const stale = Exit.fail(new Conflict({ reason: "revision_changed", currentRevision: 2 }));
    expect(exit).toEqual(
      Exit.succeed({ revision: 2, note: "first", staleEdit: stale, staleRemove: stale }),
    );
  });

  test("setting status complete runs the full validation; filling the fields then passes", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* svc;
        const tooEarly = yield* Effect.exit(s.edit(id, { status: "complete" }, 1));
        const done = fields(yield* s.edit(id, { ...czkInput, status: "complete" }, 1));
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id });
        return { tooEarly: issuesOf(tooEarly).length, done, audit };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.tooEarly).toBe(3);
    expect(exit.value.done.status).toBe("complete");
    expect(exit.value.done.revision).toBe(2);
    const editEntry = exit.value.audit[1];
    expect(editEntry?.action).toBe("expense.edit");
    expect(editEntry?.changes.map((c) => c.path)).toContain("status");
    expect(editEntry?.changes.find((c) => c.path === "status")).toEqual({
      path: "status",
      before: "incomplete",
      after: "complete",
    });
  });

  test("null clears a field; an absent field keeps it", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ ...czkInput, note: "keep me" }));
        const s = yield* svc;
        return fields(yield* s.edit(id, { category: null }, 1));
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.category).toBeNull();
    expect(exit.value.note).toBe("keep me");
  });

  test("remove soft-deletes: the Expense is NotFound and leaves the list; audit kept", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record(czkInput));
        const s = yield* svc;
        yield* s.remove(id, 1);
        const get = yield* Effect.exit(s.get(id));
        const again = yield* Effect.exit(s.remove(id, 2));
        const page = yield* s.list({});
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id });
        return { get, again, listed: page.items.length, actions: audit.map((e) => e.action), id };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const nf = Exit.fail(new NotFound({ entity: "Expense", id: exit.value.id }));
    expect(exit.value.get).toEqual(nf);
    expect(exit.value.again).toEqual(nf);
    expect(exit.value.listed).toBe(0);
    expect(exit.value.actions).toEqual(["expense.record", "expense.remove"]);
  });
});

describe("deductibility, reverse charge and FX", () => {
  test("partial and no deductibility scale the claimable input VAT", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const partial = fields(yield* record({ ...czkInput, deductibility: { partial: 33 } }));
        const none = fields(yield* record({ ...czkInput, deductibility: "none" }));
        return [
          partial.deductibility,
          fmt(partial.deductibleVat?.amount),
          fmt(none.deductibleVat?.amount),
        ];
      }),
    );
    // 21 x 33 % = 6.93
    expect(exit).toEqual(Exit.succeed([{ partial: 33 }, "6.93", "0"]));
  });

  test("an out-of-range partial share is malformed", async () => {
    const exit = await scenario(record({ ...czkInput, deductibility: { partial: 100 } }));
    expect(issuesOf(exit).map((i) => i.code)).toEqual(["request.malformed"]);
  });

  test("reverse charge: supplier VAT 0, the recipient self-assesses at the tax point's rate", async () => {
    const exit = await scenario(
      Effect.map(
        record({
          ...czkInput,
          total: "1000.00",
          vat: [
            { treatment: "reverse_charge", base: "600.00" },
            { treatment: "reverse_charge", base: "400.00", selfAssessed: "reduced" },
          ],
        }),
        fields,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const v = exit.value;
    expect(v.totals?.buckets.map((b) => [b.treatment, fmt(b.vat), fmt(b.gross)])).toEqual([
      ["reverse_charge", "0", "1000"],
    ]);
    expect(v.selfAssessed.map((b) => [fmt(b.ratePercent), fmt(b.base), fmt(b.vat)])).toEqual([
      ["21", "600", "126"],
      ["12", "400", "48"],
    ]);
    expect(fmt(v.deductibleVat?.amount)).toBe("174");
  });

  test("selfAssessed is only for self-assessed treatments", async () => {
    const exit = await scenario(
      record({
        ...czkInput,
        vat: [{ treatment: "standard", base: "100.00", vat: "21.00", selfAssessed: "reduced" }],
      }),
    );
    expect(issuesOf(exit).map((i) => [i.path.join("."), i.params?.reason])).toEqual([
      ["vat.0.selfAssessed", "self_assessment_not_allowed"],
    ]);
  });

  test("a non-CZK Expense stores the CNB fixing for its tax point and CZK amounts", async () => {
    const exit = await scenario(
      Effect.map(
        record({
          ...czkInput,
          currency: "EUR",
          total: "121.00",
          // A Sunday tax point carries back to the Friday fixing.
          taxableSupplyOn: "2026-11-22",
        }),
        fields,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const v = exit.value;
    expect(v.fx).toEqual({
      rate: expect.anything(),
      quantity: 1,
      fixingDate: "2026-11-20" as IsoDate,
      source: "cnb",
    });
    expect(fmt(v.fx?.rate)).toBe("25.125");
    // 121 x 25.125 = 3040.125 -> 3040.13; 21 x 25.125 = 527.625 -> 527.63
    expect(fmt(v.totalCzk)).toBe("3040.13");
    expect(fmt(v.totals?.buckets[0]?.vatCzk)).toBe("527.63");
    expect(fmt(v.deductibleVatCzk)).toBe("527.63");
  });

  test("a currency CNB does not quote is fx.rate_missing; rates down is Unavailable unless cached", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const missing = yield* Effect.exit(
          record({ ...czkInput, currency: "USD", taxableSupplyOn: "2026-11-22" }),
        );
        const rates = yield* FixtureRates;
        yield* Ref.set(rates.unavailable, true);
        // The USD attempt fetched the fixing for 2026-11-22: it is read through the cache.
        const cached = yield* Effect.exit(
          record({ ...czkInput, currency: "EUR", taxableSupplyOn: "2026-11-22" }),
        );
        const down = yield* Effect.exit(
          record({ ...czkInput, currency: "EUR", taxableSupplyOn: "2026-11-21" }),
        );
        const czkStillWorks = Exit.isSuccess(yield* Effect.exit(record(czkInput)));
        return {
          missing: issuesOf(missing).map((i) => i.code),
          cachedFixing: Exit.isSuccess(cached) ? fields(cached.value).fx?.fixingDate : null,
          down,
          czkStillWorks,
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        missing: ["fx.rate_missing"],
        cachedFixing: "2026-11-20" as IsoDate,
        down: Exit.fail(new Unavailable({ dependency: "exchange_rates" })),
        czkStillWorks: true,
      }),
    );
  });
});

describe("FX stability and self-assessment scope", () => {
  test("an unrelated edit keeps the stored fixing (no CNB call); a new tax point refetches", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const eur = { ...czkInput, currency: "EUR", taxableSupplyOn: "2026-11-22" };
        const id = expenseId(yield* record(eur));
        const s = yield* Expenses;
        const rates = yield* FixtureRates;
        yield* Ref.set(rates.unavailable, true);
        const noted = fields(yield* s.edit(id, { note: "paid by card" }, 1));
        const moved = yield* Effect.exit(s.edit(id, { taxableSupplyOn: "2026-11-21" }, 2));
        return { fx: noted.fx?.fixingDate, czk: fmt(noted.totalCzk), moved };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        fx: "2026-11-20" as IsoDate,
        czk: "3040.13",
        moved: Exit.fail(new Unavailable({ dependency: "exchange_rates" })),
      }),
    );
  });

  test("a currency change is audited with its new rate and CZK total", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ ...czkInput, taxableSupplyOn: "2026-11-22" }));
        const s = yield* Expenses;
        yield* s.edit(id, { currency: "EUR" }, 1);
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id });
        return audit[1]?.changes.map((c) => c.path);
      }),
    );
    expect(exit).toEqual(Exit.succeed(["currency", "fx", "totalCzk"]));
  });

  test("an intra-EU acquisition of goods is self-assessed like reverse charge", async () => {
    const exit = await scenario(
      Effect.map(
        record({
          ...czkInput,
          total: "500.00",
          vat: [{ treatment: "exempt_intra_eu_goods", base: "500.00", selfAssessed: "reduced" }],
        }),
        fields,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(
      exit.value.selfAssessed.map((b) => [b.treatment, fmt(b.ratePercent), fmt(b.vat)]),
    ).toEqual([["exempt_intra_eu_goods", "12", "60"]]);
    expect(fmt(exit.value.deductibleVat?.amount)).toBe("60");
  });
});

describe("Expenses.list", () => {
  test("pages newest first; incomplete filter; a cursor is bound to its filter", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const a = expenseId(yield* record(czkInput));
        const b = expenseId(yield* record({ status: "incomplete" }));
        const c = expenseId(yield* record(czkInput));
        const s = yield* svc;
        const first = yield* s.list({ limit: 2 });
        const second = yield* s.list({ limit: 2, cursor: first.nextCursor ?? "" });
        const incomplete = yield* s.list({ incomplete: true });
        const mismatch = yield* Effect.exit(
          s.list({ incomplete: true, cursor: first.nextCursor ?? "" }),
        );
        const garbage = yield* Effect.exit(s.list({ cursor: "%%%" }));
        const ids = (p: typeof first) => p.items.map((i) => decodeSummary(i).id as ExpenseId);
        return {
          first: ids(first),
          second: ids(second),
          end: second.nextCursor,
          incomplete: incomplete.items.map((i) => decodeSummary(i).status),
          mismatch: issuesOf(mismatch).map((i) => i.code),
          garbage: issuesOf(garbage).map((i) => i.code),
          expected: [c, b, a],
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const v = exit.value;
    expect(v.first).toEqual(v.expected.slice(0, 2));
    expect(v.second).toEqual(v.expected.slice(2));
    expect(v.end).toBeNull();
    expect(v.incomplete).toEqual(["incomplete"]);
    expect(v.mismatch).toEqual(["page.cursor_mismatch"]);
    expect(v.garbage).toEqual(["request.malformed"]);
  });
});
