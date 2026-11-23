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
 * - test/helpers/ `runTest(caller, effect, fixtures?)` over `InMemoryPortsLive` and a TestClock at
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
export * from "./contract";
export * from "./ports";
export { IdGenerator, IdGeneratorLive, newId } from "./shared/ids";
export { makeRequestOutcome, RequestOutcomeLive } from "./shared/requestOutcome";
