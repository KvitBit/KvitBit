/**
 * `RecurringDocumentLink`: the narrow write port that stamps an issued document with the
 * occurrence that produced it (`documents.schedule_id, occurrence`, UNIQUE; core-ports 4.8, 7.2).
 * The domain `Documents.issue` carries no schedule link, so the issue step calls this right after
 * it, in the same transaction. The Documents module owns the columns; integration provides this
 * from its repository. No authorize, no audit. A second document for the same occurrence breaks
 * the unique index: `UniqueViolation`, which the issue step treats as a defect (its own run row
 * under the schedule lock already prevents it). Board seam: see the ce-recurring post in #384.
 */
import type { DocumentId, IsoDate, ScheduleId, WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Schema } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";

export interface OccurrenceLink {
  readonly scheduleId: ScheduleId;
  readonly occurrence: IsoDate;
}

export class RecurringDocumentLink extends Context.Service<
  RecurringDocumentLink,
  {
    readonly link: (
      workspaceId: WorkspaceId,
      document: DocumentId,
      occurrence: OccurrenceLink,
    ) => Effect.Effect<void, UniqueViolation | StoreUnavailable>;
  }
>()("kvitbit/core/RecurringDocumentLink") {}

interface LinkRow {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly scheduleId: ScheduleId;
  readonly occurrence: IsoDate;
}

const LinksTable = defineCollection<LinkRow>({
  name: "fake_document_links",
  entity: "Document",
  schema: Schema.Unknown as unknown as Schema.Codec<LinkRow, unknown>,
  unique: [
    {
      name: "documents_schedule_occurrence_unique",
      scope: "workspace",
      key: (row) => [row.scheduleId, row.occurrence],
    },
  ],
});

/**
 * In-memory fake on `MemoryTables` (so links roll back with the transaction) enforcing the
 * unique (schedule, occurrence) index. `all` lists document id -> occurrence. Tests only.
 */
export class FakeDocumentLinks extends Context.Service<
  FakeDocumentLinks,
  {
    readonly all: Effect.Effect<
      ReadonlyArray<OccurrenceLink & { readonly document: string }>,
      StoreUnavailable
    >;
  }
>()("kvitbit/core/testing/FakeDocumentLinks") {
  static readonly layer: Layer.Layer<
    RecurringDocumentLink | FakeDocumentLinks,
    never,
    MemoryTables
  > = Layer.effectContext(
    Effect.map(MemoryTables, (tables) => {
      const links = tables.collection(LinksTable);
      return Context.make(
        FakeDocumentLinks,
        FakeDocumentLinks.of({
          all: Effect.map(links.listGlobal(), (rows) =>
            rows.map((row) => ({
              document: row.id,
              scheduleId: row.scheduleId,
              occurrence: row.occurrence,
            })),
          ),
        }),
      ).pipe(
        Context.add(
          RecurringDocumentLink,
          RecurringDocumentLink.of({
            link: (workspaceId, document, { scheduleId, occurrence }) =>
              Effect.asVoid(
                links.insert({ id: document, workspaceId, revision: 1, scheduleId, occurrence }),
              ),
          }),
        ),
      );
    }),
  );
}
