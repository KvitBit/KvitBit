/** `NumberingSeriesRepo` over `numbering_series`. */
import { NumberingSeriesRepo } from "@kvitbit/core";
import type { DocumentKind, NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type SeriesRow = Effect.Success<ReturnType<NumberingSeriesRepo["Service"]["get"]>>;

const spec: TableSpec<SeriesRow> = {
  table: "numbering_series",
  collection: "numbering_series",
  entity: "NumberingSeries",
  select: "id, workspace_id, revision, kind, name, pattern, is_default",
  decode: decodeEach(
    (row: DbRow): SeriesRow => ({
      id: row.id as NumberingSeriesId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      kind: row.kind as DocumentKind,
      name: row.name as string,
      pattern: row.pattern as string,
      isDefault: Boolean(row.is_default),
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    kind: row.kind,
    name: row.name,
    pattern: row.pattern,
    is_default: row.isDefault,
  }),
};

export const NumberingSeriesRepoSql: Layer.Layer<NumberingSeriesRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    NumberingSeriesRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const table = makeTable(sql, spec);
      return NumberingSeriesRepo.of({
        get: (workspaceId, id) => table.get(workspaceId, id),
        lock: (workspaceId, id) => table.lock(workspaceId, id),
        findDefault: (workspaceId, kind) =>
          table.first(workspaceId, sql`kind = ${kind} and is_default = true`),
        list: (workspaceId) => table.select(workspaceId, undefined, sql`order by kind asc, id asc`),
        insert: table.insert,
        update: table.update,
      });
    }),
  );
