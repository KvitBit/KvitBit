/** PriceList module (core-ports 4.3). The parent wires `PriceListLive` into the core composition. */

import type { NotFound, PriceListItemId, WorkspaceId } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { StoreUnavailable } from "../../store/CoreStore";
import { PriceListLive } from "./live";
import type { PriceListItemViewData } from "./model";
import { toPriceListItemView } from "./model";
import { PriceListRepo, PriceListRepoMemory } from "./repo";

export type { PriceListImpl } from "./live";
export { makePriceList, PriceListLive } from "./live";
export type { PriceListItemRow, PriceListItemSaveFields, PriceListItemViewData } from "./model";
export {
  PriceListItemRowSchema,
  PriceListItemSaveInput,
  PriceListItemViewSchema,
  toPriceListItemView,
} from "./model";
export type { PriceListFilter } from "./repo";
export { PriceListItemsTable, PriceListRepo, PriceListRepoMemory } from "./repo";

/**
 * The narrow read port Documents uses to fill a line from `LineInput.item` (description, unit,
 * unitPrice, vat). It does not authorize: the calling Documents method has authorized its own
 * action, and a `documents`-scoped token must still draft from the Price List (rule R1).
 * Archived items are returned with `archived: true`; whether a draft may use them is Documents'
 * rule.
 */
export class PriceListItems extends Context.Service<
  PriceListItems,
  {
    readonly forLine: (
      workspaceId: WorkspaceId,
      id: PriceListItemId,
    ) => Effect.Effect<PriceListItemViewData, NotFound | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/pricelist/PriceListItems") {}

export const PriceListItemsLive: Layer.Layer<PriceListItems, never, PriceListRepo> = Layer.effect(
  PriceListItems,
  Effect.map(PriceListRepo, (repo) => ({
    forLine: (workspaceId: WorkspaceId, id: PriceListItemId) =>
      Effect.map(repo.get(workspaceId, id), toPriceListItemView),
  })),
);

/**
 * PriceList on the in-memory repository, with `PriceListItems` and the memory repo exposed.
 * Requires `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator).
 */
export const PriceListTestLayer = Layer.mergeAll(PriceListLive, PriceListItemsLive).pipe(
  Layer.provideMerge(PriceListRepoMemory),
);
