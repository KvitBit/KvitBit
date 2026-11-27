/** `PriceListRepo` over `price_list_items`. */

import { PriceListRepo } from "@kvitbit/core";
import { CurrencyCode, PriceListItemId, VatTreatment, WorkspaceId } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { foldText, formatDecimal, parseDecimal } from "../codec";
import { col, decodeEach, makeTable, type TableSpec } from "../table";

type PriceListItemRow = Effect.Success<ReturnType<PriceListRepo["Service"]["get"]>>;

const OptionalText = Schema.String.pipe(Schema.NullOr, Schema.optional);
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    workspace_id: Schema.String,
    name: Schema.String,
    description: OptionalText,
    unit: OptionalText,
    currency: Schema.String,
    vat: VatTreatment.pipe(Schema.NullOr, Schema.optional),
    archived_at: OptionalText,
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);

const spec: TableSpec<PriceListItemRow> = {
  table: "price_list_items",
  collection: "price_list_items",
  entity: "PriceListItem",
  select: Arr.join(
    [
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
    ],
    ", ",
  ),
  decode: decodeEach((row): PriceListItemRow => {
    const stored = Option.getOrThrow(decodeRow(row));
    return {
      id: PriceListItemId.make(stored.id),
      workspaceId: WorkspaceId.make(stored.workspace_id),
      revision: Number(row.revision),
      name: stored.name,
      description: stored.description ?? null,
      unit: stored.unit ?? null,
      unitPrice: parseDecimal(row.unit_price),
      currency: CurrencyCode.make(stored.currency),
      vat: stored.vat ?? null,
      archivedAt: stored.archived_at ?? null,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    };
  }),
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
        get: Effect.fn("PriceListRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
        getForUpdate: Effect.fn("PriceListRepo.getForUpdate")((workspaceId, id, expectedRevision) =>
          table.getForUpdate(workspaceId, id, expectedRevision),
        ),
        lock: Effect.fn("PriceListRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
        insert: table.insert,
        update: table.update,
        list: Effect.fn("PriceListRepo.list")((workspaceId, filter) =>
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
                : Arr.filter(rows, (row) =>
                    Arr.some(
                      [row.name, row.description],
                      (value) => value !== null && Str.includes(folded)(foldText(value)),
                    ),
                  );
            },
          ),
        ),
      });
    }),
  );
