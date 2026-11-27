/**
 * The module steps a `RecurringIssuance` workflow and the `RecurringSweep` cron call
 * (core-ports 7.2, 7.3). Workflows and crons are defined later; these are their bodies.
 *
 * Exactly once per (schedule, occurrence), across crashes, retries and concurrent runs:
 * - "issue" runs in ONE transaction: lock the schedule row, return the existing `issued` run if
 *   there is one, else call `Documents.issue` (a savepoint of this transaction), upsert the run
 *   as `issued` and advance `next_occurrence`. A crash anywhere rolls all of it back; a
 *   concurrent run waits on the lock and then sees the run.
 * - "send" is a separate step and transaction: an issued run with autoSend records
 *   `send: "pending"`; the step calls `Documents.send` and records the delivery in the same
 *   transaction. A crash between issue and send leaves the run pending, so rerunning the
 *   occurrence sends only.
 * - Expected failures (Invalid, NotFound, Forbidden from Documents) pause the schedule and record
 *   the run as data (rule J6); other failures (Unavailable, Conflict) fail the step for retry.
 *
 * Every step runs as the sealed System caller of its job, `RecurringIssuance{scheduleId,
 * occurrence}`, and refuses any other caller (R4, R5): Members never call these.
 */

import type {
  DeliveryId,
  IsoDate,
  IssueCode,
  ScheduleId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  type Action,
  type CoreError,
  CurrentCaller,
  Documents,
  Forbidden,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { pragueDate } from "../../engines/calendar";
import { systemCaller } from "../../internal/system";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { IdGenerator, newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { RecurringDocumentLink } from "./links";
import type { RunRow, ScheduleRow } from "./repo";
import { dieOnUnique, RecurringRepo } from "./repo";
import { documentInputOf } from "./service";
import type { SweepDecision } from "./sweep";
import { decideDue, isMissed, issueEligibility, occurrenceAfter, ruleOf } from "./sweep";

/** Request key of the occurrence's issue (core-ports 7.2); also the workflow key's suffix. */
export const occurrenceKey: {
  (occurrence: IsoDate): (scheduleId: ScheduleId) => string;
  (scheduleId: ScheduleId, occurrence: IsoDate): string;
} = Fn.dual(
  2,
  (scheduleId: ScheduleId, occurrence: IsoDate) => `recurring:${scheduleId}:${occurrence}`,
);

export type SkipReason = "detached" | "paused" | "not_next" | "not_due" | "archived" | "not_missed";

export type IssueOutcome =
  /** The occurrence's document; `replayed` when an earlier run had already issued it. */
  | { readonly _tag: "Issued"; readonly run: RunRow; readonly replayed: boolean }
  /** Documents refused the occurrence; the schedule is paused (RecurringIssuanceFailed). */
  | { readonly _tag: "Paused"; readonly reason: IssueCode | null; readonly run: RunRow }
  /** Nothing to do: the occurrence is not the schedule's next due one. */
  | { readonly _tag: "Skipped"; readonly reason: SkipReason };

export type SendOutcome =
  | { readonly _tag: "Queued"; readonly deliveryId: DeliveryId; readonly replayed: boolean }
  | { readonly _tag: "NotRequested" }
  | { readonly _tag: "Paused"; readonly reason: IssueCode | null; readonly run: RunRow }
  /** No issued run for the occurrence (yet). */
  | { readonly _tag: "NotIssued" };

export interface OccurrenceResult {
  readonly issue: IssueOutcome;
  readonly send: SendOutcome | null;
}

type StepError = CoreError;

export class RecurringIssuance extends Context.Service<
  RecurringIssuance,
  {
    /** Activity "issue" + "advance": exactly one document for the occurrence. */
    readonly issue: (
      scheduleId: ScheduleId,
      occurrence: IsoDate,
    ) => Effect.Effect<IssueOutcome, StepError, CurrentCaller>;
    /** Activity "enqueue-delivery": queues the issued document's email once, if autoSend. */
    readonly send: (
      scheduleId: ScheduleId,
      occurrence: IsoDate,
    ) => Effect.Effect<SendOutcome, StepError, CurrentCaller>;
    /** The whole workflow body: issue, then send when the run is pending. Safe to rerun. */
    readonly run: (
      scheduleId: ScheduleId,
      occurrence: IsoDate,
    ) => Effect.Effect<OccurrenceResult, StepError, CurrentCaller>;
    /** The sweep's catch-up cap: pauses the schedule with `schedule.missed_occurrences`. */
    readonly pauseMissed: (
      scheduleId: ScheduleId,
      occurrence: IsoDate,
    ) => Effect.Effect<IssueOutcome, StepError, CurrentCaller>;
    /** Cross-tenant: what this sweep tick does, at the current instant (Prague date). */
    readonly due: Effect.Effect<ReadonlyArray<SweepDecision>, StepError>;
    /**
     * Cross-tenant (OutboxReconcile, J1a): occurrences issued with autoSend whose send is still
     * pending after `olderThanMillis` (a crash between issue and send). Rerun `run` for each, as
     * its job's System caller: it sends only.
     */
    readonly pendingSends: (olderThanMillis: number) => Effect.Effect<
      ReadonlyArray<{
        readonly workspaceId: WorkspaceId;
        readonly scheduleId: ScheduleId;
        readonly occurrence: IsoDate;
      }>,
      StepError
    >;
    /**
     * One RecurringSweep tick: `start` runs for each occurrence to issue (it starts the
     * workflow), as the System caller of that occurrence's job; missed occurrences pause their
     * schedule here. One decision's failure is logged and does not stop the others.
     */
    readonly sweep: <E>(
      start: (decision: SweepDecision) => Effect.Effect<void, E, CurrentCaller>,
    ) => Effect.Effect<ReadonlyArray<SweepDecision>, StepError>;
  }
>()("@kvitbit/core/modules/recurring/issuance/RecurringIssuance") {}

/** The pause reason a Documents failure records; null when no IssueCode names it. */
const failureCode = (error: CoreError): IssueCode | null =>
  error._tag === "Invalid" ? error.issues[0].code : null;

/** The pausing error when no IssueCode names it, e.g. `NotFound:Contact`. */
const failureError = (error: CoreError): string | null =>
  error._tag === "NotFound"
    ? `NotFound:${error.entity}`
    : error._tag === "Forbidden"
      ? `Forbidden:${error.action}`
      : error._tag === "Conflict"
        ? `Conflict:${error.reason}`
        : null;

/**
 * Documents failures that pause the schedule (J6: failure is data). `Unavailable` and a
 * `Conflict{revision_changed}` race are transient: they fail the step so the workflow retries.
 * Every other Conflict (locked, illegal transition, duplicate) would fail forever, so it pauses.
 */
const pauses = (error: CoreError): boolean =>
  error._tag === "Invalid" ||
  error._tag === "NotFound" ||
  error._tag === "Forbidden" ||
  (error._tag === "Conflict" && error.reason !== "revision_changed");

export const makeRecurringIssuance = Effect.gen(function* () {
  const store = yield* CoreStore;
  const ids = yield* IdGenerator;
  const repo = yield* RecurringRepo;
  const documents = yield* Documents;
  const links = yield* RecurringDocumentLink;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CoreStore, store), Effect.provideService(IdGenerator, ids));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const today = Effect.map(Clock.currentTimeMillis, pragueDate);

  /** R4: only the System caller of this very occurrence's job. */
  const authorizeJob = (action: Action, scheduleId: ScheduleId, occurrence: IsoDate) =>
    Effect.flatMap(authorizeInWorkspace(action), ({ caller, workspaceId }) =>
      caller._tag === "System" &&
      caller.job._tag === "RecurringIssuance" &&
      caller.job.scheduleId === scheduleId &&
      caller.job.occurrence === occurrence
        ? Effect.succeed(workspaceId)
        : Effect.fail(Forbidden.make({ action })),
    );

  const upsertRun = Effect.fn("upsertRun")(function* (
    workspaceId: WorkspaceId,
    scheduleId: ScheduleId,
    occurrence: IsoDate,
    patch: Pick<
      RunRow,
      "outcome" | "documentId" | "documentNumber" | "deliveryId" | "send" | "failure"
    >,
  ) {
    const at = yield* nowIso;
    const existing = yield* repo.findRun(workspaceId, scheduleId, occurrence);
    if (Option.isSome(existing)) {
      return yield* repo.updateRun({ ...existing.value, ...patch, at }, existing.value.revision);
    }
    return yield* repo.insertRun({
      id: yield* newId(),
      workspaceId,
      revision: 1,
      scheduleId,
      occurrence,
      at,
      ...patch,
    });
  });

  const pauseSchedule = Effect.fn("pauseSchedule")(function* (
    schedule: ScheduleRow,
    reason: IssueCode | null,
    occurrence: IsoDate,
    error: string | null = null,
  ) {
    const next = yield* repo.updateSchedule(
      { ...schedule, pausedAt: yield* nowIso, pausedReason: reason, pausedError: error },
      schedule.revision,
    );
    yield* appendAudit({
      workspaceId: schedule.workspaceId,
      subject: { entity: "Schedule", id: schedule.id },
      action: "schedule.pause",
      revision: next.revision,
      changes: [{ path: "pausedReason", before: schedule.pausedReason, after: reason }],
      reason: `occurrence ${occurrence}`,
    });
    return next;
  });

  /** The catch-up cap (core-ports 4.8): pause and record the occurrence as skipped_missed. */
  const pauseForMissed = Effect.fn("pauseForMissed")(function* (
    schedule: ScheduleRow,
    occurrence: IsoDate,
  ) {
    const reason = "schedule.missed_occurrences" as const;
    yield* pauseSchedule(schedule, reason, occurrence);
    const run = yield* upsertRun(schedule.workspaceId, schedule.id, occurrence, {
      outcome: "skipped_missed",
      documentId: null,
      documentNumber: null,
      deliveryId: null,
      send: "none",
      failure: reason,
    });
    return { _tag: "Paused", reason, run } as const;
  });

  const issue: RecurringIssuance["Service"]["issue"] = Effect.fn("issue")(
    function* (scheduleId, occurrence) {
      const workspaceId = yield* authorizeJob("document.issue", scheduleId, occurrence);
      return yield* store.transaction(
        Effect.gen(function* () {
          const schedule = yield* repo.lockSchedule(workspaceId, scheduleId);
          const existing = yield* repo.findRun(workspaceId, scheduleId, occurrence);
          if (Option.isSome(existing) && existing.value.outcome === "issued") {
            return { _tag: "Issued", run: existing.value, replayed: true } as const;
          }
          const day = yield* today;
          const eligibility = issueEligibility(schedule, occurrence, day);
          if (eligibility._tag === "Ineligible") {
            return { _tag: "Skipped", reason: eligibility.reason } as const;
          }
          // A workflow that started on time but runs past the cap pauses instead of issuing.
          if (isMissed(occurrence, day, schedule.catchUpThrough)) {
            return yield* pauseForMissed(schedule, occurrence);
          }
          const template = yield* repo.getTemplate(workspaceId, schedule.templateId);
          if (template.archivedAt !== null) return { _tag: "Skipped", reason: "archived" } as const;
          const input = {
            ...documentInputOf(template.input),
            kind: schedule.issueAs,
            issuedOn: occurrence,
            taxableSupplyOn: occurrence,
          };
          // A savepoint: a refused issue reverts only Documents' writes. The link stamps the
          // document with its occurrence (unique backstop, documents(schedule_id, occurrence)).
          const issued = yield* Effect.result(
            store
              .transaction(
                Effect.tap(documents.issue({ input }), (issuedDocument) =>
                  links.link(workspaceId, issuedDocument.id, { scheduleId, occurrence }),
                ),
              )
              .pipe(dieOnUnique),
          );
          if (Result.isFailure(issued)) {
            const error = issued.failure;
            if (error._tag === "StoreUnavailable" || !pauses(error)) return yield* error;
            const reason = failureCode(error);
            yield* pauseSchedule(schedule, reason, occurrence, failureError(error));
            const run = yield* upsertRun(workspaceId, scheduleId, occurrence, {
              outcome: "failed",
              documentId: null,
              documentNumber: null,
              deliveryId: null,
              send: "none",
              failure: reason,
            });
            return { _tag: "Paused", reason, run } as const;
          }
          const document = issued.success;
          const run = yield* upsertRun(workspaceId, scheduleId, occurrence, {
            outcome: "issued",
            documentId: document.id,
            documentNumber: document.number,
            deliveryId: null,
            // Snapshot of autoSend: a later schedule change does not affect this occurrence.
            send: schedule.autoSend ? "pending" : "none",
            failure: null,
          });
          // "advance": compare-and-set on the schedule row locked above.
          yield* repo.updateSchedule(
            { ...schedule, nextOccurrence: occurrenceAfter(ruleOf(schedule), occurrence) },
            schedule.revision,
          );
          return { _tag: "Issued", run, replayed: false } as const;
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const send: RecurringIssuance["Service"]["send"] = Effect.fn("send")(
    function* (scheduleId, occurrence) {
      const workspaceId = yield* authorizeJob("document.send", scheduleId, occurrence);
      return yield* store.transaction(
        Effect.gen(function* () {
          const schedule = yield* repo.lockSchedule(workspaceId, scheduleId);
          const found = yield* repo.findRun(workspaceId, scheduleId, occurrence);
          if (Option.isNone(found) || found.value.outcome !== "issued") {
            return { _tag: "NotIssued" } as const;
          }
          const run = found.value;
          if (run.send === "queued" && run.deliveryId !== null) {
            return { _tag: "Queued", deliveryId: run.deliveryId, replayed: true } as const;
          }
          if (run.send === "failed") return { _tag: "Paused", reason: run.failure, run } as const;
          if (run.send !== "pending" || run.documentId === null) {
            return { _tag: "NotRequested" } as const;
          }
          const sent = yield* Effect.result(store.transaction(documents.send(run.documentId)));
          if (Result.isFailure(sent)) {
            const error = sent.failure;
            if (error._tag === "StoreUnavailable" || !pauses(error)) return yield* error;
            const reason = failureCode(error);
            // The document stays issued; resume does not retry the send (send it manually).
            if (schedule.detachedAt === null && schedule.pausedAt === null) {
              yield* pauseSchedule(schedule, reason, occurrence, failureError(error));
            }
            const failed = yield* upsertRun(workspaceId, scheduleId, occurrence, {
              ...run,
              send: "failed",
              failure: reason,
            });
            return { _tag: "Paused", reason, run: failed } as const;
          }
          const deliveryId = sent.success.deliveryId;
          yield* upsertRun(workspaceId, scheduleId, occurrence, {
            ...run,
            deliveryId,
            send: "queued",
          });
          return { _tag: "Queued", deliveryId, replayed: false } as const;
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const run: RecurringIssuance["Service"]["run"] = Effect.fn("run")(
    function* (scheduleId, occurrence) {
      const issued = yield* issue(scheduleId, occurrence);
      if (issued._tag !== "Issued" || issued.run.send === "none") {
        return { issue: issued, send: null };
      }
      return { issue: issued, send: yield* send(scheduleId, occurrence) };
    },
  );

  const pauseMissed: RecurringIssuance["Service"]["pauseMissed"] = Effect.fn("pauseMissed")(
    function* (scheduleId, occurrence) {
      const workspaceId = yield* authorizeJob("document.issue", scheduleId, occurrence);
      return yield* store.transaction(
        Effect.gen(function* () {
          const schedule = yield* repo.lockSchedule(workspaceId, scheduleId);
          const day = yield* today;
          const eligibility = issueEligibility(schedule, occurrence, day);
          if (eligibility._tag === "Ineligible") {
            return { _tag: "Skipped", reason: eligibility.reason } as const;
          }
          if (!isMissed(occurrence, day, schedule.catchUpThrough)) {
            return { _tag: "Skipped", reason: "not_missed" } as const;
          }
          return yield* pauseForMissed(schedule, occurrence);
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const pendingSends: RecurringIssuance["Service"]["pendingSends"] = Effect.fn("pendingSends")(
    function* (olderThanMillis) {
      const now = yield* DateTime.now;
      const before = DateTime.formatIso(DateTime.subtract(now, { milliseconds: olderThanMillis }));
      const rows = yield* store.transaction(repo.pendingSendRuns(before));
      return EffectArray.map(rows, (row) => ({
        workspaceId: row.workspaceId,
        scheduleId: row.scheduleId,
        occurrence: row.occurrence,
      }));
    },
    orUnavailable,
  );

  const due: RecurringIssuance["Service"]["due"] = Effect.gen(function* () {
    const day = yield* today;
    const rows = yield* store.transaction(repo.dueSchedules(day));
    return decideDue(rows, day);
  }).pipe(orUnavailable);

  const sweep: RecurringIssuance["Service"]["sweep"] = Effect.fn("sweep")(function* <E>(
    start: (decision: SweepDecision) => Effect.Effect<void, E, CurrentCaller>,
  ) {
    const decisions = yield* due;
    yield* Effect.forEach(
      decisions,
      (decision) => {
        const caller = systemCaller(decision.workspaceId, {
          _tag: "RecurringIssuance",
          scheduleId: decision.scheduleId,
          occurrence: decision.occurrence,
        });
        const step: Effect.Effect<void, E | StepError, CurrentCaller> =
          decision.action === "pause_missed"
            ? Effect.asVoid(pauseMissed(decision.scheduleId, decision.occurrence))
            : start(decision);
        return step.pipe(
          Effect.provideService(CurrentCaller, caller),
          // Interruption (shutdown, cron cancel) stops the tick; other failures are logged.
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("RecurringSweep: decision failed", decision, cause),
          ),
        );
      },
      { discard: true, concurrency: 1 },
    );
    return decisions;
  });

  return RecurringIssuance.of({ issue, send, run, pauseMissed, due, pendingSends, sweep });
});

/**
 * `RecurringIssuance` on `RecurringRepo`. Needs CoreStore | IdGenerator | RecurringRepo |
 * RecurringDocumentLink | Documents.
 */
export const RecurringIssuanceLive: Layer.Layer<
  RecurringIssuance,
  never,
  CoreStore | IdGenerator | RecurringRepo | RecurringDocumentLink | Documents
> = Layer.effect(RecurringIssuance, makeRecurringIssuance);
