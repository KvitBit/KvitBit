/** Shared scenario runner and fixtures for the Expenses tests. */
import type {
  Caller,
  ContactId,
  CurrencyCode,
  ExpenseId,
  ExpenseView,
  IsoDate,
  RequestKey,
} from "@kvitbit/domain/contract";
import { CurrentCaller, Expenses } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import type { Layer } from "effect";
import { BigDecimal, Effect, Ref, Stream } from "effect";
import type { ExpenseViewFields } from "../../../src/modules/expenses";
import {
  decodeView,
  ExpensesTestLayer,
  FakeSupplierDirectory,
} from "../../../src/modules/expenses";
import { type InMemoryPortsLive, member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../helpers";

export const owner = member("owner");
export const ownerB = member("owner", { workspaceId: WORKSPACE_B });

export const EUR_FIXING: CnbFixing = {
  fixingDate: "2026-11-20" as IsoDate,
  sequence: 1,
  rates: [
    { code: "EUR" as CurrencyCode, quantity: 1, rate: BigDecimal.fromStringUnsafe("25.125") },
  ],
};

export const SUPPLIER_CONTACT = "01900000-0000-7000-8000-0000000c0001" as ContactId;
export const SUPPLIER_CONTACT_B = "01900000-0000-7000-8000-0000000c0002" as ContactId;

type ScenarioServices =
  | Layer.Success<typeof ExpensesTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

/** Runs `body` as `caller` with Expenses on fresh in-memory ports (EUR fixing, two supplier Contacts). */
export const scenario = <A, E>(
  body: Effect.Effect<A, E, ScenarioServices>,
  options: { readonly caller?: Caller; readonly layer?: typeof ExpensesTestLayer } = {},
) =>
  runTest(
    options.caller ?? owner,
    Effect.gen(function* () {
      const dir = yield* FakeSupplierDirectory;
      yield* Ref.set(dir.contacts, [
        {
          workspaceId: WORKSPACE_A,
          contactId: SUPPLIER_CONTACT,
          name: "Dodavatel s.r.o.",
          ico: "27074358",
          dic: "CZ27074358",
        },
        {
          workspaceId: WORKSPACE_B,
          contactId: SUPPLIER_CONTACT_B,
          name: "Other workspace s.r.o.",
          ico: "25596641",
          dic: null,
        },
      ]);
      return yield* body;
    }).pipe(Effect.provide(options.layer ?? ExpensesTestLayer)),
    { fixings: [EUR_FIXING] },
  );

/** Runs `effect` as another caller inside a scenario. */
export const as = <A, E, R>(caller: Caller, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentCaller, caller);

/** A valid complete CZK Expense: 100 + 21 % VAT. */
export const czkInput = {
  supplier: { contact: SUPPLIER_CONTACT },
  supplierDocumentNumber: "FV-2026-001",
  issuedOn: "2026-11-20",
  taxableSupplyOn: "2026-11-19",
  dueOn: "2026-12-04",
  currency: "CZK",
  total: "121.00",
  vat: [{ treatment: "standard", base: "100.00", vat: "21.00" }],
  category: "software",
  tags: ["saas"],
};

export const fields = (view: ExpenseView): ExpenseViewFields => decodeView(view);

export const record = (input: Record<string, unknown>, requestKey?: string) =>
  Effect.gen(function* () {
    const s = yield* Expenses;
    return yield* s.record(
      input,
      requestKey === undefined ? undefined : { requestKey: requestKey as RequestKey },
    );
  });

export const bytesOf = (text: string) => Stream.make(new TextEncoder().encode(text));

export const expenseId = (view: ExpenseView) => fields(view).id as ExpenseId;

/** A HEIC `ftyp` box: size 24, major brand mif1, compatible brands mif1 + heic. */
export const HEIC_HEAD = Uint8Array.from([
  0,
  0,
  0,
  24,
  ...new TextEncoder().encode("ftypmif1"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("mif1heic"),
]);
