import { Database } from "bun:sqlite";

export const feedbackLabel = "visual-feedback";
export const claimedLabel = "visual-feedback:claimed";
export const humanNeeded = "<!-- kvitbit-agent:human-needed -->";

export interface Issue {
  number: number;
  claimed: boolean;
}

export interface Reply {
  questionId: number;
  commentId: number;
  body: string;
}

export interface IssueTracker {
  list(): Promise<readonly Issue[]>;
  isAvailable(number: number): Promise<boolean>;
  ensureClaimLabel(): Promise<void>;
  claim(number: number): Promise<void>;
  replies(number: number): Promise<readonly Reply[]>;
}

export interface WorkerRunner {
  find(number: number): Promise<string | null>;
  start(number: number): Promise<string>;
  sendReply(threadId: string, reply: Reply): Promise<void>;
  receivedReply(threadId: string, commentId: number): Promise<boolean>;
}

interface Assignment {
  number: number;
  phase: "claiming" | "starting" | "assigned";
  threadId: string | null;
}

interface ReplyReservation {
  issue: number;
  threadId: string;
  questionId: number;
  commentId: number;
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
        CREATE TABLE IF NOT EXISTS worker_reply (
          repo_id INTEGER NOT NULL,
          comment_id INTEGER NOT NULL,
          issue INTEGER NOT NULL,
          question_id INTEGER NOT NULL,
          thread_id TEXT NOT NULL,
          accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
          PRIMARY KEY (repo_id, comment_id)
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

  recordThread(issue: number, threadId: string): void {
    this.db
      .query(`
        INSERT INTO assignment (repo_id, issue, phase, thread_id) VALUES (?, ?, 'assigned', ?)
        ON CONFLICT (repo_id, issue) DO UPDATE SET phase = 'assigned', thread_id = excluded.thread_id
        WHERE assignment.phase != 'assigned'
      `)
      .run(this.repoId, issue, threadId);
  }

  replyAccepted(commentId: number): boolean {
    return (
      this.db
        .query<{ accepted: number }, [number, number]>(
          "SELECT accepted FROM worker_reply WHERE repo_id = ? AND comment_id = ?",
        )
        .get(this.repoId, commentId)?.accepted === 1
    );
  }

  pendingReplies(): ReplyReservation[] {
    return this.db
      .query<ReplyReservation, [number]>(`
        SELECT issue, thread_id AS threadId, question_id AS questionId, comment_id AS commentId
        FROM worker_reply WHERE repo_id = ? AND accepted = 0 ORDER BY comment_id
      `)
      .all(this.repoId);
  }

  reserveReply({ commentId, issue, questionId, threadId }: ReplyReservation): boolean {
    return (
      this.db
        .query(`
          INSERT INTO worker_reply (repo_id, comment_id, issue, question_id, thread_id)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
        `)
        .run(this.repoId, commentId, issue, questionId, threadId).changes === 1
    );
  }

  acceptReply({ commentId, issue, questionId, threadId }: ReplyReservation): void {
    this.db
      .query(`
        INSERT INTO worker_reply (repo_id, comment_id, issue, question_id, thread_id, accepted)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT (repo_id, comment_id) DO UPDATE SET accepted = 1
        WHERE worker_reply.thread_id = excluded.thread_id
      `)
      .run(this.repoId, commentId, issue, questionId, threadId);
  }
}

interface PassResult {
  plannedAssignments: number[];
  started: number[];
  adopted: number[];
  plannedReplies: number[];
  replied: number[];
  recoveredReplies: number[];
  failures: { issue: number; operation: "assignment" | "reply"; reason: string }[];
}

function failureReason(error: unknown): string {
  return error instanceof PoolError ? error.message : "Unexpected response or local state error";
}

export class PoolError extends Error {}

async function recoverReplies(
  { apply, pool, runner }: PassOptions,
  result: PassResult,
): Promise<Set<number>> {
  const issues = new Set<number>();
  for (const reservation of pool.pendingReplies()) {
    const { commentId, issue, threadId } = reservation;
    issues.add(issue);
    try {
      if (!(await runner.receivedReply(threadId, commentId))) {
        throw new PoolError(`T3 has not confirmed delivery of GitHub comment ${commentId}`);
      }
      if (apply) {
        pool.acceptReply(reservation);
        result.recoveredReplies.push(commentId);
      }
    } catch (error) {
      result.failures.push({ issue, operation: "reply", reason: failureReason(error) });
    }
  }
  return issues;
}

async function relayReplies(
  number: number,
  threadId: string,
  { apply, pool, runner, tracker }: PassOptions,
  result: PassResult,
): Promise<void> {
  try {
    // Relay one answer per issue per pass so the worker can ask a follow-up.
    const reply = (await tracker.replies(number)).find(
      ({ commentId }) => !pool.replyAccepted(commentId),
    );
    if (!reply) return;
    const { commentId, questionId } = reply;
    const reservation = { issue: number, threadId, questionId, commentId };
    result.plannedReplies.push(commentId);
    if (!apply) return;

    if (await runner.receivedReply(threadId, commentId)) {
      pool.acceptReply(reservation);
      result.recoveredReplies.push(commentId);
    } else if (pool.reserveReply(reservation)) {
      await runner.sendReply(threadId, reply);
      pool.acceptReply(reservation);
      result.replied.push(commentId);
    } else if (!pool.replyAccepted(commentId)) {
      throw new PoolError(`T3 has not confirmed delivery of GitHub comment ${commentId}`);
    }
  } catch (error) {
    result.failures.push({ issue: number, operation: "reply", reason: failureReason(error) });
  }
}

interface PassOptions {
  apply: boolean;
  maxWorkers: number;
  pool: IssuePool;
  runner: WorkerRunner;
  tracker: IssueTracker;
  fetchMain(): Promise<void>;
}

export async function runIssuePool(options: PassOptions): Promise<PassResult> {
  const { apply, maxWorkers, pool, runner, tracker, fetchMain } = options;
  const result: PassResult = {
    plannedAssignments: [],
    started: [],
    adopted: [],
    plannedReplies: [],
    replied: [],
    recoveredReplies: [],
    failures: [],
  };
  let fetched: Promise<void> | undefined;
  let attempts = 0;
  const pendingReplyIssues = await recoverReplies(options, result);
  const issues = new Map((await tracker.list()).map((issue) => [issue.number, issue]));
  const numbers = new Set([
    ...pool.pendingAssignments().map(({ number }) => number),
    ...[...issues.keys()].sort((left, right) => left - right),
  ]);
  for (const number of numbers) {
    try {
      const issue = issues.get(number);
      const assignment = pool.assignment(number);
      const threadId = assignment?.threadId ?? (await runner.find(number));
      if (threadId) {
        if (apply && !assignment?.threadId) {
          pool.recordThread(number, threadId);
          result.adopted.push(number);
        }
        if (issue && !pendingReplyIssues.has(number)) {
          await relayReplies(number, threadId, options, result);
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
