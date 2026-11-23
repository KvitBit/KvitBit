/** Regressions for review round 1 on 0fbe8de. */
import { describe, expect, test } from "bun:test";
import type { ContactId, CurrencyCode, WorkspaceId } from "@kvitbit/domain/contract";
import { CurrentCaller, Expenses, Invalid, MoneyMath } from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit, Layer, Ref, Schema } from "effect";
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
  matchesType,
} from "../../../src/modules/expenses";
import { CoreStore, StoreUnavailable } from "../../../src/store/CoreStore";
import { defineCollection, MemoryBlobStorage, MemoryTables, WORKSPACE_A } from "../../helpers";
import { bytesOf, czkInput, expenseId, fields, HEIC_HEAD, record, scenario } from "./fixtures";

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
    ...ascii(compatible.join("")),
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

describe("list", () => {
  test("rows carry the currency; a cursor with a malformed id is request.malformed", async () => {
    const exit = await scenario(
      Effect.gen(function* () {
        yield* record({ ...czkInput, currency: "EUR", taxableSupplyOn: "2026-11-22" });
        const s = yield* Expenses;
        const page = yield* s.list({});
        const forged = yield* Effect.exit(s.list({ cursor: btoa(JSON.stringify(["all", ""])) }));
        return {
          currency: page.items.map((i) => decodeSummary(i).currency as string | null),
          forged,
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        currency: ["EUR"],
        forged: Exit.fail(
          new Invalid({ issues: [{ path: ["cursor"], code: "request.malformed" }] }),
        ),
      }),
    );
  });
});

// A supplier port whose IČO path upserts a Contact through MemoryTables, like Contacts.fromIco
// does through the store: its write must roll back with a failed edit (rule C1).
const ContactRow = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  revision: Schema.Number,
  ico: Schema.String,
});
type ContactRow = typeof ContactRow.Type & { readonly workspaceId: WorkspaceId };
const Upserted = defineCollection<ContactRow>({
  name: "test_upserted_contacts",
  entity: "Contact",
  schema: ContactRow as unknown as Schema.Codec<ContactRow, unknown>,
});
const UpsertingSuppliers = Layer.effect(
  ExpenseSuppliers,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(Upserted);
    return {
      contact: () => Effect.die("unused"),
      fromIco: (ico: string) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          const workspaceId = (caller as { readonly workspaceId: WorkspaceId }).workspaceId;
          const id = `01900000-0000-7000-8000-0000000c${ico.slice(-4)}`;
          yield* table.insert({ id, workspaceId, revision: 1, ico }).pipe(Effect.orDie);
          return { contactId: id as ContactId, name: `Supplier ${ico}`, ico, dic: null };
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
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(
          yield* record({ ...czkInput, supplier: { manual: { name: "Typed" } } }),
        );
        const s = yield* Expenses;
        const tables = yield* MemoryTables;
        const contacts = tables.collection(Upserted);
        const store = yield* CoreStore;
        const payables = yield* ExpensePayables;
        yield* store.transaction(
          payables.settle(WORKSPACE_A, id, {
            amount: MoneyMath.make(BigDecimal.fromStringUnsafe("21"), "CZK" as CurrencyCode),
            payments: 1,
          }),
        );
        // Fails inside the transaction, after the supplier upsert ran (paid Expense keeps CZK).
        const failed = yield* Effect.exit(
          s.edit(
            id,
            { currency: "EUR", taxableSupplyOn: "2026-11-22", supplier: { ico: "11111111" } },
            2,
          ),
        );
        const afterFailed = (yield* contacts.listGlobal()).length;
        const ok = fields(yield* s.edit(id, { supplier: { ico: "22222222" } }, 2));
        const afterOk = (yield* contacts.listGlobal()).map((c) => c.ico);
        return { failed: Exit.isFailure(failed), afterFailed, afterOk, supplier: ok.supplier?.ico };
      }),
      { layer },
    );
    expect(exit).toEqual(
      Exit.succeed({ failed: true, afterFailed: 0, afterOk: ["22222222"], supplier: "22222222" }),
    );
  });
});

describe("attach and an uncertain commit", () => {
  test("a store failure keeps the blob (housekeeping decides); a certain rollback deletes it", async () => {
    const mode = { current: "ok" as "ok" | "store_down" | "gone" };
    const FlakyRepo = Layer.effect(
      ExpensesRepo,
      Effect.map(ExpensesRepo, (repo) => ({
        ...repo,
        insertAttachment: (row: Parameters<typeof repo.insertAttachment>[0]) =>
          mode.current === "store_down"
            ? Effect.fail(new StoreUnavailable({ cause: "commit outcome unknown" }))
            : repo.insertAttachment(row),
        lock: (ws: Parameters<typeof repo.lock>[0], id: Parameters<typeof repo.lock>[1]) =>
          mode.current === "gone"
            ? Effect.flatMap(repo.lock(ws, id), (row) =>
                Effect.succeed({ ...row, removedAt: "2026-11-23T09:00:00.000Z" }),
              )
            : repo.lock(ws, id),
      })),
    ).pipe(Layer.provide(ExpensesRepoMemory));
    const layer = Layer.mergeAll(ExpensesLive, ExpensePayablesLive, ExpenseRecordsLive).pipe(
      Layer.provideMerge(FakeExpenseSuppliers),
      Layer.provideMerge(FlakyRepo),
    );
    const exit = await scenario(
      Effect.gen(function* () {
        const id = expenseId(yield* record({ status: "incomplete" }));
        const s = yield* Expenses;
        const blobs = (yield* MemoryBlobStorage).blobs;
        const file = (text: string) => ({
          name: "r.pdf",
          contentType: "application/pdf",
          bytes: bytesOf(`%PDF-${text}`),
        });
        mode.current = "store_down";
        const down = yield* Effect.exit(s.attach(id, file("a")));
        const keptAfterDown = (yield* Ref.get(blobs)).size;
        mode.current = "gone";
        const gone = yield* Effect.exit(s.attach(id, file("b")));
        const afterGone = (yield* Ref.get(blobs)).size;
        return { down: Exit.isFailure(down), keptAfterDown, gone: Exit.isFailure(gone), afterGone };
      }),
      { layer },
    );
    expect(exit).toEqual(Exit.succeed({ down: true, keptAfterDown: 1, gone: true, afterGone: 1 }));
  });
});
