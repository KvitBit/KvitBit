/**
 * SQL concurrency primitives over Effect `SqlClient` (core-ports.md section 8): Workspace-scoped
 * row locks, revision checks, gapless number allocation, insert-only number reservations and the
 * request-key log. They run inside the caller's transaction; a later SQL implementation of core's
 * store port builds on them.
 */
export {
  NumberingExhausted,
  NumberTaken,
  RequestKeyReused,
  RevisionConflict,
  RowNotFound,
} from "./errors";
export {
  type AllocatedNumber,
  type AllocateNumberInput,
  allocateNumber,
  type NumberCandidate,
  type ReserveNumberInput,
  reserveNumber,
} from "./numbering";
export {
  type ClaimOutcome,
  claimRequest,
  lookupRequest,
  type RequestClaim,
  type RequestFingerprint,
  type RequestScope,
} from "./request-log";
export { checkRevision, lockRowForUpdate, type Row, updateWithRevision } from "./rows";
export { type DocumentKind, type RevisionedTable, revisionedTableNames } from "./tables";
export { transactionWithRetry } from "./transaction";
