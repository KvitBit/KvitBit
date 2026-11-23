/**
 * Record -> `DocumentView` / `DocumentSummary`, and the concrete codecs for the domain's
 * placeholder schemas (`ContactSnapshot`, `IssuerSnapshot`, `LineView`, `DocumentSummary` are
 * `Schema.Unknown` brands in @kvitbit/domain). `DocumentViewCodec` round-trips the concrete
 * values (decimals included) through JSON, so idempotent replays (C3) and the SQL request log
 * decode exactly what was stored; integration can use it to replace the placeholders.
 */
import type {
  ContactSnapshot,
  DocumentId,
  DocumentKind,
  DocumentRelation,
  DocumentSummary,
  DocumentView,
  IsoDate,
  IssuerSnapshot,
  LineView,
} from "@kvitbit/domain/contract";
import {
  ContactId,
  DocumentId as DocumentIdSchema,
  DocumentKind as DocumentKindSchema,
  DocumentSettlement,
  DocumentStatus,
  DocumentView as DocumentViewSchema,
  IsoDate as IsoDateSchema,
  LineId,
  Money,
  PriceListItemId,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { Schema } from "effect";
import { StatutoryText } from "../../engines/statutory";
import type { DocumentRecord } from "./record";
import { ContactSnapshotRecord, IssuerSnapshotRecord, isOverdue } from "./record";

/** The concrete `LineView`. */
export const LineViewData = Schema.Struct({
  id: LineId,
  item: Schema.NullOr(PriceListItemId),
  description: Schema.String,
  quantity: Schema.BigDecimal,
  unit: Schema.NullOr(Schema.String),
  unitPrice: Schema.BigDecimal,
  treatment: VatTreatment,
  ratePercent: Schema.BigDecimal,
  /** quantity x unitPrice, full precision. */
  amount: Schema.BigDecimal,
  /** Final Invoice deduction line: the deducted Payment Tax Document (relation "deducts"). */
  deducts: Schema.NullOr(DocumentIdSchema),
});
export type LineViewData = typeof LineViewData.Type;

/** The concrete `DocumentSummary` (list row). */
export const DocumentSummaryData = Schema.Struct({
  id: DocumentIdSchema,
  kind: DocumentKindSchema,
  number: Schema.NullOr(Schema.String),
  status: DocumentStatus,
  locked: Schema.Boolean,
  settlement: DocumentSettlement,
  overdue: Schema.Boolean,
  revision: Schema.Int,
  contact: Schema.Struct({ id: ContactId, name: Schema.String }),
  issuedOn: IsoDateSchema,
  dueOn: IsoDateSchema,
  total: Money,
});
export type DocumentSummaryData = typeof DocumentSummaryData.Type;

/** `DocumentView` with the placeholders made concrete. */
export const DocumentViewData = Schema.Struct({
  ...DocumentViewSchema.fields,
  contact: ContactSnapshotRecord,
  issuer: IssuerSnapshotRecord,
  lines: Schema.Array(LineViewData),
});

/** JSON-safe codec typed as the domain `DocumentView` (C3 result, ui/HTTP integration). */
export const DocumentViewCodec = DocumentViewData as unknown as Schema.Codec<DocumentView, unknown>;
export const DocumentSummaryCodec = DocumentSummaryData as unknown as Schema.Codec<
  DocumentSummary,
  unknown
>;

export interface RelatedDocument {
  readonly relation: DocumentRelation;
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly number: string;
}

/** Per-read values the record does not hold. */
export interface ViewContext {
  /** Prague today, for `overdue`. */
  readonly today: IsoDate;
  /** Resolved links (numbered documents only). */
  readonly related?: ReadonlyArray<RelatedDocument>;
  /** Stage 2 (share links, deliveries) fills these. */
  readonly share?: DocumentView["share"];
  readonly deliveries?: DocumentView["deliveries"];
}

export const toLineView = (line: DocumentRecord["lines"][number]): LineView =>
  ({
    id: line.id,
    item: line.item,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    treatment: line.treatment,
    ratePercent: line.ratePercent,
    amount: line.amount,
    deducts: line.deducts,
  }) satisfies LineViewData as unknown as LineView;

export const toView = (row: DocumentRecord, ctx: ViewContext): DocumentView => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  status: row.status,
  locked: row.locked,
  settlement: row.settlement,
  overdue: isOverdue(row, ctx.today),
  revision: row.revision,
  taxDocument: row.taxDocument,
  contact: row.contact as unknown as ContactSnapshot,
  issuer: row.issuer as unknown as IssuerSnapshot,
  dates: { issuedOn: row.issuedOn, taxableSupplyOn: row.taxableSupplyOn, dueOn: row.dueOn },
  paymentMethod: row.paymentMethod,
  lines: row.lines.map(toLineView),
  totals: row.totals,
  fx: row.fx,
  statutoryNotes: StatutoryText.notes({
    kind: row.kind,
    regime: row.issuer.regime,
    treatments: new Set(row.lines.map((l) => l.treatment)),
    issuerRegisterEntry: row.issuer.registerEntry,
    language: row.language,
  }),
  // PaymentQr (rule D12) is not in the engines yet (src/engines/index.ts): null until it is.
  paymentQr: null,
  related: ctx.related ?? [],
  share: ctx.share ?? null,
  deliveries: ctx.deliveries ?? [],
});

export const toSummary = (row: DocumentRecord, today: IsoDate): DocumentSummary =>
  ({
    id: row.id,
    kind: row.kind,
    number: row.number,
    status: row.status,
    locked: row.locked,
    settlement: row.settlement,
    overdue: isOverdue(row, today),
    revision: row.revision,
    contact: { id: row.contactId, name: row.contact.name },
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    total: row.totals.gross,
  }) satisfies DocumentSummaryData as unknown as DocumentSummary;
