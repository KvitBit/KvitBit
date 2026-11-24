import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { RevisionConflict, RowNotFound } from "./errors";
import { checkPatchColumns, type RevisionedTable, scopeColumn } from "./tables";

/** A row as Postgres returns it: snake_case column names, no decoding. */
export type Row = Readonly<Record<string, unknown>>;

/**
 * `SELECT * … FOR UPDATE` on one row, scoped by Workspace (core-ports.md S2, S7). The lock is held
 * until the caller's transaction ends, so call it inside `sql.withTransaction`; outside one the
 * lock is released as soon as the statement finishes. Lock the root document first (S4).
 */
export const lockRowForUpdate = (
  table: RevisionedTable,
  workspaceId: string,
  id: string,
): Effect.Effect<Row, RowNotFound | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Effect.sync(() => scopeColumn(table));
    const rows = yield* sql<Row>`
      select * from ${sql(table)}
      where ${sql(scope)} = ${workspaceId} and id = ${id}
      for update`;
    const row = rows[0];
    if (row === undefined) return yield* new RowNotFound({ table, workspaceId, id });
    return row;
  });

/** Fails with `RevisionConflict` unless `row.revision` equals `expectedRevision`. */
export const checkRevision = (
  table: RevisionedTable,
  row: Row,
  expectedRevision: number,
): Effect.Effect<void, RevisionConflict> => {
  const currentRevision = Number(row.revision);
  return currentRevision === expectedRevision
    ? Effect.void
    : Effect.fail(
        new RevisionConflict({ table, id: String(row.id), expectedRevision, currentRevision }),
      );
};

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
export const updateWithRevision = (
  table: RevisionedTable,
  workspaceId: string,
  id: string,
  expectedRevision: number,
  patch: Readonly<Record<string, unknown>>,
): Effect.Effect<Row, RowNotFound | RevisionConflict | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Effect.sync(() => {
      checkPatchColumns(table, patch);
      return scopeColumn(table);
    });
    const assignments =
      Object.keys(patch).length === 0 ? sql`` : sql`${sql.update({ ...patch })}, `;
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
    if (found === undefined) return yield* new RowNotFound({ table, workspaceId, id });
    return yield* new RevisionConflict({
      table,
      id,
      expectedRevision,
      currentRevision: Number(found.revision),
    });
  });
