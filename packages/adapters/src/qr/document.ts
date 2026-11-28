/** Picks the payment QR format for a document (core-ports rule D12). */

import type { DocumentKind, DocumentStatus, Invalid, IsoDate } from "@kvitbit/domain";
import * as BigDecimal from "effect/BigDecimal";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type * as Types from "effect/Types";
import { type EpcInput, epc } from "./epc";
import { type SpaydInput, spayd } from "./spayd";

export interface QrSource {
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  readonly currency: string;
  /** Amount left to pay in the document currency. */
  readonly amount: BigDecimal.BigDecimal;
  readonly bankAccount: null | { readonly iban: string | null; readonly bic?: string | null };
  /** Issuing Entity name: SPAYD `RN`, EPC beneficiary name. */
  readonly recipientName: string;
  /** Remittance text, e.g. "Faktura 2026-0042": SPAYD `MSG`, EPC unstructured text. */
  readonly message: string;
  readonly variableSymbol?: string | null;
  readonly constantSymbol?: string | null;
  readonly dueOn?: IsoDate | null;
}

export interface PaymentQrPayload {
  readonly format: "spayd" | "epc";
  readonly payload: string;
}

/**
 * SPAYD for CZK and EPC for EUR when the bank account has an IBAN; `null` otherwise, and for
 * Credit Notes, cancelled documents, Payment Tax Documents (they record a payment already
 * received) and documents with nothing left to pay.
 */
export const forDocument = (doc: QrSource): Result.Result<PaymentQrPayload | null, Invalid> => {
  const iban = doc.bankAccount?.iban ?? null;
  if (
    doc.kind === "credit_note" ||
    doc.kind === "payment_tax_document" ||
    doc.status === "cancelled" ||
    iban === null ||
    Str.trim(iban) === "" ||
    !BigDecimal.isPositive(doc.amount)
  ) {
    return Result.succeed(null);
  }
  const bic = doc.bankAccount?.bic;
  if (doc.currency === "CZK") {
    const input: Types.Mutable<SpaydInput> = {
      iban,
      amount: doc.amount,
      recipientName: doc.recipientName,
      message: doc.message,
    };
    if (bic !== null && bic !== undefined) input.bic = bic;
    if (doc.variableSymbol !== null && doc.variableSymbol !== undefined) {
      input.variableSymbol = doc.variableSymbol;
    }
    if (doc.constantSymbol !== null && doc.constantSymbol !== undefined) {
      input.constantSymbol = doc.constantSymbol;
    }
    if (doc.dueOn !== null && doc.dueOn !== undefined) input.dueOn = doc.dueOn;
    return Result.map(spayd(input), (payload) => ({ format: "spayd" as const, payload }));
  }
  if (doc.currency === "EUR") {
    const input: Types.Mutable<EpcInput> = {
      iban,
      beneficiaryName: doc.recipientName,
      amount: doc.amount,
      remittance: { text: doc.message },
    };
    if (bic !== null && bic !== undefined) input.bic = bic;
    return Result.map(epc(input), (payload) => ({ format: "epc" as const, payload }));
  }
  return Result.succeed(null);
};
