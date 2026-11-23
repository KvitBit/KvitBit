/**
 * Payment QR for `DocumentView.paymentQr` (rule D12): the `forDocument` subset of core-ports
 * 5.3 PaymentQr, which src/engines does not provide yet (move it there when it lands).
 * SPAYD (QR Platba, CBA 1.2) for CZK, EPC069-12 v002 (SCT) for EUR, each only when the bank
 * account has an IBAN; otherwise null. Credit Notes, cancelled documents and documents with
 * nothing to pay (gross <= 0) never carry one.
 *
 * Validation (5.3): an IBAN failing the ISO 13616 mod-97 check, an amount above the format's
 * maximum, or a variable symbol that is not 1-10 digits is `Invalid`; `compose` runs this on
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

/** ISO 13616: 2 letters, 2 check digits, up to 30 alphanumerics, mod 97 = 1. */
export const isValidIban = (iban: string): boolean => {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
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

const spaydValue = (value: string) => value.toUpperCase().replaceAll("*", "%2A");

export const forDocument = (doc: QrSource): Result.Result<PaymentQr | null, Invalid> => {
  if (doc.kind === "credit_note" || doc.status === "cancelled") return Result.succeed(null);
  const account = doc.issuer.bankAccount;
  const iban = account?.iban?.replace(/\s/g, "").toUpperCase();
  if (!account || !iban) return Result.succeed(null);
  if (doc.currency !== "CZK" && doc.currency !== "EUR") return Result.succeed(null);
  const gross = doc.totals.gross.amount;
  if (!BigDecimal.isPositive(gross)) return Result.succeed(null);
  if (!isValidIban(iban)) return invalid(["bankAccount"], "request.malformed", { field: "iban" });
  let vs: string | null = null;
  if (doc.variableSymbol !== null) {
    if (!isValidVariableSymbol(doc.variableSymbol)) {
      return invalid(["variableSymbol"], "request.malformed");
    }
    vs = doc.variableSymbol;
  } else {
    const digits = (doc.number ?? "").replace(/\D/g, "");
    vs = digits === "" ? null : digits.slice(-10);
  }
  const bic = account.bic?.trim().toUpperCase() || null;
  if (doc.currency === "CZK") {
    if (BigDecimal.isGreaterThan(gross, MAX_SPAYD)) {
      return invalid(["lines"], "qr.field_too_long", { field: "AM", max: "9999999.99" });
    }
    const fields = [
      "SPD",
      "1.0",
      `ACC:${iban}${bic ? `+${bic}` : ""}`,
      `AM:${amount2(gross)}`,
      "CC:CZK",
      `DT:${doc.dueOn.replaceAll("-", "")}`,
    ];
    if (vs !== null) fields.push(`X-VS:${vs}`);
    const name = truncate(doc.issuer.name, 35);
    if (name !== "") fields.push(`RN:${spaydValue(name)}`);
    return Result.succeed({ format: "spayd", payload: fields.join("*") });
  }
  if (BigDecimal.isGreaterThan(gross, MAX_EPC)) {
    return invalid(["lines"], "qr.field_too_long", { field: "amount", max: "999999999.99" });
  }
  const fields = [
    "BCD",
    "002",
    "1",
    "SCT",
    bic ?? "",
    truncate(doc.issuer.name, 70),
    iban,
    `EUR${amount2(gross)}`,
    "", // purpose
    "", // structured reference
    doc.number ? truncate(doc.number, 140) : "", // unstructured remittance
  ];
  // EPC069-12 §2.2: the payload ends at its last populated field.
  while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  return Result.succeed({ format: "epc", payload: fields.join("\n") });
};

/** The view's QR: stored documents passed `forDocument` when composed, so a failure is null. */
export const paymentQrOf = (doc: QrSource): PaymentQr | null =>
  Result.getOrElse(forDocument(doc), () => null);
