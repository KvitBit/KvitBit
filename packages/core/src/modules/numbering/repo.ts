/**
 * `NumberingSeriesRepo`: the `numbering_series` table (one row per Numbering Series) with the
 * repository conventions of src/store/tables.ts. Counters and reservations are CoreStore's.
 */
import type {
  Conflict,
  DocumentKind,
  NotFound,
  NumberingSeriesId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  DocumentKind as DocumentKindSchema,
  NumberingSeriesId as NumberingSeriesIdSchema,
  WorkspaceId as WorkspaceIdSchema,
} from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";

export const SeriesRow = Schema.Struct({
  id: NumberingSeriesIdSchema,
  workspaceId: WorkspaceIdSchema,
  revision: Schema.Finite,
  kind: DocumentKindSchema,
  name: Schema.String,
  /** Valid by `Numbering.parsePattern` when stored. */
  pattern: Schema.String,
  isDefault: Schema.Boolean,
});
export type SeriesRow = typeof SeriesRow.Type;

/** Unique index: one default series per (workspace, kind) (rule W3). */
export const DEFAULT_PER_KIND = "numbering_series_one_default_per_kind";

export const NumberingSeriesTable = defineCollection<SeriesRow>({
  name: "numbering_series",
  entity: "NumberingSeries",
  schema: SeriesRow,
  unique: [
    {
      name: DEFAULT_PER_KIND,
      scope: "workspace",
      key: (row) => (row.isDefault ? [row.kind] : null),
    },
  ],
});

export class NumberingSeriesRepo extends Context.Service<
  NumberingSeriesRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: NumberingSeriesId,
    ) => Effect.Effect<SeriesRow, NotFound | StoreUnavailable>;
    /** Row-lock without a revision (configureSeries carries none, rule C6). */
    readonly lock: (
      workspaceId: WorkspaceId,
      id: NumberingSeriesId,
    ) => Effect.Effect<SeriesRow, NotFound | StoreUnavailable>;
    readonly findDefault: (
      workspaceId: WorkspaceId,
      kind: DocumentKind,
    ) => Effect.Effect<Option.Option<SeriesRow>, StoreUnavailable>;
    /** Every series of the Workspace, by kind then id. */
    readonly list: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<SeriesRow>, StoreUnavailable>;
    readonly insert: (
      row: SeriesRow,
    ) => Effect.Effect<SeriesRow, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: SeriesRow,
      expectedRevision: number,
    ) => Effect.Effect<SeriesRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/numbering/repo/NumberingSeriesRepo") {}

/** In-memory `NumberingSeriesRepo` on `MemoryTables` (tests). */
export const NumberingSeriesRepoMemory: Layer.Layer<NumberingSeriesRepo, never, MemoryTables> =
  Layer.effect(
    NumberingSeriesRepo,
    Effect.map(MemoryTables, (tables) => {
      const table = tables.collection(NumberingSeriesTable);
      return {
        get: (workspaceId, id) => table.get(workspaceId, id),
        lock: (workspaceId, id) => table.lock(workspaceId, id),
        findDefault: (workspaceId, kind) => table.findUnique(DEFAULT_PER_KIND, [kind], workspaceId),
        list: (workspaceId) => table.list(workspaceId, { orderBy: ["kind"] }),
        insert: table.insert,
        update: table.update,
      };
    }),
  );
