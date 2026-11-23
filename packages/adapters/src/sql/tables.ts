import type { documentKindValues } from "@kvitbit/db/schema";

export type DocumentKind = (typeof documentKindValues)[number];

/**
 * Tables carrying `id`, `revision` and `updated_at`, mapped to the column that scopes them to a
 * Workspace. The map is the whitelist: only these names reach SQL as identifiers.
 */
const revisionedTables = {
  workspaces: "id",
  bank_accounts: "workspace_id",
  numbering_series: "workspace_id",
  invitations: "workspace_id",
  contacts: "workspace_id",
  price_list_items: "workspace_id",
  documents: "workspace_id",
  payments: "workspace_id",
  expenses: "workspace_id",
  templates: "workspace_id",
} as const;

export type RevisionedTable = keyof typeof revisionedTables;

export const revisionedTableNames = Object.keys(revisionedTables) as ReadonlyArray<RevisionedTable>;

/**
 * Scope column for a whitelisted table. Throws on anything else, so a name built at runtime from
 * untrusted input never becomes an identifier.
 */
export const scopeColumn = (table: RevisionedTable): string => {
  if (!Object.hasOwn(revisionedTables, table)) {
    throw new Error(`sql: table ${JSON.stringify(table)} is not a revisioned table`);
  }
  return revisionedTables[table];
};

/** Columns a patch may not set: identity, tenancy and the bookkeeping `updateWithRevision` owns. */
const protectedColumns = new Set(["id", "workspace_id", "revision", "created_at", "updated_at"]);

const columnName = /^[a-z][a-z0-9_]*$/;

/**
 * Rejects patch keys that are not plain snake_case column names or are protected, and
 * `undefined` values, which would bind as SQL NULL; pass `null` to clear a column.
 */
export const checkPatchColumns = (patch: Readonly<Record<string, unknown>>): void => {
  for (const [key, value] of Object.entries(patch)) {
    if (!columnName.test(key) || protectedColumns.has(key)) {
      throw new Error(`sql: patch column ${JSON.stringify(key)} is not allowed`);
    }
    if (value === undefined) {
      throw new Error(`sql: patch column ${JSON.stringify(key)} is undefined; use null`);
    }
  }
};
