/**
 * Czech QR Platba payload (Short Payment Descriptor, CBA standard 1.2, header `SPD*1.0*`).
 * Field order and amount formatting are adapted from DeskoHub
 * `apps/deskohub-workspace/features/accounting/backend/invoice-payment-qr.ts`.
 */

import type { Invalid, IsoDate } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import type * as BigDecimal from "effect/BigDecimal";
import * as Result from "effect/Result";
import * as Str from "effect/String";
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

const DIGITS = /^\d+$/;

/** `%` first so an escaped `*` is not escaped twice. */
const escapeValue = (value: string): string =>
  Str.replace(/\*/g, "%2A")(Str.replace(/%/g, "%25")(value));

/** Single line, uppercased, escaped, cut at a word so the escaped value fits `max`. */
const textField = (raw: string | undefined, max: number): string | undefined => {
  if (raw === undefined) return undefined;
  const text = truncateAtWord({ max, measure: (s) => escapeValue(s).length })(
    Str.toUpperCase(singleLine(raw)),
  );
  return text === "" ? undefined : escapeValue(text);
};

const symbolField = (
  field: string,
  raw: string | undefined,
): Result.Result<string | undefined, Invalid> => {
  if (raw === undefined || Str.trim(raw) === "") return Result.succeed(undefined);
  const value = Str.trim(raw);
  if (!DIGITS.test(value))
    return Result.fail(invalid({ path: [field], code: "request.malformed" }));
  if (value.length > SPAYD_LIMITS.symbol) {
    return Result.fail(
      invalid({
        path: [field],
        code: "qr.field_too_long",
        params: { max: String(SPAYD_LIMITS.symbol) },
      }),
    );
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
        invalid({
          path: ["iban"],
          code: "qr.field_too_long",
          params: { max: String(SPAYD_LIMITS.acc) },
        }),
      );
    }
    const amount = yield* validAmount("amount", input.amount, "0.01", "9999999.99");
    const vs = yield* symbolField("variableSymbol", input.variableSymbol);
    const ks = yield* symbolField("constantSymbol", input.constantSymbol);
    const message = textField(input.message, SPAYD_LIMITS.message);
    const recipient = textField(input.recipientName, SPAYD_LIMITS.recipientName);

    const fields: Array<string> = ["SPD", "1.0", `ACC:${acc}`, `AM:${amount}`, "CC:CZK"];
    if (input.dueOn !== undefined) fields.push(`DT:${Str.replaceAll("-", "")(input.dueOn)}`);
    if (message !== undefined) fields.push(`MSG:${message}`);
    if (recipient !== undefined) fields.push(`RN:${recipient}`);
    if (vs !== undefined) fields.push(`X-VS:${vs}`);
    if (ks !== undefined) fields.push(`X-KS:${ks}`);
    return Arr.join(fields, "*");
  });
