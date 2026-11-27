/** Seed data for the Documents e2e scenarios on TestCore (registry records, CNB fixings, setup). */

import type { DocumentView, TaxRegime } from "@kvitbit/domain/contract";
import {
  BankAccountInput,
  ContactId,
  Contacts,
  CurrencyCode,
  IsoDate,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { CnbFixing, RegistryRecord } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { asCaller } from "../helpers";

export const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
/** Normalized decimal string, for assertions. */
export const str = (d: BigDecimal.BigDecimal) => d.pipe(BigDecimal.normalize, BigDecimal.format);

export const CZK = CurrencyCode.make("CZK");
export const EUR = CurrencyCode.make("EUR");

/** The Issuing Entity's IČO and the buyer's IČO; both pass the checksum. */
const ISSUER_ICO = "27074358";
export const BUYER_ICO = "25596641";

const issuerRecord: RegistryRecord = {
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

export const fixing = ({
  date,
  eur,
  sequence = 1,
}: {
  readonly date: string;
  readonly eur: string;
  readonly sequence?: number;
}): CnbFixing => ({
  fixingDate: IsoDate.make(date),
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
    const owner = yield* ws.create({ ico: ISSUER_ICO, taxRegime: regime });
    const buyer = yield* asCaller(
      owner,
      Effect.gen(function* () {
        yield* ws.saveBankAccount(
          BankAccountInput.make({ iban: "CZ1801000000000123456789", currency: CZK }),
        );
        yield* ws.saveBankAccount(
          BankAccountInput.make({ iban: "CZ6701000000000987654321", currency: EUR }),
        );
        const contacts = yield* Contacts;
        const fromAres = yield* contacts.fromIco(BUYER_ICO);
        const id = yield* Schema.decodeUnknownEffect(ContactId)(fromAres["id"]);
        return yield* contacts.save({
          id,
          expectedRevision: fromAres.revision,
          billingEmails: ["fakturace@odberatel.cz"],
        });
      }),
    );
    const id = yield* Schema.decodeUnknownEffect(ContactId)(buyer["id"]);
    return { owner, buyer: id };
  });

export const amounts = (view: Pick<DocumentView, "totals">) => ({
  net: str(view.totals.net.amount),
  vat: str(view.totals.vat.amount),
  gross: str(view.totals.gross.amount),
});

/** [treatment, rate %, base, vat, gross, vatCzk] per VAT bucket. */
export const buckets = (view: Pick<DocumentView, "totals">) =>
  EffectArray.map(view.totals.buckets, (b) => [
    b.treatment,
    str(b.ratePercent),
    str(b.base),
    str(b.vat),
    str(b.gross),
    b.vatCzk === null ? null : str(b.vatCzk),
  ]);
