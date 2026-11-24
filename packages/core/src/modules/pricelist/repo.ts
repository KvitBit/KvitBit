/**
 * `PriceListRepo`: the PriceList module's repository port (conventions in src/store/tables.ts)
 * and its in-memory implementation on `MemoryTables`.
 */
import type { Conflict, NotFound, PriceListItemId, WorkspaceId } from "@kvitbit/domain/contract";
import type { Schema } from "effect";
import { Context, Effect, Layer } from "effect";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import { foldText } from "../contacts/input";
import type { PriceListItemRow } from "./model";
import { PriceListItemRowSchema } from "./model";

export const PriceListItemsTable = defineCollection<PriceListItemRow>({
  name: "price_list_items",
  entity: "PriceListItem",
  schema: PriceListItemRowSchema as unknown as Schema.Codec<PriceListItemRow, unknown>,
});

export interface PriceListFilter {
  /** Case- and diacritics-insensitive substring of the name or description. */
  readonly text?: string | undefined;
  readonly includeArchived: boolean;
}

export class PriceListRepo extends Context.Service<
  PriceListRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: PriceListItemId,
    ) => Effect.Effect<PriceListItemRow, NotFound | StoreUnavailable>;
    readonly getForUpdate: (
      workspaceId: WorkspaceId,
      id: PriceListItemId,
      expectedRevision: number,
    ) => Effect.Effect<PriceListItemRow, NotFound | Conflict | StoreUnavailable>;
    readonly lock: (
      workspaceId: WorkspaceId,
      id: PriceListItemId,
    ) => Effect.Effect<PriceListItemRow, NotFound | StoreUnavailable>;
    readonly insert: (
      row: PriceListItemRow,
    ) => Effect.Effect<PriceListItemRow, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: PriceListItemRow,
      expectedRevision: number,
    ) => Effect.Effect<PriceListItemRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** Items matching the filter, by name then id ascending (a bounded collection: no paging). */
    readonly list: (
      workspaceId: WorkspaceId,
      filter: PriceListFilter,
    ) => Effect.Effect<ReadonlyArray<PriceListItemRow>, StoreUnavailable>;
  }
>()("kvitbit/core/PriceListRepo") {}

/** `PriceListRepo` on `MemoryTables` (tests and the in-memory composition). */
export const PriceListRepoMemory: Layer.Layer<PriceListRepo, never, MemoryTables> = Layer.effect(
  PriceListRepo,
  Effect.gen(function* () {
    const table = (yield* MemoryTables).collection(PriceListItemsTable);
    return {
      get: (workspaceId, id) => table.get(workspaceId, id),
      getForUpdate: (workspaceId, id, expectedRevision) =>
        table.getForUpdate(workspaceId, id, expectedRevision),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      insert: (row) => table.insert(row),
      update: (next, expectedRevision) => table.update(next, expectedRevision),
      list: (workspaceId, filter) =>
        Effect.map(
          table.list(workspaceId, {
            ...(filter.includeArchived ? {} : { where: { archivedAt: null } }),
            orderBy: ["name"],
          }),
          (rows) => {
            const folded = filter.text === undefined ? "" : foldText(filter.text);
            return folded === ""
              ? rows
              : rows.filter((row) =>
                  [row.name, row.description].some(
                    (value) => value !== null && foldText(value).includes(folded),
                  ),
                );
          },
        ),
    };
  }),
);
