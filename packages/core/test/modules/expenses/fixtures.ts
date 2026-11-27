/** Shared scenario runner and fixtures for the Expenses tests. */
import type { AttachmentView, Caller, ExpenseInput, ExpenseView } from "@kvitbit/domain/contract";
import {
  ContactId,
  CurrencyCode,
  CurrentCaller,
  ExpenseId,
  Expenses,
  IsoDate,
  RequestKey,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ExpenseViewFields } from "../../../src/modules/expenses";
import {
  decodeView,
  ExpensesTestLayer,
  FakeSupplierDirectory,
} from "../../../src/modules/expenses";
import { AttachResultFields } from "../../../src/modules/expenses/model";
import { type InMemoryPortsLive, member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../helpers";

const owner = member("owner");
export const ownerB = member("owner", { workspaceId: WORKSPACE_B });

export const EUR_FIXING: CnbFixing = {
  fixingDate: IsoDate.make("2026-11-20"),
  sequence: 1,
  rates: [
    { code: CurrencyCode.make("EUR"), quantity: 1, rate: BigDecimal.fromStringUnsafe("25.125") },
  ],
};

export const SUPPLIER_CONTACT = ContactId.make("01900000-0000-7000-8000-0000000c0001");
export const SUPPLIER_CONTACT_B = ContactId.make("01900000-0000-7000-8000-0000000c0002");

type ScenarioServices =
  | Layer.Success<typeof ExpensesTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

/** Runs an Expenses scenario on fresh in-memory ports with the EUR fixing and supplier Contacts. */
export const scenarioWithLayer =
  (layer: typeof ExpensesTestLayer) =>
  <A, E>(body: Effect.Effect<A, E, ScenarioServices>) =>
    runTest(
      owner,
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
      }).pipe(Effect.provide(layer)),
      { fixings: [EUR_FIXING] },
    );

export const scenario = scenarioWithLayer(ExpensesTestLayer);

/** Runs an Effect as another caller inside a scenario. */
export const asCaller = (caller: Caller) => Effect.provideService(CurrentCaller, caller);

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

const decodeAttachment = Schema.decodeUnknownEffect(Schema.toCodecJson(AttachResultFields));
export const attachmentFields = (view: AttachmentView) => decodeAttachment(view);

export const recordWithKey = (requestKey?: string) => (input: ExpenseInput) =>
  Effect.flatMap(Expenses, (expenses) =>
    expenses.record(
      input,
      requestKey === undefined ? undefined : { requestKey: RequestKey.make(requestKey) },
    ),
  );

export const record = recordWithKey();

export const bytesOf = (text: string) => Stream.make(new TextEncoder().encode(text));

export const expenseId = (view: ExpenseView) => ExpenseId.make(fields(view).id);

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
