/** Seed data and runners for the Documents tests (real layers on in-memory ports). */
import type {
  BankAccountId,
  Caller,
  ContactDefaults,
  ContactId,
  CurrencyCode,
  DocumentInput,
  IsoDate,
  NumberingSeriesId,
  PriceListItemId,
  TaxRegime,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import type { Exit, Layer } from "effect";
import { BigDecimal, Effect } from "effect";
import type { ContactForDocument, IssuerForDocument } from "../../../src/modules/documents";
import { DocumentFixtures, DocumentsTestLayer } from "../../../src/modules/documents";
import type { InMemoryPortsLive } from "../../../src/testing";
import { member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../helpers";

export const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Normalized decimal string, for assertions. */
export const str = (d: BigDecimal.BigDecimal) => BigDecimal.format(BigDecimal.normalize(d));

const uuid = (tail: string) => `01900000-0000-7000-8000-${tail.padStart(12, "0")}`;
export const CZ_BUYER = uuid("c0000001") as ContactId;
export const DE_BUYER = uuid("c0000002") as ContactId;
export const CZ_NO_DIC = uuid("c0000003") as ContactId;
export const B_BUYER = uuid("c00000b1") as ContactId;
export const ITEM = uuid("e0000001") as PriceListItemId;
export const CZK_ACCOUNT = uuid("ba000001") as BankAccountId;
export const EUR_ACCOUNT = uuid("ba000002") as BankAccountId;
export const SERIES_WS = uuid("5e000001") as NumberingSeriesId;

export const CZK = "CZK" as CurrencyCode;
export const EUR = "EUR" as CurrencyCode;

export const issuer = (
  workspaceId: WorkspaceId,
  regime: TaxRegime,
  billing: Partial<IssuerForDocument["billing"]> = {},
): IssuerForDocument => ({
  party: {
    workspaceId,
    name: "Dodavatel s.r.o.",
    ico: "27074358",
    dic: regime === "non_vat_payer" ? null : "CZ27074358",
    address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
    registerEntry: "C 123 vedená u Městského soudu v Praze",
    email: null,
    phone: null,
    web: null,
  },
  regime,
  bankAccounts: [
    {
      id: CZK_ACCOUNT,
      name: null,
      currency: CZK,
      accountNumber: "123456789/0100",
      iban: "CZ6501000000000123456789",
      bic: null,
      isDefault: true,
    },
    {
      id: EUR_ACCOUNT,
      name: null,
      currency: EUR,
      accountNumber: null,
      iban: "CZ0201000000000987654321",
      bic: "KOMBCZPP",
      isDefault: true,
    },
  ],
  billing: {
    currency: CZK,
    language: "cs",
    dueDays: 14,
    paymentMethod: "bank_transfer",
    seriesByKind: { invoice: SERIES_WS },
    defaultNote: null,
    ...billing,
  },
  reminders: { enabled: true, proformas: false, offsetsDays: [3, 10] },
  paymentRounding: "none",
  revision: 1,
});

export const contact = (
  id: ContactId,
  options: {
    country?: string;
    dic?: string | null;
    defaults?: ContactDefaults;
    name?: string;
  } = {},
): ContactForDocument => ({
  party: {
    contactId: id,
    name: options.name ?? "Odběratel a.s.",
    ico: "25596641",
    dic: options.dic === undefined ? "CZ25596641" : options.dic,
    legalForm: null,
    address: { street: null, city: "Brno", postalCode: null, country: options.country ?? "CZ" },
  },
  defaults: { reminderPolicy: { mode: "inherit" }, ...options.defaults },
  roles: ["customer"],
  billingEmails: ["fakturace@odberatel.cz"],
  archived: false,
  revision: 1,
});

export const fixing = (fixingDate: string, eur: string, sequence = 1): CnbFixing => ({
  fixingDate: fixingDate as IsoDate,
  sequence,
  rates: [{ code: EUR, quantity: 1, rate: dec(eur) }],
});

/** A simple invoice for CZ_BUYER: 2 x 1000 standard + 1 x 500 reduced. */
export const invoiceInput = (extra: Partial<DocumentInput> = {}): DocumentInput => ({
  kind: "invoice",
  contact: CZ_BUYER,
  lines: [
    { description: "Konzultace", quantity: dec("2"), unitPrice: dec("1000") },
    { description: "Kniha", unitPrice: dec("500"), vat: "reduced" },
  ],
  issuedOn: "2026-11-23" as IsoDate,
  ...extra,
});

/** Seeds Workspace A (vat_payer by default) and B (non_vat_payer) with their Contacts. */
export const seed = (
  regimeA: TaxRegime = "vat_payer",
  billingA: Partial<IssuerForDocument["billing"]> = {},
) =>
  Effect.gen(function* () {
    const f = yield* DocumentFixtures;
    yield* f.putIssuer(issuer(WORKSPACE_A, regimeA, billingA));
    yield* f.putIssuer(issuer(WORKSPACE_B, "non_vat_payer"));
    yield* f.putContact(WORKSPACE_A, contact(CZ_BUYER));
    yield* f.putContact(WORKSPACE_A, contact(DE_BUYER, { country: "DE", dic: "DE123456789" }));
    yield* f.putContact(WORKSPACE_A, contact(CZ_NO_DIC, { dic: null }));
    yield* f.putContact(WORKSPACE_B, contact(B_BUYER));
  });

type Services =
  | Layer.Success<typeof DocumentsTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

/** Runs `body` as `caller` (default owner) over `DocumentsTestLayer` after `seed()`. */
export const scenario = <A, E>(
  body: Effect.Effect<A, E, Services>,
  options: {
    readonly caller?: Caller;
    readonly fixings?: ReadonlyArray<CnbFixing>;
    readonly regimeA?: TaxRegime;
    readonly billingA?: Partial<IssuerForDocument["billing"]>;
  } = {},
): Promise<Exit.Exit<A, E>> =>
  runTest(
    options.caller ?? member("owner"),
    Effect.andThen(seed(options.regimeA, options.billingA), body).pipe(
      Effect.provide(DocumentsTestLayer),
    ),
    { fixings: options.fixings ?? [] },
  );

/** Runs `effect` as another caller inside a scenario. */
export const as = <A, E, R>(caller: Caller, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentCaller, caller);
