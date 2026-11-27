/**
 * Shared setup for the payments-flow e2e tests: a vat_payer Workspace onboarded through
 * `Workspaces.create` on a fresh `TestCore`, with CZK and EUR bank accounts and a customer and a
 * supplier saved through `Contacts`. Every step goes through the service tags.
 */

import type {
  ContactView,
  CurrentCaller,
  DocumentInput,
  DocumentView,
  ExpenseId,
  MemberCaller,
} from "@kvitbit/domain/contract";
import {
  BankAccountInput,
  ContactId,
  Contacts,
  CurrencyCode,
  type DocumentId,
  Documents,
  type ExpenseView,
  IsoDate,
  MoneyMath,
  Payments,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { RegistryRecord } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { decodeView } from "../../src/modules/expenses";
import type { TestCoreServices } from "../../src/testing";
import { account, asCaller, runCore } from "../helpers";
import { fixing } from "../modules/documents/fixtures";

export const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Normalized decimal string, for assertions. */
export const str = (d: BigDecimal.BigDecimal) => d.pipe(BigDecimal.normalize, BigDecimal.format);

const CZK = CurrencyCode.make("CZK");
export const EUR = CurrencyCode.make("EUR");
export const TODAY = IsoDate.make("2026-11-23");

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

interface World {
  readonly owner: MemberCaller;
  readonly customer: ContactId;
  readonly supplier: ContactId;
}

type Body<A, E> = (world: World) => Effect.Effect<A, E, TestCoreServices | CurrentCaller>;

/**
 * Runs `body` as the owner of a new vat_payer Workspace on a fresh TestCore (TestClock at
 * TEST_NOW, CNB fixing EUR = 25.000 on 2026-11-23).
 */
export const inWorkspace = <A, E>(body: Body<A, E>) =>
  runCore(
    account(),
    Effect.gen(function* () {
      const owner = yield* Effect.flatMap(Workspaces, (ws) =>
        ws.create({ name: "Alfa Beta s.r.o.", ico: ICO, taxRegime: "vat_payer" }),
      );
      return yield* asCaller(
        owner,
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          yield* ws.saveBankAccount(
            BankAccountInput.make({
              iban: "CZ65 0800 0000 1920 0014 5399",
              currency: "CZK",
            }),
          );
          yield* ws.saveBankAccount(
            BankAccountInput.make({ iban: "DE89370400440532013000", currency: "EUR" }),
          );
          const contacts = yield* Contacts;
          const customer = yield* contacts.save({
            name: "Odběratel a.s.",
            ico: "25596641",
            dic: "CZ25596641",
            address: { city: "Brno", country: "CZ" },
            roles: ["customer"],
            billingEmails: ["fakturace@odberatel.cz"],
          });
          const supplier = yield* contacts.save({
            name: "Dodavatel s.r.o.",
            ico: "27074358",
            dic: "CZ27074358",
            address: { city: "Praha", country: "CZ" },
            roles: ["supplier"],
          });
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
    throw new Error("Expected payments flow to succeed", { cause: exit.cause });
  return exit.value;
};

const decodeContactId = Schema.decodeUnknownResult(ContactId);
const contactId = (view: ContactView) => Result.getOrThrow(decodeContactId(view.id));
export const docId = (v: DocumentView) => v.id;

/** 2 x 1000 standard + 1 x 500 reduced: base 2500, VAT 420 + 60, gross 2980 CZK. */
export const issueInvoice = ({
  contact,
  ...extra
}: Partial<DocumentInput> & { readonly contact: ContactId }) =>
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
      },
    }),
  );

const money = (amount: string, currency: CurrencyCode = CZK) =>
  MoneyMath.make(dec(amount), currency);

export const payDocument = ({
  document,
  amount,
  currency = CZK,
}: {
  readonly document: DocumentId;
  readonly amount?: string;
  readonly currency?: CurrencyCode;
}) =>
  Effect.flatMap(Payments, (p) => {
    const target = { document };
    return p.record(
      amount === undefined ? { target } : { target, amount: money(amount, currency) },
    );
  });

export const payExpense = ({
  expense,
  amount,
}: {
  readonly expense: ExpenseId;
  readonly amount?: string;
}) =>
  Effect.flatMap(Payments, (p) => {
    const target = { expense };
    return p.record(amount === undefined ? { target } : { target, amount: money(amount) });
  });

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

export const expenseFields = (view: ExpenseView) => decodeView(view);

export const bodyText = (bytes: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(bytes), (chunks) =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      Uint8Array.from(EffectArray.flatMap(chunks, (c) => [...c])),
    ),
  );
