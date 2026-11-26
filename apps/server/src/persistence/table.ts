/**
 * The row conventions of packages/core/src/store/tables.ts over one Postgres table: Workspace
 * scoping (R2), `SELECT ... FOR UPDATE` row locks with the revision check (C2, S2), the
 * compare-and-set update that stores revision + 1, and unique violations named after the core
 * constraint. Each repository declares a `TableSpec` (columns, row mapping, child tables) and
 * writes its named queries with `select`/`selectGlobal`.
 *
 * Inserts and updates run in a savepoint, so a `UniqueViolation` reverts only that statement
 * and the module may still decide what to do with it (Postgres would otherwise abort the whole
 * transaction).
 */
import type { StoreUnavailable, UniqueViolation } from "@kvitbit/core/ports";
import type { EntityKind, WorkspaceId } from "@kvitbit/domain/contract";
import { Conflict, NotFound } from "@kvitbit/domain/contract";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";
import { unavailable, writeErrors } from "./errors";

/** A row as the driver returns it (column name -> value). */
export type DbRow = Readonly<Record<string, unknown>>;

/** Every stored aggregate: tenant-scoped and revisioned. */
export interface StoredRow {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
}

/** What a repository effect may require besides its own services. */
export type Sql = SqlClient.SqlClient;

export interface TableSpec<A extends StoredRow> {
  /** Database table, e.g. `"price_list_items"`. */
  readonly table: string;
  /** Core collection name (`UniqueViolation.collection`), e.g. `"price_list_items"`. */
  readonly collection: string;
  /** `NotFound.entity` for misses. */
  readonly entity: EntityKind;
  /** The Workspace column; `"id"` for the workspaces table itself. Default `"workspace_id"`. */
  readonly scope?: string;
  /**
   * The select list, trusted SQL. Must yield `id`, the scope column and `revision`; cast dates,
   * instants and numerics to text with `col.date`/`col.instant`/`col.numeric` so every driver
   * returns the same strings.
   */
  readonly select: string;
  /** Main-table rows to core rows (in the same order); load child tables here, in one query. */
  readonly decode: (rows: ReadonlyArray<DbRow>) => Effect.Effect<ReadonlyArray<A>, SqlError, Sql>;
  /** A core row to its main-table columns. `revision` is ignored; the table manages it. */
  readonly encode: (row: A) => DbRow;
  /** Replaces the row's child-table rows after the main row is written. */
  readonly writeChildren?: (
    row: A,
    mode: "insert" | "update",
  ) => Effect.Effect<void, SqlError, Sql>;
  /** Database constraint name -> core constraint name, for names that differ. */
  readonly constraints?: Readonly<Record<string, string>>;
}

/** Column expressions for `TableSpec.select`. */
export const col = {
  /** `date` as `YYYY-MM-DD`. */
  date: (name: string, as: string = name) => `${q(name)}::text as ${q(as)}`,
  /** `timestamptz` as an ISO instant with milliseconds and `Z` (what `toISOString` prints). */
  instant: (name: string, as: string = name) =>
    `to_char(${q(name)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${q(as)}`,
  /** `numeric` as its decimal string. */
  numeric: (name: string, as: string = name) => `${q(name)}::text as ${q(as)}`,
} as const;

const q = (name: string) => (name.includes(".") || name.includes("(") ? name : `"${name}"`);

/** Pure per-row decoding lifted to `TableSpec.decode`. */
export const decodeEach =
  <A>(f: (row: DbRow) => A) =>
  (rows: ReadonlyArray<DbRow>): Effect.Effect<ReadonlyArray<A>, never, never> =>
    Effect.sync(() => rows.map(f));

export interface SqlTable<A extends StoredRow> {
  readonly spec: TableSpec<A>;
  readonly get: (
    workspaceId: WorkspaceId,
    id: string,
  ) => Effect.Effect<A, NotFound | StoreUnavailable, never>;
  readonly find: (
    workspaceId: WorkspaceId,
    id: string,
  ) => Effect.Effect<Option.Option<A>, StoreUnavailable, never>;
  /** Row lock without a revision check (C6). */
  readonly lock: (
    workspaceId: WorkspaceId,
    id: string,
  ) => Effect.Effect<A, NotFound | StoreUnavailable, never>;
  /** Row lock, then `Conflict{revision_changed}` when `expectedRevision` is stale (C2, S2). */
  readonly getForUpdate: (
    workspaceId: WorkspaceId,
    id: string,
    expectedRevision: number,
  ) => Effect.Effect<A, NotFound | Conflict | StoreUnavailable, never>;
  /** Stores `row` at revision 1. */
  readonly insert: (row: A) => Effect.Effect<A, UniqueViolation | StoreUnavailable, never>;
  /** Compare-and-set: stores `next` at `expectedRevision + 1`. */
  readonly update: (
    next: A,
    expectedRevision: number,
  ) => Effect.Effect<A, NotFound | Conflict | UniqueViolation | StoreUnavailable, never>;
  /** Hard delete with the same compare-and-set. */
  readonly remove: (
    workspaceId: WorkspaceId,
    id: string,
    expectedRevision: number,
  ) => Effect.Effect<void, NotFound | Conflict | StoreUnavailable, never>;
  /** `select <spec.select> from <table> where <scope> = ws and (<where>) <tail>`. */
  readonly select: (
    workspaceId: WorkspaceId,
    where?: Fragment,
    tail?: Fragment,
  ) => Effect.Effect<ReadonlyArray<A>, StoreUnavailable, never>;
  /** Cross-tenant `select` (flows without a Workspace, maintenance scans). */
  readonly selectGlobal: (
    where?: Fragment,
    tail?: Fragment,
  ) => Effect.Effect<ReadonlyArray<A>, StoreUnavailable, never>;
  /** The first row of `select`, if any. */
  readonly first: (
    workspaceId: WorkspaceId,
    where?: Fragment,
    tail?: Fragment,
  ) => Effect.Effect<Option.Option<A>, StoreUnavailable, never>;
  /** The first row of `selectGlobal`, if any. */
  readonly firstGlobal: (
    where?: Fragment,
    tail?: Fragment,
  ) => Effect.Effect<Option.Option<A>, StoreUnavailable, never>;
}

/**
 * The table's operations over `sql`. Build it once in the repository layer; the operations join
 * whatever transaction the calling fiber has open.
 */
export const makeTable = <A extends StoredRow>(
  sql: SqlClient.SqlClient,
  spec: TableSpec<A>,
): SqlTable<A> => {
  const withSql = <X, E>(self: Effect.Effect<X, E, Sql>) =>
    Effect.provideService(self, SqlClient.SqlClient, sql);
  /** Runs `self` in a savepoint (or a transaction when none is open). */
  const savepoint = <X, E>(self: Effect.Effect<X, E, Sql>) => sql.withTransaction(withSql(self));
  const scope = spec.scope ?? "workspace_id";
  const rename = (constraint: string) => spec.constraints?.[constraint] ?? constraint;
  const writeFailure = writeErrors(spec.collection, rename);
  const notFound = (id: string) => new NotFound({ entity: spec.entity, id });

  const run = (
    build: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<DbRow>, SqlError>,
  ): Effect.Effect<ReadonlyArray<A>, StoreUnavailable> =>
    unavailable(
      Effect.gen(function* () {
        const rows = yield* build(sql);
        return rows.length === 0 ? [] : yield* withSql(spec.decode(rows));
      }),
    );

  const byId = (workspaceId: WorkspaceId, id: string, lock: boolean) =>
    Effect.map(
      run(
        (sql) =>
          sql`select ${sql.unsafe(spec.select)} from ${sql(spec.table)}
            where ${sql(scope)} = ${workspaceId} and id = ${id}${lock ? sql` for update` : sql``}`,
      ),
      (rows) => Option.fromUndefinedOr(rows[0]),
    );

  const required = (
    workspaceId: WorkspaceId,
    id: string,
    lock: boolean,
  ): Effect.Effect<A, NotFound | StoreUnavailable> =>
    Effect.flatMap(byId(workspaceId, id, lock), (row) =>
      Option.isSome(row) ? Effect.succeed(row.value) : Effect.fail(notFound(id)),
    );

  const checked = (row: A, expectedRevision: number): Effect.Effect<A, Conflict> =>
    row.revision === expectedRevision
      ? Effect.succeed(row)
      : Effect.fail(new Conflict({ reason: "revision_changed", currentRevision: row.revision }));

  /** After a CAS that matched no row: the reason (missing row or stale revision). */
  const missedCas = (
    workspaceId: WorkspaceId,
    id: string,
  ): Effect.Effect<never, NotFound | Conflict | StoreUnavailable> =>
    Effect.flatMap(
      byId(workspaceId, id, false),
      (row): Effect.Effect<never, NotFound | Conflict> =>
        Option.isSome(row)
          ? Effect.fail(
              new Conflict({ reason: "revision_changed", currentRevision: row.value.revision }),
            )
          : Effect.fail(notFound(id)),
    );

  const columnsOf = (row: A) => {
    const { revision: _ignored, ...columns } = spec.encode(row) as Record<string, unknown>;
    return columns;
  };

  const select: SqlTable<A>["select"] = (workspaceId, where, tail) =>
    run(
      (sql) =>
        sql`select ${sql.unsafe(spec.select)} from ${sql(spec.table)}
          where ${sql(scope)} = ${workspaceId}${where === undefined ? sql`` : sql` and (${where})`}
          ${tail ?? sql``}`,
    );

  const selectGlobal: SqlTable<A>["selectGlobal"] = (where, tail) =>
    run(
      (sql) =>
        sql`select ${sql.unsafe(spec.select)} from ${sql(spec.table)}
          ${where === undefined ? sql`` : sql`where ${where}`} ${tail ?? sql``}`,
    );

  return {
    spec,
    get: (workspaceId, id) => required(workspaceId, id, false),
    find: (workspaceId, id) => byId(workspaceId, id, false),
    lock: (workspaceId, id) => required(workspaceId, id, true),
    getForUpdate: (workspaceId, id, expectedRevision) =>
      Effect.flatMap(required(workspaceId, id, true), (row) => checked(row, expectedRevision)),
    insert: (row) =>
      Effect.gen(function* () {
        const stored = { ...row, revision: 1 };
        yield* savepoint(
          Effect.gen(function* () {
            yield* sql`insert into ${sql(spec.table)} ${sql.insert({ ...columnsOf(stored), revision: 1 })}`;
            if (spec.writeChildren !== undefined) yield* spec.writeChildren(stored, "insert");
          }),
        ).pipe(writeFailure);
        return stored;
      }),
    update: (next, expectedRevision) =>
      Effect.gen(function* () {
        const stored = { ...next, revision: expectedRevision + 1 };
        const { id: _id, [scope === "id" ? "id" : scope]: _scope, ...columns } = columnsOf(stored);
        const updated = yield* savepoint(
          Effect.gen(function* () {
            const rows = yield* sql`update ${sql(spec.table)}
              set ${sql.update({ ...columns, revision: expectedRevision + 1 })}
              where ${sql(scope)} = ${next.workspaceId} and id = ${next.id}
                and revision = ${expectedRevision}
              returning id`;
            if (rows.length > 0 && spec.writeChildren !== undefined) {
              yield* spec.writeChildren(stored, "update");
            }
            return rows.length;
          }),
        ).pipe(writeFailure);
        if (updated === 0) return yield* missedCas(next.workspaceId, next.id);
        return stored;
      }),
    remove: (workspaceId, id, expectedRevision) =>
      Effect.gen(function* () {
        const rows = yield* unavailable(
          sql`delete from ${sql(spec.table)}
            where ${sql(scope)} = ${workspaceId} and id = ${id} and revision = ${expectedRevision}
            returning id`,
        );
        if (rows.length === 0) return yield* missedCas(workspaceId, id);
      }),
    select,
    selectGlobal,
    first: (workspaceId, where, tail) =>
      Effect.map(select(workspaceId, where, tail), (rows) => Option.fromUndefinedOr(rows[0])),
    firstGlobal: (where, tail) =>
      Effect.map(selectGlobal(where, tail), (rows) => Option.fromUndefinedOr(rows[0])),
  };
};
