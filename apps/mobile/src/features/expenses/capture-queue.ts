import type { ExpenseId, ExpenseInput, WorkspaceSummary } from "@kvitbit/domain/contract";
import {
  idempotencyHeaders,
  isAutoRetryable,
  isRetryable,
  retryAfterSeconds,
  UiError,
  uuidV7,
} from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";
import type { CaptureStorage } from "../../platform/capture/capture-storage-port";
import type { SavedFile, TransferResult, UploadRequest } from "../../platform/transfer";
import { fromMobilePromise, requestKeyReplayWindowOpen } from "../../runtime/request-intent";
import { canWriteWorkspace } from "../dashboard/model";
import { runFeatureEffect, runFeatureSync } from "../ui-effect";
import {
  type CaptureFailure,
  type CaptureFields,
  type CaptureFile,
  type CaptureJob,
  type CaptureScope,
  decodeCaptureJournal,
  decodeRejectedReceipts,
  encodeCaptureJournal,
  type RejectedReceipt,
} from "./capture-journal";
import { InvalidReceipt, readReceipt } from "./receipt-file";

export type { CaptureFields, CaptureJob, CaptureScope, RejectedReceipt } from "./capture-journal";

export const mayCapture: {
  (principalId: string | null, workspace: WorkspaceSummary): boolean;
  (workspace: WorkspaceSummary): (principalId: string | null) => boolean;
} = Fn.dual(
  2,
  (principalId: string | null, workspace: WorkspaceSummary) =>
    principalId !== null && canWriteWorkspace(workspace),
);

export interface CaptureAccess {
  readonly scope: CaptureScope;
  readonly canWrite: () => boolean;
  readonly verifyWrite?: () => Promise<boolean>;
}

export interface CaptureQueueSummary {
  readonly pendingCount: number;
  readonly blockedCount: number;
  readonly hasBlocked: boolean;
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

const decimalInput = /^\d+(?:\.\d+)?$/;
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;
const scopeKey = (scope: CaptureScope) =>
  runFeatureSync(encodeCaptureJournal([scope.principalId, scope.workspaceId]));
const rejectedScopeKey = (scope: CaptureScope, expenseId: ExpenseId) =>
  runFeatureSync(
    encodeCaptureJournal(["rejected", scope.principalId, scope.workspaceId, expenseId]),
  );

type QueueError = Effect.Error<ReturnType<typeof fromMobilePromise>> | Schema.SchemaError;

const runQueueEffect = <A>(effect: Effect.Effect<A, QueueError>) =>
  runFeatureEffect(
    Effect.catchTag(effect, "MobileBridgeError", (error) => Effect.die(error.cause)),
  );

function capturePayload(fields: CaptureFields): ExpenseInput {
  const total = Str.replace(",", ".")(Str.replace(/\s+/g, "")(Str.trim(fields.total)));
  const supplier = Str.trim(fields.supplierName);
  const note = Str.trim(fields.note);
  const payload: Record<string, string | { readonly manual: { readonly name: string } }> & {
    readonly status: "incomplete";
  } = {
    status: "incomplete",
    currency: Str.toUpperCase(Str.trim(fields.currency)) || "CZK",
  };
  if (supplier !== "") payload["supplier"] = { manual: { name: supplier } };
  if (decimalInput.test(total)) payload["total"] = total;
  if (note !== "") payload["note"] = note;
  return payload;
}

export function makeCaptureQueue({
  storage,
  saveBytes,
  removeBytes,
  read = readReceipt,
  key = () => runFeatureEffect(uuidV7),
  now = () => runFeatureSync(Clock.currentTimeMillis),
}: QueueOptions) {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
  const listeners = new Set<JobChanges>();
  const journalVersions = new WeakMap<readonly CaptureJob[] | readonly RejectedReceipt[], string>();

  const load = Effect.fn("CaptureQueue.load")(function* (scope: CaptureScope) {
    const slot = scopeKey(scope);
    const stored = yield* fromMobilePromise(() => storage.load(slot));
    if (stored === null) return [];
    const jobs = yield* decodeCaptureJournal(stored);
    const matching = Arr.filter(jobs, (job) => scopeKey(job.scope) === slot);
    if (matching.length === jobs.length) journalVersions.set(matching, stored);
    return matching;
  });

  const save = Effect.fn("CaptureQueue.save")(function* (
    scope: CaptureScope,
    jobs: readonly CaptureJob[],
    previous: readonly CaptureJob[],
  ) {
    const value = yield* encodeCaptureJournal(jobs);
    const version = journalVersions.get(previous) ?? (yield* encodeCaptureJournal(previous));
    yield* fromMobilePromise(() => storage.save(scopeKey(scope), value, version));
    journalVersions.set(jobs, value);
    for (const listener of listeners) listener(scope);
  });

  function locked<A>(access: CaptureAccess, work: Effect.Effect<A, QueueError>): Promise<A> {
    // Serialize each Workspace even if another principal's request is still in flight.
    const slot = access.scope.workspaceId;
    return runQueueEffect(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = locks.get(slot) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          lock.users += 1;
          locks.set(slot, lock);
          return lock;
        }),
        (lock) =>
          lock.semaphore.withPermits(1)(
            fromMobilePromise(() => storage.lock(slot, () => runQueueEffect(work))),
          ),
        (lock) =>
          Effect.sync(() => {
            lock.users -= 1;
            if (lock.users === 0) locks.delete(slot);
          }),
      ),
    );
  }

  const loadRejected = Effect.fn("CaptureQueue.loadRejected")(function* (
    scope: CaptureScope,
    expenseId: ExpenseId,
  ) {
    const stored = yield* fromMobilePromise(() => storage.load(rejectedScopeKey(scope, expenseId)));
    if (stored === null) return [];
    const items = yield* decodeRejectedReceipts(stored);
    journalVersions.set(items, stored);
    return items;
  });

  const saveRejected = Effect.fn("CaptureQueue.saveRejected")(function* (
    scope: CaptureScope,
    expenseId: ExpenseId,
    items: readonly RejectedReceipt[],
    previous: readonly RejectedReceipt[],
  ) {
    const value = yield* encodeCaptureJournal(items);
    const version = journalVersions.get(previous) ?? (yield* encodeCaptureJournal(previous));
    yield* fromMobilePromise(() =>
      storage.save(rejectedScopeKey(scope, expenseId), value, version),
    );
    journalVersions.set(items, value);
    for (const listener of listeners) listener(scope);
  });

  const persistRejected = Effect.fn("CaptureQueue.persistRejected")(function* (
    scope: CaptureScope,
    job: CaptureJob,
  ) {
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
    const existing = yield* loadRejected(scope, job.expenseId);
    const existingKeys = new Set(Arr.map(existing, (entry) => entry.key));
    const merged = [...existing, ...Arr.filter(rejected, (entry) => !existingKeys.has(entry.key))];
    if (merged.length !== existing.length) {
      yield* saveRejected(scope, job.expenseId, merged, existing);
    }
  });

  const canWriteNow = Effect.fn("CaptureQueue.canWriteNow")(function* (access: CaptureAccess) {
    if (!access.canWrite()) return false;
    if (access.verifyWrite !== undefined) return yield* fromMobilePromise(access.verifyWrite);
    return true;
  });

  const dropFinished = Effect.fn("CaptureQueue.dropFinished")(function* (
    scope: CaptureScope,
    jobs: readonly CaptureJob[],
    job: CaptureJob,
  ) {
    // Persist rejected filenames and issues before removing the job so reopening the expense shows them.
    yield* persistRejected(scope, job);
    // Keep the completed job until its local files have been released, so a restart can finish cleanup.
    yield* Effect.forEach(
      job.files,
      (receipt) => fromMobilePromise(() => removeBytes(receipt.file.ref)),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    const remaining = Arr.filter(jobs, (other) => other.key !== job.key);
    yield* save(scope, remaining, jobs);
    return remaining;
  });

  const replay = Effect.fn("CaptureQueue.replay")(function* (
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

    const update = Effect.fn("CaptureQueue.update")(function* (changes: Partial<CaptureJob>) {
      const updated = { ...job, ...changes };
      const next = Arr.map(jobs, (entry) => (entry.key === updated.key ? updated : entry));
      yield* save(scope, next, jobs);
      jobs = next;
      job = updated;
    });

    const fail = Effect.fn("CaptureQueue.fail")(function* (error: UiError) {
      const prior = options.reconnect === true ? undefined : job.submission?.failure;
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
      yield* update({ submission: { fields, payload, failure } });
    });

    let expenseId = job.expenseId;
    if (expenseId === null) {
      const firstAttempt = job.recordAttemptAt;
      if (firstAttempt !== undefined && !requestKeyReplayWindowOpen(firstAttempt, now())) {
        yield* update({ submission: { fields, payload, failure: { kind: "expired" } } });
        return { jobs, job };
      }
      if (network.isOnline !== undefined && !(yield* fromMobilePromise(network.isOnline))) {
        yield* fail(UiError.offline);
        return { jobs, job };
      }
      if (!(yield* canWriteNow(access))) return { jobs, job };
      if (firstAttempt === undefined) yield* update({ recordAttemptAt: now() });
      if (!(yield* canWriteNow(access))) return { jobs, job };
      const result = yield* fromMobilePromise(() => network.record(job.scope, job.key, payload));
      if (result._tag === "Err") {
        if (!(yield* canWriteNow(access))) return { jobs, job };
        yield* fail(result.error);
        return { jobs, job };
      }
      expenseId = result.value;
      yield* update({ expenseId, submission: { fields, payload } });
    }

    for (const receipt of job.files) {
      if (receipt.result !== undefined) continue;
      if (!(yield* canWriteNow(access))) return { jobs, job };
      const actual = yield* fromMobilePromise(() => read(receipt.file)).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (actual?.file.sha256 !== receipt.file.sha256 || actual.file.size !== receipt.file.size) {
        yield* fail(UiError.unexpected());
        return { jobs, job };
      }
      if (!(yield* canWriteNow(access))) return { jobs, job };
      options.onProgress?.(receipt.key, 0);
      const request: UploadRequest = {
        path: `/workspaces/${job.scope.workspaceId}/expenses/${expenseId}/attachments`,
        headers: idempotencyHeaders(receipt.key),
        file: receipt.file,
        onProgress: (progress) => options.onProgress?.(receipt.key, progress),
      };
      const result = yield* fromMobilePromise(() => network.upload(request));
      if (
        result._tag === "Err" &&
        result.error._tag !== "PayloadTooLarge" &&
        !(
          result.error._tag === "Invalid" &&
          Arr.every<{ readonly code: string }>(result.error.issues, (issue) =>
            Str.startsWith("attachment.")(issue.code),
          )
        )
      ) {
        if (!(yield* canWriteNow(access))) return { jobs, job };
        yield* fail(result.error);
        return { jobs, job };
      }
      const fileResult: NonNullable<CaptureFile["result"]> =
        result._tag === "Ok" ? { kind: "uploaded" } : { kind: "rejected", error: result.error };
      yield* update({
        files: Arr.map(job.files, (entry) =>
          entry.key === receipt.key ? { ...entry, result: fileResult } : entry,
        ),
        submission: { fields, payload },
      });
    }

    yield* update({ done: true });
    jobs = yield* dropFinished(scope, jobs, job);
    return { jobs, job };
  });

  return {
    load: (scope: CaptureScope) => runQueueEffect(load(scope)),
    loadRejected: (scope: CaptureScope, expenseId: ExpenseId) =>
      runQueueEffect(loadRejected(scope, expenseId)),
    dismissRejected(access: CaptureAccess, expenseId: ExpenseId, fileKey: string) {
      return locked(
        access,
        Effect.gen(function* () {
          if (!(yield* canWriteNow(access))) return;
          const existing = yield* loadRejected(access.scope, expenseId);
          const remaining = Arr.filter(existing, (entry) => entry.key !== fileKey);
          if (remaining.length !== existing.length) {
            yield* saveRejected(access.scope, expenseId, remaining, existing);
          }
        }),
      );
    },
    clearRejected(access: CaptureAccess, expenseId: ExpenseId) {
      return locked(
        access,
        Effect.gen(function* () {
          if (!(yield* canWriteNow(access))) return;
          const existing = yield* loadRejected(access.scope, expenseId);
          if (existing.length > 0) {
            yield* saveRejected(access.scope, expenseId, [], existing);
          }
        }),
      );
    },
    subscribe(listener: JobChanges) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stage(access: CaptureAccess, target: ExpenseId | null, sources: readonly CaptureSource[]) {
      return locked(
        access,
        Effect.gen(function* () {
          const { scope } = access;
          const issues: CaptureIssue[] = [];
          const acknowledge: string[] = [];
          if (!access.canWrite()) return { job: undefined, issues, acknowledge };
          const jobs = yield* load(scope);
          const draft = Option.getOrUndefined(
            Arr.findFirst(
              jobs,
              (candidate) =>
                candidate.targetExpenseId === target && candidate.submission === undefined,
            ),
          );
          const files = [...(draft?.files ?? [])];
          for (const source of sources) {
            if (!access.canWrite()) break;
            if (
              source.source !== undefined &&
              Arr.some(jobs, (candidate) =>
                Arr.some(candidate.files, (entry) => entry.sources.includes(source.source ?? "")),
              )
            ) {
              acknowledge.push(source.source);
              continue;
            }
            const staged = yield* Effect.result(
              Effect.gen(function* () {
                const captured = yield* fromMobilePromise(() => read(source));
                const duplicate = Option.getOrElse(
                  Arr.findFirstIndex(files, (entry) => entry.file.sha256 === captured.file.sha256),
                  () => -1,
                );
                if (duplicate === -1) {
                  const fileKey = yield* fromMobilePromise(key);
                  const ref = yield* fromMobilePromise(() =>
                    saveBytes(fileKey, source.name, captured.bytes),
                  );
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
              }),
            );
            if (Result.isFailure(staged)) {
              const error = staged.failure.cause;
              issues.push(Schema.is(InvalidReceipt)(error) ? error.issue : "unreadable");
              if (Schema.is(InvalidReceipt)(error) && source.source !== undefined)
                acknowledge.push(source.source);
            }
          }
          if (files.length === 0) return { job: draft, issues, acknowledge };
          const job: CaptureJob = {
            key: draft?.key ?? (yield* fromMobilePromise(() => key())),
            scope: draft?.scope ?? scope,
            targetExpenseId: target,
            expenseId: target,
            files,
          };
          yield* save(
            scope,
            draft === undefined
              ? [...jobs, job]
              : Arr.map(jobs, (entry) => (entry === draft ? job : entry)),
            jobs,
          );
          return { job, issues, acknowledge };
        }),
      );
    },
    remove(access: CaptureAccess, jobKey: string, fileKey: string) {
      return locked(
        access,
        Effect.gen(function* () {
          if (!access.canWrite()) return;
          const jobs = yield* load(access.scope);
          const job = Option.getOrUndefined(Arr.findFirst(jobs, (entry) => entry.key === jobKey));
          if (job === undefined || job.submission !== undefined) return;
          const receipt = Option.getOrUndefined(
            Arr.findFirst(job.files, (entry) => entry.key === fileKey),
          );
          if (receipt === undefined) return;
          const files = Arr.filter(job.files, (entry) => entry.key !== fileKey);
          yield* save(
            access.scope,
            Arr.flatMap(jobs, (entry) =>
              entry !== job ? [entry] : files.length === 0 ? [] : [{ ...job, files }],
            ),
            jobs,
          );
          yield* fromMobilePromise(() => removeBytes(receipt.file.ref));
        }),
      );
    },
    discard(access: CaptureAccess, jobKey: string) {
      return locked(
        access,
        Effect.gen(function* () {
          if (!access.canWrite()) return;
          const jobs = yield* load(access.scope);
          const job = Option.getOrUndefined(Arr.findFirst(jobs, (entry) => entry.key === jobKey));
          const failure = job?.submission?.failure;
          if (job === undefined || (failure?.kind !== "blocked" && failure?.kind !== "expired"))
            return;
          const done = { ...job, done: true as const };
          const updated = Arr.map(jobs, (entry) => (entry === job ? done : entry));
          yield* save(access.scope, updated, jobs);
          yield* dropFinished(access.scope, updated, done);
        }),
      );
    },
    submit(
      access: CaptureAccess,
      network: CaptureNetwork,
      jobKey: string,
      fields: CaptureFields,
      onProgress: (key: string, progress: number) => void,
    ) {
      return locked(
        access,
        Effect.gen(function* () {
          if (!access.canWrite()) return;
          let jobs: readonly CaptureJob[] = yield* load(access.scope);
          let job = Option.getOrUndefined(Arr.findFirst(jobs, (entry) => entry.key === jobKey));
          if (
            job === undefined ||
            job.files.length === 0 ||
            job.done === true ||
            !canRetryCapture(job)
          )
            return job;
          if (job.submission === undefined) {
            const submitted = { ...job, submission: { fields, payload: capturePayload(fields) } };
            const next = Arr.map(jobs, (entry) =>
              entry.key === submitted.key ? submitted : entry,
            );
            yield* save(access.scope, next, jobs);
            jobs = next;
            job = submitted;
          }
          return (yield* replay(access, network, jobs, job, { onProgress })).job;
        }),
      );
    },
    drain(
      access: CaptureAccess,
      network: CaptureNetwork,
      options: { readonly reconnect?: boolean; readonly signedIn?: boolean } = {},
    ) {
      return locked(
        access,
        Effect.gen(function* () {
          const completed: CaptureJob[] = [];
          let nextAt: number | undefined;
          if (!access.canWrite()) return { completed, nextAt };
          let jobs: readonly CaptureJob[] = yield* load(access.scope);
          for (let job of jobs) {
            if (!access.canWrite()) break;
            if (job.done === true) {
              jobs = yield* dropFinished(access.scope, jobs, job);
              continue;
            }
            if (job.submission === undefined) continue;
            const failure = job.submission.failure;
            if (
              failure?.kind === "blocked" ||
              failure?.kind === "expired" ||
              (failure?.kind === "needsSignIn" && options.signedIn !== true)
            )
              continue;
            if (
              failure?.kind !== "retry" ||
              options.reconnect === true ||
              failure.nextAt <= now()
            ) {
              const replayed = yield* replay(access, network, jobs, job, options);
              jobs = replayed.jobs;
              job = replayed.job;
              if (job.done === true) completed.push(job);
            }
            const retry = job.submission?.failure;
            if (retry?.kind === "retry") nextAt = Math.min(nextAt ?? retry.nextAt, retry.nextAt);
          }
          return { completed, nextAt };
        }),
      );
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

function isCaptureJobBlocked(job: CaptureJob, canWrite: boolean): boolean {
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
