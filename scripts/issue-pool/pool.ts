import { Database } from "bun:sqlite";

export const feedbackLabel = "visual-feedback";
export const claimedLabel = "visual-feedback:claimed";

export interface Issue {
  number: number;
  claimed: boolean;
}

export interface IssueTracker {
  list(): Promise<readonly Issue[]>;
  isAvailable(number: number): Promise<boolean>;
  ensureClaimLabel(): Promise<void>;
  claim(number: number): Promise<void>;
}

export interface WorkerRunner {
  find(number: number): Promise<string | null>;
  start(number: number): Promise<string>;
}

interface Assignment {
  number: number;
  phase: "claiming" | "starting" | "assigned";
  threadId: string | null;
}

export class IssuePool {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly repoId: number,
    readonly = false,
  ) {
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
    if (!binding) return false;
    if (bindings.length !== 1 || binding.repoId !== this.repoId || binding.issue !== issue) {
      throw new PoolError(`T3 worker for issue ${issue} has a conflicting saved assignment`);
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
          throw new PoolError(`Issue ${issue} has a different saved T3 worker`);
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

function failureReason(error: unknown): string {
  return error instanceof PoolError ? error.message : "Unexpected response or local state error";
}

export class PoolError extends Error {}

interface PassOptions {
  apply: boolean;
  maxWorkers: number;
  pool: IssuePool;
  runner: WorkerRunner;
  tracker: IssueTracker;
  fetchMain(): Promise<void>;
}

export async function runIssuePool({
  apply,
  maxWorkers,
  pool,
  runner,
  tracker,
  fetchMain,
}: PassOptions): Promise<PassResult> {
  const result: PassResult = {
    plannedAssignments: [],
    started: [],
    adopted: [],
    failures: [],
  };
  let fetched: Promise<void> | undefined;
  let attempts = 0;
  const issues = new Map((await tracker.list()).map((issue) => [issue.number, issue]));
  const numbers = new Set([
    ...pool.pendingAssignments().map(({ number }) => number),
    ...[...issues.keys()].sort((left, right) => left - right),
  ]);
  for (const number of numbers) {
    try {
      const issue = issues.get(number);
      const assignment = pool.assignment(number);
      if (assignment?.threadId) {
        pool.hasWorkerBinding(number, assignment.threadId);
        continue;
      }
      const threadId = await runner.find(number);
      if (threadId) {
        if (apply) {
          pool.recordThread(number, threadId);
          result.adopted.push(number);
        }
        continue;
      }
      if (assignment?.phase === "starting") {
        // A failed acknowledgment can follow an accepted start. Only adopt an
        // existing worker in this case, even if nobody can find it yet.
        throw new PoolError("T3 has not confirmed the reserved worker");
      }
      if (!issue || issue.claimed) {
        if (assignment) throw new PoolError("GitHub has not confirmed the reserved claim");
        continue;
      }
      if (attempts >= maxWorkers) continue;
      if (!(await tracker.isAvailable(number))) {
        if (assignment) throw new PoolError("GitHub has not confirmed the reserved claim");
        continue;
      }

      result.plannedAssignments.push(number);
      if (!apply) {
        attempts += 1;
        continue;
      }

      fetched ??= fetchMain();
      await fetched;
      await tracker.ensureClaimLabel();
      if (!(await tracker.isAvailable(number))) {
        if (assignment) throw new PoolError("GitHub has not confirmed the reserved claim");
        continue;
      }
      if (!assignment && !pool.reserveAssignment(number)) continue;
      // Retrying an unconfirmed, still-unlabeled claim can add the same label
      // again. Only the claimant that wins the next transition can start T3.
      await tracker.claim(number);
      if (!pool.reserveStart(number)) continue;
      attempts += 1;
      pool.recordThread(number, await runner.start(number));
      result.started.push(number);
    } catch (error) {
      result.failures.push({
        issue: number,
        operation: "assignment",
        reason: failureReason(error),
      });
    }
  }
  return result;
}
