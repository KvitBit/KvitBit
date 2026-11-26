import type { ExpenseId, ExpenseInput, WorkspaceSummary } from "@kvitbit/domain/contract";
import {
  idempotencyHeaders,
  isAutoRetryable,
  isRetryable,
  retryAfterSeconds,
  UiError,
  uuidV7,
} from "@kvitbit/ui-port/api";
import { Effect } from "effect";
import type { CaptureStorage } from "../../platform/capture/capture-storage-port";
import type { LocalFile, SavedFile, TransferResult, UploadRequest } from "../../platform/transfer";
import { requestKeyReplayWindowOpen } from "../../runtime/request-intent";
import { canWriteWorkspace } from "../dashboard/model";
import { InvalidReceipt, readReceipt } from "./receipt-file";

export function mayCapture(principalId: string | null, workspace: WorkspaceSummary) {
  return principalId !== null && canWriteWorkspace(workspace);
}

export interface CaptureScope {
  readonly principalId: string;
  readonly workspaceId: WorkspaceSummary["id"];
  readonly workspaceSlug: WorkspaceSummary["slug"];
}

export interface CaptureAccess {
  readonly scope: CaptureScope;
  readonly canWrite: () => boolean;
  readonly verifyWrite?: () => Promise<boolean>;
}

type CaptureFailure =
  | {
      readonly kind: "retry";
      readonly error: UiError;
      readonly attempt: number;
      readonly nextAt: number;
    }
  | { readonly kind: "needsSignIn" | "blocked"; readonly error: UiError }
  | { readonly kind: "expired" };

interface CaptureFile {
  readonly key: string;
  readonly file: LocalFile;
  readonly sources: readonly string[];
  readonly result?:
    | { readonly kind: "uploaded" }
    | { readonly kind: "rejected"; readonly error: UiError };
}

export interface CaptureFields {
  readonly supplierName: string;
  readonly total: string;
  readonly currency: string;
  readonly note: string;
}

export interface RejectedReceipt {
  readonly key: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly error: UiError;
}

export interface CaptureQueueSummary {
  readonly pendingCount: number;
  readonly blockedCount: number;
  readonly hasBlocked: boolean;
}

export interface CaptureJob {
  readonly key: string;
  readonly scope: CaptureScope;
  readonly targetExpenseId: ExpenseId | null;
  readonly expenseId: ExpenseId | null;
  readonly recordAttemptAt?: number;
  readonly files: readonly CaptureFile[];
  readonly submission?: {
    readonly fields: CaptureFields;
    readonly payload: ExpenseInput;
    readonly failure?: CaptureFailure;
  };
  readonly done?: true;
}

export interface CaptureNetwork {
  readonly isOnline?: () => Promise<boolean>;
  readonly record: (
    scope: CaptureScope,
    key: string,
    input: ExpenseInput,
  ) => Promise<TransferResult<ExpenseId>>;
  readonly upload: (request: UploadRequest) => Promise<TransferResult<unknown>>;
}

interface QueueOptions {
  readonly storage: CaptureStorage;
  readonly saveBytes: (
    key: string,
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
  ) => Promise<string>;
  readonly removeBytes: (ref: string) => Promise<void>;
  readonly read?: typeof readReceipt;
  readonly key?: () => Promise<string>;
  readonly now?: () => number;
}

type CaptureSource = SavedFile & { readonly source?: string };
type CaptureIssue = InvalidReceipt["issue"] | "unreadable";
type JobChanges = (scope: CaptureScope) => void;

const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;
const scopeKey = (scope: CaptureScope) => JSON.stringify([scope.principalId, scope.workspaceId]);
const rejectedScopeKey = (scope: CaptureScope, expenseId: ExpenseId) =>
  JSON.stringify(["rejected", scope.principalId, scope.workspaceId, expenseId]);

export function capturePayload(fields: CaptureFields): ExpenseInput {
  const total = fields.total.trim().replace(/\s+/g, "").replace(",", ".");
  const supplier = fields.supplierName.trim();
  const note = fields.note.trim();
  return {
    status: "incomplete",
    currency: fields.currency.trim().toUpperCase() || "CZK",
    ...(supplier === "" ? {} : { supplier: { manual: { name: supplier } } }),
    ...(/^\d+(?:\.\d+)?$/.test(total) ? { total } : {}),
    ...(note === "" ? {} : { note }),
  };
}

export function makeCaptureQueue({
  storage,
  saveBytes,
  removeBytes,
  read = readReceipt,
  key = () => Effect.runPromise(uuidV7),
  now = Date.now,
}: QueueOptions) {
  const pending = new Map<string, Promise<unknown>>();
  const listeners = new Set<JobChanges>();

  async function load(scope: CaptureScope): Promise<readonly CaptureJob[]> {
    const stored = await storage.load(scopeKey(scope));
    return stored === null
      ? []
      : (JSON.parse(stored) as CaptureJob[]).filter(
          (job) => scopeKey(job.scope) === scopeKey(scope),
        );
  }

  async function save(
    scope: CaptureScope,
    jobs: readonly CaptureJob[],
    previous: readonly CaptureJob[],
  ) {
    await storage.save(scopeKey(scope), JSON.stringify(jobs), JSON.stringify(previous));
    for (const listener of listeners) listener(scope);
  }

  function locked<T>(access: CaptureAccess, work: () => Promise<T>): Promise<T> {
    // Serialize all jobs for a Workspace even when a previous principal's call is in flight.
    const lockKey = access.scope.workspaceId;
    const previous = pending.get(lockKey);
    const result = Promise.resolve(previous)
      .catch(() => undefined)
      .then(() => storage.lock(lockKey, work));
    pending.set(lockKey, result);
    const clear = () => {
      if (pending.get(lockKey) === result) pending.delete(lockKey);
    };
    void result.then(clear, clear);
    return result;
  }

  async function loadRejected(
    scope: CaptureScope,
    expenseId: ExpenseId,
  ): Promise<readonly RejectedReceipt[]> {
    const stored = await storage.load(rejectedScopeKey(scope, expenseId));
    return stored === null ? [] : (JSON.parse(stored) as RejectedReceipt[]);
  }

  async function saveRejected(
    scope: CaptureScope,
    expenseId: ExpenseId,
    items: readonly RejectedReceipt[],
    previous: readonly RejectedReceipt[],
  ) {
    await storage.save(
      rejectedScopeKey(scope, expenseId),
      JSON.stringify(items),
      JSON.stringify(previous),
    );
    for (const listener of listeners) listener(scope);
  }

  async function persistRejected(scope: CaptureScope, job: CaptureJob) {
    if (job.expenseId === null) return;
    const rejected: RejectedReceipt[] = [];
    for (const receipt of job.files) {
      if (receipt.result?.kind === "rejected") {
        rejected.push({
          key: receipt.key,
          name: receipt.file.name,
          contentType: receipt.file.contentType,
          size: receipt.file.size,
          error: receipt.result.error,
        });
      }
    }
    if (rejected.length === 0) return;
    const existing = await loadRejected(scope, job.expenseId);
    const existingKeys = new Set(existing.map((entry) => entry.key));
    const merged = [...existing, ...rejected.filter((entry) => !existingKeys.has(entry.key))];
    if (merged.length !== existing.length) {
      await saveRejected(scope, job.expenseId, merged, existing);
    }
  }

  async function canWriteNow(access: CaptureAccess): Promise<boolean> {
    if (!access.canWrite()) return false;
    if (access.verifyWrite !== undefined) return access.verifyWrite();
    return true;
  }

  async function dropFinished(scope: CaptureScope, jobs: readonly CaptureJob[], job: CaptureJob) {
    // Persist rejected filenames and issues before removing the job so reopening the expense shows them.
    await persistRejected(scope, job);
    // Keep the completed job until its local files have been released, so a restart can finish cleanup.
    await Promise.all(job.files.map((receipt) => removeBytes(receipt.file.ref)));
    const remaining = jobs.filter((other) => other.key !== job.key);
    await save(scope, remaining, jobs);
    return remaining;
  }

  async function replay(
    access: CaptureAccess,
    network: CaptureNetwork,
    all: readonly CaptureJob[],
    initial: CaptureJob,
    options: {
      readonly onProgress?: (key: string, progress: number) => void;
      readonly reconnect?: boolean;
    } = {},
  ) {
    let jobs = all;
    let job = initial;
    const submission = job.submission;
    const { scope } = access;
    if (submission === undefined || !access.canWrite()) return { jobs, job };
    const { fields, payload } = submission;

    async function update(changes: Partial<CaptureJob>) {
      const updated = { ...job, ...changes };
      const next = jobs.map((entry) => (entry.key === updated.key ? updated : entry));
      await save(scope, next, jobs);
      jobs = next;
      job = updated;
    }

    async function fail(error: UiError) {
      const prior = options.reconnect ? undefined : job.submission?.failure;
      const attempt = prior?.kind === "retry" ? prior.attempt + 1 : 0;
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
      const failure: CaptureFailure = isAutoRetryable(error)
        ? {
            kind: "retry",
            error,
            attempt,
            nextAt: now() + Math.max(delay, (retryAfterSeconds(error) ?? 0) * 1000),
          }
        : { kind: error._tag === "Unauthorized" ? "needsSignIn" : "blocked", error };
      await update({ submission: { fields, payload, failure } });
    }

    let expenseId = job.expenseId;
    if (expenseId === null) {
      const firstAttempt = job.recordAttemptAt;
      if (firstAttempt !== undefined && !requestKeyReplayWindowOpen(firstAttempt, now())) {
        await update({ submission: { fields, payload, failure: { kind: "expired" } } });
        return { jobs, job };
      }
      if (network.isOnline !== undefined && !(await network.isOnline())) {
        await fail(UiError.offline);
        return { jobs, job };
      }
      if (!(await canWriteNow(access))) return { jobs, job };
      if (firstAttempt === undefined) await update({ recordAttemptAt: now() });
      if (!(await canWriteNow(access))) return { jobs, job };
      const result = await network.record(job.scope, job.key, payload);
      if (result._tag === "Err") {
        if (!(await canWriteNow(access))) return { jobs, job };
        await fail(result.error);
        return { jobs, job };
      }
      expenseId = result.value;
      await update({ expenseId, submission: { fields, payload } });
    }

    for (const receipt of job.files) {
      if (receipt.result !== undefined) continue;
      if (!(await canWriteNow(access))) return { jobs, job };
      const actual = await read(receipt.file).catch(() => null);
      if (actual?.file.sha256 !== receipt.file.sha256 || actual.file.size !== receipt.file.size) {
        await fail(UiError.unexpected());
        return { jobs, job };
      }
      if (!(await canWriteNow(access))) return { jobs, job };
      options.onProgress?.(receipt.key, 0);
      const result = await network.upload({
        path: `/workspaces/${job.scope.workspaceId}/expenses/${expenseId}/attachments`,
        headers: idempotencyHeaders(receipt.key),
        file: receipt.file,
        onProgress: (progress) => options.onProgress?.(receipt.key, progress),
      });
      if (
        result._tag === "Err" &&
        result.error._tag !== "PayloadTooLarge" &&
        !(
          result.error._tag === "Invalid" &&
          result.error.issues.every((issue) => issue.code.startsWith("attachment."))
        )
      ) {
        if (!(await canWriteNow(access))) return { jobs, job };
        await fail(result.error);
        return { jobs, job };
      }
      const fileResult: NonNullable<CaptureFile["result"]> =
        result._tag === "Ok" ? { kind: "uploaded" } : { kind: "rejected", error: result.error };
      await update({
        files: job.files.map((entry) =>
          entry.key === receipt.key ? { ...entry, result: fileResult } : entry,
        ),
        submission: { fields, payload },
      });
    }

    await update({ done: true });
    jobs = await dropFinished(scope, jobs, job);
    return { jobs, job };
  }

  return {
    load,
    loadRejected,
    dismissRejected(access: CaptureAccess, expenseId: ExpenseId, fileKey: string) {
      return locked(access, async () => {
        if (!(await canWriteNow(access))) return;
        const existing = await loadRejected(access.scope, expenseId);
        const remaining = existing.filter((entry) => entry.key !== fileKey);
        if (remaining.length !== existing.length) {
          await saveRejected(access.scope, expenseId, remaining, existing);
        }
      });
    },
    clearRejected(access: CaptureAccess, expenseId: ExpenseId) {
      return locked(access, async () => {
        if (!(await canWriteNow(access))) return;
        const existing = await loadRejected(access.scope, expenseId);
        if (existing.length > 0) {
          await saveRejected(access.scope, expenseId, [], existing);
        }
      });
    },
    subscribe(listener: JobChanges) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stage(access: CaptureAccess, target: ExpenseId | null, sources: readonly CaptureSource[]) {
      return locked(access, async () => {
        const { scope } = access;
        const issues: CaptureIssue[] = [];
        const acknowledge: string[] = [];
        if (!access.canWrite()) return { job: undefined, issues, acknowledge };
        const jobs = await load(scope);
        const draft = jobs.find(
          (job) => job.targetExpenseId === target && job.submission === undefined,
        );
        const files = [...(draft?.files ?? [])];
        for (const source of sources) {
          if (!access.canWrite()) break;
          if (
            source.source !== undefined &&
            jobs.some((job) =>
              job.files.some((entry) => entry.sources.includes(source.source ?? "")),
            )
          ) {
            acknowledge.push(source.source);
            continue;
          }
          try {
            const captured = await read(source);
            const duplicate = files.findIndex(
              (entry) => entry.file.sha256 === captured.file.sha256,
            );
            if (duplicate === -1) {
              const fileKey = await key();
              const ref = await saveBytes(fileKey, source.name, captured.bytes);
              files.push({
                key: fileKey,
                file: { ...captured.file, ref },
                sources: source.source === undefined ? [] : [source.source],
              });
            } else if (source.source !== undefined) {
              const entry = files[duplicate];
              if (entry !== undefined)
                files[duplicate] = { ...entry, sources: [...entry.sources, source.source] };
            }
            if (source.source !== undefined) acknowledge.push(source.source);
          } catch (error) {
            issues.push(error instanceof InvalidReceipt ? error.issue : "unreadable");
            if (error instanceof InvalidReceipt && source.source !== undefined)
              acknowledge.push(source.source);
          }
        }
        if (files.length === 0) return { job: draft, issues, acknowledge };
        const job: CaptureJob = {
          key: draft?.key ?? (await key()),
          scope: draft?.scope ?? scope,
          targetExpenseId: target,
          expenseId: target,
          files,
        };
        await save(
          scope,
          draft === undefined
            ? [...jobs, job]
            : jobs.map((entry) => (entry === draft ? job : entry)),
          jobs,
        );
        return { job, issues, acknowledge };
      });
    },
    remove(access: CaptureAccess, jobKey: string, fileKey: string) {
      return locked(access, async () => {
        if (!access.canWrite()) return;
        const jobs = await load(access.scope);
        const job = jobs.find((entry) => entry.key === jobKey);
        if (job === undefined || job.submission !== undefined) return;
        const receipt = job.files.find((entry) => entry.key === fileKey);
        if (receipt === undefined) return;
        const files = job.files.filter((entry) => entry.key !== fileKey);
        await save(
          access.scope,
          jobs.flatMap((entry) =>
            entry !== job ? [entry] : files.length === 0 ? [] : [{ ...job, files }],
          ),
          jobs,
        );
        await removeBytes(receipt.file.ref);
      });
    },
    discard(access: CaptureAccess, jobKey: string) {
      return locked(access, async () => {
        if (!access.canWrite()) return;
        const jobs = await load(access.scope);
        const job = jobs.find((entry) => entry.key === jobKey);
        const failure = job?.submission?.failure;
        if (job === undefined || (failure?.kind !== "blocked" && failure?.kind !== "expired"))
          return;
        const done = { ...job, done: true as const };
        const updated = jobs.map((entry) => (entry === job ? done : entry));
        await save(access.scope, updated, jobs);
        await dropFinished(access.scope, updated, done);
      });
    },
    submit(
      access: CaptureAccess,
      network: CaptureNetwork,
      jobKey: string,
      fields: CaptureFields,
      onProgress: (key: string, progress: number) => void,
    ) {
      return locked(access, async () => {
        if (!access.canWrite()) return undefined;
        let jobs = await load(access.scope);
        let job = jobs.find((entry) => entry.key === jobKey);
        if (
          job === undefined ||
          job.files.length === 0 ||
          job.done === true ||
          !canRetryCapture(job)
        )
          return job;
        if (job.submission === undefined) {
          const submitted = { ...job, submission: { fields, payload: capturePayload(fields) } };
          const next = jobs.map((entry) => (entry.key === submitted.key ? submitted : entry));
          await save(access.scope, next, jobs);
          jobs = next;
          job = submitted;
        }
        return (await replay(access, network, jobs, job, { onProgress })).job;
      });
    },
    drain(
      access: CaptureAccess,
      network: CaptureNetwork,
      options: { readonly reconnect?: boolean; readonly signedIn?: boolean } = {},
    ) {
      return locked(access, async () => {
        const completed: CaptureJob[] = [];
        let nextAt: number | undefined;
        if (!access.canWrite()) return { completed, nextAt };
        let jobs = await load(access.scope);
        for (let job of jobs) {
          if (!access.canWrite()) break;
          if (job.done === true) {
            jobs = await dropFinished(access.scope, jobs, job);
            continue;
          }
          if (job.submission === undefined) continue;
          const failure = job.submission.failure;
          if (
            failure?.kind === "blocked" ||
            failure?.kind === "expired" ||
            (failure?.kind === "needsSignIn" && !options.signedIn)
          )
            continue;
          if (failure?.kind !== "retry" || options.reconnect || failure.nextAt <= now()) {
            const replayed = await replay(access, network, jobs, job, options);
            jobs = replayed.jobs;
            job = replayed.job;
            if (job.done === true) completed.push(job);
          }
          const retry = job.submission?.failure;
          if (retry?.kind === "retry") nextAt = Math.min(nextAt ?? retry.nextAt, retry.nextAt);
        }
        return { completed, nextAt };
      });
    },
  };
}

export function canRetryCapture(job: CaptureJob) {
  const failure = job.submission?.failure;
  if (failure?.kind === "expired") return false;
  const error = failure?.error;
  return (
    error === undefined ||
    (isRetryable(error) && error._tag !== "Conflict") ||
    error._tag === "Unauthorized"
  );
}

export function isCaptureJobBlocked(job: CaptureJob, canWrite: boolean): boolean {
  if (job.done === true) return false;
  const failure = job.submission?.failure;
  if (failure?.kind === "blocked" || failure?.kind === "expired") return true;
  if (job.submission !== undefined && !canWrite) return true;
  return false;
}

export function summarizeCaptureJobs(
  entries: readonly { readonly jobs: readonly CaptureJob[]; readonly canWrite: boolean }[],
): CaptureQueueSummary {
  let pendingCount = 0;
  let blockedCount = 0;
  for (const entry of entries) {
    for (const job of entry.jobs) {
      if (job.done === true) continue;
      pendingCount += 1;
      if (isCaptureJobBlocked(job, entry.canWrite)) blockedCount += 1;
    }
  }
  return { pendingCount, blockedCount, hasBlocked: blockedCount > 0 };
}
