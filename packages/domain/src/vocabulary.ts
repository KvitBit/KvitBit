/** Shared vocabulary (core-ports section 1). Terms follow CONTEXT.md. */
import { Schema } from "effect";
import { PriceListItemId, RequestKey } from "./ids";

/** URL name of a Workspace: lowercase letters, digits and hyphens, 3 to 40 chars, unique across the install. */
export const WorkspaceSlug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/)),
  Schema.brand("WorkspaceSlug"),
);
export type WorkspaceSlug = typeof WorkspaceSlug.Type;

export const Role = Schema.Literals(["owner", "admin", "member", "accountant"]);
export type Role = typeof Role.Type;

/** Czech VAT status of the Issuing Entity. */
export const TaxRegime = Schema.Literals(["non_vat_payer", "vat_payer", "identified_person"]);
export type TaxRegime = typeof TaxRegime.Type;

export const Locale = Schema.Literals(["cs", "en"]);
export type Locale = typeof Locale.Type;

export const DocumentKind = Schema.Literals([
  "invoice",
  "proforma",
  "payment_tax_document",
  "credit_note",
]);
export type DocumentKind = typeof DocumentKind.Type;

/** Lifecycle state of a document (core-ports section 4.4, `DocumentView.status`). */
export const DocumentStatus = Schema.Literals(["draft", "issued", "cancelled"]);
export type DocumentStatus = typeof DocumentStatus.Type;

/** Settlement derived at read time (`DocumentView.settlement`, rule P1). */
export const DocumentSettlement = Schema.Literals([
  "unpaid",
  "partially_paid",
  "paid",
  "overpaid",
  "credited",
]);
export type DocumentSettlement = typeof DocumentSettlement.Type;

/** How the buyer is asked to pay; printed on the document and used as the default Payment method. */
export const PaymentMethod = Schema.Literals(["bank_transfer", "cash", "card", "other"]);
export type PaymentMethod = typeof PaymentMethod.Type;

export const CurrencyCode = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Z]{3}$/)),
  Schema.brand("CurrencyCode"),
);
export type CurrencyCode = typeof CurrencyCode.Type;

/** Calendar date in Europe/Prague, YYYY-MM-DD. */
export const IsoDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  Schema.brand("IsoDate"),
);
export type IsoDate = typeof IsoDate.Type;

/** All money arithmetic uses BigDecimal. Amounts cross the wire as decimal strings (JSON codec). */
export const Money = Schema.Struct({ amount: Schema.BigDecimal, currency: CurrencyCode });
export type Money = typeof Money.Type;

/**
 * VAT is chosen by supply class, never by a raw percentage. VatMath resolves the
 * percentage in force on the tax point (§47), so 21 and 12 never appear in caller code.
 */
export const VatTreatment = Schema.Literals([
  "standard", // 21 % since 2024-01-01
  "reduced", // 12 % since 2024-01-01
  "exempt_intra_eu_goods", // §64, buyer EU VAT ID required
  "reverse_charge", // §92a domestic or EU services; buyer VAT ID required
  "outside_scope", // the only treatment for non_vat_payer and for identified_person domestic supplies
]);
export type VatTreatment = typeof VatTreatment.Type;

export const LineInput = Schema.Struct({
  item: Schema.optional(PriceListItemId), // fills description, unit, unitPrice, vat from the Price List Item
  description: Schema.optional(Schema.String),
  quantity: Schema.optional(Schema.BigDecimal), // default 1
  unit: Schema.optional(Schema.String),
  unitPrice: Schema.optional(Schema.BigDecimal), // document currency; excl. VAT unless pricesIncludeVat
  vat: Schema.optional(VatTreatment), // default from Tax Regime + Contact (core-ports 4.4, rule D9)
});
export type LineInput = typeof LineInput.Type;

/** A page of results. `nextCursor` is null on the last page. */
export const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) });
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | null;
}

/** Cursor paging input. limit 1 to 100, default 50. A cursor is bound to the filter it came from. */
export const PageRequest = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
});
export type PageRequest = typeof PageRequest.Type;

/**
 * Retry-safety token. HTTP maps the Idempotency-Key header. MCP maps the optional
 * idempotencyKey tool argument (`mcp:<grantId>:<idempotencyKey>`) on single-call writes and the
 * confirmation id (`mcp-confirm:<confirmationId>`) on confirmed two-step calls; it never uses
 * JSON-RPC call ids, which restart per connection. Workflows derive their keys.
 */
export const RequestOptions = Schema.Struct({ requestKey: Schema.optional(RequestKey) });
export type RequestOptions = typeof RequestOptions.Type;

/** The API Key or MCP client a Member acts through. Shown in audit as "X via <name>". */
export const ClientRef = Schema.Struct({
  kind: Schema.Literals(["api_key", "mcp"]),
  id: Schema.String, // API Key id or MCP grant id (apps/server owns both)
  name: Schema.String, // key name or OAuth client name at the time of the call
});
export type ClientRef = typeof ClientRef.Type;

/** A stored image or file reference. */
export const ImageRef = Schema.Struct({
  contentType: Schema.String,
  bytes: Schema.Int,
  sha256: Schema.String,
  updatedAt: Schema.String,
});
export type ImageRef = typeof ImageRef.Type;

/** Entities an error or audit entry can name (core-ports section 3). */
export const EntityKind = Schema.Literals([
  "Workspace",
  "Member",
  "Invitation",
  "Contact",
  "PriceListItem",
  "Document",
  "Payment",
  "Expense",
  "Attachment",
  "Template",
  "Schedule",
  "NumberingSeries",
  "BankAccount",
  "ShareLink",
  "BrandingImage",
  "Export",
  "ApiKey",
  "McpGrant",
]);
export type EntityKind = typeof EntityKind.Type;

/** "Classic Czech" (screen 23) and "Modern Minimal" (screen 24). */
export const PdfTemplate = Schema.Literals(["classic", "modern_minimal"]);
export type PdfTemplate = typeof PdfTemplate.Type;

export const DeliveryPurpose = Schema.Literals(["document", "reminder"]);
export type DeliveryPurpose = typeof DeliveryPurpose.Type;

export const BrandingImage = Schema.Literals(["logo", "stamp"]);
export type BrandingImage = typeof BrandingImage.Type;
