import type { WorkspaceId } from "@kvitbit/domain/contract";
import { Context, Effect, Option, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";

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

export const withReportArchivePage = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  page: ReportArchivePage,
) => Effect.provideService(effect, CurrentReportArchivePage, page);

export const selectReportRows = <A, E>(
  sql: SqlClient.SqlClient,
  table: ReportTable,
  filter: Fragment,
  select: (where: Fragment) => Effect.Effect<ReadonlyArray<A>, E>,
) =>
  Effect.flatMap(CurrentReportArchivePage, (page) =>
    select(page?.table === table ? sql`${filter} and id = any(${page.ids}::uuid[])` : filter),
  );

/** Bound the scan at its first pull and release the transaction before emitting a page. */
export const archivePages = <Row extends { readonly id: string }, A, E, R>(
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  table: ArchiveTable,
  columns: Fragment,
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
          : Stream.paginate<string | null, ReadonlyArray<A>, E | SqlError, R>(null, (after) =>
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
};
