/** Seed data for the Documents e2e scenarios on TestCore (registry records, CNB fixings, setup). */
import type {
  ContactId,
  CurrencyCode,
  DocumentView,
  IsoDate,
  MemberCaller,
  TaxRegime,
} from "@kvitbit/domain/contract";
import { Contacts, Workspaces } from "@kvitbit/domain/contract";
import type { CnbFixing, RegistryRecord } from "@kvitbit/domain/ports";
import { BigDecimal, Effect } from "effect";
import { asCaller } from "../helpers";

export const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Normalized decimal string, for assertions. */
export const str = (d: BigDecimal.BigDecimal) => BigDecimal.format(BigDecimal.normalize(d));

export const CZK = "CZK" as CurrencyCode;
export const EUR = "EUR" as CurrencyCode;

/** The Issuing Entity's IČO and the buyer's IČO; both pass the checksum. */
export const ISSUER_ICO = "27074358";
export const BUYER_ICO = "25596641";

export const issuerRecord: RegistryRecord = {
  name: "Dodavatel s.r.o.",
  address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27074358",
  legalForm: "112",
  registerEntry: "C 123 vedená u Městského soudu v Praze",
  terminatedOn: null,
};

export const buyerRecord: RegistryRecord = {
  name: "Odběratel a.s.",
  address: { street: "Masarykova 5", city: "Brno", postalCode: "60200", country: "CZ" },
  dic: "CZ25596641",
  legalForm: "121",
  registerEntry: "B 456 vedená u Krajského soudu v Brně",
  terminatedOn: null,
};

export const registry = { [ISSUER_ICO]: issuerRecord, [BUYER_ICO]: buyerRecord };

export const fixing = (fixingDate: string, eur: string, sequence = 1): CnbFixing => ({
  fixingDate: fixingDate as IsoDate,
  sequence,
  rates: [{ code: EUR, quantity: 1, rate: dec(eur) }],
});

/**
 * As an Account: creates a Workspace from the issuer's IČO with `regime`, adds a CZK and a EUR
 * bank account, and saves the buyer from ARES with an invoicing email. Returns the owner and buyer.
 */
export const onboard = (regime: TaxRegime) =>
  Effect.gen(function* () {
    const ws = yield* Workspaces;
    const owner = yield* ws.create({ ico: ISSUER_ICO, taxRegime: regime } as never);
    const buyer = yield* asCaller(
      owner,
      Effect.gen(function* () {
        yield* ws.saveBankAccount({ iban: "CZ1801000000000123456789", currency: CZK } as never);
        yield* ws.saveBankAccount({ iban: "CZ6701000000000987654321", currency: EUR } as never);
        const contacts = yield* Contacts;
        const fromAres = yield* contacts.fromIco(BUYER_ICO);
        return yield* contacts.save({
          id: fromAres.id as ContactId,
          expectedRevision: fromAres.revision,
          billingEmails: ["fakturace@odberatel.cz"],
        } as never);
      }),
    );
    return { owner, buyer: buyer.id as ContactId } as { owner: MemberCaller; buyer: ContactId };
  });

export const amounts = (view: Pick<DocumentView, "totals">) => ({
  net: str(view.totals.net.amount),
  vat: str(view.totals.vat.amount),
  gross: str(view.totals.gross.amount),
});

/** [treatment, rate %, base, vat, gross, vatCzk] per VAT bucket. */
export const buckets = (view: Pick<DocumentView, "totals">) =>
  view.totals.buckets.map((b) => [
    b.treatment,
    str(b.ratePercent),
    str(b.base),
    str(b.vat),
    str(b.gross),
    b.vatCzk === null ? null : str(b.vatCzk),
  ]);
