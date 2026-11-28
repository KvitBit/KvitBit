import { TestCaller } from "../../helpers/callerContext";
/** Regressions for review round 1 on 0fbe8de. */

import { describe, expect, test } from "bun:test";
import type { AttachmentView, CoreError } from "@kvitbit/domain/contract";
import {
  ContactId,
  CurrencyCode,
  Expenses,
  Invalid,
  MoneyMath,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import type { FakeSupplier } from "../../../src/modules/expenses";
import {
  decodeSummary,
  ExpensePayables,
  ExpensePayablesLive,
  ExpenseRecordsLive,
  ExpenseSuppliers,
  ExpensesLive,
  ExpensesRepo,
  ExpensesRepoMemory,
  FakeExpenseSuppliers,
  FakeSupplierDirectory,
  makeExpensesLive,
  matchesType,
} from "../../../src/modules/expenses";
import { CoreStore, StoreUnavailable } from "../../../src/store/CoreStore";
import { defineCollection, MemoryBlobStorage, MemoryTables, WORKSPACE_A } from "../../helpers";
import {
  attachmentFields,
  bytesOf,
  czkInput,
  expenseId,
  fields,
  HEIC_HEAD,
  record,
  scenario,
  scenarioWithLayer,
} from "./fixtures";

const ascii = (text: string) => new TextEncoder().encode(text);
const ftyp = (major: string, ...compatible: Array<string>) =>
  Uint8Array.from([
    0,
    0,
    0,
    16 + 4 * compatible.length,
    ...ascii(`ftyp${major}`),
    0,
    0,
    0,
    0,
    ...ascii(EffectArray.join(compatible, "")),
  ]);

describe("HEIC sniffing", () => {
  test("a HEIC still-image brand is required among the major or compatible brands", () => {
    expect(matchesType("image/heic", HEIC_HEAD)).toBe(true);
    expect(matchesType("image/heic", ftyp("heic"))).toBe(true);
    expect(matchesType("image/heic", ftyp("mif1", "heix"))).toBe(true);
    // Generic HEIF, an image sequence, AVIF: not image/heic.
    expect(matchesType("image/heic", ftyp("mif1", "mif1"))).toBe(false);
    expect(matchesType("image/heic", ftyp("msf1", "hevc"))).toBe(false);
    expect(matchesType("image/heic", ftyp("avif", "mif1"))).toBe(false);
    // A compatible brand past the box size does not count.
    const truncated = ftyp("mif1", "heic");
    truncated[3] = 16;
    expect(matchesType("image/heic", truncated)).toBe(false);
  });
});

describe("HEIC brands and streaming", () => {
  test("heim and heis are HEIC too, as major or compatible brand", () => {
    for (const brand of ["heim", "heis"]) {
      expect(matchesType("image/heic", ftyp(brand))).toBe(true);
      expect(matchesType("image/heic", ftyp("mif1", "mif1", brand))).toBe(true);
    }
  });

  test("a qualifying brand past the first 64 bytes of the ftyp box is found while streaming", async () => {
    // 68-byte box: 13 non-HEIC compatible brands, then heix at offset 64.
    const box = ftyp("mif1", ...Array.from({ length: 12 }, () => "mif1"), "heix");
    expect(box.length).toBe(68);
    const exit = await scenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        // Delivered in 5-byte chunks, plus image data after the box.
        const bytes = Uint8Array.from([...box, 1, 2, 3, 4, 5, 6, 7]);
        const chunks = Array.from({ length: Math.ceil(bytes.length / 5) }, (_, i) =>
          bytes.subarray(i * 5, i * 5 + 5),
        );
        const att = yield* s.attach(testCaller, id, {
          name: "IMG.HEIC",
          contentType: "image/heic",
          bytes: Stream.fromIterable(chunks),
        });
        const notHeic = ftyp("mif1", ...Array.from({ length: 13 }, () => "mif1"));
        const rejected = yield* Effect.exit(
          s.attach(testCaller, id, {
            name: "x.heic",
            contentType: "image/heic",
            bytes: Stream.make(notHeic),
          }),
        );
        const attachment = yield* attachmentFields(att);
        return {
          bytes: attachment.bytes,
          rejected: Exit.isFailure(rejected),
        };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ bytes: 75, rejected: true }));
  });
});

describe("size limit vs type sniffing", () => {
  test("a HEIC upload crossing the limit is too_large however it is chunked", async () => {
    const layer = Layer.mergeAll(
      makeExpensesLive({ maxAttachmentBytes: 24 }),
      ExpensePayablesLive,
      ExpenseRecordsLive,
    ).pipe(Layer.provideMerge(FakeExpenseSuppliers), Layer.provideMerge(ExpensesRepoMemory));
    // 32-byte ftyp box whose HEIC brand sits at bytes 28..31, past the 24-byte limit.
    const box = ftyp("mif1", "mif1", "mif1", "mif1", "heic");
    expect(box.length).toBe(32);
    const tooLarge = Exit.fail(
      Invalid.make({
        issues: [{ path: ["file"], code: "attachment.too_large", params: { maxBytes: "24" } }],
      }),
    );
    const exit = await scenarioWithLayer(layer)(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const file = (bytes: Stream.Stream<Uint8Array>) => ({
          name: "i.heic",
          contentType: "image/heic",
          bytes,
        });
        // Same layout with no HEIC brand anywhere: still too_large, not type_rejected.
        const plain = ftyp("mif1", "mif1", "mif1", "mif1", "mif1");
        const plainWhole = yield* Effect.exit(s.attach(testCaller, id, file(Stream.make(plain))));
        const plainSplit = yield* Effect.exit(
          s.attach(testCaller, id, file(Stream.make(plain.subarray(0, 28), plain.subarray(28)))),
        );
        const whole = yield* Effect.exit(s.attach(testCaller, id, file(Stream.make(box))));
        const split = yield* Effect.exit(
          s.attach(testCaller, id, file(Stream.make(box.subarray(0, 28), box.subarray(28)))),
        );
        // A mismatch proven within the limit stays a type rejection, whole or split.
        const pdfLike = Uint8Array.from([
          ...new TextEncoder().encode("%PDX-"),
          ...new Uint8Array(27),
        ]);
        const spoofWhole = yield* Effect.exit(
          s.attach(testCaller, id, {
            ...file(Stream.make(pdfLike)),
            contentType: "application/pdf",
          }),
        );
        const spoofSplit = yield* Effect.exit(
          s.attach(testCaller, id, {
            ...file(Stream.make(pdfLike.subarray(0, 3), pdfLike.subarray(3))),
            contentType: "application/pdf",
          }),
        );
        return {
          plainWhole,
          plainSplit,
          whole,
          split,
          spoofWhole: attachmentIssueCode(spoofWhole),
          spoofSplit: attachmentIssueCode(spoofSplit),
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        plainWhole: tooLarge,
        plainSplit: tooLarge,
        whole: tooLarge,
        split: tooLarge,
        spoofWhole: "attachment.type_rejected",
        spoofSplit: "attachment.type_rejected",
      }),
    );
  });
});

const attachmentIssueCode = (exit: Exit.Exit<AttachmentView, CoreError>) => {
  const error = exit.pipe(Exit.findErrorOption, Option.getOrUndefined);
  return error?._tag === "Invalid" ? error.issues[0].code : undefined;
};

describe("list", () => {
  test("rows carry the currency; a cursor with a malformed id is request.malformed", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        yield* record({ ...czkInput, currency: "EUR", taxableSupplyOn: "2026-11-22" });
        const s = yield* Expenses;
        const page = yield* s.list(testCaller, {});
        const forged = yield* Effect.exit(s.list(testCaller, { cursor: btoa('["all",""]') }));
        return {
          currency: EffectArray.map(page.items, (i) => decodeSummary(i).currency),
          forged,
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        currency: [CurrencyCode.make("EUR")],
        forged: Exit.fail(
          Invalid.make({ issues: [{ path: ["cursor"], code: "request.malformed" }] }),
        ),
      }),
    );
  });
});

// A supplier port whose IČO path upserts a Contact through MemoryTables, like Contacts.fromIco
// does through the store: its write must roll back with a failed edit (rule C1).
const ContactRow = Schema.Struct({
  id: Schema.String,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  ico: Schema.String,
});
const Upserted = defineCollection({
  name: "test_upserted_contacts",
  entity: "Contact",
  schema: ContactRow,
});
const UpsertingSuppliers = Layer.effect(
  ExpenseSuppliers,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(Upserted);
    return {
      contact: () => Effect.die("unused"),
      fromIco: (caller, ico) =>
        Effect.gen(function* () {
          if (caller._tag !== "Member") return yield* Effect.die("expected a Workspace member");
          const id = `01900000-0000-7000-8000-0000000c${EffectString.slice(-4)(ico)}`;
          yield* table
            .insert({ id, workspaceId: caller.workspaceId, revision: 1, ico })
            .pipe(Effect.orDie);
          return { contactId: ContactId.make(id), name: `Supplier ${ico}`, ico, dic: null };
        }),
    };
  }),
);

const EmptyDirectory = Layer.effect(
  FakeSupplierDirectory,
  Effect.map(Ref.make<ReadonlyArray<FakeSupplier>>([]), (contacts) => ({ contacts })),
);

describe("edit and the supplier upsert", () => {
  test("a failed edit leaves no upserted Contact; a successful one keeps it", async () => {
    const layer = Layer.mergeAll(ExpensesLive, ExpensePayablesLive, ExpenseRecordsLive).pipe(
      Layer.provideMerge(UpsertingSuppliers),
      Layer.provideMerge(ExpensesRepoMemory),
      Layer.merge(EmptyDirectory),
    );
    const exit = await scenarioWithLayer(layer)(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const result = yield* record({ ...czkInput, supplier: { manual: { name: "Typed" } } });
        const id = expenseId(result);
        const s = yield* Expenses;
        const tables = yield* MemoryTables;
        const contacts = tables.collection(Upserted);
        const store = yield* CoreStore;
        const payables = yield* ExpensePayables;
        yield* store.transaction(
          payables.settle(WORKSPACE_A, id, {
            amount: MoneyMath.make(BigDecimal.fromStringUnsafe("21"), CurrencyCode.make("CZK")),
            payments: 1,
          }),
        );
        // Fails inside the transaction, after the supplier upsert ran (paid Expense keeps CZK).
        const failed = yield* Effect.exit(
          s.edit(
            testCaller,
            id,
            { currency: "EUR", taxableSupplyOn: "2026-11-22", supplier: { ico: "11111111" } },
            2,
          ),
        );
        const afterFailed = (yield* contacts.listGlobal()).length;
        const editResult = yield* s.edit(testCaller, id, { supplier: { ico: "22222222" } }, 2);
        const ok = fields(editResult);
        const savedContacts = yield* contacts.listGlobal();
        const afterOk = EffectArray.map(savedContacts, (c) => c.ico);
        return { failed: Exit.isFailure(failed), afterFailed, afterOk, supplier: ok.supplier?.ico };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({ failed: true, afterFailed: 0, afterOk: ["22222222"], supplier: "22222222" }),
    );
  });
});

describe("attach and an uncertain commit", () => {
  test("a store failure keeps the blob (housekeeping decides); a certain rollback deletes it", async () => {
    const mode = Ref.makeUnsafe<"ok" | "store_down" | "gone">("ok");
    const FlakyRepo = Layer.effect(
      ExpensesRepo,
      Effect.map(ExpensesRepo, (repo) => ({
        ...repo,
        insertAttachment: (row: Parameters<typeof repo.insertAttachment>[0]) =>
          Ref.get(mode).pipe(
            Effect.flatMap((current) =>
              current === "store_down"
                ? Effect.fail(StoreUnavailable.make({ cause: "commit outcome unknown" }))
                : repo.insertAttachment(row),
            ),
          ),
        lock: (ws: Parameters<typeof repo.lock>[0], id: Parameters<typeof repo.lock>[1]) =>
          Effect.zipWith(repo.lock(ws, id), Ref.get(mode), (row, current) =>
            current === "gone" ? { ...row, removedAt: "2026-11-23T09:00:00.000Z" } : row,
          ),
      })),
    ).pipe(Layer.provide(ExpensesRepoMemory));
    const layer = Layer.mergeAll(ExpensesLive, ExpensePayablesLive, ExpenseRecordsLive).pipe(
      Layer.provideMerge(FakeExpenseSuppliers),
      Layer.provideMerge(FlakyRepo),
    );
    const exit = await scenarioWithLayer(layer)(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const result = yield* record({ status: "incomplete" });
        const id = expenseId(result);
        const s = yield* Expenses;
        const blobs = (yield* MemoryBlobStorage).blobs;
        const file = (text: string) => ({
          name: "r.pdf",
          contentType: "application/pdf",
          bytes: bytesOf(`%PDF-${text}`),
        });
        yield* Ref.set(mode, "store_down");
        const down = yield* Effect.exit(s.attach(testCaller, id, file("a")));
        const keptAfterDown = (yield* Ref.get(blobs)).size;
        yield* Ref.set(mode, "gone");
        const gone = yield* Effect.exit(s.attach(testCaller, id, file("b")));
        const afterGone = (yield* Ref.get(blobs)).size;
        return { down: Exit.isFailure(down), keptAfterDown, gone: Exit.isFailure(gone), afterGone };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ down: true, keptAfterDown: 1, gone: true, afterGone: 1 }));
  });
});
