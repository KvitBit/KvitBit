/** `ExportsRepo` over `exports`. */
import { ExportsRepo } from "@kvitbit/core";
import type { ExportId, WorkspaceId } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type ExportRow = Effect.Success<ReturnType<ExportsRepo["Service"]["get"]>>;

const spec: TableSpec<ExportRow> = {
  table: "exports",
  collection: "exports",
  entity: "Export",
  select: [
    "id",
    "workspace_id",
    "revision",
    "status",
    col.instant("created_at"),
    col.instant("ready_at"),
    col.instant("expires_at"),
    "size_bytes",
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): ExportRow => ({
      id: row.id as ExportId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      status: row.status as ExportRow["status"],
      createdAt: row.created_at as string,
      readyAt: (row.ready_at as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
      sizeBytes:
        row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    status: row.status,
    created_at: row.createdAt,
    ready_at: row.readyAt,
    expires_at: row.expiresAt,
    size_bytes: row.sizeBytes,
  }),
};

export const ExportsRepoSql: Layer.Layer<ExportsRepo, never, SqlClient.SqlClient> = Layer.effect(
  ExportsRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = makeTable(sql, spec);
    return ExportsRepo.of({
      get: (workspaceId, id) => table.get(workspaceId, id),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      findRunning: (workspaceId) => table.first(workspaceId, sql`status = 'running'`),
      insert: table.insert,
      update: table.update,
      listExpired: (nowIso, failedBefore) =>
        table.selectGlobal(
          sql`(status = 'ready' and expires_at is not null and expires_at <= ${nowIso}::timestamptz)
            or (status = 'failed' and created_at < ${failedBefore}::timestamptz)`,
        ),
      remove: (workspaceId, id, expectedRevision) =>
        table.remove(workspaceId, id, expectedRevision),
    });
  }),
);
