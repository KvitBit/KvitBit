import {
  bankAccounts,
  contacts,
  type documentKindValues,
  documents,
  expenses,
  invitations,
  numberingSeries,
  payments,
  priceListItems,
  templates,
  workspaces,
} from "@kvitbit/db/schema";
import { type Column, getColumns, getTableName, type Table } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type * as SqlClient from "effect/sql/SqlClient";

export type DocumentKind = (typeof documentKindValues)[number];

/**
 * Tables carrying `id`, `revision` and `updated_at`, mapped to the column that scopes them to a
 * Workspace. This map and the Drizzle schema are the whitelist: only these table names, and only
 * their schema's column names, reach SQL as identifiers.
 */
const revisionedTables = [
  { table: workspaces, scope: "id" },
  { table: bankAccounts, scope: "workspace_id" },
  { table: numberingSeries, scope: "workspace_id" },
  { table: invitations, scope: "workspace_id" },
  { table: contacts, scope: "workspace_id" },
  { table: priceListItems, scope: "workspace_id" },
  { table: documents, scope: "workspace_id" },
  { table: payments, scope: "workspace_id" },
  { table: expenses, scope: "workspace_id" },
  { table: templates, scope: "workspace_id" },
] as const satisfies ReadonlyArray<{ readonly table: Table; readonly scope: string }>;

export type RevisionedTable = (typeof revisionedTables)[number]["table"]["_"]["name"];

export const revisionedTableNames: ReadonlyArray<RevisionedTable> = Arr.map(
  revisionedTables,
  ({ table }) => getTableName(table),
);

const tablesByName = new Map(
  Arr.map(
    revisionedTables,
    ({ table, scope }) =>
      [
        getTableName(table),
        {
          scope,
          columns: new Set(
            Arr.map(Record.values<string, Column>(getColumns(table)), (column) => column.name),
          ),
        },
      ] as const,
  ),
);

/** Validate table names at runtime before using them as SQL identifiers. */
const tableDefinition = (table: RevisionedTable) => {
  const definition = tablesByName.get(table);
  return definition === undefined
    ? Effect.die(new Error(`sql: table "${table}" is not a revisioned table`))
    : Effect.succeed(definition);
};

export const scopeColumn = (table: RevisionedTable) =>
  tableDefinition(table).pipe(Effect.map(({ scope }) => scope));

export type SqlPatch = Readonly<Parameters<SqlClient.SqlClient["update"]>[0]>;

/** Columns a patch may not set: identity, tenancy and the bookkeeping `updateWithRevision` owns. */
const protectedColumns = new Set(["id", "workspace_id", "revision", "created_at", "updated_at"]);

/**
 * Rejects patch keys that are not columns of `table` or are protected, and `undefined` values,
 * which would bind as SQL NULL; pass `null` to clear a column.
 */
export const scopeColumnForPatch = Effect.fn("Sql.scopeColumnForPatch")(function* (
  table: RevisionedTable,
  patch: SqlPatch,
) {
  const { columns, scope } = yield* tableDefinition(table);
  for (const [key, value] of Record.toEntries(patch)) {
    if (!columns.has(key) || protectedColumns.has(key)) {
      return yield* Effect.die(new Error(`sql: patch column "${key}" is not allowed on ${table}`));
    }
    if (value === undefined) {
      return yield* Effect.die(new Error(`sql: patch column "${key}" is undefined; use null`));
    }
  }
  return scope;
});
