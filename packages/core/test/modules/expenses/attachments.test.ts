import { describe, expect, test } from "bun:test";
import type { AttachmentId, CurrencyCode, ExpenseId, IsoDate } from "@kvitbit/domain/contract";
import {
  Conflict,
  Expenses,
  Invalid,
  MoneyMath,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import type { BlobKey } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Exit, Layer, Ref, Stream } from "effect";
import type { AttachmentViewFields } from "../../../src/modules/expenses";
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
import { as, bytesOf, czkInput, expenseId, fields, ownerB, record, scenario } from "./fixtures";

const pdf = (text = "%PDF-1.7 receipt") => ({
  name: "receipt.pdf",
  contentType: "application/pdf",
  bytes: bytesOf(text),
});

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const attachmentFields = (view: unknown) => view as AttachmentViewFields;

const collect = (stream: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(stream), (chunks) =>
    new TextDecoder().decode(Uint8Array.from([...chunks].flatMap((c) => [...c]))),
  );

const czk = (amount: string) =>
  MoneyMath.make(BigDecimal.fromStringUnsafe(amount), "CZK" as CurrencyCode);

describe("attachments", () => {
  test("attach streams to a Workspace-prefixed key with size and sha256; read returns the bytes", async () => {
    const digest = await sha256("%PDF-1.7 receipt");
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const att = attachmentFields(yield* s.attach(id, pdf()));
        const view = fields(yield* s.get(id));
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
          actions: audit.map((e) => e.action),
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
      `workspaces/${WORKSPACE_A}/expenses/${v.id}/attachments/${v.att.id}` as BlobKey,
    ]);
    expect(v.view.attachments.map((a) => a.id)).toEqual([v.att.id]);
    expect(v.view.revision).toBe(2);
    expect(v.download).toMatchObject({ filename: "receipt.pdf", contentType: "application/pdf" });
    expect(v.text).toBe("%PDF-1.7 receipt");
    expect(v.actions).toEqual(["expense.record", "expense.attach"]);
  });

  test("attach is idempotent by content hash: same bytes return the same attachment, one blob", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const first = attachmentFields(yield* s.attach(id, pdf()));
        const second = attachmentFields(yield* s.attach(id, { ...pdf(), name: "again.pdf" }));
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        return {
          same: first.id === second.id,
          blobs: blobs.size,
          revision: fields(yield* s.get(id)).revision,
        };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ same: true, blobs: 1, revision: 2 }));
  });

  test("a stream past maxBytes is attachment.too_large; a wrong type is attachment.type_rejected", async () => {
    const layer = Layer.mergeAll(
      makeExpensesLive({ maxAttachmentBytes: 8 }),
      ExpensePayablesLive,
      ExpenseRecordsLive,
    ).pipe(Layer.provideMerge(FakeExpenseSuppliers), Layer.provideMerge(ExpensesRepoMemory));
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const big = yield* Effect.exit(
          s.attach(id, { ...pdf(), bytes: Stream.make(new Uint8Array(5), new Uint8Array(5)) }),
        );
        const exe = yield* Effect.exit(
          s.attach(id, {
            name: "x.exe",
            contentType: "application/x-msdownload",
            bytes: bytesOf("MZ"),
          }),
        );
        const heic = attachmentFields(
          yield* s.attach(id, {
            name: "IMG.HEIC",
            contentType: "Image/HEIC; charset=binary",
            bytes: bytesOf("heic"),
          }),
        );
        return {
          big,
          exe,
          heicType: heic.contentType,
          attached: fields(yield* s.get(id)).attachments.length,
        };
      }),
      { layer },
    );
    expect(exit).toEqual(
      Exit.succeed({
        big: Exit.fail(
          new Invalid({
            issues: [{ path: ["file"], code: "attachment.too_large", params: { maxBytes: "8" } }],
          }),
        ),
        exe: Exit.fail(
          new Invalid({
            issues: [{ path: ["file", "contentType"], code: "attachment.type_rejected" }],
          }),
        ),
        heicType: "image/heic",
        attached: 1,
      }),
    );
  });

  test("blob storage down is Unavailable{blob_storage} and leaves no attachment", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        yield* Ref.set((yield* MemoryBlobStorage).unavailable, true);
        const down = yield* Effect.exit(s.attach(id, pdf()));
        return { down, attached: fields(yield* s.get(id)).attachments.length };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        down: Exit.fail(new Unavailable({ dependency: "blob_storage" })),
        attached: 0,
      }),
    );
  });

  test("detach removes the row, then the blob; another Expense's attachment is NotFound", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const a = expenseId(yield* record({ status: "incomplete" }));
        const b = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const att = attachmentFields(yield* s.attach(a, pdf())).id as AttachmentId;
        const wrongExpense = yield* Effect.exit(s.detach(b, att));
        const wrongRead = yield* Effect.exit(s.attachment(b, att));
        yield* s.detach(a, att);
        const again = yield* Effect.exit(s.detach(a, att));
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        const view = fields(yield* s.get(a));
        return {
          wrongExpense,
          wrongRead,
          again,
          blobs: blobs.size,
          attached: view.attachments.length,
          att,
        };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const nf = Exit.fail(new NotFound({ entity: "Attachment", id: exit.value.att }));
    expect(exit.value.wrongExpense).toEqual(nf);
    expect(exit.value.wrongRead).toEqual(nf);
    expect(exit.value.again as Exit.Exit<unknown, unknown>).toEqual(nf);
    expect(exit.value.blobs).toBe(0);
    expect(exit.value.attached).toBe(0);
  });

  test("a row whose blob is gone reads as Unavailable{blob_storage}", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const att = attachmentFields(yield* s.attach(id, pdf())).id as AttachmentId;
        yield* Ref.set((yield* MemoryBlobStorage).blobs, new Map<BlobKey, never>());
        return yield* Effect.exit(s.attachment(id, att));
      }),
    );
    expect(exit).toEqual(Exit.succeed(Exit.fail(new Unavailable({ dependency: "blob_storage" }))));
  });

  test("attach on another Workspace's Expense is NotFound before any blob is written", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const foreign = yield* Effect.exit(as(ownerB, s.attach(id, pdf())));
        const blobs = yield* Ref.get((yield* MemoryBlobStorage).blobs);
        return { foreign, blobs: blobs.size, id };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.foreign).toEqual(
      Exit.fail(new NotFound({ entity: "Expense", id: exit.value.id })),
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
        const id = expenseId(yield* record(czkInput));
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
        const view = fields(yield* (yield* Expenses).get(id));
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
    expect(BigDecimal.format(v.before.gross?.amount ?? BigDecimal.fromBigInt(0n))).toBe("121");
    expect([v.partial, v.paid, v.over]).toEqual(["partially_paid", "paid", "overpaid"]);
    expect(v.payment.settlement).toBe("overpaid");
    expect(v.payment.payments).toBe(3);
    expect(v.revision).toBe(4);
  });

  test("an Expense with payments cannot be removed, change currency or become incomplete", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record(czkInput));
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
        remove: Exit.fail(new Conflict({ reason: "illegal_transition" })),
        currency: Exit.fail(
          new Invalid({ issues: [{ path: ["currency"], code: "payment.currency_mismatch" }] }),
        ),
        incomplete: Exit.fail(
          new Invalid({ issues: [{ path: ["status"], code: "expense.incomplete" }] }),
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
        const id = expenseId(yield* record(czkInput));
        const draft = expenseId(yield* record({ status: "incomplete" }));
        const foreign = yield* Effect.exit(inTx(payables.lock(WORKSPACE_B, id)));
        const incomplete = yield* inTx(payables.lock(WORKSPACE_A, draft));
        yield* s.remove(id, 1);
        const removed = yield* Effect.exit(inTx(payables.lock(WORKSPACE_A, id)));
        const settleRemoved = yield* Effect.exit(
          inTx(payables.settle(WORKSPACE_A, id, { amount: czk("1"), payments: 1 })),
        );
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
    const nf = Exit.fail(new NotFound({ entity: "Expense", id: exit.value.id }));
    expect(exit.value.foreign).toEqual(nf);
    expect(exit.value.removed).toEqual(nf);
    expect(exit.value.settleRemoved).toEqual(nf);
    expect(exit.value.incomplete).toEqual(["incomplete", null]);
  });
});

describe("ExpenseRecords (Reports seam)", () => {
  test("complete Expenses by issuedOn or taxPoint; incomplete and removed left out and counted", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const s = yield* Expenses;
        const nov = expenseId(yield* record(czkInput)); // issued 11-20, tax point 11-19
        const dec = expenseId(
          yield* record({ ...czkInput, issuedOn: "2026-12-01", taxableSupplyOn: null }),
        );
        const gone = expenseId(yield* record(czkInput));
        yield* s.remove(gone, 1);
        yield* record({ status: "incomplete", issuedOn: "2026-11-20" });
        yield* as(ownerB, record({ ...czkInput, supplier: { manual: { name: "B supplier" } } }));
        const records = yield* ExpenseRecords;
        const range = (field: "issuedOn" | "taxPoint", from: string, to: string) =>
          Effect.map(
            records.complete(WORKSPACE_A, { field, from: from as IsoDate, to: to as IsoDate }),
            (rows) => rows.map((r) => r.id as ExpenseId),
          );
        return {
          byIssued: yield* range("issuedOn", "2026-11-20", "2026-11-30"),
          byTaxPoint: yield* range("taxPoint", "2026-11-19", "2026-11-19"),
          december: yield* range("taxPoint", "2026-12-01", "2026-12-31"),
          incomplete: yield* records.incompleteCount(WORKSPACE_A),
          sample: (yield* records.complete(WORKSPACE_A, {
            field: "issuedOn",
            from: "2026-11-01" as IsoDate,
            to: "2026-11-30" as IsoDate,
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
    expect(BigDecimal.format(v.sample?.deductibleVatCzk ?? BigDecimal.fromBigInt(0n))).toBe("21");
  });
});
