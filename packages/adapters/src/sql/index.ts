/**
 * SQL concurrency primitives over Effect `SqlClient` (core-ports.md section 8): Workspace-scoped
 * row locks, revision checks, counters and insert-only number reservations, gapless number
 * allocation and the request-key log. They run inside the caller's transaction and follow the
 * shape of core's `CoreStore` port (counters.lock/peek/set, reservations.tryReserve,
 * requestLog.claim/complete), so its SQL implementation can delegate to them.
 */
export { NumberingExhausted, NumberTaken, RevisionConflict, RowNotFound } from "./errors";
export {
  type AllocatedNumber,
  type AllocateNumberInput,
  allocateNumber,
  type CounterKey,
  lockCounter,
  type NumberCandidate,
  peekCounter,
  type Reservation,
  reserveNumber,
  type SeriesSnapshot,
  setCounter,
  tryReserveNumber,
} from "./numbering";
export {
  type ClaimOptions,
  type ClaimOutcome,
  claimRequest,
  completeRequest,
  lookupRequest,
  type RequestCompletion,
  type RequestLogEntry,
  type RequestScope,
} from "./request-log";
export { checkRevision, lockRowForUpdate, type Row, updateWithRevision } from "./rows";
export { type DocumentKind, type RevisionedTable, revisionedTableNames } from "./tables";
export { transactionWithRetry } from "./transaction";
