/** Picks the payment QR format for a document (core-ports rule D12). */
import type { DocumentKind, DocumentStatus, Invalid, IsoDate } from "@kvitbit/domain";
import { BigDecimal, Result } from "effect";
import { epc } from "./epc";
import { spayd } from "./spayd";

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
    iban.trim() === "" ||
    !BigDecimal.isPositive(doc.amount)
  ) {
    return Result.succeed(null);
  }
  const bic = doc.bankAccount?.bic ?? undefined;
  if (doc.currency === "CZK") {
    return Result.map(
      spayd({
        iban,
        ...(bic === undefined ? {} : { bic }),
        amount: doc.amount,
        recipientName: doc.recipientName,
        message: doc.message,
        ...(doc.variableSymbol ? { variableSymbol: doc.variableSymbol } : {}),
        ...(doc.constantSymbol ? { constantSymbol: doc.constantSymbol } : {}),
        ...(doc.dueOn ? { dueOn: doc.dueOn } : {}),
      }),
      (payload) => ({ format: "spayd" as const, payload }),
    );
  }
  if (doc.currency === "EUR") {
    return Result.map(
      epc({
        iban,
        ...(bic === undefined ? {} : { bic }),
        beneficiaryName: doc.recipientName,
        amount: doc.amount,
        remittance: { text: doc.message },
      }),
      (payload) => ({ format: "epc" as const, payload }),
    );
  }
  return Result.succeed(null);
};
