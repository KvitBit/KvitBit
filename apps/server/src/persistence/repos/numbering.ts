/** `NumberingSeriesRepo` over `numbering_series`. */
import { NumberingSeriesRepo } from "@kvitbit/core";
import { DocumentKind, NumberingSeriesId } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { decodeWorkspaceId } from "../codec";
import { decodeEach, makeTable, type TableSpec } from "../table";

type SeriesRow = Effect.Success<ReturnType<NumberingSeriesRepo["Service"]["get"]>>;

const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    workspace_id: Schema.String,
    kind: DocumentKind,
    name: Schema.String,
    pattern: Schema.String,
  }),
);

const spec: TableSpec<SeriesRow> = {
  table: "numbering_series",
  collection: "numbering_series",
  entity: "NumberingSeries",
  select: "id, workspace_id, revision, kind, name, pattern, is_default",
  decode: decodeEach((row): SeriesRow => {
    const stored = Option.getOrThrow(decodeRow(row));
    return {
      id: NumberingSeriesId.make(stored.id),
      workspaceId: decodeWorkspaceId(stored.workspace_id),
      revision: Number(row.revision),
      kind: stored.kind,
      name: stored.name,
      pattern: stored.pattern,
      isDefault: Boolean(row.is_default),
    };
  }),
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
        get: Effect.fn("NumberingSeriesRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
        lock: Effect.fn("NumberingSeriesRepo.lock")((workspaceId, id) =>
          table.lock(workspaceId, id),
        ),
        findDefault: Effect.fn("NumberingSeriesRepo.findDefault")((workspaceId, kind) =>
          table.first(workspaceId, sql`kind = ${kind} and is_default = true`),
        ),
        list: Effect.fn("NumberingSeriesRepo.list")((workspaceId) =>
          table.select(workspaceId, undefined, sql`order by kind asc, id asc`),
        ),
        insert: table.insert,
        update: table.update,
      });
    }),
  );
