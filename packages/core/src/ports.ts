/**
 * `@kvitbit/core/ports` (server only): the driven ports (core-ports 6), the request-scoped
 * `RequestOutcome`, and the core's own persistence port `CoreStore`, which a SQL adapter
 * implements.
 */
export * from "@kvitbit/domain/ports";
export type {
  Claim,
  CoreStoreShape,
  CounterKey,
  RequestLogEntry,
  RequestScope,
  Reservation,
} from "./store/CoreStore";
export { CoreStore, StoreUnavailable, UniqueViolation } from "./store/CoreStore";
