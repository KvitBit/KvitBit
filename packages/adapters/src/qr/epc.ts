/**
 * EPC QR payload (EPC069-12 "Quick Response Code: Guidelines to Enable Data Capture for the
 * Initiation of a SEPA Credit Transfer", version 002, UTF-8, SCT). EUR only.
 *
 * Lines, separated by LF: service tag `BCD`, version `002`, character set `1` (UTF-8),
 * identification `SCT`, BIC (optional in 002 within the EEA), beneficiary name (max 70),
 * IBAN, amount `EUR` + 0.01..999999999.99, purpose (empty), structured reference (max 35) or
 * unstructured remittance text (max 140, never both). Trailing empty lines are dropped; the
 * whole payload is at most 331 bytes.
 */
import type { Invalid } from "@kvitbit/domain";
import { type BigDecimal, Result } from "effect";
import {
  EEA_COUNTRIES,
  invalid,
  singleLine,
  truncateAtWord,
  validAmount,
  validBic,
  validIban,
} from "./fields";

export interface EpcInput {
  readonly iban: string;
  readonly bic?: string;
  /** Truncated at a word boundary to 70 characters. */
  readonly beneficiaryName: string;
  /** EUR 0.01 to 999,999,999.99. */
  readonly amount: BigDecimal.BigDecimal;
  /** Structured creditor reference (at most 35, rejected when longer) or free text (truncated to 140). */
  readonly remittance: { readonly reference: string } | { readonly text: string };
}

export const EPC_LIMITS = { name: 70, reference: 35, text: 140, payloadBytes: 331 } as const;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export const epc = (input: EpcInput): Result.Result<string, Invalid> =>
  Result.gen(function* () {
    const iban = yield* validIban("iban", input.iban);
    const bic = yield* validBic("bic", input.bic);
    // Version 002 allows omitting the BIC only within the EEA. Only the beneficiary side can be
    // checked here; a payer PSP outside the EEA is the caller's concern.
    if (bic === undefined && !EEA_COUNTRIES.has(iban.slice(0, 2))) {
      return yield* Result.fail(
        invalid("bic", "request.malformed", { reason: "required_outside_eea" }),
      );
    }
    const name = truncateAtWord(singleLine(input.beneficiaryName), EPC_LIMITS.name);
    if (name === "") return yield* Result.fail(invalid("beneficiaryName", "request.malformed"));
    const amount = yield* validAmount("amount", input.amount, "0.01", "999999999.99");

    let reference = "";
    let text = "";
    if ("reference" in input.remittance) {
      reference = input.remittance.reference.replace(/\s+/g, "");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected
      if (reference === "" || /[\u0000-\u001f\u007f]/.test(reference)) {
        return yield* Result.fail(invalid(["remittance", "reference"], "request.malformed"));
      }
      if (reference.length > EPC_LIMITS.reference) {
        return yield* Result.fail(
          invalid(["remittance", "reference"], "qr.field_too_long", {
            max: String(EPC_LIMITS.reference),
          }),
        );
      }
    }

    const head = ["BCD", "002", "1", "SCT", bic ?? "", name, iban, `EUR${amount}`, "", reference];
    if (!("reference" in input.remittance)) {
      // Free text yields first when multi-byte characters would push the payload over budget.
      const budget = EPC_LIMITS.payloadBytes - utf8Length(`${head.join("\n")}\n`);
      text = truncateAtWord(singleLine(input.remittance.text), EPC_LIMITS.text, (s) =>
        utf8Length(s) > budget ? Number.POSITIVE_INFINITY : [...s].length,
      );
    }
    const lines = [...head, text];
    while (lines.at(-1) === "") lines.pop();
    const payload = lines.join("\n");
    if (utf8Length(payload) > EPC_LIMITS.payloadBytes) {
      return yield* Result.fail(
        invalid("payload", "qr.field_too_long", { max: String(EPC_LIMITS.payloadBytes) }),
      );
    }
    return payload;
  });
