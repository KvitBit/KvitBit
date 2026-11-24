/**
 * In-memory `CoreStore` for tests.
 *
 * - One semaphore serializes top-level transactions, which gives the row locks of
 *   `getForUpdate`/`lock`/`counters.lock` and the waiting of concurrent `requestLog.claim`s.
 * - Each transaction or savepoint is a frame carried in the fiber Context, so child fibers share
 *   it. A frame snapshots the state when it opens and restores it if it fails, dies or is
 *   interrupted. Sibling savepoints of one frame run one at a time.
 * - Every operation checks its frame and performs its reads and writes in one synchronous step,
 *   so concurrent child fibers never interleave between a check and a write.
 * - Defects, matching what SQL would do silently wrong: a write outside a transaction (rule C1),
 *   any use of a frame that has ended (or whose ancestor has), any use of a frame while one of
 *   its savepoints is open (a SQL statement there would be rolled back with the savepoint), and
 *   a transaction that ends while a savepoint it started is still open (that transaction then
 *   rolls back).
 * - The `number_reservations_document_fk` foreign key: `reservations.tryReserve` of a free
 *   number for a document with no row, and removing a document a reservation references, are
 *   defects, as Postgres aborts the transaction.
 * Rows are treated as immutable values; never mutate a row after storing it. Audit entries are
 * stored as JSON, as the SQL table stores them.
 */
import type { AuditEntry, NotFound as NotFoundError, WorkspaceId } from "@kvitbit/domain/contract";
import { Conflict, NotFound } from "@kvitbit/domain/contract";
import { Cause, Context, Effect, Exit, Layer, Option, Semaphore } from "effect";
import type {
  Claim,
  CoreStoreShape,
  CounterKey,
  RequestLogEntry,
  RequestScope,
  Reservation,
} from "./CoreStore";
import { CoreStore, UniqueViolation } from "./CoreStore";
import { runQuery } from "./query";
import type { Collection, CollectionDef, Row, Scalar, UniqueConstraint } from "./tables";
import { MemoryTables } from "./tables";

interface Frame {
  readonly parent: Frame | null;
  open: boolean;
  /** Open savepoints directly under this frame (0 or 1: siblings serialize). */
  children: number;
  readonly savepoints: Semaphore.Semaphore;
  readonly afterCommit: Array<Effect.Effect<void>>;
  /** Counters this frame locked; promoted to the parent when a savepoint commits. */
  readonly lockedCounters: Set<string>;
}

/** A request key claimed by the running transaction but not completed yet. */
interface PendingClaim {
  readonly _tag: "Pending";
}

interface State {
  readonly tables: Map<string, Map<string, Row>>;
  readonly counters: Map<string, number>;
  readonly reservations: Map<string, Reservation>;
  readonly requestLog: Map<string, RequestLogEntry | PendingClaim>;
  /** JSON-encoded entries, append-only. */
  readonly audit: Array<{ readonly workspaceId: WorkspaceId; readonly json: string }>;
}

const emptyState = (): State => ({
  tables: new Map(),
  counters: new Map(),
  reservations: new Map(),
  requestLog: new Map(),
  audit: [],
});

const copyState = (s: State): State => ({
  tables: new Map([...s.tables].map(([name, rows]) => [name, new Map(rows)])),
  counters: new Map(s.counters),
  reservations: new Map(s.reservations),
  requestLog: new Map(s.requestLog),
  audit: [...s.audit],
});

const isPending = (v: RequestLogEntry | PendingClaim | undefined): v is PendingClaim =>
  v !== undefined && "_tag" in v && v._tag === "Pending";

/** The index tuple of `row`, or undefined when the row is outside the index or has a NULL. */
const uniqueKey = <A extends Row>(row: A, constraint: UniqueConstraint<A>): string | undefined => {
  const key = constraint.key(row);
  if (key === null || key.some((v) => v === null)) return undefined;
  return JSON.stringify([constraint.scope === "workspace" ? row.workspaceId : "*", ...key]);
};

const scopeKey = (scope: RequestScope) =>
  scope._tag === "Workspace" ? `w:${scope.workspaceId}` : `u:${scope.userId}`;

/** The documents collection's name (`DocumentsTable` in modules/documents/record.ts). */
const DOCUMENTS_TABLE = "documents";

const defect = (message: string) => Effect.die(new Error(`CoreStore: ${message}`));

/** Whether this frame or an enclosing one holds the counter lock. */
const holdsCounter = (frame: Frame | null, key: string): boolean =>
  frame !== null && (frame.lockedCounters.has(key) || holdsCounter(frame.parent, key));

/** Whether this frame and every ancestor are still open. */
const chainOpen = (frame: Frame | null): boolean =>
  frame === null || (frame.open && chainOpen(frame.parent));

/** Why `frame` cannot run an operation right now, or undefined when it can. */
const frameProblem = (frame: Frame): string | undefined =>
  !chainOpen(frame)
    ? "used after its transaction ended"
    : frame.children > 0
      ? "used from a transaction while one of its savepoints is open"
      : undefined;

let instances = 0;

export interface MemoryStore {
  readonly store: CoreStoreShape;
  readonly tables: MemoryTables["Service"];
}

export const makeMemoryStore: Effect.Effect<MemoryStore> = Effect.sync(() => {
  let state = emptyState();
  const lock = Semaphore.makeUnsafe(1);
  const CurrentFrame = Context.Reference<Frame | null>(
    `kvitbit/core/MemoryStore/frame/${++instances}`,
    { defaultValue: () => null },
  );

  /**
   * Opens a frame under `parent`, runs `effect` in it and closes it. Setup and the closing
   * bookkeeping are uninterruptible, so an interruption can never skip the rollback.
   */
  const runFrame = <A, E, R>(
    parent: Frame | null,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<{ readonly value: A; readonly frame: Frame }, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const problem = parent === null ? undefined : frameProblem(parent);
        if (problem !== undefined) return defect(problem);
        const frame: Frame = {
          parent,
          open: true,
          children: 0,
          savepoints: Semaphore.makeUnsafe(1),
          afterCommit: [],
          lockedCounters: new Set(),
        };
        if (parent !== null) parent.children += 1;
        const snapshot = copyState(state);
        return Effect.flatMap(
          Effect.exit(restore(Effect.provideService(effect, CurrentFrame, frame))),
          (bodyExit) => {
            let exit: Exit.Exit<A, E> = bodyExit;
            if (Exit.isSuccess(exit) && frame.children > 0) {
              exit = Exit.die(
                new Error("CoreStore: transaction ended while one of its savepoints is open"),
              );
            }
            const parentAlive = chainOpen(parent);
            frame.open = false;
            if (parent !== null) parent.children -= 1;
            if (!parentAlive) {
              // The enclosing transaction already ended (and rolled back): touch nothing.
              return Exit.isSuccess(exit)
                ? defect("savepoint outlived its transaction")
                : Effect.failCause(exit.cause);
            }
            if (Exit.isFailure(exit)) {
              state = snapshot;
              return Effect.failCause(exit.cause);
            }
            if (parent !== null) {
              parent.afterCommit.push(...frame.afterCommit);
              for (const k of frame.lockedCounters) parent.lockedCounters.add(k);
            } else {
              // A claim that was never completed is not committed.
              for (const [k, v] of state.requestLog) if (isPending(v)) state.requestLog.delete(k);
            }
            return Effect.succeed({ value: exit.value, frame });
          },
        );
      }),
    );

  const drainAfterCommit = (frame: Frame) =>
    Effect.uninterruptible(
      Effect.forEach(
        frame.afterCommit,
        (hook) =>
          Effect.flatMap(Effect.exit(hook), (exit) =>
            Exit.isFailure(exit)
              ? Effect.logError("CoreStore.afterCommit failed", Cause.pretty(exit.cause))
              : Effect.void,
          ),
        { discard: true },
      ),
    );

  const transaction: CoreStoreShape["transaction"] = (effect) =>
    Effect.flatMap(CurrentFrame, (parent) =>
      parent === null
        ? Effect.flatMap(lock.withPermits(1)(runFrame(null, effect)), ({ value, frame }) =>
            Effect.as(drainAfterCommit(frame), value),
          )
        : Effect.map(
            parent.savepoints.withPermits(1)(runFrame(parent, effect)),
            ({ value }) => value,
          ),
    );

  /**
   * Reads outside a transaction wait for the running one, so they never see its writes. `f`
   * runs synchronously and returns an already-decided Effect.
   */
  const read = <A, E>(f: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.flatMap(CurrentFrame, (frame) =>
      frame === null
        ? lock.withPermits(1)(Effect.suspend(f))
        : Effect.suspend(() => {
            const problem = frameProblem(frame);
            return problem === undefined ? f() : defect(problem);
          }),
    );

  /** A write: needs a usable frame; `f` checks and writes in one synchronous step. */
  const write = <A, E>(
    operation: string,
    f: (frame: Frame) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(CurrentFrame, (frame) =>
      frame === null
        ? defect(`${operation} outside a transaction (rule C1)`)
        : Effect.suspend(() => {
            const problem = frameProblem(frame);
            return problem === undefined ? f(frame) : defect(problem);
          }),
    );

  const table = (name: string): Map<string, Row> => {
    let rows = state.tables.get(name);
    if (rows === undefined) {
      rows = new Map();
      state.tables.set(name, rows);
    }
    return rows;
  };

  const collection = <A extends Row>(def: CollectionDef<A>): Collection<A> => {
    const rows = () => table(def.name) as Map<string, A>;
    const notFound = (id: string): NotFoundError => new NotFound({ entity: def.entity, id });
    const lookup = (workspaceId: WorkspaceId, id: string): A | undefined => {
      const row = rows().get(id);
      return row !== undefined && row.workspaceId === workspaceId ? row : undefined;
    };
    /** The stored row at `expectedRevision` (when given), or the error to fail with. */
    const locate = (
      workspaceId: WorkspaceId,
      id: string,
      expectedRevision: number | undefined,
    ): A | NotFoundError | Conflict => {
      const row = lookup(workspaceId, id);
      if (row === undefined) return notFound(id);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) {
        return new Conflict({ reason: "revision_changed", currentRevision: row.revision });
      }
      return row;
    };
    const isError = (v: unknown): v is NotFoundError | Conflict =>
      v instanceof NotFound || v instanceof Conflict;
    const violation = (row: A): UniqueViolation | undefined => {
      for (const constraint of def.unique ?? []) {
        const key = uniqueKey(row, constraint);
        if (key === undefined) continue;
        for (const other of rows().values()) {
          if (other.id !== row.id && uniqueKey(other, constraint) === key) {
            return new UniqueViolation({ collection: def.name, constraint: constraint.name });
          }
        }
      }
      return undefined;
    };
    const fetch = (workspaceId: WorkspaceId, id: string): Effect.Effect<A, NotFoundError> => {
      const row = lookup(workspaceId, id);
      return row === undefined ? Effect.fail(notFound(id)) : Effect.succeed(row);
    };

    return {
      get: (workspaceId, id) => read(() => fetch(workspaceId, id)),
      find: (workspaceId, id) =>
        read(() => Effect.succeed(Option.fromUndefinedOr(lookup(workspaceId, id)))),
      getForUpdate: (workspaceId, id, expectedRevision) =>
        write("getForUpdate", (): Effect.Effect<A, NotFoundError | Conflict> => {
          const found = locate(workspaceId, id, expectedRevision);
          return isError(found) ? Effect.fail(found) : Effect.succeed(found);
        }),
      lock: (workspaceId, id) => write("lock", () => fetch(workspaceId, id)),
      insert: (row) =>
        write("insert", (): Effect.Effect<A, UniqueViolation> => {
          if (rows().has(row.id)) {
            return Effect.fail(
              new UniqueViolation({ collection: def.name, constraint: "primary" }),
            );
          }
          const stored: A = { ...row, revision: 1 };
          const broken = violation(stored);
          if (broken !== undefined) return Effect.fail(broken);
          rows().set(row.id, stored);
          return Effect.succeed(stored);
        }),
      update: (next, expectedRevision) =>
        write("update", (): Effect.Effect<A, NotFoundError | Conflict | UniqueViolation> => {
          const found = locate(next.workspaceId, next.id, expectedRevision);
          if (isError(found)) return Effect.fail(found);
          const stored: A = { ...next, revision: expectedRevision + 1 };
          const broken = violation(stored);
          if (broken !== undefined) return Effect.fail(broken);
          rows().set(next.id, stored);
          return Effect.succeed(stored);
        }),
      remove: (workspaceId, id, expectedRevision) =>
        write("remove", (): Effect.Effect<void, NotFoundError | Conflict> => {
          const found = locate(workspaceId, id, expectedRevision);
          if (isError(found)) return Effect.fail(found);
          // `number_reservations_document_fk` (no ON DELETE): a reserved number keeps its row.
          if (
            def.name === DOCUMENTS_TABLE &&
            [...state.reservations.values()].some(
              (r) => r.workspaceId === workspaceId && r.documentId === id,
            )
          ) {
            return defect(`number_reservations_document_fk: document ${id} has a reserved number`);
          }
          rows().delete(id);
          return Effect.void;
        }),
      list: (workspaceId, query) =>
        read(() =>
          Effect.succeed(
            runQuery(
              [...rows().values()].filter((r) => r.workspaceId === workspaceId),
              query,
            ),
          ),
        ),
      listGlobal: (query) => read(() => Effect.succeed(runQuery(rows().values(), query))),
      findUnique: (name, key, workspaceId) =>
        read(() => {
          const constraint = def.unique?.find((c) => c.name === name);
          if (constraint === undefined) return defect(`${def.name} has no unique "${name}"`);
          if (constraint.scope === "workspace" && workspaceId === undefined) {
            return defect(`${def.name}.${name} needs a workspaceId`);
          }
          const wanted = JSON.stringify([
            constraint.scope === "workspace" ? workspaceId : "*",
            ...(key as ReadonlyArray<Scalar>),
          ]);
          for (const row of rows().values()) {
            if (uniqueKey(row, constraint) === wanted) return Effect.succeed(Option.some(row));
          }
          return Effect.succeed(Option.none());
        }),
    };
  };

  const counterKey = (key: CounterKey) =>
    JSON.stringify([key.workspaceId, key.seriesId, key.period]);
  const logKey = (scope: RequestScope, key: string) => JSON.stringify([scopeKey(scope), key]);

  const store: CoreStoreShape = {
    transaction,
    afterCommit: (hook) =>
      write("afterCommit", (frame) => {
        frame.afterCommit.push(hook);
        return Effect.void;
      }),
    counters: {
      lock: (key) =>
        write("counters.lock", (frame) => {
          const k = counterKey(key);
          frame.lockedCounters.add(k);
          const next = state.counters.get(k);
          if (next !== undefined) return Effect.succeed(next);
          state.counters.set(k, 1);
          return Effect.succeed(1);
        }),
      peek: (key) => read(() => Effect.succeed(state.counters.get(counterKey(key)) ?? 1)),
      set: (key, next) =>
        write("counters.set", (frame) => {
          const k = counterKey(key);
          const current = state.counters.get(k);
          if (current === undefined || !holdsCounter(frame, k)) {
            return defect(`counters.set without counters.lock in this transaction (${k})`);
          }
          if (!Number.isInteger(next) || next < current) {
            return defect(`counter ${k} must grow (${current} -> ${next})`);
          }
          state.counters.set(k, next);
          return Effect.void;
        }),
    },
    reservations: {
      tryReserve: (reservation) =>
        write("reservations.tryReserve", () => {
          const k = JSON.stringify([reservation.workspaceId, reservation.kind, reservation.number]);
          if (state.reservations.has(k)) return Effect.succeed(false);
          // `number_reservations_document_fk` (not deferrable): a free key for a document whose
          // row does not exist yet fails the statement, and Postgres aborts the transaction. A
          // taken key inserts nothing, so no foreign key is checked.
          const document = table(DOCUMENTS_TABLE).get(reservation.documentId);
          if (document === undefined || document.workspaceId !== reservation.workspaceId) {
            return defect(
              `number_reservations_document_fk: ${reservation.number} reserved for document ${reservation.documentId}, which has no row`,
            );
          }
          state.reservations.set(k, reservation);
          return Effect.succeed(true);
        }),
    },
    requestLog: {
      claim: (scope, key, now) =>
        write("requestLog.claim", (frame): Effect.Effect<Claim> => {
          if (frame.parent !== null) {
            return defect(
              "requestLog.claim inside a savepoint; claim in the outermost transaction",
            );
          }
          const k = logKey(scope, key);
          const existing = state.requestLog.get(k);
          // Transactions are serialized, so a pending claim can only be this transaction's own.
          if (isPending(existing)) {
            return defect(`request key ${k} claimed twice in one transaction`);
          }
          if (existing !== undefined && existing.expiresAt > now) {
            return Effect.succeed({ _tag: "Existing", entry: existing });
          }
          state.requestLog.set(k, { _tag: "Pending" });
          return Effect.succeed({ _tag: "Claimed" });
        }),
      complete: (entry) =>
        write("requestLog.complete", () => {
          const k = logKey(entry.scope, entry.key);
          if (!isPending(state.requestLog.get(k))) {
            return defect(`requestLog.complete without a claim (${k})`);
          }
          state.requestLog.set(k, entry);
          return Effect.void;
        }),
    },
    audit: {
      append: (workspaceId, entry) =>
        write("audit.append", () => {
          state.audit.push({ workspaceId, json: JSON.stringify(entry) });
          return Effect.void;
        }),
      history: (workspaceId, subject) =>
        read(() =>
          Effect.succeed(
            state.audit
              .filter((a) => a.workspaceId === workspaceId)
              .map((a) => JSON.parse(a.json) as AuditEntry)
              .filter((e) => e.subject.entity === subject.entity && e.subject.id === subject.id)
              .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
          ),
        ),
    },
  };
  return { store, tables: { collection } };
});

/** The in-memory `CoreStore` and the `MemoryTables` that share its transactions. */
export const CoreStoreMemory: Layer.Layer<CoreStore | MemoryTables> = Layer.effectContext(
  Effect.map(makeMemoryStore, ({ store, tables }) =>
    Context.make(CoreStore, store).pipe(Context.add(MemoryTables, tables)),
  ),
);
