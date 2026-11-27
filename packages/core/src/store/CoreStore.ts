/**
 * The core's persistence port. ADR-0004 (S1) has modules use `SqlClient` directly; Phase 2 keeps
 * the core pure, so the core owns this port instead: an in-memory implementation backs the tests
 * (`@kvitbit/core/testing`) and a SQL implementation (SELECT ... FOR UPDATE at READ COMMITTED,
 * rules S2-S5) implements the same interface later.
 *
 * Transaction boundary: an Effect wrapper (`transaction(effect)`), not a unit-of-work object.
 * Every write runs inside one (rule C1). Nested calls are savepoints. Deadlock and serialization
 * retries (S4) belong to the outermost transaction only.
 *
 * Aggregate rows are not here: each module declares its own repository port with named
 * operations that follow the conventions in `./tables.ts` (lock with expectedRevision, CAS update,
 * Workspace-scoped NotFound, UniqueViolation). The SQL adapter implements those ports against the
 * normalized tables of packages/db; their in-memory implementations are built on `MemoryTables`
 * (`@kvitbit/core/testing`), which shares this store's transactions.
 */
import type {
  AuditEntry,
  DocumentId,
  DocumentKind,
  NumberingSeriesId,
  RequestKey,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Errors ------------------------------------------------------------------------------------

/**
 * The store could not answer (connection, deadlock after retries, serialization failure).
 * Internal; `orUnavailable` turns it into `Unavailable{database}`.
 */
export class StoreUnavailable extends Schema.TaggedError<
  StoreUnavailable,
  { readonly brand: unique symbol }
>()("StoreUnavailable", {
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

/**
 * An insert or update broke a declared unique constraint. Internal; the module maps it to the
 * domain error its method documents (e.g. `Invalid{workspace.slug_taken}`, `Conflict{duplicate}`).
 * `constraint` is the constraint's name, or `"primary"` for a duplicate id. In SQL the
 * transaction is aborted after this error, so a module fails the transaction with it.
 */
export class UniqueViolation extends Schema.TaggedError<
  UniqueViolation,
  { readonly brand: unique symbol }
>()("UniqueViolation", {
  collection: Schema.String,
  constraint: Schema.String,
}) {}

// Numbering (S3) ----------------------------------------------------------------------------

/** One `numbering_counters` row. */
export interface CounterKey {
  readonly workspaceId: WorkspaceId;
  readonly seriesId: NumberingSeriesId;
  /** Period bucket of the series, e.g. `"2026"` or `"2026-11"`; `"all"` for a never-resetting series. */
  readonly period: string;
}

/** One `number_reservations` row; unique on (workspaceId, kind, number). */
export interface Reservation {
  readonly workspaceId: WorkspaceId;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly seriesId: NumberingSeriesId | null;
  readonly documentId: DocumentId;
}

// Request log (C3) --------------------------------------------------------------------------

/** Keys are scoped to the Workspace, or to the user for Account callers. */
export type RequestScope =
  | { readonly _tag: "Workspace"; readonly workspaceId: WorkspaceId }
  | { readonly _tag: "User"; readonly userId: UserId };

export interface RequestLogEntry {
  readonly scope: RequestScope;
  readonly key: RequestKey;
  readonly method: string;
  /** SHA-256 hex of the canonical JSON of [method, encoded payload]. */
  readonly fingerprint: string;
  /** The method's success value as canonical JSON (Schema.toCodecJson). */
  readonly result: unknown;
  readonly createdAt: string;
  /** createdAt + 24 h; an expired entry counts as absent and is taken over atomically. */
  readonly expiresAt: string;
}

export type Claim =
  /** The key is free (or expired); this transaction owns it until it commits or rolls back. */
  | { readonly _tag: "Claimed" }
  /** A committed live entry holds the key. */
  | { readonly _tag: "Existing"; readonly entry: RequestLogEntry };

// The port ----------------------------------------------------------------------------------

export interface CoreStoreShape {
  /**
   * Runs `effect` atomically: any failure, defect or interruption rolls back every write made
   * inside it. Nested calls are savepoints: an inner failure reverts only the inner writes.
   * Child fibers share the transaction; using it after it ended, or from the enclosing
   * transaction while a savepoint is open, is a defect.
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreUnavailable, R>;
  /**
   * Runs `effect` after the outermost transaction commits (e.g. starting a workflow whose intent
   * row the transaction wrote, rule J1); dropped on rollback, including a savepoint's rollback.
   * Its failures are logged, never surfaced. Only inside `transaction`.
   */
  readonly afterCommit: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  readonly counters: {
    /** Upserts the counter at 1 and row-locks it; returns the next sequence to allocate. */
    readonly lock: (key: CounterKey) => Effect.Effect<number, StoreUnavailable>;
    /** The next sequence without locking (settings views); 1 for an unused counter. */
    readonly peek: (key: CounterKey) => Effect.Effect<number, StoreUnavailable>;
    /** Sets the next sequence; it only grows (a lower value is a defect). Needs `lock` first. */
    readonly set: (key: CounterKey, next: number) => Effect.Effect<void, StoreUnavailable>;
  };
  readonly reservations: {
    /**
     * Inserts the reservation unless the number is taken; `false` when taken. Insert-only: a
     * reserved number is never released (rule D4). Never aborts the transaction.
     */
    readonly tryReserve: (reservation: Reservation) => Effect.Effect<boolean, StoreUnavailable>;
  };
  readonly requestLog: {
    /**
     * Claims the key for this transaction, or returns the committed live entry. A concurrent
     * claimer of the same key waits until the owner's transaction ends, then sees its entry
     * (or claims the key if the owner rolled back). Claiming a key this transaction already
     * holds is a defect. Must run in the outermost transaction, before any row lock.
     */
    readonly claim: (
      scope: RequestScope,
      key: RequestKey,
      now: string,
    ) => Effect.Effect<Claim, StoreUnavailable>;
    /** Stores the result for a key this transaction claimed. */
    readonly complete: (entry: RequestLogEntry) => Effect.Effect<void, StoreUnavailable>;
  };
  readonly audit: {
    /** Append-only (rule C5). */
    readonly append: (
      workspaceId: WorkspaceId,
      entry: AuditEntry,
    ) => Effect.Effect<void, StoreUnavailable>;
    /** One subject's entries in time order. */
    readonly history: (
      workspaceId: WorkspaceId,
      subject: AuditEntry["subject"],
    ) => Effect.Effect<ReadonlyArray<AuditEntry>, StoreUnavailable>;
  };
}

export class CoreStore extends Context.Service<CoreStore, CoreStoreShape>()(
  "@kvitbit/core/store/CoreStore",
) {}
