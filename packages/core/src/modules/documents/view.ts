/**
 * Record -> `DocumentView` / `DocumentSummary`, and the concrete codecs for the domain's
 * placeholder schemas (`ContactSnapshot`, `IssuerSnapshot`, `LineView`, `DocumentSummary` are
 * `Schema.Unknown` brands in @kvitbit/domain). `DocumentViewCodec` round-trips the concrete
 * values (decimals included) through JSON, so idempotent replays (C3) and the SQL request log
 * decode exactly what was stored; integration can use it to replace the placeholders.
 */

import type {
  DocumentId,
  DocumentKind,
  DocumentRelation,
  DocumentSummary,
  DocumentView,
  IsoDate,
  LineView,
  Locale,
} from "@kvitbit/domain/contract";
import {
  ContactId,
  ContactSnapshot,
  DocumentId as DocumentIdSchema,
  DocumentKind as DocumentKindSchema,
  DocumentSettlement,
  DocumentStatus,
  DocumentView as DocumentViewSchema,
  IsoDate as IsoDateSchema,
  IssuerSnapshot,
  LineView as Line,
  LineId,
  Money,
  PriceListItemId,
  DocumentSummary as Summary,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
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
export const DocumentViewCodec = Schema.Struct({
  ...DocumentViewSchema.fields,
  contact: ContactSnapshotRecord.pipe(Schema.brand("ContactSnapshot")),
  issuer: IssuerSnapshotRecord.pipe(Schema.brand("IssuerSnapshot")),
  lines: Schema.Array(LineViewData.pipe(Schema.brand("LineView"))),
});

export const DocumentSummaryCodec: Schema.Codec<DocumentSummary, unknown> =
  DocumentSummaryData.pipe(Schema.brand("DocumentSummary"));

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
  /** Language of the printed texts (statutory notes); default the document's (pdf override). */
  readonly language?: Locale;
}

export const toLineView = (line: DocumentRecord["lines"][number]): LineView =>
  Line.make({
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
  } satisfies LineViewData);

export const toView: {
  (ctx: ViewContext): (row: DocumentRecord) => DocumentView;
  (row: DocumentRecord, ctx: ViewContext): DocumentView;
} = Fn.dual(
  2,
  (row: DocumentRecord, ctx: ViewContext): DocumentView => ({
    id: row.id,
    kind: row.kind,
    number: row.number,
    status: row.status,
    locked: row.locked,
    settlement: row.settlement,
    overdue: isOverdue(row, ctx.today),
    revision: row.revision,
    taxDocument: row.taxDocument,
    contact: ContactSnapshot.make(row.contact),
    issuer: IssuerSnapshot.make(row.issuer),
    dates: { issuedOn: row.issuedOn, taxableSupplyOn: row.taxableSupplyOn, dueOn: row.dueOn },
    paymentMethod: row.paymentMethod,
    lines: EffectArray.map(row.lines, toLineView),
    totals: row.totals,
    fx: row.fx,
    statutoryNotes: StatutoryText.notes({
      kind: row.kind,
      regime: row.issuer.regime,
      // Deduction lines (D8) print the advance's treatment, not a supply of their own.
      treatments: new Set(
        EffectArray.map(
          EffectArray.filter(row.lines, (l) => l.deducts === null),
          (l) => l.treatment,
        ),
      ),
      issuerRegisterEntry: row.issuer.registerEntry,
      language: ctx.language ?? row.language,
    }),
    // Rule D12 waits on the PaymentQr engine (core-ports 5.3, src/engines): null until it lands.
    paymentQr: null,
    related: ctx.related ?? [],
    share: ctx.share ?? null,
    deliveries: ctx.deliveries ?? [],
  }),
);

export const toSummary: {
  (today: IsoDate): (row: DocumentRecord) => DocumentSummary;
  (row: DocumentRecord, today: IsoDate): DocumentSummary;
} = Fn.dual(
  2,
  (row: DocumentRecord, today: IsoDate): DocumentSummary =>
    Summary.make({
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
    } satisfies DocumentSummaryData),
);
