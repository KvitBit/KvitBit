/**
 * In-memory `CoreStore` for tests.
 *
 * - One semaphore serializes top-level transactions, which gives the row locks of
 *   `getForUpdate`/`lock`/`counters.lock` and the waiting of concurrent `requestLog.claim`s.
 * - Each transaction or savepoint is a frame carried in the fiber Context, so child fibers share
 *   it. A frame snapshots the state when it opens and restores it if it fails, dies or is
 *   interrupted. Sibling savepoints of one frame run one at a time.
 * - Defects, matching what SQL would do silently wrong: a write outside a transaction (rule C1),
 *   any use of a frame that has ended, and any use of a frame while one of its savepoints is
 *   open (a SQL statement there would be rolled back with the savepoint).
 * Rows are treated as immutable values; never mutate a row after storing it.
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
  readonly audit: Array<{ readonly workspaceId: WorkspaceId; readonly entry: AuditEntry }>;
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

const defect = (message: string) => Effect.die(new Error(`CoreStore: ${message}`));

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

  const runFrame = <A, E, R>(parent: Frame | null, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const frame: Frame = {
        parent,
        open: true,
        children: 0,
        savepoints: Semaphore.makeUnsafe(1),
        afterCommit: [],
      };
      if (parent !== null) parent.children += 1;
      const snapshot = copyState(state);
      return effect.pipe(
        Effect.provideService(CurrentFrame, frame),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            frame.open = false;
            if (parent !== null) parent.children -= 1;
            if (Exit.isFailure(exit)) {
              state = snapshot;
            } else if (parent !== null) {
              parent.afterCommit.push(...frame.afterCommit);
            } else {
              // A claim that was never completed is not committed.
              for (const [k, v] of state.requestLog) if (isPending(v)) state.requestLog.delete(k);
            }
          }),
        ),
        Effect.map((value) => ({ value, frame })),
      );
    });

  const unusable = (frame: Frame) =>
    !frame.open
      ? defect("used after its transaction ended")
      : frame.children > 0
        ? defect("used from a transaction while one of its savepoints is open")
        : undefined;

  const transaction: CoreStoreShape["transaction"] = (effect) =>
    Effect.flatMap(CurrentFrame, (parent) => {
      if (parent === null) {
        return lock
          .withPermits(1)(runFrame(null, effect))
          .pipe(
            Effect.tap(({ frame }) =>
              Effect.forEach(
                frame.afterCommit,
                (hook) =>
                  Effect.exit(hook).pipe(
                    Effect.flatMap((exit) =>
                      Exit.isFailure(exit)
                        ? Effect.logError("CoreStore.afterCommit failed", Cause.pretty(exit.cause))
                        : Effect.void,
                    ),
                  ),
                { discard: true },
              ),
            ),
            Effect.map(({ value }) => value),
          );
      }
      return parent.savepoints
        .withPermits(1)(Effect.suspend(() => unusable(parent) ?? runFrame(parent, effect)))
        .pipe(Effect.map(({ value }) => value));
    });

  /** Reads outside a transaction wait for the running one, so they never see its writes. */
  const read = <A, E>(f: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.flatMap(CurrentFrame, (frame) =>
      frame === null
        ? lock.withPermits(1)(Effect.suspend(f))
        : (unusable(frame) ?? Effect.suspend(f)),
    );

  const write = <A, E>(
    operation: string,
    f: (frame: Frame) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(CurrentFrame, (frame) =>
      frame === null
        ? defect(`${operation} outside a transaction (rule C1)`)
        : (unusable(frame) ?? Effect.suspend(() => f(frame))),
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
    const stale = (currentRevision: number) =>
      Effect.fail(new Conflict({ reason: "revision_changed", currentRevision }));
    const locked = (
      workspaceId: WorkspaceId,
      id: string,
      expectedRevision: number | undefined,
    ): Effect.Effect<A, NotFoundError | Conflict> => {
      const row = lookup(workspaceId, id);
      if (row === undefined) return Effect.fail(notFound(id));
      if (expectedRevision !== undefined && row.revision !== expectedRevision) {
        return stale(row.revision);
      }
      return Effect.succeed(row);
    };
    const checkUnique = (row: A): Effect.Effect<void, UniqueViolation> => {
      for (const constraint of def.unique ?? []) {
        const key = uniqueKey(row, constraint);
        if (key === undefined) continue;
        for (const other of rows().values()) {
          if (other.id !== row.id && uniqueKey(other, constraint) === key) {
            return Effect.fail(
              new UniqueViolation({ collection: def.name, constraint: constraint.name }),
            );
          }
        }
      }
      return Effect.void;
    };

    return {
      get: (workspaceId, id) =>
        read(() => locked(workspaceId, id, undefined) as Effect.Effect<A, NotFoundError>),
      find: (workspaceId, id) =>
        read(() => Effect.succeed(Option.fromUndefinedOr(lookup(workspaceId, id)))),
      getForUpdate: (workspaceId, id, expectedRevision) =>
        write("getForUpdate", () => locked(workspaceId, id, expectedRevision)),
      lock: (workspaceId, id) =>
        write("lock", () => locked(workspaceId, id, undefined) as Effect.Effect<A, NotFoundError>),
      insert: (row) =>
        write("insert", () => {
          if (rows().has(row.id)) {
            return Effect.fail(
              new UniqueViolation({ collection: def.name, constraint: "primary" }),
            );
          }
          const stored: A = { ...row, revision: 1 };
          return Effect.as(
            Effect.tap(checkUnique(stored), () => Effect.sync(() => rows().set(row.id, stored))),
            stored,
          );
        }),
      update: (next, expectedRevision) =>
        write("update", () =>
          Effect.gen(function* () {
            yield* locked(next.workspaceId, next.id, expectedRevision);
            const stored: A = { ...next, revision: expectedRevision + 1 };
            yield* checkUnique(stored);
            rows().set(next.id, stored);
            return stored;
          }),
        ),
      remove: (workspaceId, id, expectedRevision) =>
        write("remove", () =>
          Effect.map(locked(workspaceId, id, expectedRevision), () => {
            rows().delete(id);
          }),
        ),
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
      Effect.flatMap(CurrentFrame, (frame) =>
        frame === null
          ? defect("afterCommit outside a transaction")
          : (unusable(frame) ??
            Effect.sync(() => {
              frame.afterCommit.push(hook);
            })),
      ),
    counters: {
      lock: (key) =>
        write("counters.lock", () =>
          Effect.sync(() => {
            const k = counterKey(key);
            const next = state.counters.get(k);
            if (next !== undefined) return next;
            state.counters.set(k, 1);
            return 1;
          }),
        ),
      peek: (key) => read(() => Effect.succeed(state.counters.get(counterKey(key)) ?? 1)),
      set: (key, next) =>
        write("counters.set", () => {
          const k = counterKey(key);
          const current = state.counters.get(k);
          if (current === undefined) return defect(`counters.set before counters.lock (${k})`);
          if (!Number.isInteger(next) || next < current) {
            return defect(`counter ${k} must grow (${current} -> ${next})`);
          }
          return Effect.sync(() => {
            state.counters.set(k, next);
          });
        }),
    },
    reservations: {
      tryReserve: (reservation) =>
        write("reservations.tryReserve", () =>
          Effect.sync(() => {
            const k = JSON.stringify([
              reservation.workspaceId,
              reservation.kind,
              reservation.number,
            ]);
            if (state.reservations.has(k)) return false;
            state.reservations.set(k, reservation);
            return true;
          }),
        ),
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
          if (isPending(existing))
            return defect(`request key ${k} claimed twice in one transaction`);
          if (existing !== undefined && existing.expiresAt > now) {
            return Effect.succeed({ _tag: "Existing" as const, entry: existing });
          }
          return Effect.sync(() => {
            state.requestLog.set(k, { _tag: "Pending" });
            return { _tag: "Claimed" as const };
          });
        }),
      complete: (entry) =>
        write("requestLog.complete", () => {
          const k = logKey(entry.scope, entry.key);
          if (!isPending(state.requestLog.get(k))) {
            return defect(`requestLog.complete without a claim (${k})`);
          }
          return Effect.sync(() => {
            state.requestLog.set(k, entry);
          });
        }),
    },
    audit: {
      append: (workspaceId, entry) =>
        write("audit.append", () =>
          Effect.sync(() => {
            state.audit.push({ workspaceId, entry });
          }),
        ),
      history: (workspaceId, subject) =>
        read(() =>
          Effect.succeed(
            state.audit
              .filter(
                (a) =>
                  a.workspaceId === workspaceId &&
                  a.entry.subject.entity === subject.entity &&
                  a.entry.subject.id === subject.id,
              )
              .map((a) => a.entry)
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
