import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import { RevisionConflict, RowNotFound } from "./errors";
import { type RevisionedTable, type SqlPatch, scopeColumn, scopeColumnForPatch } from "./tables";

/** A row as Postgres returns it: snake_case column names, no decoding. */
export type Row = SqlConnection.Row;

/**
 * `SELECT * … FOR UPDATE` on one row, scoped by Workspace (core-ports.md S2, S7). The lock is held
 * until the caller's transaction ends, so call it inside `sql.withTransaction`; outside one the
 * lock is released as soon as the statement finishes. Lock the root document first (S4).
 */
export const lockRowForUpdate = Effect.fn("sql.lockRow")(function* (
  table: RevisionedTable,
  workspaceId: string,
  id: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* scopeColumn(table);
  const rows = yield* sql<Row>`
      select * from ${sql(table)}
      where ${sql(scope)} = ${workspaceId} and id = ${id}
      for update`;
  const row = rows[0];
  if (row === undefined) return yield* RowNotFound.make({ table, workspaceId, id });
  return row;
});

/** Fails with `RevisionConflict` unless `row.revision` equals `expectedRevision`. */
export const checkRevision = Effect.fn("Sql.checkRevision")(function* (
  table: RevisionedTable,
  row: Row,
  expectedRevision: number,
) {
  const currentRevision = Number(row["revision"]);
  if (currentRevision !== expectedRevision) {
    return yield* RevisionConflict.make({
      table,
      id: String(row["id"]),
      expectedRevision,
      currentRevision,
    });
  }
});

/**
 * Applies `patch` (snake_case column → value) to one row if its revision is still
 * `expectedRevision`, bumps `revision` and `updated_at`, and returns the updated row. The
 * conditional UPDATE takes the row lock itself, so it is safe with or without a prior
 * `lockRowForUpdate`; under READ COMMITTED a concurrent writer that committed first makes this
 * one fail with `RevisionConflict` carrying the new revision.
 *
 * Patch keys must be columns of `table` in the Drizzle schema; `id`, `workspace_id`, `revision`, `created_at` and
 * `updated_at` are rejected as a defect, as are `undefined` values. JSON columns take an already
 * serialized value.
 */
export const updateWithRevision = Effect.fn("Sql.updateWithRevision")(function* (
  table: RevisionedTable,
  workspaceId: string,
  id: string,
  expectedRevision: number,
  patch: SqlPatch,
) {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* scopeColumnForPatch(table, patch);
  const assignments = Record.isEmptyRecord(patch) ? sql`` : sql`${sql.update({ ...patch })}, `;
  const updated = yield* sql<Row>`
      update ${sql(table)}
      set ${assignments}revision = revision + 1, updated_at = now()
      where ${sql(scope)} = ${workspaceId} and id = ${id} and revision = ${expectedRevision}
      returning *`;
  const row = updated[0];
  if (row !== undefined) return row;
  const current = yield* sql<{ readonly revision: number }>`
      select revision from ${sql(table)} where ${sql(scope)} = ${workspaceId} and id = ${id}`;
  const found = current[0];
  if (found === undefined) return yield* RowNotFound.make({ table, workspaceId, id });
  return yield* RevisionConflict.make({
    table,
    id,
    expectedRevision,
    currentRevision: Number(found.revision),
  });
});
