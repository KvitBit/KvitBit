import { describe, expect, test } from "bun:test";
import type { CoreError, Issue } from "@kvitbit/domain/contract";
import {
  AttachmentId,
  Conflict,
  ExpenseId,
  Expenses,
  Forbidden,
  IsoDate,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { decodeSummary } from "../../../src/modules/expenses";
import { CoreStore } from "../../../src/store/CoreStore";
import { FixtureRates, member, WORKSPACE_A } from "../../helpers";
import { withoutStackTrace } from "../../helpers/run";
import {
  asCaller,
  attachmentFields,
  bytesOf,
  czkInput,
  expenseId,
  fields,
  ownerB,
  record,
  recordWithKey,
  SUPPLIER_CONTACT,
  SUPPLIER_CONTACT_B,
  scenario,
} from "./fixtures";

const fmt = (d: BigDecimal.BigDecimal | null | undefined) =>
  d === null || d === undefined ? String(d) : d.pipe(BigDecimal.normalize, BigDecimal.format);

const issuesOf = (exit: Exit.Exit<unknown, CoreError>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.pipe(Exit.findErrorOption, Option.getOrUndefined);
  return error?._tag === "Invalid" ? error.issues : [];
};

const issuePath = (path: Issue["path"]) => {
  const segments = EffectArray.map(path, String);
  return EffectArray.join(segments, ".");
};

describe("Expenses.record", () => {
  test("a complete CZK Expense: supplier Contact link, VAT buckets checked not recalculated, audit", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record(czkInput);
        const view = fields(result);
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
    const buckets = view.totals?.buckets ?? [];
    expect(EffectArray.map(buckets, (b) => [b.treatment, fmt(b.ratePercent), fmt(b.vat)])).toEqual([
      ["standard", "21", "21"],
    ]);
    expect(fmt(view.totals?.gross.amount)).toBe("121");
    expect(view.fx).toBeNull();
    expect(fmt(view.totalCzk)).toBe("121");
    expect(view.deductibility).toBe("full");
    expect(fmt(view.deductibleVat?.amount)).toBe("21");
    expect(view.payment).toEqual({ settlement: "unpaid", paid: null, payments: 0 });
    expect(EffectArray.map(audit, (e) => [e.action, e.revision])).toEqual([["expense.record", 1]]);
  });

  test("status defaults to complete and runs the required-field checks", async () => {
    const exit = await scenario(record({ note: "only a note" }));
    const issues = issuesOf(exit);
    expect(
      EffectArray.map(issues, (i) => [i.code, issuePath(i.path), i.params?.["reason"]]),
    ).toEqual([
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
    const issues = issuesOf(exit);
    expect(issues).toEqual([
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
    const issues = issuesOf(exit);
    expect(EffectArray.map(issues, (i) => [issuePath(i.path), i.params?.["reason"]])).toEqual([
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
    const buckets = exit.value.totals?.buckets ?? [];
    expect(EffectArray.map(buckets, (b) => [b.treatment, fmt(b.base), fmt(b.vat)])).toEqual([
      ["outside_scope", "99.9", "0"],
    ]);
    expect(fmt(exit.value.deductibleVat?.amount)).toBe("0");
  });

  test("malformed open fields are request.malformed", async () => {
    const exit = await scenario(record({ ...czkInput, total: 121 }));
    const issues = issuesOf(exit);
    expect(EffectArray.map(issues, (i) => i.code)).toEqual(["request.malformed"]);
  });

  test("idempotency: same key and input replays; a different input conflicts", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const recordWithRequestKey = recordWithKey("key-1");
        const first = yield* recordWithRequestKey(czkInput);
        const again = yield* recordWithRequestKey(czkInput);
        const other = yield* Effect.exit(recordWithRequestKey({ ...czkInput, note: "changed" }));
        const s = yield* Expenses;
        const page = yield* s.list({});
        return { first, again, other, count: page.items.length };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.again).toEqual(exit.value.first);
    expect(exit.value.count).toBe(1);
    // The same key with a different payload is Conflict{idempotency_mismatch} (rule C3).
    expect(exit.value.other.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "idempotency_mismatch" })),
    );
  });
});

describe("input decoding", () => {
  test("unknown keys and wrong types are request.malformed at their paths", async () => {
    const exit = await scenario(record({ ...czkInput, total: 121, bogus: true }));
    const issues = issuesOf(exit);
    expect(EffectArray.map(issues, (i) => [i.code, issuePath(i.path)])).toEqual(
      expect.arrayContaining([
        ["request.malformed", "total"],
        ["request.malformed", "bogus"],
      ]),
    );
  });

  test("open fields must be plain JSON", async () => {
    const exit = await scenario(record({ ...czkInput, total: BigDecimal.fromStringUnsafe("121") }));
    const issues = issuesOf(exit);
    expect(EffectArray.map(issues, (i) => [i.code, i.path.length])).toEqual([
      ["request.malformed", 0],
    ]);
  });

  test("a reused key with a changed payload conflicts even when the new payload is invalid", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const recordWithRequestKey = recordWithKey("key-2");
        yield* recordWithRequestKey(czkInput);
        return yield* Effect.exit(recordWithRequestKey({ ...czkInput, total: "nope" }));
      }),
    );
    expect(exit).toEqual(
      Conflict.make({ reason: "idempotency_mismatch" }).pipe(Exit.fail, Exit.succeed),
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
        const s = yield* Expenses;
        const asAccountant = asCaller(member("accountant"));
        const read = yield* s.get(id).pipe(asAccountant);
        const write = yield* record(czkInput).pipe(asAccountant, Effect.exit);
        const edit = yield* s.edit(id, { note: "x" }, 1).pipe(asAccountant, Effect.exit);
        const remove = yield* s.remove(id, 1).pipe(asAccountant, Effect.exit);
        return { read: fields(read).id === id, write, edit, remove };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        read: true,
        write: Exit.fail(Forbidden.make({ action: "expense.write" })),
        edit: Exit.fail(Forbidden.make({ action: "expense.write" })),
        remove: Exit.fail(Forbidden.make({ action: "expense.write" })),
      }),
    );
  });

  test("a token scoped to expenses:read reads, lists and downloads but cannot write", async () => {
    const asReader = asCaller(member("member", { scopes: ["expenses:read"] }));
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const s = yield* Expenses;
        const attached = yield* s.attach(id, {
          name: "a.pdf",
          contentType: "application/pdf",
          bytes: bytesOf("%PDF-1.7"),
        });
        const att = yield* attachmentFields(attached);
        yield* s.get(id).pipe(asReader);
        yield* s.list({}).pipe(asReader);
        const download = yield* s.attachment(id, att.id).pipe(asReader);
        expect(download.filename).toBe("a.pdf");
        return yield* s
          .attach(id, { name: "a.pdf", contentType: "application/pdf", bytes: bytesOf("%PDF") })
          .pipe(asReader, Effect.exit);
      }),
    );
    expect(exit).toEqual(Forbidden.make({ action: "expense.write" }).pipe(Exit.fail, Exit.succeed));
  });

  test("a token without the expenses scope is Forbidden even for reads", async () => {
    const outsider = member("member", { scopes: ["contacts:read"] });
    const exit = await scenario(
      Effect.gen(function* () {
        const s = yield* Expenses;
        return yield* s.list({}).pipe(asCaller(outsider));
      }),
    );
    expect(exit.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "expense.read" })),
    );
  });

  test("another Workspace's Expense is NotFound for every method", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const s = yield* Expenses;
        const attachmentId = AttachmentId.make(id);
        const asForeignOwner = asCaller(ownerB);
        const results = yield* Effect.forEach(
          [
            s.get(id),
            s.edit(id, { note: "x" }, 1),
            s.remove(id, 1),
            s.attachment(id, attachmentId),
            s.detach(id, attachmentId),
          ],
          (operation) => operation.pipe(asForeignOwner, Effect.exit),
          { concurrency: 1 },
        );
        const list = yield* s.list({}).pipe(asForeignOwner);
        return { results, listed: list.items.length, id };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    for (const r of exit.value.results) {
      expect(Exit.isFailure(r)).toBe(true);
      expect(r.pipe(withoutStackTrace)).toEqual(
        Exit.fail(NotFound.make({ entity: "Expense", id: exit.value.id })),
      );
    }
    expect(exit.value.listed).toBe(0);
  });

  test("a token scoped to expenses links a typed supplier but needs contacts scopes for Contacts", async () => {
    const asToken = asCaller(member("member", { scopes: ["expenses:write", "expenses:read"] }));
    const exit = await scenario(
      Effect.gen(function* () {
        const byIco = yield* record({ ...czkInput, supplier: { ico: "27074358" } }).pipe(
          asToken,
          Effect.exit,
        );
        const byContact = yield* record(czkInput).pipe(asToken, Effect.exit);
        const manual = yield* record({ ...czkInput, supplier: { manual: { name: "Shop" } } }).pipe(
          asToken,
          Effect.exit,
        );
        return {
          byIco: byIco.pipe(withoutStackTrace),
          byContact: byContact.pipe(withoutStackTrace),
          manual: Exit.isSuccess(manual),
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        byIco: Exit.fail(Forbidden.make({ action: "contact.write" })),
        byContact: Exit.fail(Forbidden.make({ action: "contact.read" })),
        manual: true,
      }),
    );
  });

  test("a supplier Contact of another Workspace is NotFound", async () => {
    const exit = await scenario(record({ ...czkInput, supplier: { contact: SUPPLIER_CONTACT_B } }));
    expect(exit.pipe(withoutStackTrace)).toEqual(
      Exit.fail(NotFound.make({ entity: "Contact", id: SUPPLIER_CONTACT_B })),
    );
  });

  test("supplier by IČO resolves the supplier Contact; a manual supplier links none", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ ...czkInput, supplier: { ico: "27074358" } });
        const byIco = fields(result);
        const result2 = yield* record({
          ...czkInput,
          supplier: { manual: { name: "Foreign GmbH", dic: "DE123" } },
        });
        const manual = fields(result2);
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
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const s = yield* Expenses;
        const editResult = yield* s.edit(id, { note: "first" }, 1);
        const edited = fields(editResult);
        const staleEdit = yield* Effect.exit(s.edit(id, { note: "second" }, 1));
        const staleRemove = yield* Effect.exit(s.remove(id, 1));
        return { revision: edited.revision, note: edited.note, staleEdit, staleRemove };
      }),
    );
    const stale = Exit.fail(Conflict.make({ reason: "revision_changed", currentRevision: 2 }));
    expect(exit).toEqual(
      Exit.succeed({ revision: 2, note: "first", staleEdit: stale, staleRemove: stale }),
    );
  });

  test("setting status complete runs the full validation; filling the fields then passes", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const tooEarly = yield* Effect.exit(s.edit(id, { status: "complete" }, 1));
        const editResult = yield* s.edit(id, { ...czkInput, status: "complete" }, 1);
        const done = fields(editResult);
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
    const changes = editEntry?.changes ?? [];
    expect(EffectArray.map(changes, (c) => c.path)).toContain("status");
    expect(EffectArray.findFirst(changes, (c) => c.path === "status")).toEqual(
      Option.some({
        path: "status",
        before: "incomplete",
        after: "complete",
      }),
    );
  });

  test("null clears a field; an absent field keeps it", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ ...czkInput, note: "keep me" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const editResult = yield* s.edit(id, { category: null }, 1);
        return fields(editResult);
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
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const s = yield* Expenses;
        yield* s.remove(id, 1);
        const get = yield* Effect.exit(s.get(id));
        const again = yield* Effect.exit(s.remove(id, 2));
        const page = yield* s.list({});
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id });
        return {
          get,
          again,
          listed: page.items.length,
          actions: EffectArray.map(audit, (e) => e.action),
          id,
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const nf = Exit.fail(NotFound.make({ entity: "Expense", id: exit.value.id }));
    expect(exit.value.get.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.again.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.listed).toBe(0);
    expect(exit.value.actions).toEqual(["expense.record", "expense.remove"]);
  });
});

describe("deductibility, reverse charge and FX", () => {
  test("partial and no deductibility scale the claimable input VAT", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ ...czkInput, deductibility: { partial: 33 } });
        const partial = fields(result);
        const result2 = yield* record({ ...czkInput, deductibility: "none" });
        const none = fields(result2);
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
    const issues = issuesOf(exit);
    expect(EffectArray.map(issues, (i) => i.code)).toEqual(["request.malformed"]);
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
    const buckets = v.totals?.buckets ?? [];
    expect(EffectArray.map(buckets, (b) => [b.treatment, fmt(b.vat), fmt(b.gross)])).toEqual([
      ["reverse_charge", "0", "1000"],
    ]);
    expect(
      EffectArray.map(v.selfAssessed, (b) => [fmt(b.ratePercent), fmt(b.base), fmt(b.vat)]),
    ).toEqual([
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
    const issues = issuesOf(exit);
    expect(EffectArray.map(issues, (i) => [issuePath(i.path), i.params?.["reason"]])).toEqual([
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
      fixingDate: IsoDate.make("2026-11-20"),
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
        const exitResult = yield* Effect.exit(record(czkInput));
        const czkStillWorks = Exit.isSuccess(exitResult);
        return {
          missing: EffectArray.map(issuesOf(missing), (i) => i.code),
          cachedFixing: Exit.isSuccess(cached) ? fields(cached.value).fx?.fixingDate : null,
          down: down.pipe(withoutStackTrace),
          czkStillWorks,
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        missing: ["fx.rate_missing"],
        cachedFixing: IsoDate.make("2026-11-20"),
        down: Exit.fail(Unavailable.make({ dependency: "exchange_rates" })),
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
        const result = yield* record(eur);
        const id = expenseId(result);
        const s = yield* Expenses;
        const rates = yield* FixtureRates;
        yield* Ref.set(rates.unavailable, true);
        const editResult = yield* s.edit(id, { note: "paid by card" }, 1);
        const noted = fields(editResult);
        const moved = yield* Effect.exit(s.edit(id, { taxableSupplyOn: "2026-11-21" }, 2));
        return {
          fx: noted.fx?.fixingDate,
          czk: fmt(noted.totalCzk),
          moved: moved.pipe(withoutStackTrace),
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        fx: IsoDate.make("2026-11-20"),
        czk: "3040.13",
        moved: Exit.fail(Unavailable.make({ dependency: "exchange_rates" })),
      }),
    );
  });

  test("a currency change is audited with its new rate and CZK total", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ ...czkInput, taxableSupplyOn: "2026-11-22" });
        const id = expenseId(result);
        const s = yield* Expenses;
        yield* s.edit(id, { currency: "EUR" }, 1);
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id });
        return EffectArray.map(audit[1]?.changes ?? [], (c) => c.path);
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
      EffectArray.map(exit.value.selfAssessed, (b) => [
        b.treatment,
        fmt(b.ratePercent),
        fmt(b.vat),
      ]),
    ).toEqual([["exempt_intra_eu_goods", "12", "60"]]);
    expect(fmt(exit.value.deductibleVat?.amount)).toBe("60");
  });
});

describe("Expenses.list", () => {
  test("pages newest first; incomplete filter; a cursor is bound to its filter", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record(czkInput);
        const a = expenseId(result);
        const result2 = yield* record({ status: "incomplete" });
        const b = expenseId(result2);
        const result3 = yield* record(czkInput);
        const c = expenseId(result3);
        const s = yield* Expenses;
        const first = yield* s.list({ limit: 2 });
        const second = yield* s.list({ limit: 2, cursor: first.nextCursor ?? "" });
        const incomplete = yield* s.list({ incomplete: true });
        const mismatch = yield* Effect.exit(
          s.list({ incomplete: true, cursor: first.nextCursor ?? "" }),
        );
        const garbage = yield* Effect.exit(s.list({ cursor: "%%%" }));
        const ids = (p: typeof first) =>
          EffectArray.map(p.items, (i) => ExpenseId.make(decodeSummary(i).id));
        return {
          first: ids(first),
          second: ids(second),
          end: second.nextCursor,
          incomplete: EffectArray.map(incomplete.items, (i) => decodeSummary(i).status),
          mismatch: EffectArray.map(issuesOf(mismatch), (i) => i.code),
          garbage: EffectArray.map(issuesOf(garbage), (i) => i.code),
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
