/**
 * Shared setup for the payments-flow e2e tests: a vat_payer Workspace onboarded through
 * `Workspaces.create` on a fresh `TestCore`, with CZK and EUR bank accounts and a customer and a
 * supplier saved through `Contacts`. Every step goes through the service tags.
 */
import type {
  ContactId,
  ContactView,
  CurrencyCode,
  CurrentCaller,
  DocumentId,
  DocumentInput,
  DocumentView,
  ExpenseId,
  IsoDate,
  MemberCaller,
} from "@kvitbit/domain/contract";
import { Contacts, Documents, MoneyMath, Payments, Workspaces } from "@kvitbit/domain/contract";
import type { RegistryRecord } from "@kvitbit/domain/ports";
import type { Exit } from "effect";
import { BigDecimal, Effect, Stream } from "effect";
import { decodeView } from "../../src/modules/expenses";
import type { TestCoreServices } from "../../src/testing";
import { account, asCaller, runCore } from "../helpers";
import { fixing } from "../modules/documents/fixtures";

export const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Normalized decimal string, for assertions. */
export const str = (d: BigDecimal.BigDecimal) => BigDecimal.format(BigDecimal.normalize(d));

export const CZK = "CZK" as CurrencyCode;
export const EUR = "EUR" as CurrencyCode;
export const TODAY = "2026-11-23" as IsoDate;

/** The issuer's IČO, with a CompanyRegistry record (prefills name, address and DIČ). */
const ICO = "27082440";
const RECORD: RegistryRecord = {
  name: "Alfa Beta s.r.o.",
  address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27082440",
  legalForm: "s.r.o.",
  registerEntry: "C 12345 vedená u Městského soudu v Praze",
  terminatedOn: null,
};

export interface World {
  readonly owner: MemberCaller;
  readonly customer: ContactId;
  readonly supplier: ContactId;
}

export type Body<A, E> = (world: World) => Effect.Effect<A, E, TestCoreServices | CurrentCaller>;

/**
 * Runs `body` as the owner of a new vat_payer Workspace on a fresh TestCore (TestClock at
 * TEST_NOW, CNB fixing EUR = 25.000 on 2026-11-23).
 */
export const inWorkspace = <A, E>(body: Body<A, E>): Promise<Exit.Exit<A, E | unknown>> =>
  runCore(
    account(),
    Effect.gen(function* () {
      const owner = yield* Effect.flatMap(Workspaces, (ws) =>
        ws.create({ name: "Alfa Beta s.r.o.", ico: ICO, taxRegime: "vat_payer" } as never),
      );
      return yield* asCaller(
        owner,
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          yield* ws.saveBankAccount({
            iban: "CZ65 0800 0000 1920 0014 5399",
            currency: "CZK",
          } as never);
          yield* ws.saveBankAccount({ iban: "DE89370400440532013000", currency: "EUR" } as never);
          const contacts = yield* Contacts;
          const customer = yield* contacts.save({
            name: "Odběratel a.s.",
            ico: "25596641",
            dic: "CZ25596641",
            address: { city: "Brno", country: "CZ" },
            roles: ["customer"],
            billingEmails: ["fakturace@odberatel.cz"],
          } as never);
          const supplier = yield* contacts.save({
            name: "Dodavatel s.r.o.",
            ico: "27074358",
            dic: "CZ27074358",
            address: { city: "Praha", country: "CZ" },
            roles: ["supplier"],
          } as never);
          return yield* body({
            owner,
            customer: contactId(customer),
            supplier: contactId(supplier),
          });
        }),
      );
    }),
    { registry: { [ICO]: RECORD }, fixings: [fixing("2026-11-23", "25.000")] },
  );

export const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (exit._tag === "Failure")
    throw new Error(
      `expected success, got ${JSON.stringify(exit.cause, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
    );
  return exit.value;
};

const contactId = (v: ContactView) => (v as unknown as { readonly id: ContactId }).id;
export const docId = (v: DocumentView) => v.id as DocumentId;

/** 2 x 1000 standard + 1 x 500 reduced: base 2500, VAT 420 + 60, gross 2980 CZK. */
export const issueInvoice = (contact: ContactId, extra: Partial<DocumentInput> = {}) =>
  Effect.flatMap(Documents, (d) =>
    d.issue({
      input: {
        kind: "invoice",
        contact,
        lines: [
          { description: "Konzultace", quantity: dec("2"), unitPrice: dec("1000") },
          { description: "Kniha", unitPrice: dec("500"), vat: "reduced" },
        ],
        issuedOn: TODAY,
        ...extra,
      } as DocumentInput,
    }),
  );

export const money = (amount: string, currency: CurrencyCode = CZK) =>
  MoneyMath.make(dec(amount), currency);

export const payDocument = (document: DocumentId, amount?: string, currency = CZK) =>
  Effect.flatMap(Payments, (p) =>
    p.record({
      target: { document },
      ...(amount === undefined ? {} : { amount: money(amount, currency) }),
    }),
  );

export const payExpense = (expense: ExpenseId, amount?: string) =>
  Effect.flatMap(Payments, (p) =>
    p.record({ target: { expense }, ...(amount === undefined ? {} : { amount: money(amount) }) }),
  );

/**
 * A complete CZK Expense from `supplier`: 100 + 21 % VAT = 121 CZK, tax point TODAY.
 */
export const expenseInput = (supplier: ContactId) => ({
  supplier: { contact: supplier },
  supplierDocumentNumber: "FV-2026-001",
  issuedOn: TODAY,
  taxableSupplyOn: TODAY,
  dueOn: "2026-12-04",
  currency: "CZK",
  total: "121.00",
  vat: [{ treatment: "standard", base: "100.00", vat: "21.00" }],
  category: "software",
  tags: [],
});

export const expenseFields = decodeView;

export const bodyText = (bytes: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(bytes), (chunks) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      Uint8Array.from(chunks.flatMap((c) => [...c])),
    ),
  );
