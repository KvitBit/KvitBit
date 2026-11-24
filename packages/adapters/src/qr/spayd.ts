/**
 * Czech QR Platba payload (Short Payment Descriptor, CBA standard 1.2, header `SPD*1.0*`).
 * Field order and amount formatting are adapted from DeskoHub
 * `apps/deskohub-workspace/features/accounting/backend/invoice-payment-qr.ts`.
 */
import type { Invalid, IsoDate } from "@kvitbit/domain";
import { type BigDecimal, Result } from "effect";
import { invalid, singleLine, truncateAtWord, validAmount, validBic, validIban } from "./fields";

export interface SpaydInput {
  readonly iban: string;
  readonly bic?: string;
  /** CZK, at most 9,999,999.99. */
  readonly amount: BigDecimal.BigDecimal;
  /** X-VS: at most 10 digits. */
  readonly variableSymbol?: string;
  /** X-KS: at most 10 digits. */
  readonly constantSymbol?: string;
  /** DT: written as YYYYMMDD. */
  readonly dueOn?: IsoDate;
  /** RN: truncated at a word boundary to 35 characters. */
  readonly recipientName?: string;
  /** MSG: truncated at a word boundary to 60 characters. */
  readonly message?: string;
}

export const SPAYD_LIMITS = { acc: 46, recipientName: 35, message: 60, symbol: 10 } as const;

/** `%` first so an escaped `*` is not escaped twice. */
const escapeValue = (value: string): string => value.replace(/%/g, "%25").replace(/\*/g, "%2A");

/** Single line, uppercased, escaped, cut at a word so the escaped value fits `max`. */
const textField = (raw: string | undefined, max: number): string | undefined => {
  if (raw === undefined) return undefined;
  const text = truncateAtWord(singleLine(raw).toUpperCase(), max, (s) => escapeValue(s).length);
  return text === "" ? undefined : escapeValue(text);
};

const symbolField = (
  field: string,
  raw: string | undefined,
): Result.Result<string | undefined, Invalid> => {
  if (raw === undefined || raw.trim() === "") return Result.succeed(undefined);
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return Result.fail(invalid(field, "request.malformed"));
  if (value.length > SPAYD_LIMITS.symbol) {
    return Result.fail(invalid(field, "qr.field_too_long", { max: String(SPAYD_LIMITS.symbol) }));
  }
  return Result.succeed(value);
};

/** Builds the SPAYD string. An invalid IBAN, BIC, amount or symbol is `Invalid`. */
export const spayd = (input: SpaydInput): Result.Result<string, Invalid> =>
  Result.gen(function* () {
    const iban = yield* validIban("iban", input.iban);
    const bic = yield* validBic("bic", input.bic);
    const acc = bic === undefined ? iban : `${iban}+${bic}`;
    if (acc.length > SPAYD_LIMITS.acc) {
      return yield* Result.fail(
        invalid("iban", "qr.field_too_long", { max: String(SPAYD_LIMITS.acc) }),
      );
    }
    const amount = yield* validAmount("amount", input.amount, "0.01", "9999999.99");
    const vs = yield* symbolField("variableSymbol", input.variableSymbol);
    const ks = yield* symbolField("constantSymbol", input.constantSymbol);
    const message = textField(input.message, SPAYD_LIMITS.message);
    const recipient = textField(input.recipientName, SPAYD_LIMITS.recipientName);

    const fields: Array<string> = ["SPD", "1.0", `ACC:${acc}`, `AM:${amount}`, "CC:CZK"];
    if (input.dueOn !== undefined) fields.push(`DT:${input.dueOn.replaceAll("-", "")}`);
    if (message !== undefined) fields.push(`MSG:${message}`);
    if (recipient !== undefined) fields.push(`RN:${recipient}`);
    if (vs !== undefined) fields.push(`X-VS:${vs}`);
    if (ks !== undefined) fields.push(`X-KS:${ks}`);
    return fields.join("*");
  });
