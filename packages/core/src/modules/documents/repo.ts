/**
 * `DocumentsRepo`: the `documents` table with the repository conventions of
 * src/store/tables.ts (Workspace-scoped, `getForUpdate` revision check, compare-and-set
 * `update`, `UniqueViolation` per index name, `StoreUnavailable`).
 */
import type {
  Conflict,
  ContactId,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  IsoDate,
  NotFound,
  ScheduleId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { compareScalar } from "../../store/query";
import type { Scalar } from "../../store/tables";
import { MemoryTables } from "../../store/tables";
import type { DocumentRecord } from "./record";
import { DocumentsTable, isOverdue } from "./record";

/** `Documents.list` filter, already validated. Every field narrows; absent = any. */
export interface DocumentSearch {
  readonly kind?: DocumentKind | undefined;
  readonly status?: DocumentStatus | undefined;
  readonly settlement?: DocumentSettlement | undefined;
  readonly contactId?: ContactId | undefined;
  /** issuedOn >= from */
  readonly from?: IsoDate | undefined;
  /** issuedOn <= to */
  readonly to?: IsoDate | undefined;
  /**
   * true: issued, not settled (`unpaid`/`partially_paid`) and `dueOn < today`;
   * false: every other document.
   */
  readonly overdue?: { readonly value: boolean; readonly today: IsoDate } | undefined;
  /** Case-insensitive substring of the number or the buyer's name. */
  readonly text?: string | undefined;
}

/** Order: `issuedOn` desc, then `id` desc. `after` is the [issuedOn, id] of the last row seen. */
export interface DocumentPage {
  readonly after?: readonly [IsoDate, DocumentId] | undefined;
  readonly limit: number;
}

export class DocumentsRepo extends Context.Service<
  DocumentsRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<DocumentRecord, NotFound | StoreUnavailable>;
    /** Several documents by id (related links); missing ids are left out. */
    readonly getMany: (
      workspaceId: WorkspaceId,
      ids: ReadonlyArray<DocumentId>,
    ) => Effect.Effect<ReadonlyArray<DocumentRecord>, StoreUnavailable>;
    readonly getForUpdate: (
      workspaceId: WorkspaceId,
      id: DocumentId,
      expectedRevision: number,
    ) => Effect.Effect<DocumentRecord, NotFound | Conflict | StoreUnavailable>;
    /** Row lock without a revision (C6; the payments seam locks Proformas first, S2-S4). */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: DocumentId,
    ) => Effect.Effect<DocumentRecord, NotFound | StoreUnavailable>;
    readonly insert: (
      row: DocumentRecord,
    ) => Effect.Effect<DocumentRecord, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: DocumentRecord,
      expectedRevision: number,
    ) => Effect.Effect<DocumentRecord, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** Hard delete (drafts only; the caller checks the status). */
    readonly remove: (
      workspaceId: WorkspaceId,
      id: DocumentId,
      expectedRevision: number,
    ) => Effect.Effect<void, NotFound | Conflict | StoreUnavailable>;
    /**
     * Recurring issuance link (board #450): sets `scheduleId`/`occurrence` inside the caller's
     * transaction; a second document for the same occurrence is
     * `UniqueViolation{documents_schedule_occurrence_unique}`. Bumps the revision.
     */
    readonly linkSchedule: (
      workspaceId: WorkspaceId,
      id: DocumentId,
      link: { readonly scheduleId: ScheduleId; readonly occurrence: IsoDate },
    ) => Effect.Effect<void, NotFound | UniqueViolation | StoreUnavailable>;
    /** One page of `search` in list order, plus whether more rows follow. */
    readonly search: (
      workspaceId: WorkspaceId,
      search: DocumentSearch,
      page: DocumentPage,
    ) => Effect.Effect<
      { readonly rows: ReadonlyArray<DocumentRecord>; readonly more: boolean },
      StoreUnavailable
    >;

    // ReportsSource reads (compose/reportsSource.ts) ------------------------------------------
    /**
     * Issued and cancelled documents (never drafts) whose `field` lies in `from..to`
     * (inclusive). The tax point is `taxableSupplyOn ?? issuedOn`; a Proforma has none, so the
     * `taxPoint` range never returns one. Any order.
     */
    readonly reportable: (
      workspaceId: WorkspaceId,
      range: ReportableRange,
    ) => Effect.Effect<ReadonlyArray<DocumentRecord>, StoreUnavailable>;
    /**
     * Issued Invoices and Proformas whose stored settlement is `unpaid` or `partially_paid`:
     * the candidates for a positive outstanding amount (the caller applies `outstandingOf`).
     * Any order.
     */
    readonly receivable: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<DocumentRecord>, StoreUnavailable>;
  }
>()("kvitbit/core/DocumentsRepo") {}

/** `DocumentsRepo.reportable` range; `from` and `to` inclusive. */
export interface ReportableRange {
  readonly field: "issuedOn" | "taxPoint";
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/** The tax point a report files a document under; null for a Proforma (not a tax document). */
export const reportTaxPoint = (
  row: Pick<DocumentRecord, "kind" | "taxableSupplyOn" | "issuedOn">,
): IsoDate | null => (row.kind === "proforma" ? null : (row.taxableSupplyOn ?? row.issuedOn));

const matchesSearch = (row: DocumentRecord, s: DocumentSearch): boolean => {
  if (s.overdue !== undefined && isOverdue(row, s.overdue.today) !== s.overdue.value) return false;
  if (s.text !== undefined && s.text !== "") {
    const needle = s.text.toLowerCase();
    const hay = [row.number ?? "", row.contact.name].join("\n").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
};

/** Drops `undefined` members (exactOptionalPropertyTypes query shapes). */
const definedOnly = <A extends object>(value: A): { [K in keyof A]?: Exclude<A[K], undefined> } =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof A]?: Exclude<A[K], undefined>;
  };

/** List order: issuedOn desc, id desc. */
const listOrder = (a: DocumentRecord, b: DocumentRecord) =>
  compareScalar(b.issuedOn, a.issuedOn) || compareScalar(b.id, a.id);

const afterCursor = (row: DocumentRecord, after: readonly [Scalar, Scalar]) =>
  compareScalar(row.issuedOn, after[0]) < 0 ||
  (compareScalar(row.issuedOn, after[0]) === 0 && compareScalar(row.id, after[1]) < 0);

/** In-memory `DocumentsRepo` on `MemoryTables` (tests). */
export const DocumentsRepoMemory: Layer.Layer<DocumentsRepo, never, MemoryTables> = Layer.effect(
  DocumentsRepo,
  Effect.map(MemoryTables, (tables) => {
    const table = tables.collection(DocumentsTable);
    return DocumentsRepo.of({
      get: (workspaceId, id) => table.get(workspaceId, id),
      getMany: (workspaceId, ids) =>
        ids.length === 0 ? Effect.succeed([]) : table.list(workspaceId, { whereIn: { id: ids } }),
      getForUpdate: (workspaceId, id, expectedRevision) =>
        table.getForUpdate(workspaceId, id, expectedRevision),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      insert: table.insert,
      update: table.update,
      remove: (workspaceId, id, expectedRevision) =>
        table.remove(workspaceId, id, expectedRevision),
      linkSchedule: (workspaceId, id, link) =>
        Effect.flatMap(table.lock(workspaceId, id), (row) =>
          table.update({ ...row, ...link }, row.revision).pipe(
            // The row is locked: its revision cannot have moved.
            Effect.catchTag("Conflict", (e) => Effect.die(e)),
            Effect.asVoid,
          ),
        ),
      search: (workspaceId, s, page) =>
        Effect.map(
          table.list(workspaceId, {
            where: definedOnly({
              kind: s.kind,
              status: s.status,
              settlement: s.settlement,
              contactId: s.contactId,
            }),
            range: { issuedOn: definedOnly({ gte: s.from, lte: s.to }) },
          }),
          (rows) => {
            const after = page.after;
            const sorted = rows
              .filter((row) => matchesSearch(row, s))
              .filter((row) => after === undefined || afterCursor(row, after))
              .sort(listOrder);
            return { rows: sorted.slice(0, page.limit), more: sorted.length > page.limit };
          },
        ),

      // ReportsSource reads ---------------------------------------------------------------
      reportable: (workspaceId, range) =>
        range.field === "issuedOn"
          ? table.list(workspaceId, {
              whereIn: { status: ["issued", "cancelled"] },
              range: { issuedOn: { gte: range.from, lte: range.to } },
            })
          : // SQL: coalesce(taxable_supply_on, issued_on) between from and to, kind <> 'proforma'.
            Effect.map(
              table.list(workspaceId, { whereIn: { status: ["issued", "cancelled"] } }),
              (rows) =>
                rows.filter((row) => {
                  const point = reportTaxPoint(row);
                  return point !== null && range.from <= point && point <= range.to;
                }),
            ),
      receivable: (workspaceId) =>
        table.list(workspaceId, {
          where: { status: "issued" },
          whereIn: { kind: ["invoice", "proforma"], settlement: ["unpaid", "partially_paid"] },
        }),
    });
  }),
);
