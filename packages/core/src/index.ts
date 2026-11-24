/**
 * @kvitbit/core (server only): the nine caller-facing modules over a pure core
 * (docs/design/core-ports.md, ADR-0004). Entry points: `./contract` (browser safe: domain
 * vocabulary + `can`), `./engines` (pure engines), `./ports` (driven ports + `CoreStore`),
 * `./testing` (in-memory ports).
 *
 * Layout and conventions for module streams:
 * - src/policy/   `can` + the table of core-ports 2.3 (`table.ts`), `authorize` /
 *                 `authorizeInWorkspace` (first statement of every method, rule R1a), and
 *                 `checkMembershipChange` (R1c, R3; invite, setRole and leave authorize
 *                 through it, not a preceding `authorize`).
 * - src/store/    `CoreStore` port (transaction + savepoints, afterCommit, counters, reservations,
 *                 request log, audit), `allocateNumber`/`reserveNumber` (S3), the in-memory store
 *                 and `MemoryTables` (tables.ts: row conventions every repository follows).
 * - src/shared/   `withIdempotency` (C3), `checkRevision` (C2), `appendAudit` (C5),
 *                 `orUnavailable` (port failure -> Unavailable), override resolvers
 *                 (`resolveDocumentDefaults`, `resolveReminders`), `IdGenerator`, `RequestOutcome`.
 * - src/engines/  pure engines (VatMath, Numbering, PaymentQr, StatutoryText, Schedules).
 * - src/modules/<name>/ one directory per module: workspaces, contacts, pricelist, numbering,
 *                 documents, expenses, payments, recurring (templates, reminders, deliveries),
 *                 reports. Each owns a repository port (`<Name>Repo`, a Context.Service with named
 *                 operations following src/store/tables.ts) plus its in-memory implementation
 *                 built on `MemoryTables` (exported from ./testing; the SQL implementation comes
 *                 with the adapters), and implements the domain service tag from
 *                 @kvitbit/domain as `<Name>Live`, a Layer requiring CoreStore | IdGenerator |
 *                 its repo | the driven ports it uses. Export it here.
 * - src/internal/ the System caller seal; never exported from an entry point.
 * - src/compose/ the composition (core-ports 10): `bindings.ts` binds each seam port to its owning
 *                 module; `CoreLive` requires only `CoreStore | CoreRepos | CoreExternalPorts`.
 *                 `TestCore` (./testing) is the same composition on memory ports and fakes.
 * - test/helpers/ `runCore(caller, effect, options?)` over `TestCore`, and
 *                 `runTest(caller, effect, fixtures?)` over `InMemoryPortsLive` and a TestClock at
 *                 TEST_NOW; caller builders `member(role, { scopes })`, `account()`,
 *                 `system(job)`, `shareVisitor()`, `invitationHolder()`.
 *
 * Method shape: authorize (R1a) -> withIdempotency (C3, outermost) or transaction ->
 * repo.getForUpdate(ws, id, expectedRevision) | repo.lock (C2/C6, before any state rule) ->
 * domain rules -> repo.update(next, expectedRevision) / insert -> appendAudit (C5) ->
 * afterCommit(start workflow) -> orUnavailable. Rows are scoped by the
 * caller's Workspace; another Workspace's record is NotFound (R2). No Drizzle, SQL, HTTP or
 * filesystem imports anywhere in this package.
 */

// Seam layers for a partial composition: the one-line bindings plus the four compose adapters
// CoreModulesLive wires (bank-account references, document activity, reports source, share
// workspaces), so an app can rebuild any slice of CoreLive from the root entry.
export { BankAccountReferencesLive } from "./compose/bankAccounts";
export * from "./compose/bindings";
// Composition (core-ports 10) --------------------------------------------------------------
export type {
  CoreExternalPorts,
  CoreLiveRequires,
  CoreRepos,
  CoreRequirements,
  CoreServices,
} from "./compose/CoreLive";
export { CoreLive, CoreModulesLive } from "./compose/CoreLive";
export { DocumentActivityLive } from "./compose/documentActivity";
export { ReportsSourceLive } from "./compose/reportsSource";
export { ShareWorkspacesLive } from "./compose/shareWorkspaces";
export * from "./contract";
// Each module's full surface (row types, tables, job steps, pure helpers), namespaced -------
export * as ContactsModule from "./modules/contacts";
// Module layers, flat ---------------------------------------------------------------------
// Ports the adapters and apps/server implement, flat --------------------------------------
export { ContactSnapshotsLive, ContactsLive, ContactsRepo } from "./modules/contacts";
export * as DocumentsModule from "./modules/documents";
export {
  DeliveriesRepo,
  DeliveryJobs,
  DocumentDeliveryReadsLive,
  DocumentPaymentsLive,
  DocumentRenderer,
  DocumentSenderLive,
  DocumentsLive,
  DocumentsRepo,
} from "./modules/documents";
export * as ExpensesModule from "./modules/expenses";
export {
  ExpensePayablesLive,
  ExpenseRecordsLive,
  ExpensesLive,
  ExpensesRepo,
} from "./modules/expenses";
export * as NumberingModule from "./modules/numbering";
export { NumberingSeriesLive, NumberingSeriesRepo } from "./modules/numbering";
export * as PaymentsModule from "./modules/payments";
export { PaymentDocumentsLive, PaymentsLive, PaymentsRepo } from "./modules/payments";
export * as PriceListModule from "./modules/pricelist";
export { PriceListItemsLive, PriceListLive, PriceListRepo } from "./modules/pricelist";
export * as RecurringModule from "./modules/recurring";
export { RecurringIssuanceLive, RecurringRepo, TemplatesLive } from "./modules/recurring";
export * as ReportsModule from "./modules/reports";
export {
  ExportJobsLive,
  ExportsRepo,
  ExportWorkflow,
  FxFixingCache,
  ReportPdfRenderer,
  ReportsLive,
} from "./modules/reports";
export * as ShareLinksModule from "./modules/sharelinks";
export {
  PublicShareLinksLive,
  ShareLinkKeys,
  ShareLinksRepo,
  ShareVisitorDevice,
} from "./modules/sharelinks";
export * as WorkspacesModule from "./modules/workspaces";
export {
  BrandingPreview,
  InvitationDelivery,
  InvitationTokens,
  IssuerSnapshotsLive,
  UserDirectory,
  WorkspaceSnapshotsLive,
  WorkspacesLive,
  WorkspacesRepo,
} from "./modules/workspaces";
export * from "./ports";
export { IdGenerator, IdGeneratorLive, newId } from "./shared/ids";
export { makeRequestOutcome, RequestOutcomeLive } from "./shared/requestOutcome";
