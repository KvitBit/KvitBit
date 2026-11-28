import { Database } from "bun:sqlite";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

export const feedbackLabel = "visual-feedback";
export const claimedLabel = "visual-feedback:claimed";

interface Issue {
  number: number;
  claimed: boolean;
}

export interface IssueTracker {
  readonly list: Effect.Effect<ReadonlyArray<Issue>, PoolError>;
  isAvailable(number: number): Effect.Effect<boolean, PoolError>;
  readonly ensureClaimLabel: Effect.Effect<void, PoolError>;
  claim(number: number): Effect.Effect<void, PoolError>;
}

export interface WorkerRunner {
  find(number: number): Effect.Effect<string | null, PoolError>;
  start(number: number): Effect.Effect<string, PoolError>;
}

interface Assignment {
  number: number;
  phase: "claiming" | "starting" | "assigned";
  threadId: string | null;
}

export class IssuePool {
  private readonly db: Database;
  private readonly repoId: number;

  constructor(path: string, repoId: number, readonly = false) {
    this.repoId = repoId;
    this.db = new Database(path, { readonly, create: !readonly, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (!readonly) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS assignment (
          repo_id INTEGER NOT NULL,
          issue INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('claiming', 'starting', 'assigned')),
          thread_id TEXT,
          CHECK ((phase = 'assigned') = (thread_id IS NOT NULL)),
          PRIMARY KEY (repo_id, issue)
        ) STRICT;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  assignment(issue: number): Assignment | null {
    return this.db
      .query<Assignment, [number, number]>(
        "SELECT issue AS number, phase, thread_id AS threadId FROM assignment WHERE repo_id = ? AND issue = ?",
      )
      .get(this.repoId, issue);
  }

  pendingAssignments(): Assignment[] {
    return this.db
      .query<Assignment, [number]>(`
        SELECT issue AS number, phase, thread_id AS threadId FROM assignment
        WHERE repo_id = ? AND phase != 'assigned' ORDER BY issue
      `)
      .all(this.repoId);
  }

  reserveAssignment(issue: number): boolean {
    return (
      this.db
        .query(`
          INSERT INTO assignment (repo_id, issue, phase) VALUES (?, ?, 'claiming')
          ON CONFLICT DO NOTHING
        `)
        .run(this.repoId, issue).changes === 1
    );
  }

  reserveStart(issue: number): boolean {
    return (
      this.db
        .query(
          "UPDATE assignment SET phase = 'starting' WHERE repo_id = ? AND issue = ? AND phase = 'claiming'",
        )
        .run(this.repoId, issue).changes === 1
    );
  }

  hasWorkerBinding(issue: number, threadId: string): boolean {
    const bindings = this.db
      .query<{ repoId: number; issue: number }, [string]>(
        "SELECT repo_id AS repoId, issue FROM assignment WHERE thread_id = ?",
      )
      .all(threadId);
    const [binding] = bindings;
    if (!(binding !== undefined)) return false;
    if (bindings.length !== 1 || binding.repoId !== this.repoId || binding.issue !== issue) {
      throw PoolError.make({
        message: `T3 worker for issue ${issue} has a conflicting saved assignment`,
      });
    }
    return true;
  }

  recordThread(issue: number, threadId: string): void {
    this.db
      .transaction(() => {
        this.hasWorkerBinding(issue, threadId);
        this.db
          .query(`
          INSERT INTO assignment (repo_id, issue, phase, thread_id) VALUES (?, ?, 'assigned', ?)
          ON CONFLICT (repo_id, issue) DO UPDATE SET phase = 'assigned', thread_id = excluded.thread_id
          WHERE assignment.phase != 'assigned'
        `)
          .run(this.repoId, issue, threadId);
        if (this.assignment(issue)?.threadId !== threadId) {
          throw PoolError.make({ message: `Issue ${issue} has a different saved T3 worker` });
        }
      })
      .immediate();
  }
}

interface PassResult {
  plannedAssignments: number[];
  started: number[];
  adopted: number[];
  failures: { issue: number; operation: "assignment"; reason: string }[];
}

function failureReason(cause: unknown): string {
  return Schema.is(PoolError)(cause) ? cause.message : "Unexpected response or local state error";
}

export class PoolError extends Schema.TaggedError<PoolError, { readonly brand: unique symbol }>()(
  "PoolError",
  { message: Schema.String },
) {}

interface PassOptions {
  apply: boolean;
  maxWorkers: number;
  pool: IssuePool;
  runner: WorkerRunner;
  tracker: IssueTracker;
  fetchMain(): Effect.Effect<void, PoolError>;
}

export const runIssuePool = Effect.fn("IssuePool.runPass")(function* ({
  apply,
  maxWorkers,
  pool,
  runner,
  tracker,
  fetchMain,
}: PassOptions) {
  const result: PassResult = {
    plannedAssignments: [],
    started: [],
    adopted: [],
    failures: [],
  };
  const fetched = yield* Effect.cached(fetchMain());
  let attempts = 0;
  const listed = yield* tracker.list;
  const issues = new Map(Arr.map(listed, (issue) => [issue.number, issue] as const));
  const numbers = new Set([
    ...Arr.map(pool.pendingAssignments(), ({ number }) => number),
    ...Arr.sort(issues.keys(), Order.Number),
  ]);
  const processIssue = Effect.fn("IssuePool.processIssue")(function* (number: number) {
    const issue = issues.get(number);
    const assignment = pool.assignment(number);
    if (
      assignment?.threadId !== undefined &&
      assignment?.threadId !== null &&
      assignment?.threadId !== ""
    ) {
      pool.hasWorkerBinding(number, assignment.threadId);
      return;
    }
    const threadId = yield* runner.find(number);
    if (threadId !== null && threadId !== "") {
      if (apply) {
        pool.recordThread(number, threadId);
        result.adopted.push(number);
      }
      return;
    }
    if (assignment?.phase === "starting") {
      // A failed acknowledgment can follow an accepted start. Only adopt an
      // existing worker in this case, even if nobody can find it yet.
      return yield* PoolError.make({ message: "T3 has not confirmed the reserved worker" });
    }
    if (!(issue !== undefined) || issue.claimed) {
      if (assignment !== null)
        return yield* PoolError.make({ message: "GitHub has not confirmed the reserved claim" });
      return;
    }
    if (attempts >= maxWorkers) return;
    if (!(yield* tracker.isAvailable(number))) {
      if (assignment !== null)
        return yield* PoolError.make({ message: "GitHub has not confirmed the reserved claim" });
      return;
    }

    result.plannedAssignments.push(number);
    if (!apply) {
      attempts += 1;
      return;
    }

    yield* fetched;
    yield* tracker.ensureClaimLabel;
    if (!(yield* tracker.isAvailable(number))) {
      if (assignment !== null)
        return yield* PoolError.make({ message: "GitHub has not confirmed the reserved claim" });
      return;
    }
    if (!(assignment !== null || pool.reserveAssignment(number))) return;
    // Retrying an unconfirmed, still-unlabeled claim can add the same label
    // again. Only the claimant that wins the next transition can start T3.
    yield* tracker.claim(number);
    if (!pool.reserveStart(number)) return;
    attempts += 1;
    const started = yield* runner.start(number);
    pool.recordThread(number, started);
    result.started.push(number);
  });
  for (const number of numbers) {
    yield* processIssue(number).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          result.failures.push({
            issue: number,
            operation: "assignment",
            reason: failureReason(error),
          });
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          result.failures.push({
            issue: number,
            operation: "assignment",
            reason: failureReason(defect),
          });
        }),
      ),
    );
  }
  return result;
});
