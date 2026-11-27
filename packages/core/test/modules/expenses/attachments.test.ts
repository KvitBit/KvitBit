import { describe, expect, test } from "bun:test";
import {
  Conflict,
  CurrencyCode,
  ExpenseId,
  Expenses,
  Invalid,
  IsoDate,
  MoneyMath,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import { BlobKey } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import {
  ExpensePayables,
  ExpensePayablesLive,
  ExpenseRecords,
  ExpenseRecordsLive,
  ExpensesRepoMemory,
  FakeExpenseSuppliers,
  makeExpensesLive,
} from "../../../src/modules/expenses";
import { CoreStore } from "../../../src/store/CoreStore";
import { MemoryBlobStorage, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { withoutStackTrace } from "../../helpers/run";
import {
  asCaller,
  attachmentFields,
  bytesOf,
  czkInput,
  expenseId,
  fields,
  HEIC_HEAD,
  ownerB,
  record,
  scenario,
  scenarioWithLayer,
} from "./fixtures";

const pdf = (text = "%PDF-1.7 receipt") => ({
  name: "receipt.pdf",
  contentType: "application/pdf",
  bytes: bytesOf(text),
});

const sha256 = async (text: string) =>
  EffectArray.join(
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
      (b) => EffectString.padStart(2, "0")(b.toString(16)),
    ),
    "",
  );

const collect = (stream: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(stream), (chunks) =>
    new TextDecoder().decode(Uint8Array.from(EffectArray.flatMap([...chunks], (c) => [...c]))),
  );

const czk = (amount: string) =>
  MoneyMath.make(BigDecimal.fromStringUnsafe(amount), CurrencyCode.make("CZK"));

describe("attachments", () => {
  test("attach streams to a Workspace-prefixed key with size and sha256; read returns the bytes", async () => {
    const digest = await sha256("%PDF-1.7 receipt");
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const attachResult = yield* s.attach(id, pdf());
        const att = yield* attachmentFields(attachResult);
        const getResult = yield* s.get(id);
        const view = fields(getResult);
        const download = yield* s.attachment(id, att.id);
        const text = yield* collect(download.bytes);
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id });
        return {
          id,
          att,
          view,
          download,
          text,
          keys: [...blobs.keys()],
          actions: EffectArray.map(audit, (e) => e.action),
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const v = exit.value;
    expect(v.att).toMatchObject({
      expenseId: v.id,
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytes: 16,
      sha256: digest,
    });
    expect(v.keys).toEqual([
      BlobKey.make(`workspaces/${WORKSPACE_A}/expenses/${v.id}/attachments/${v.att.id}`),
    ]);
    expect(EffectArray.map(v.view.attachments, (a) => a.id)).toEqual([v.att.id]);
    expect(v.view.revision).toBe(2);
    expect(v.download).toMatchObject({ filename: "receipt.pdf", contentType: "application/pdf" });
    expect(v.text).toBe("%PDF-1.7 receipt");
    expect(v.actions).toEqual(["expense.record", "expense.attach"]);
  });

  test("attach is idempotent by content hash: same bytes return the same attachment, one blob", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const attachResult = yield* s.attach(id, pdf());
        const first = yield* attachmentFields(attachResult);
        const attachResult2 = yield* s.attach(id, { ...pdf(), name: "again.pdf" });
        const second = yield* attachmentFields(attachResult2);
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        const view = yield* s.get(id);
        return {
          same: first.id === second.id,
          blobs: blobs.size,
          revision: fields(view).revision,
        };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ same: true, blobs: 1, revision: 2 }));
  });

  test("a stream past maxBytes is attachment.too_large; a wrong type is attachment.type_rejected", async () => {
    const layer = Layer.mergeAll(
      makeExpensesLive({ maxAttachmentBytes: 24 }),
      ExpensePayablesLive,
      ExpenseRecordsLive,
    ).pipe(Layer.provideMerge(FakeExpenseSuppliers), Layer.provideMerge(ExpensesRepoMemory));
    const exit = await scenarioWithLayer(layer)(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const big = yield* Effect.exit(
          s.attach(id, {
            ...pdf(),
            bytes: Stream.make(new TextEncoder().encode("%PDF-"), new Uint8Array(25)),
          }),
        );
        const exe = yield* Effect.exit(
          s.attach(id, {
            name: "x.exe",
            contentType: "application/x-msdownload",
            bytes: bytesOf("MZ"),
          }),
        );
        const attachResult = yield* s.attach(id, {
          name: "IMG.HEIC",
          contentType: "Image/HEIC; charset=binary",
          bytes: Stream.make(HEIC_HEAD),
        });
        const heic = yield* attachmentFields(attachResult);
        const view = yield* s.get(id);
        return {
          big,
          exe,
          heicType: heic.contentType,
          attached: fields(view).attachments.length,
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        big: Exit.fail(
          Invalid.make({
            issues: [{ path: ["file"], code: "attachment.too_large", params: { maxBytes: "24" } }],
          }),
        ),
        exe: Exit.fail(
          Invalid.make({
            issues: [{ path: ["file", "contentType"], code: "attachment.type_rejected" }],
          }),
        ),
        heicType: "image/heic",
        attached: 1,
      }),
    );
  });

  test("magic bytes: a spoofed or empty upload is attachment.type_rejected and stores no blob", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        const spoofed = yield* Effect.exit(s.attach(id, { ...pdf(), bytes: Stream.make(png) }));
        const empty = yield* Effect.exit(s.attach(id, { ...pdf(), bytes: Stream.empty }));
        const short = yield* Effect.exit(s.attach(id, { ...pdf(), bytes: bytesOf("%PD") }));
        const attachResult = yield* s.attach(id, {
          name: "p.png",
          contentType: "image/png",
          bytes: Stream.make(png),
        });
        const realPng = yield* attachmentFields(attachResult);
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        return { spoofed, empty, short, png: realPng.contentType, blobs: blobs.size };
      }),
    );
    const rejected = Exit.fail(
      Invalid.make({
        issues: [{ path: ["file", "contentType"], code: "attachment.type_rejected" }],
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        spoofed: rejected,
        empty: rejected,
        short: rejected,
        png: "image/png",
        blobs: 1,
      }),
    );
  });

  test("attach returns the Expense revision after it", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const attachResult = yield* s.attach(id, pdf());
        const att = yield* attachmentFields(attachResult);
        const attachResult2 = yield* s.attach(id, pdf());
        const again = yield* attachmentFields(attachResult2);
        const view = yield* s.get(id);
        return [att.expenseRevision, again.expenseRevision, fields(view).revision];
      }),
    );
    expect(exit).toEqual(Exit.succeed([2, 2, 2]));
  });

  test("blob storage down is Unavailable{blob_storage} and leaves no attachment", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        yield* Ref.set((yield* MemoryBlobStorage).unavailable, true);
        const down = yield* Effect.exit(s.attach(id, pdf()));
        const view = yield* s.get(id);
        return { down: down.pipe(withoutStackTrace), attached: fields(view).attachments.length };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        down: Exit.fail(Unavailable.make({ dependency: "blob_storage" })),
        attached: 0,
      }),
    );
  });

  test("detach removes the row, then the blob; another Expense's attachment is NotFound", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const a = expenseId(result);
        const result2 = yield* record({ status: "incomplete" });
        const b = expenseId(result2);
        const s = yield* Expenses;
        const attachResult = yield* s.attach(a, pdf());
        const { id: attachmentId } = yield* attachmentFields(attachResult);
        const wrongExpense = yield* Effect.exit(s.detach(b, attachmentId));
        const wrongRead = yield* Effect.exit(s.attachment(b, attachmentId));
        yield* s.detach(a, attachmentId);
        // Detach is idempotent by state (C6): a retry succeeds, with no second audit entry.
        const again = yield* Effect.exit(s.detach(a, attachmentId));
        const store = yield* CoreStore;
        const audit = yield* store.audit.history(WORKSPACE_A, { entity: "Expense", id: a });
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        const getResult = yield* s.get(a);
        const view = fields(getResult);
        return {
          wrongExpense,
          wrongRead,
          again,
          actions: EffectArray.map(audit, (e) => e.action),
          revision: view.revision,
          blobs: blobs.size,
          attached: view.attachments.length,
          attachmentId,
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const nf = Exit.fail(NotFound.make({ entity: "Attachment", id: exit.value.attachmentId }));
    expect(exit.value.wrongExpense.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.wrongRead.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.again).toEqual(Exit.void);
    expect(exit.value.actions).toEqual(["expense.record", "expense.attach", "expense.detach"]);
    expect(exit.value.revision).toBe(3);
    expect(exit.value.blobs).toBe(0);
    expect(exit.value.attached).toBe(0);
  });

  test("a row whose blob is gone reads as Unavailable{blob_storage}", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const attachResult = yield* s.attach(id, pdf());
        const { id: attachmentId } = yield* attachmentFields(attachResult);
        yield* Ref.set((yield* MemoryBlobStorage).blobs, new Map<BlobKey, never>());
        return yield* Effect.exit(s.attachment(id, attachmentId));
      }),
    );
    expect(exit).toEqual(
      Unavailable.make({ dependency: "blob_storage" }).pipe(Exit.fail, Exit.succeed),
    );
  });

  test("attach on another Workspace's Expense is NotFound before any blob is written", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const foreign = yield* s.attach(id, pdf()).pipe(asCaller(ownerB), Effect.exit);
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        return { foreign, blobs: blobs.size, id };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.foreign.pipe(withoutStackTrace)).toEqual(
      Exit.fail(NotFound.make({ entity: "Expense", id: exit.value.id })),
    );
    expect(exit.value.blobs).toBe(0);
  });
});

describe("ExpensePayables (Payments seam)", () => {
  const inTx = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(CoreStore, (store) => store.transaction(effect));

  test("lock reads the payable; settle stores the paid state and derives the settlement", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const payables = yield* ExpensePayables;
        const before = yield* inTx(payables.lock(WORKSPACE_A, id));
        const partial = yield* inTx(
          payables.settle(WORKSPACE_A, id, { amount: czk("21"), payments: 1 }),
        );
        const paid = yield* inTx(
          payables.settle(WORKSPACE_A, id, { amount: czk("121"), payments: 2 }),
        );
        const over = yield* inTx(
          payables.settle(WORKSPACE_A, id, { amount: czk("150"), payments: 3 }),
        );
        const getResult = yield* (yield* Expenses).get(id);
        const view = fields(getResult);
        return { before, partial, paid, over, payment: view.payment, revision: view.revision };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const v = exit.value;
    expect(v.before).toMatchObject({
      workspaceId: WORKSPACE_A,
      revision: 1,
      status: "complete",
      currency: "CZK",
      paid: null,
      payments: 0,
      settlement: "unpaid",
    });
    (v.before.gross?.amount ?? BigDecimal.fromBigInt(0n))
      .pipe(BigDecimal.format, expect)
      .toBe("121");
    expect([v.partial, v.paid, v.over]).toEqual(["partially_paid", "paid", "overpaid"]);
    expect(v.payment.settlement).toBe("overpaid");
    expect(v.payment.payments).toBe(3);
    expect(v.revision).toBe(4);
  });

  test("an Expense with payments cannot be removed, change currency or become incomplete", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const payables = yield* ExpensePayables;
        yield* inTx(payables.settle(WORKSPACE_A, id, { amount: czk("21"), payments: 1 }));
        const s = yield* Expenses;
        const remove = yield* Effect.exit(s.remove(id, 2));
        const currency = yield* Effect.exit(
          s.edit(id, { currency: "EUR", taxableSupplyOn: "2026-11-22" }, 2),
        );
        const incomplete = yield* Effect.exit(s.edit(id, { status: "incomplete" }, 2));
        // Removing the last Payment unblocks removal.
        yield* inTx(payables.settle(WORKSPACE_A, id, { amount: czk("0"), payments: 0 }));
        const removed = yield* Effect.exit(s.remove(id, 3));
        return { remove, currency, incomplete, removed };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        remove: Exit.fail(Conflict.make({ reason: "illegal_transition" })),
        currency: Exit.fail(
          Invalid.make({ issues: [{ path: ["currency"], code: "payment.currency_mismatch" }] }),
        ),
        incomplete: Exit.fail(
          Invalid.make({ issues: [{ path: ["status"], code: "expense.incomplete" }] }),
        ),
        removed: Exit.void,
      }),
    );
  });

  test("lock: another Workspace's or a removed Expense is NotFound; incomplete shows its status", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const payables = yield* ExpensePayables;
        const s = yield* Expenses;
        const result = yield* record(czkInput);
        const id = expenseId(result);
        const result2 = yield* record({ status: "incomplete" });
        const draft = expenseId(result2);
        const foreign = yield* payables.lock(WORKSPACE_B, id).pipe(inTx, Effect.exit);
        const incomplete = yield* inTx(payables.lock(WORKSPACE_A, draft));
        yield* s.remove(id, 1);
        const removed = yield* payables.lock(WORKSPACE_A, id).pipe(inTx, Effect.exit);
        const settleRemoved = yield* payables
          .settle(WORKSPACE_A, id, { amount: czk("1"), payments: 1 })
          .pipe(inTx, Effect.exit);
        return {
          id,
          foreign,
          incomplete: [incomplete.status, incomplete.gross],
          removed,
          settleRemoved,
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const nf = Exit.fail(NotFound.make({ entity: "Expense", id: exit.value.id }));
    expect(exit.value.foreign.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.removed.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.settleRemoved.pipe(withoutStackTrace)).toEqual(nf);
    expect(exit.value.incomplete).toEqual(["incomplete", null]);
  });
});

describe("ExpenseRecords (Reports seam)", () => {
  test("complete Expenses by issuedOn or taxPoint; incomplete and removed left out and counted", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const s = yield* Expenses;
        const result = yield* record(czkInput);
        const nov = expenseId(result); // issued 11-20, tax point 11-19
        const result2 = yield* record({
          ...czkInput,
          issuedOn: "2026-12-01",
          taxableSupplyOn: null,
        });
        const dec = expenseId(result2);
        const result3 = yield* record(czkInput);
        const gone = expenseId(result3);
        yield* s.remove(gone, 1);
        yield* record({ status: "incomplete", issuedOn: "2026-11-20" });
        yield* record({ ...czkInput, supplier: { manual: { name: "B supplier" } } }).pipe(
          asCaller(ownerB),
        );
        const records = yield* ExpenseRecords;
        const range = (field: "issuedOn" | "taxPoint", from: string, to: string) =>
          Effect.map(
            records.complete(WORKSPACE_A, {
              field,
              from: IsoDate.make(from),
              to: IsoDate.make(to),
            }),
            (rows) => EffectArray.map(rows, (r) => ExpenseId.make(r.id)),
          );
        return {
          byIssued: yield* range("issuedOn", "2026-11-20", "2026-11-30"),
          byTaxPoint: yield* range("taxPoint", "2026-11-19", "2026-11-19"),
          december: yield* range("taxPoint", "2026-12-01", "2026-12-31"),
          incomplete: yield* records.incompleteCount(WORKSPACE_A),
          sample: (yield* records.complete(WORKSPACE_A, {
            field: "issuedOn",
            from: IsoDate.make("2026-11-01"),
            to: IsoDate.make("2026-11-30"),
          }))[0],
          nov,
          dec,
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const v = exit.value;
    expect(v.byIssued).toEqual([v.nov]);
    expect(v.byTaxPoint).toEqual([v.nov]);
    expect(v.december).toEqual([v.dec]);
    expect(v.incomplete).toBe(1);
    expect(v.sample).toMatchObject({
      id: v.nov,
      taxPoint: "2026-11-19",
      issuedOn: "2026-11-20",
      currency: "CZK",
      deductiblePercent: 100,
      supplierDocumentNumber: "FV-2026-001",
      payments: 0,
    });
    (v.sample?.deductibleVatCzk ?? BigDecimal.fromBigInt(0n))
      .pipe(BigDecimal.format, expect)
      .toBe("21");
  });
});
