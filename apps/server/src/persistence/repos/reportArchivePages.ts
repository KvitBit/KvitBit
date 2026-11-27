import type { WorkspaceId } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";

const ARCHIVE_PAGE_SIZE = 128;
type ReportTable = "documents" | "payments" | "expenses";
type ArchiveTable = ReportTable | "attachments";

interface ReportArchivePage {
  readonly table: ReportTable;
  readonly ids: ReadonlyArray<string>;
}

// The normal report reads have no id restriction. The archive provides the selected IDs
// only while projecting one page through the usual report repositories.
const CurrentReportArchivePage = Context.Reference<ReportArchivePage | undefined>(
  "kvitbit/server/CurrentReportArchivePage",
  { defaultValue: () => undefined },
);

export const withReportArchivePage: {
  (page: ReportArchivePage): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, page: ReportArchivePage): Effect.Effect<A, E, R>;
} = Fn.dual(2, <A, E, R>(effect: Effect.Effect<A, E, R>, page: ReportArchivePage) =>
  Effect.provideService(effect, CurrentReportArchivePage, page),
);

export const selectReportRows: {
  <A, E>(
    table: ReportTable,
    filter: Statement.Fragment,
    select: (where: Statement.Fragment) => Effect.Effect<ReadonlyArray<A>, E>,
  ): (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, E>;
  <A, E>(
    sql: SqlClient.SqlClient,
    table: ReportTable,
    filter: Statement.Fragment,
    select: (where: Statement.Fragment) => Effect.Effect<ReadonlyArray<A>, E>,
  ): Effect.Effect<ReadonlyArray<A>, E>;
} = Fn.dual(
  4,
  <A, E>(
    sql: SqlClient.SqlClient,
    table: ReportTable,
    filter: Statement.Fragment,
    select: (where: Statement.Fragment) => Effect.Effect<ReadonlyArray<A>, E>,
  ) =>
    Effect.flatMap(CurrentReportArchivePage, (page) =>
      select(page?.table === table ? sql`${filter} and id = any(${page.ids}::uuid[])` : filter),
    ),
);

/** Bound the scan at its first pull and release the transaction before emitting a page. */
export const archivePages: {
  <Row extends { readonly id: string }, A, E, R>(
    workspaceId: WorkspaceId,
    table: ArchiveTable,
    columns: Statement.Fragment,
    project: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, E, R>,
    filter?: Statement.Statement<SqlConnection.Row>,
  ): (sql: SqlClient.SqlClient) => Stream.Stream<ReadonlyArray<A>, E | SqlError.SqlError, R>;
  <Row extends { readonly id: string }, A, E, R>(
    sql: SqlClient.SqlClient,
    workspaceId: WorkspaceId,
    table: ArchiveTable,
    columns: Statement.Fragment,
    project: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, E, R>,
    filter?: Statement.Statement<SqlConnection.Row>,
  ): Stream.Stream<ReadonlyArray<A>, E | SqlError.SqlError, R>;
} = Fn.dual(
  // An explicit filter gives the data-last call the same arity as a data-first call without one.
  (args) => Predicate.isFunction(args[0]),
  <Row extends { readonly id: string }, A, E, R>(
    sql: SqlClient.SqlClient,
    workspaceId: WorkspaceId,
    table: ArchiveTable,
    columns: Statement.Fragment,
    project: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, E, R>,
    filter = sql`true`,
  ) => {
    const source = sql`from ${sql(table)} where workspace_id = ${workspaceId} and (${filter})`;
    return Stream.unwrap(
      Effect.map(
        sql<{ readonly id: string }>`select id ${source} order by id desc limit 1`,
        ([last]) =>
          last === undefined
            ? Stream.empty
            : Stream.paginate<string | null, ReadonlyArray<A>, E | SqlError.SqlError, R>(
                null,
                (after) =>
                  sql
                    .withTransaction(
                      Effect.gen(function* () {
                        const cursor = after === null ? sql`` : sql`and id > ${after}::uuid`;
                        const rows = yield* sql<Row>`
                    select ${columns} ${source} and id <= ${last.id}::uuid ${cursor}
                    order by id limit ${ARCHIVE_PAGE_SIZE}
                  `;
                        const end = rows.at(-1);
                        if (end === undefined) return [[], Option.none()] as const;
                        const projected = yield* project(rows);
                        // Report filters can discard the entire page. Advance by the selected IDs.
                        const next =
                          rows.length === ARCHIVE_PAGE_SIZE && end.id !== last.id
                            ? Option.some(end.id)
                            : Option.none();
                        return [[projected], next] as const;
                      }),
                    )
                    .pipe(
                      Effect.provideService(
                        SqlClient.BeginTransaction,
                        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
                      ),
                    ),
              ),
      ),
    );
  },
);
