/**
 * Payment QR for `DocumentView.paymentQr` (rule D12): the `forDocument` subset of core-ports
 * 5.3 PaymentQr, which src/engines does not provide yet (move it there when it lands).
 * SPAYD (QR Platba, CBA 1.2) for CZK, EPC069-12 v002 (SCT) for EUR, each only when the bank
 * account has an IBAN; otherwise null. Credit Notes, cancelled documents and documents with
 * nothing to pay (gross <= 0) never carry one.
 *
 * Issue codes: the frozen IssueCode union has no qr.iban_invalid / variable-symbol code, so,
 * like the rest of core (numbering, identity; board #430), field validation uses
 * `request.malformed` with `params.reason` until the domain adds them.
 *
 * D12 exception (parent cd-lifecycle ruling, P1): the amount never makes a document invalid.
 * Nothing to pay (gross <= 0, credit notes included) or an amount above the format's maximum
 * (SPAYD 9,999,999.99 CZK, EPC 999,999,999.99 EUR) gives no QR, so large invoices can still be
 * drafted and issued.
 *
 * Validation (5.3): an IBAN failing ISO 13616 (SEPA country BBAN structure from the SWIFT
 * registry, mod 97), a malformed BIC, a missing BIC on an EPC payment to a non-EEA SEPA IBAN
 * (EPC069-12 v002), or a variable symbol that is not 1-10 digits is `Invalid`; `compose` runs this on
 * every write and preview, so stored documents always encode. Optional texts (recipient name,
 * remittance) are truncated at a word boundary. A caller's variable symbol is kept exactly; one
 * derived from the document number takes its last ten digits.
 */
import type {
  CurrencyCode,
  DocumentKind,
  DocumentStatus,
  IsoDate,
  Issue,
} from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { BigDecimal, Result } from "effect";
import { roundAt } from "../../engines/decimal";
import type { BankAccountRecord } from "./record";

/** What `forDocument` reads; a `DocumentRecord` satisfies it. */
export interface QrSource {
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  readonly currency: CurrencyCode;
  readonly number: string | null;
  readonly variableSymbol: string | null;
  readonly dueOn: IsoDate;
  readonly totals: { readonly gross: { readonly amount: BigDecimal.BigDecimal } };
  readonly issuer: { readonly name: string; readonly bankAccount: BankAccountRecord | null };
}

export type PaymentQr = { readonly format: "spayd" | "epc"; readonly payload: string };

const MAX_SPAYD = BigDecimal.fromStringUnsafe("9999999.99");
const MAX_EPC = BigDecimal.fromStringUnsafe("999999999.99");

const invalid = (path: Issue["path"], code: Issue["code"], params?: Record<string, string>) =>
  Result.fail(new Invalid({ issues: [params ? { path, code, params } : { path, code }] }));

/** Amount at 2 decimals, half away from zero, plain notation. */
const amount2 = (value: BigDecimal.BigDecimal) => {
  const scaled = BigDecimal.scale(roundAt(value, 2), 2);
  const digits = scaled.value.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** Cuts text to `max` characters at a word boundary (5.3: optional text is truncated). */
const truncate = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : clean.slice(0, max)).trim();
};

/**
 * BBAN structure per SEPA country, from the SWIFT IBAN registry (n digits, a upper-case letters,
 * c upper-case alphanumerics). SPAYD and EPC are SEPA-only, so a non-SEPA IBAN is invalid here.
 */
const BBAN_FORMAT: Readonly<Record<string, string>> = {
  AD: "4n4n12c",
  AL: "8n16c",
  AT: "16n",
  BE: "12n",
  BG: "4a4n2n8c",
  CH: "5n12c",
  CY: "3n5n16c",
  CZ: "4n6n10n",
  DE: "18n",
  DK: "4n9n1n",
  EE: "2n2n11n1n",
  ES: "4n4n1n1n10n",
  FI: "3n11n",
  FR: "5n5n11c2n",
  GB: "4a6n8n",
  GI: "4a15c",
  GR: "3n4n16c",
  HR: "7n10n",
  HU: "3n4n1n15n1n",
  IE: "4a6n8n",
  IS: "4n2n6n10n",
  IT: "1a5n5n12c",
  LI: "5n12c",
  LT: "5n11n",
  LU: "3n13c",
  LV: "4a13c",
  MC: "5n5n11c2n",
  MD: "2c18c",
  ME: "3n13n2n",
  MK: "3n10c2n",
  MT: "4a5n18c",
  NL: "4a10n",
  NO: "4n6n1n",
  PL: "8n16n",
  PT: "4n4n11n2n",
  RO: "4a16c",
  RS: "3n13n2n",
  SE: "3n16n1n",
  SI: "5n8n2n",
  SK: "4n6n10n",
  SM: "1a5n5n12c",
  VA: "3n15n",
};
const CLASS = { n: "[0-9]", a: "[A-Z]", c: "[A-Z0-9]" } as const;
const BBAN_PATTERN: ReadonlyMap<string, RegExp> = new Map(
  Object.entries(BBAN_FORMAT).map(([country, format]) => [
    country,
    new RegExp(
      `^${Array.from(format.matchAll(/(\d+)([nac])/g), ([, n, k]) => `${CLASS[k as keyof typeof CLASS]}{${n}}`).join("")}$`,
    ),
  ]),
);

/** ISO 13616 for a SEPA IBAN: registered country BBAN structure (length included), mod 97 = 1. */
export const isValidIban = (iban: string): boolean => {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const pattern = BBAN_PATTERN.get(iban.slice(0, 2));
  if (pattern === undefined || !pattern.test(iban.slice(4))) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = Number.parseInt(ch, 36).toString();
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
};

/** A caller's variable symbol must be 1-10 digits (SPAYD X-VS). */
export const isValidVariableSymbol = (vs: string): boolean => /^\d{1,10}$/.test(vs);

/** ISO 3166-1 alpha-2 assigned codes, plus XK (Kosovo), which SWIFT assigns in BICs. */
const COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ " +
    "BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM " +
    "DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS " +
    "GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
    "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ " +
    "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM " +
    "PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV " +
    "SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI " +
    "VN VU WF WS YE YT ZA ZM ZW XK"
  ).split(" "),
);

/**
 * ISO 9362 BIC: 4 letters (institution), an assigned 2-letter country code, 2 alphanumerics
 * (location), optional 3 alphanumerics (branch).
 */
export const isValidBic = (bic: string): boolean =>
  /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) && COUNTRIES.has(bic.slice(4, 6));

/**
 * SEPA countries outside the EEA. EPC069-12 v002 makes the beneficiary BIC optional only
 * within the EEA, so an EPC payment to one of these IBANs needs a BIC.
 */
const SEPA_NON_EEA = new Set([
  "AD",
  "AL",
  "CH",
  "GB",
  "GI",
  "MC",
  "MD",
  "ME",
  "MK",
  "RS",
  "SM",
  "VA",
]);

const spaydValue = (value: string) => value.toUpperCase().replaceAll("*", "%2A");

export const forDocument = (doc: QrSource): Result.Result<PaymentQr | null, Invalid> => {
  // 1. Every "no QR applies" case first (D12 and the parent's amount exception), so nothing
  //    below can make such a document invalid.
  if (doc.kind === "credit_note" || doc.status === "cancelled") return Result.succeed(null);
  const account = doc.issuer.bankAccount;
  const iban = account?.iban?.replace(/\s/g, "").toUpperCase();
  if (!account || !iban) return Result.succeed(null);
  if (doc.currency !== "CZK" && doc.currency !== "EUR") return Result.succeed(null);
  const format = doc.currency === "CZK" ? "spayd" : "epc";
  const gross = doc.totals.gross.amount;
  if (!BigDecimal.isPositive(gross)) return Result.succeed(null);
  if (BigDecimal.isGreaterThan(gross, format === "spayd" ? MAX_SPAYD : MAX_EPC)) {
    return Result.succeed(null);
  }

  // 2. A QR applies: its inputs must be valid (5.3).
  if (!isValidIban(iban)) {
    return invalid(["bankAccount"], "request.malformed", { field: "iban", reason: "iban_invalid" });
  }
  const bic = account.bic?.trim().toUpperCase() || null;
  if (bic !== null && !isValidBic(bic)) {
    return invalid(["bankAccount"], "request.malformed", { field: "bic", reason: "bic_invalid" });
  }
  if (format === "epc" && bic === null && SEPA_NON_EEA.has(iban.slice(0, 2))) {
    return invalid(["bankAccount"], "request.malformed", { field: "bic", reason: "bic_required" });
  }
  const name = truncate(doc.issuer.name, format === "spayd" ? 35 : 70);
  if (format === "epc" && name === "") {
    // EPC069-12: the beneficiary name is mandatory.
    return invalid(["issuer"], "request.malformed", { field: "name", reason: "required" });
  }
  let vs: string | null;
  if (doc.variableSymbol !== null) {
    if (!isValidVariableSymbol(doc.variableSymbol)) {
      return invalid(["variableSymbol"], "request.malformed", {
        reason: "variable_symbol_invalid",
      });
    }
    vs = doc.variableSymbol;
  } else {
    const digits = (doc.number ?? "").replace(/\D/g, "");
    vs = digits === "" ? null : digits.slice(-10);
  }

  // 3. Encode.
  if (format === "spayd") {
    const fields = [
      "SPD",
      "1.0",
      `ACC:${iban}${bic ? `+${bic}` : ""}`,
      `AM:${amount2(gross)}`,
      "CC:CZK",
      `DT:${doc.dueOn.replaceAll("-", "")}`,
    ];
    if (vs !== null) fields.push(`X-VS:${vs}`);
    if (name !== "") fields.push(`RN:${spaydValue(name)}`);
    return Result.succeed({ format, payload: fields.join("*") });
  }
  const fields = [
    "BCD",
    "002",
    "1",
    "SCT",
    bic ?? "",
    name,
    iban,
    `EUR${amount2(gross)}`,
    "", // purpose
    "", // structured reference
    doc.number ? truncate(doc.number, 140) : "", // unstructured remittance
  ];
  // EPC069-12 §2.2: the payload ends at its last populated field.
  while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  return Result.succeed({ format, payload: fields.join("\n") });
};

/** The view's QR: stored documents passed `forDocument` when composed, so a failure is null. */
export const paymentQrOf = (doc: QrSource): PaymentQr | null =>
  Result.getOrElse(forDocument(doc), () => null);
