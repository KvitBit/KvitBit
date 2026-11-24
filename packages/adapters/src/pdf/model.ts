/**
 * Render models for the document templates (Classic Czech D01-D05, Modern Minimal D06-D10) and
 * the report export (D11). Core builds these from `DocumentView`, `StatutoryText`, `PaymentQr`
 * and `WorkspaceBranding` (core-ports 5.5); the templates only format and lay them out.
 *
 * Amounts are document-currency `BigDecimal`s with full precision; templates round half away
 * from zero at the currency's minor unit for display only.
 */
import type {
  CurrencyCode,
  DocumentKind,
  DocumentStatus,
  IsoDate,
  Money,
  PaymentMethod,
  TaxRegime,
  VatBreakdown,
  VatTreatment,
} from "@kvitbit/domain";
import type { BigDecimal } from "effect";

/** Image bytes for a logo or stamp. Only PNG, JPEG, WebP and SVG are embedded. */
export interface RenderImage {
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
  readonly bytes: Uint8Array;
}

/** Workspace branding as printed (core-ports 4.1 `WorkspaceBranding`, with image bytes). */
export interface RenderBranding {
  /** `#RRGGBB`. Anything else falls back to Graphite `#18181B`. */
  readonly accentColor: string;
  readonly footerText: string | null;
  readonly logo: RenderImage | null;
  readonly stamp: RenderImage | null;
}

export interface RenderParty {
  readonly name: string;
  /** Street, then postcode and city, then country; printed one per line. */
  readonly addressLines: ReadonlyArray<string>;
  /** IČO. */
  readonly companyId: string | null;
  /** DIČ, or the EU VAT ID of a foreign buyer. */
  readonly vatId: string | null;
}

export interface RenderIssuer extends RenderParty {
  /** Civil Code §435 commercial register line, e.g. "Zapsána v OR u Městského soudu v Praze, oddíl C, vložka 334912". */
  readonly registerEntry: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface RenderLine {
  readonly description: string;
  /** Negative on Credit Notes. */
  readonly quantity: BigDecimal.BigDecimal;
  readonly unit: string | null;
  /** Excluding VAT. */
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly treatment: VatTreatment;
  /** 0 for non-rated treatments. */
  readonly ratePercent: BigDecimal.BigDecimal;
  /** The line's amount as printed in the Total column, VAT included. */
  readonly total: BigDecimal.BigDecimal;
  /** `deduction`: an advance deducted on a Final Invoice (§37a); amounts are negative. */
  readonly role: "item" | "deduction";
}

/** Why a document refers to another one; printed as a banner above the payment details. */
export type RenderReference =
  /** Payment Tax Document: the received advance. */
  | {
      readonly kind: "payment";
      readonly receivedOn: IsoDate;
      readonly proformaNumber: string | null;
    }
  /** Credit Note (§45): the corrected document and the reason. */
  | {
      readonly kind: "correction";
      readonly originalNumber: string;
      readonly originalIssuedOn: IsoDate;
      readonly reason: string;
    }
  /** Final Invoice: the advances it settles. */
  | {
      readonly kind: "settlement";
      readonly proformaNumbers: ReadonlyArray<string>;
      readonly paymentTaxDocumentNumbers: ReadonlyArray<string>;
    };

export interface DocumentRenderModel {
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  /** `null` while draft. */
  readonly number: string | null;
  readonly regime: TaxRegime;
  /** True when the document is a VAT tax document (`DocumentView.taxDocument`). */
  readonly taxDocument: boolean;
  readonly currency: CurrencyCode;
  readonly issuer: RenderIssuer;
  readonly customer: RenderParty;
  readonly dates: {
    readonly issuedOn: IsoDate;
    /** DUZP; for a Payment Tax Document the payment receipt date. */
    readonly taxableSupplyOn: IsoDate | null;
    readonly dueOn: IsoDate | null;
  };
  readonly paymentMethod: PaymentMethod;
  readonly bankAccount: null | {
    /** Czech account number, e.g. "2101482910/2010". */
    readonly accountNumber: string | null;
    readonly iban: string | null;
    readonly bic: string | null;
  };
  readonly variableSymbol: string | null;
  readonly orderNumber: string | null;
  readonly note: string | null;
  readonly reference: RenderReference | null;
  readonly lines: ReadonlyArray<RenderLine>;
  /** VatMath output (core-ports 5.1). For a Final Invoice, after deducting advances. */
  readonly totals: VatBreakdown;
  /** Non-CZK only: the rate VAT was converted with (rule D11). */
  readonly fx: null | {
    readonly rate: BigDecimal.BigDecimal;
    readonly quantity: number;
    /** `null` for a manual rate. */
    readonly fixingDate: IsoDate | null;
    readonly source: "cnb" | "manual";
  };
  /**
   * StatutoryText notes (core-ports 5.4). When omitted, the template derives them from the
   * regime, kind and line treatments with `statutoryNotes`.
   */
  readonly statutoryNotes?: ReadonlyArray<{ readonly code: string; readonly text: string }>;
  /** Payment QR payload (rule D12); rendered to SVG by the template. */
  readonly paymentQr: null | { readonly format: "spayd" | "epc"; readonly payload: string };
  readonly branding: RenderBranding;
}

export type ReportCell =
  | { readonly text: string }
  | { readonly count: number }
  | { readonly money: Money };

/**
 * Report export (D11). Labels come localized from the caller (the Reports module knows its
 * categories); the template adds the chrome, formatting and escaping.
 */
export interface ReportRenderModel {
  readonly workspace: {
    readonly name: string;
    readonly companyId: string | null;
    readonly vatId: string | null;
  };
  readonly branding: RenderBranding;
  /** Eyebrow line, e.g. "Q4 2026". */
  readonly periodLabel: string;
  readonly title: string;
  /** ISO 8601 instant; printed in Europe/Prague. */
  readonly generatedAt: string;
  readonly kpis: ReadonlyArray<{
    readonly label: string;
    readonly value: Money;
    readonly emphasis?: boolean;
  }>;
  readonly table: {
    readonly columns: ReadonlyArray<{ readonly label: string; readonly align: "left" | "right" }>;
    readonly rows: ReadonlyArray<{
      readonly cells: ReadonlyArray<ReportCell>;
      readonly tone?: "deduction";
    }>;
  };
  readonly total: null | { readonly label: string; readonly value: Money };
  readonly footerNote: string | null;
}
