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
import { getColumns, getTableName, type Table } from "drizzle-orm";

export type DocumentKind = (typeof documentKindValues)[number];

/**
 * Tables carrying `id`, `revision` and `updated_at`, mapped to the column that scopes them to a
 * Workspace. This map and the Drizzle schema are the whitelist: only these table names, and only
 * their schema's column names, reach SQL as identifiers.
 */
const revisionedTables = {
  workspaces: { table: workspaces, scope: "id" },
  bank_accounts: { table: bankAccounts, scope: "workspace_id" },
  numbering_series: { table: numberingSeries, scope: "workspace_id" },
  invitations: { table: invitations, scope: "workspace_id" },
  contacts: { table: contacts, scope: "workspace_id" },
  price_list_items: { table: priceListItems, scope: "workspace_id" },
  documents: { table: documents, scope: "workspace_id" },
  payments: { table: payments, scope: "workspace_id" },
  expenses: { table: expenses, scope: "workspace_id" },
  templates: { table: templates, scope: "workspace_id" },
} as const satisfies Record<string, { readonly table: Table; readonly scope: string }>;

export type RevisionedTable = keyof typeof revisionedTables;

export const revisionedTableNames = Object.keys(revisionedTables) as ReadonlyArray<RevisionedTable>;

const columnsOf = new Map<string, ReadonlySet<string>>(
  Object.entries(revisionedTables).map(([name, { table }]) => {
    if (getTableName(table) !== name) {
      throw new Error(`sql: whitelist entry ${name} points at ${getTableName(table)}`);
    }
    return [name, new Set(Object.values(getColumns(table)).map((column) => column.name))];
  }),
);

/** Column names of a whitelisted table, from the Drizzle schema. */
export const tableColumns = (table: RevisionedTable): ReadonlySet<string> => {
  const columns = columnsOf.get(table);
  if (columns === undefined) {
    throw new Error(`sql: table ${JSON.stringify(table)} is not a revisioned table`);
  }
  return columns;
};

/**
 * Scope column for a whitelisted table. Throws on anything else, so a name built at runtime from
 * untrusted input never becomes an identifier.
 */
export const scopeColumn = (table: RevisionedTable): string => {
  tableColumns(table);
  return revisionedTables[table].scope;
};

/** Columns a patch may not set: identity, tenancy and the bookkeeping `updateWithRevision` owns. */
const protectedColumns = new Set(["id", "workspace_id", "revision", "created_at", "updated_at"]);

/**
 * Rejects patch keys that are not columns of `table` or are protected, and `undefined` values,
 * which would bind as SQL NULL; pass `null` to clear a column.
 */
export const checkPatchColumns = (
  table: RevisionedTable,
  patch: Readonly<Record<string, unknown>>,
): void => {
  const columns = tableColumns(table);
  for (const [key, value] of Object.entries(patch)) {
    if (!columns.has(key) || protectedColumns.has(key)) {
      throw new Error(`sql: patch column ${JSON.stringify(key)} is not allowed on ${table}`);
    }
    if (value === undefined) {
      throw new Error(`sql: patch column ${JSON.stringify(key)} is undefined; use null`);
    }
  }
};
