/**
 * Core persistence over Postgres: the SQL `CoreStore`, one SQL layer per `CoreRepos` port and
 * the `UserDirectory` over Better Auth's user table. Everything requires only `SqlClient`;
 * provide `PgDatabaseLive` in production and `PgliteTestDatabase` in tests.
 */
import type { CoreRepos, UserDirectory } from "@kvitbit/core";
import type { CoreStore } from "@kvitbit/core/ports";
import { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { CoreStoreSql } from "./CoreStoreSql";
import { ContactsRepoSql } from "./repos/contacts";
import { DeliveriesRepoSql } from "./repos/deliveries";
import { DocumentsRepoSql } from "./repos/documents";
import { ExpensesRepoSql } from "./repos/expenses";
import { ExportsRepoSql } from "./repos/exports";
import { FxFixingCacheSql } from "./repos/fxcache";
import { NumberingSeriesRepoSql } from "./repos/numbering";
import { PaymentsRepoSql } from "./repos/payments";
import { PriceListRepoSql } from "./repos/pricelist";
import { RecurringRepoSql } from "./repos/recurring";
import { ShareLinksRepoSql } from "./repos/sharelinks";
import { UserDirectorySql } from "./repos/userDirectory";
import { WorkspacesRepoSql } from "./repos/workspaces";

export { CoreStoreSql } from "./CoreStoreSql";
export { PgDatabaseLive, PgliteTestDatabase, PgWorkerDatabaseLive } from "./database";
export {
  ContactsRepoSql,
  DeliveriesRepoSql,
  DocumentsRepoSql,
  ExpensesRepoSql,
  ExportsRepoSql,
  FxFixingCacheSql,
  NumberingSeriesRepoSql,
  PaymentsRepoSql,
  PriceListRepoSql,
  RecurringRepoSql,
  ShareLinksRepoSql,
  UserDirectorySql,
  WorkspacesRepoSql,
};

/** Every `CoreRepos` port over Postgres. */
export const CoreReposSql: Layer.Layer<CoreRepos, never, SqlClient.SqlClient> = Layer.mergeAll(
  WorkspacesRepoSql,
  ContactsRepoSql,
  PriceListRepoSql,
  NumberingSeriesRepoSql,
  DocumentsRepoSql,
  DeliveriesRepoSql,
  PaymentsRepoSql,
  ShareLinksRepoSql,
  ExpensesRepoSql,
  RecurringRepoSql,
  ExportsRepoSql,
  FxFixingCacheSql,
);

/** The SQL `CoreStore`, every repository port and the `UserDirectory`. */
export const PersistenceLive: Layer.Layer<
  CoreStore | CoreRepos | UserDirectory,
  never,
  SqlClient.SqlClient
> = Layer.mergeAll(CoreStoreSql, CoreReposSql, UserDirectorySql);
