/** `ExportsRepo` over `exports`. */

import { ExportsRepo } from "@kvitbit/core";
import { ExportId, ExportJobView, WorkspaceId } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { col, decodeEach, makeTable, type TableSpec } from "../table";

type ExportRow = Effect.Success<ReturnType<ExportsRepo["Service"]["get"]>>;

const OptionalText = Schema.String.pipe(Schema.NullOr, Schema.optional);
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    workspace_id: Schema.String,
    status: ExportJobView.fields.status,
    created_at: Schema.String,
    ready_at: OptionalText,
    expires_at: OptionalText,
  }),
);

const spec: TableSpec<ExportRow> = {
  table: "exports",
  collection: "exports",
  entity: "Export",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "status",
      col.instant("created_at"),
      col.instant("ready_at"),
      col.instant("expires_at"),
      "size_bytes",
    ],
    ", ",
  ),
  decode: decodeEach((row): ExportRow => {
    const stored = Option.getOrThrow(decodeRow(row));
    return {
      id: ExportId.make(stored.id),
      workspaceId: WorkspaceId.make(stored.workspace_id),
      revision: Number(row.revision),
      status: stored.status,
      createdAt: stored.created_at,
      readyAt: stored.ready_at ?? null,
      expiresAt: stored.expires_at ?? null,
      sizeBytes: Predicate.isNotNullish(row.size_bytes) ? Number(row.size_bytes) : null,
    };
  }),
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
      get: Effect.fn("ExportsRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
      lock: Effect.fn("ExportsRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
      findRunning: Effect.fn("ExportsRepo.findRunning")((workspaceId) =>
        table.first(workspaceId, sql`status = 'running'`),
      ),
      insert: table.insert,
      update: table.update,
      listExpired: Effect.fn("ExportsRepo.listExpired")((nowIso, failedBefore) =>
        table.selectGlobal(
          sql`(status = 'ready' and expires_at is not null and expires_at <= ${nowIso}::timestamptz)
            or (status = 'failed' and created_at < ${failedBefore}::timestamptz)`,
        ),
      ),
      remove: Effect.fn("ExportsRepo.remove")((workspaceId, id, expectedRevision) =>
        table.remove(workspaceId, id, expectedRevision),
      ),
    });
  }),
);
