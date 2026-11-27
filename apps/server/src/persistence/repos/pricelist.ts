/** `PriceListRepo` over `price_list_items`. */
import { PriceListRepo } from "@kvitbit/core";
import type {
  CurrencyCode,
  PriceListItemId,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { foldText, formatDecimal, parseDecimal } from "../codec";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type PriceListItemRow = Effect.Success<ReturnType<PriceListRepo["Service"]["get"]>>;

const spec: TableSpec<PriceListItemRow> = {
  table: "price_list_items",
  collection: "price_list_items",
  entity: "PriceListItem",
  select: [
    "id",
    "workspace_id",
    "revision",
    "name",
    "description",
    "unit",
    col.numeric("unit_price"),
    "currency",
    "vat",
    col.instant("archived_at"),
    col.instant("created_at"),
    col.instant("updated_at"),
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): PriceListItemRow => ({
      id: row.id as PriceListItemId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      unit: (row.unit as string | null) ?? null,
      unitPrice: parseDecimal(row.unit_price),
      currency: row.currency as CurrencyCode,
      vat: (row.vat as VatTreatment | null) ?? null,
      archivedAt: (row.archived_at as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    description: row.description,
    unit: row.unit,
    unit_price: formatDecimal(row.unitPrice),
    currency: row.currency,
    vat: row.vat,
    archived_at: row.archivedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }),
};

export const PriceListRepoSql: Layer.Layer<PriceListRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    PriceListRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const table = makeTable(sql, spec);
      return PriceListRepo.of({
        get: (workspaceId, id) => table.get(workspaceId, id),
        getForUpdate: (workspaceId, id, expectedRevision) =>
          table.getForUpdate(workspaceId, id, expectedRevision),
        lock: (workspaceId, id) => table.lock(workspaceId, id),
        insert: table.insert,
        update: table.update,
        list: (workspaceId, filter) =>
          Effect.map(
            table.select(
              workspaceId,
              filter.includeArchived ? undefined : sql`archived_at is null`,
              sql`order by name collate "C" asc, id asc`,
            ),
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
      });
    }),
  );
