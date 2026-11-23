/**
 * Payment QR for `DocumentView.paymentQr` (rule D12): the `forDocument` subset of core-ports
 * 5.3 PaymentQr, which src/engines does not provide yet. SPAYD (QR Platba, CBA 1.2) for CZK,
 * EPC069-12 v002 (SCT) for EUR, each only with an IBAN; otherwise null. Credit Notes and
 * cancelled documents never carry one. A document whose amount is outside the format's range
 * gets null rather than failing the view. Move to src/engines (PaymentQr) when it lands there.
 */
import { BigDecimal } from "effect";
import { roundAt } from "../../engines/decimal";
import type { DocumentRecord } from "./record";

const MAX_SPAYD = BigDecimal.fromStringUnsafe("9999999.99");
const MAX_EPC = BigDecimal.fromStringUnsafe("999999999.99");
const MIN = BigDecimal.fromStringUnsafe("0.01");

/** Amount at 2 decimals, half away from zero, plain notation. */
const amount2 = (value: BigDecimal.BigDecimal) => {
  const scaled = BigDecimal.scale(roundAt(value, 2), 2);
  const digits = (scaled.value < 0n ? -scaled.value : scaled.value).toString().padStart(3, "0");
  return `${scaled.value < 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

const inRange = (value: BigDecimal.BigDecimal, max: BigDecimal.BigDecimal) =>
  BigDecimal.isGreaterThanOrEqualTo(value, MIN) && BigDecimal.isLessThanOrEqualTo(value, max);

/** Cuts text to `max` characters at a word boundary (5.3: optional text is truncated). */
const truncate = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : clean.slice(0, max)).trim();
};

const spaydValue = (value: string) => value.toUpperCase().replaceAll("*", "%2A");

/** The variable symbol: the document's own, else the digits of its number (max 10). */
const variableSymbolOf = (row: DocumentRecord): string | null => {
  const vs = (row.variableSymbol ?? row.number ?? "").replace(/\D/g, "");
  return vs === "" ? null : vs.slice(-10);
};

export const paymentQrOf = (
  row: DocumentRecord,
): { readonly format: "spayd" | "epc"; readonly payload: string } | null => {
  if (row.kind === "credit_note" || row.status === "cancelled") return null;
  const account = row.issuer.bankAccount;
  const iban = account?.iban?.replace(/\s/g, "").toUpperCase();
  if (!account || !iban) return null;
  const gross = row.totals.gross.amount;
  if (row.currency === "CZK") {
    if (!inRange(gross, MAX_SPAYD)) return null;
    const fields = [
      "SPD",
      "1.0",
      `ACC:${iban}${account.bic ? `+${account.bic.toUpperCase()}` : ""}`,
      `AM:${amount2(gross)}`,
      "CC:CZK",
      `DT:${row.dueOn.replaceAll("-", "")}`,
    ];
    const vs = variableSymbolOf(row);
    if (vs !== null) fields.push(`X-VS:${vs}`);
    const name = truncate(row.issuer.name, 35);
    if (name !== "") fields.push(`RN:${spaydValue(name)}`);
    return { format: "spayd", payload: fields.join("*") };
  }
  if (row.currency === "EUR") {
    if (!inRange(gross, MAX_EPC)) return null;
    const remittance = row.number ? truncate(row.number, 140) : "";
    const payload = [
      "BCD",
      "002",
      "1",
      "SCT",
      account.bic?.toUpperCase() ?? "",
      truncate(row.issuer.name, 70),
      iban,
      `EUR${amount2(gross)}`,
      "",
      "",
      remittance,
    ].join("\n");
    return { format: "epc", payload };
  }
  return null;
};
