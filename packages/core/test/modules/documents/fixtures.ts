/** Seed data and runners for the Documents tests (real layers on in-memory ports). */

import type {
  Caller,
  ContactDefaults,
  DocumentInput,
  DocumentView,
  TaxRegime,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  BankAccountId,
  ContactId,
  CurrencyCode,
  CurrentCaller,
  IsoDate,
  NumberingSeriesId,
  PriceListItemId,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import type * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import type { ContactForDocument, IssuerForDocument } from "../../../src/modules/documents";
import { DocumentFixtures, DocumentsTestLayer } from "../../../src/modules/documents";
import { DocumentViewCodec } from "../../../src/modules/documents/view";
import type { InMemoryPortsLive } from "../../../src/testing";
import { member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../helpers";

export const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Normalized decimal string, for assertions. */
export const str = (d: BigDecimal.BigDecimal) => d.pipe(BigDecimal.normalize, BigDecimal.format);

export const present = <A>(value: A | null | undefined): A => {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
};

export const concreteView = (view: DocumentView): typeof DocumentViewCodec.Type => {
  Schema.asserts(DocumentViewCodec, view);
  return view;
};

const EncodedViewFields = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ id: Schema.String })),
  totals: Schema.Json,
});

export const encodedView = (view: DocumentView) =>
  Effect.runPromise(
    Schema.encodeEffect(Schema.toCodecJson(DocumentViewCodec))(concreteView(view)).pipe(
      Effect.map((encoded) => {
        Schema.asserts(EncodedViewFields, encoded);
        return encoded;
      }),
    ),
  );

const uuid = (tail: string) => `01900000-0000-7000-8000-${EffectString.padStart(12, "0")(tail)}`;
export const CZ_BUYER = ContactId.make(uuid("c0000001"));
export const DE_BUYER = ContactId.make(uuid("c0000002"));
export const CZ_NO_DIC = ContactId.make(uuid("c0000003"));
export const B_BUYER = ContactId.make(uuid("c00000b1"));
export const ITEM = PriceListItemId.make(uuid("e0000001"));
export const CZK_ACCOUNT = BankAccountId.make(uuid("ba000001"));
export const EUR_ACCOUNT = BankAccountId.make(uuid("ba000002"));
const SERIES_WS = NumberingSeriesId.make(uuid("5e000001"));

export const CZK = CurrencyCode.make("CZK");
export const EUR = CurrencyCode.make("EUR");

type Billing = Partial<IssuerForDocument["billing"]>;

export const issuer: {
  (regime: TaxRegime, billing?: Billing): (workspaceId: WorkspaceId) => IssuerForDocument;
  (workspaceId: WorkspaceId, regime: TaxRegime, billing?: Billing): IssuerForDocument;
} = Fn.dual(
  (args) => Predicate.isString(args[1]),
  (workspaceId: WorkspaceId, regime: TaxRegime, billing: Billing = {}): IssuerForDocument => ({
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
        iban: "CZ1801000000000123456789",
        bic: null,
        isDefault: true,
      },
      {
        id: EUR_ACCOUNT,
        name: null,
        currency: EUR,
        accountNumber: null,
        iban: "CZ6701000000000987654321",
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
  }),
);

interface ContactOptions {
  readonly country?: string;
  readonly dic?: string | null;
  readonly defaults?: ContactDefaults;
  readonly name?: string;
}

export const contact: {
  (options?: ContactOptions): (id: ContactId) => ContactForDocument;
  (id: ContactId, options?: ContactOptions): ContactForDocument;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (id: ContactId, options: ContactOptions = {}): ContactForDocument => ({
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
  }),
);

export const fixing: {
  (eur: string, sequence?: number): (fixingDate: string) => CnbFixing;
  (fixingDate: string, eur: string, sequence?: number): CnbFixing;
} = Fn.dual(
  (args) => Predicate.isString(args[1]),
  (fixingDate: string, eur: string, sequence = 1): CnbFixing => ({
    fixingDate: IsoDate.make(fixingDate),
    sequence,
    rates: [{ code: EUR, quantity: 1, rate: dec(eur) }],
  }),
);

/** A simple invoice for CZ_BUYER: 2 x 1000 standard + 1 x 500 reduced. */
export const invoiceInput = (extra: Partial<DocumentInput> = {}): DocumentInput => ({
  kind: "invoice",
  contact: CZ_BUYER,
  lines: [
    { description: "Konzultace", quantity: dec("2"), unitPrice: dec("1000") },
    { description: "Kniha", unitPrice: dec("500"), vat: "reduced" },
  ],
  issuedOn: IsoDate.make("2026-11-23"),
  ...extra,
});

/** Seeds Workspace A (vat_payer by default) and B (non_vat_payer) with their Contacts. */
export const seed: {
  (regimeA?: TaxRegime): Effect.Effect<void, never, DocumentFixtures>;
  (
    billingA: Billing,
  ): (regimeA: TaxRegime | undefined) => Effect.Effect<void, never, DocumentFixtures>;
  (regimeA: TaxRegime | undefined, billingA: Billing): Effect.Effect<void, never, DocumentFixtures>;
} = Fn.dual(
  (args) => !Predicate.isObject(args[0]),
  (regimeA: TaxRegime = "vat_payer", billingA: Billing = {}) =>
    Effect.gen(function* () {
      const f = yield* DocumentFixtures;
      yield* f.putIssuer(issuer(WORKSPACE_A, regimeA, billingA));
      yield* f.putIssuer(issuer(WORKSPACE_B, "non_vat_payer"));
      yield* f.putContact(WORKSPACE_A, contact(CZ_BUYER));
      yield* f.putContact(WORKSPACE_A, contact(DE_BUYER, { country: "DE", dic: "DE123456789" }));
      yield* f.putContact(WORKSPACE_A, contact(CZ_NO_DIC, { dic: null }));
      yield* f.putContact(WORKSPACE_B, contact(B_BUYER));
    }),
);

export type Services =
  | Layer.Success<typeof DocumentsTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

interface ScenarioOptions {
  readonly caller?: Caller;
  readonly fixings?: ReadonlyArray<CnbFixing>;
  readonly regimeA?: TaxRegime;
  readonly billingA?: Billing;
}

/** Runs `body` as `caller` (default owner) over `DocumentsTestLayer` after `seed()`. */
export const scenario: {
  (
    options?: ScenarioOptions,
  ): <A, E>(body: Effect.Effect<A, E, Services>) => Promise<Exit.Exit<A, E>>;
  <A, E>(body: Effect.Effect<A, E, Services>, options?: ScenarioOptions): Promise<Exit.Exit<A, E>>;
} = Fn.dual(
  (args) => Effect.isEffect(args[0]),
  <A, E>(
    body: Effect.Effect<A, E, Services>,
    options: ScenarioOptions = {},
  ): Promise<Exit.Exit<A, E>> =>
    runTest(
      options.caller ?? member("owner"),
      Effect.andThen(seed(options.regimeA, options.billingA ?? {}), body).pipe(
        Effect.provide(DocumentsTestLayer),
      ),
      { fixings: options.fixings ?? [] },
    ),
);

/** Runs `effect` as another caller inside a scenario. */
export const as: {
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): (caller: Caller) => Effect.Effect<A, E, Exclude<R, CurrentCaller>>;
  <A, E, R>(
    caller: Caller,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentCaller>>;
} = Fn.dual(2, <A, E, R>(caller: Caller, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentCaller, caller),
);
