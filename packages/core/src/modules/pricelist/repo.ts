/**
 * `PriceListRepo`: the PriceList module's repository port (conventions in src/store/tables.ts)
 * and its in-memory implementation on `MemoryTables`.
 */

import type { Conflict, NotFound, PriceListItemId, WorkspaceId } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EffectString from "effect/String";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import { foldText } from "../contacts/input";
import type { PriceListItemRow } from "./model";
import { PriceListItemRowSchema } from "./model";

export const PriceListItemsTable = defineCollection<PriceListItemRow>({
  name: "price_list_items",
  entity: "PriceListItem",
  schema: PriceListItemRowSchema,
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
>()("@kvitbit/core/modules/pricelist/repo/PriceListRepo") {}

/** `PriceListRepo` on `MemoryTables` (tests and the in-memory composition). */
export const PriceListRepoMemory: Layer.Layer<PriceListRepo, never, MemoryTables> = Layer.effect(
  PriceListRepo,
  Effect.gen(function* () {
    const table = (yield* MemoryTables).collection(PriceListItemsTable);
    return {
      get: Effect.fn("PriceListRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
      getForUpdate: Effect.fn("PriceListRepo.getForUpdate")((workspaceId, id, expectedRevision) =>
        table.getForUpdate(workspaceId, id, expectedRevision),
      ),
      lock: Effect.fn("PriceListRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
      insert: Effect.fn("PriceListRepo.insert")((row) => table.insert(row)),
      update: Effect.fn("PriceListRepo.update")((next, expectedRevision) =>
        table.update(next, expectedRevision),
      ),
      list: Effect.fn("PriceListRepo.list")((workspaceId, filter) =>
        Effect.map(
          table.list(
            workspaceId,
            filter.includeArchived
              ? { orderBy: ["name"] }
              : { orderBy: ["name"], where: { archivedAt: null } },
          ),
          (rows) => {
            const folded = filter.text === undefined ? "" : foldText(filter.text);
            return folded === ""
              ? rows
              : EffectArray.filter(rows, (row) =>
                  EffectArray.some(
                    [row.name, row.description],
                    (value) => value !== null && EffectString.includes(folded)(foldText(value)),
                  ),
                );
          },
        ),
      ),
    };
  }),
);
