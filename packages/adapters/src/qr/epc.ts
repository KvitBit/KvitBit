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
import * as Arr from "effect/Array";
import type * as BigDecimal from "effect/BigDecimal";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import {
  EEA_COUNTRIES,
  invalid,
  isAsciiControl,
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
    if (bic === undefined && !EEA_COUNTRIES.has(Str.slice(0, 2)(iban))) {
      return yield* Result.fail(
        invalid({
          path: ["bic"],
          code: "request.malformed",
          params: { reason: "required_outside_eea" },
        }),
      );
    }
    const name = truncateAtWord({ max: EPC_LIMITS.name })(singleLine(input.beneficiaryName));
    if (name === "")
      return yield* Result.fail(invalid({ path: ["beneficiaryName"], code: "request.malformed" }));
    const amount = yield* validAmount("amount", input.amount, "0.01", "999999999.99");

    let reference = "";
    let text = "";
    if ("reference" in input.remittance) {
      reference = Str.replace(/\s+/g, "")(input.remittance.reference);
      if (reference === "" || Arr.some(Array.from(reference), isAsciiControl)) {
        return yield* Result.fail(
          invalid({ path: ["remittance", "reference"], code: "request.malformed" }),
        );
      }
      if (reference.length > EPC_LIMITS.reference) {
        return yield* Result.fail(
          invalid({
            path: ["remittance", "reference"],
            code: "qr.field_too_long",
            params: {
              max: String(EPC_LIMITS.reference),
            },
          }),
        );
      }
    }

    const head = ["BCD", "002", "1", "SCT", bic ?? "", name, iban, `EUR${amount}`, "", reference];
    if (!("reference" in input.remittance)) {
      // Free text yields first when multi-byte characters would push the payload over budget.
      const budget = EPC_LIMITS.payloadBytes - utf8Length(`${Arr.join(head, "\n")}\n`);
      text = truncateAtWord({
        max: EPC_LIMITS.text,
        measure: (s) => (utf8Length(s) > budget ? Number.POSITIVE_INFINITY : Array.from(s).length),
      })(singleLine(input.remittance.text));
    }
    const lines = [...head, text];
    while (lines.at(-1) === "") lines.pop();
    const payload = Arr.join(lines, "\n");
    if (utf8Length(payload) > EPC_LIMITS.payloadBytes) {
      return yield* Result.fail(
        invalid({
          path: ["payload"],
          code: "qr.field_too_long",
          params: { max: String(EPC_LIMITS.payloadBytes) },
        }),
      );
    }
    return payload;
  });
