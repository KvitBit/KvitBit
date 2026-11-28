/**
 * Job steps of the future `DocumentDelivery` workflow (core-ports 7.2; no workflow is defined
 * this phase). Each runs as the workflow's System caller in its own transaction and is
 * idempotent by the delivery's status, so a replayed Activity or a reconcile re-start (J1a)
 * is harmless:
 * - `claim`: queued -> sending when still eligible (J3 re-check), else skipped; a sending row
 *   (a restarted job) is re-checked too and stays sending or is skipped;
 * - `dispatch`: sending -> sent, or failed on `EmailRejected` (never retried); the retryable
 *   outcomes leave it sending and fail with `DeliveryRetry` for the Activity's retry policy;
 *   the EmailSender key is always the delivery id (J2);
 * - `giveUp`: sending -> failed once retries are exhausted.
 * `deliver` runs claim then dispatch. `reconcileStaleDeliveries` is the delivery half of
 * OutboxReconcile (J1a): it restarts the job of a delivery left `queued` or `sending`.
 */

import { type Caller, DeliveryId, type WorkspaceId } from "@kvitbit/domain/contract";
import { EmailSender } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CoreStore } from "../../../store/CoreStore";
import { DocumentDeliveryReads } from "../delivery";
import { reminderState, stepBlock } from "../reminders/eligibility";
import { stillOwed } from "../reminders/policy";
import { DocumentsRepo } from "../repo";
import { now } from "../support";
import { DeliveryJobs } from "./jobs";
import type { DeliveryRecord } from "./record";
import { isTerminal } from "./record";
import { DeliveriesRepo } from "./repo";

/**
 * The provider did not take the message for certain (`not_accepted`: retrying or failing
 * over is safe) or may have (`outcome_unknown`: retry the same provider with the same key
 * only). The delivery stays `sending`; the workflow retries `dispatch`, then `giveUp`.
 */
export class DeliveryRetry extends Schema.TaggedError<
  DeliveryRetry,
  { readonly brand: unique symbol }
>()("DeliveryRetry", {
  deliveryId: DeliveryId,
  cause: Schema.Literals(["not_accepted", "outcome_unknown"]),
}) {}

/** Why a queued delivery is no longer sent (J3), or null when it still is. */
const ineligible = Effect.fn("ineligible")(function* (
  caller: Caller,
  workspaceId: WorkspaceId,
  delivery: DeliveryRecord,
) {
  const record = yield* (yield* DocumentsRepo).get(workspaceId, delivery.documentId);
  if (record.status === "cancelled") return "document_cancelled";
  if (delivery.purpose === "document") return null;
  if (!stillOwed(record)) return "document_settled";
  if (delivery.reminder === null) return null; // a manual reminder (D14)
  // Automatic reminder: the same check as selection and enqueue (reminders/eligibility.ts).
  const { today } = yield* now;
  const state = yield* reminderState(caller, workspaceId, record, today);
  return stepBlock(state, record, delivery.reminder, today, delivery.id);
});

const transition = Effect.fn("transition")(function* (
  workspaceId: WorkspaceId,
  id: DeliveryId,
  change: (row: DeliveryRecord) => Partial<DeliveryRecord> | null,
) {
  const repo = yield* DeliveriesRepo;
  const row = yield* repo.lock(workspaceId, id);
  const patch = change(row);
  if (patch === null) return row;
  const { at } = yield* now;
  return yield* repo
    .update({ ...row, ...patch, updatedAt: at }, row.revision)
    .pipe(Effect.catchTag("Conflict", (e) => Effect.die(e)));
});

/**
 * queued -> sending | skipped. A sending row (a restarted job, J1a) is re-checked as well: it
 * stays sending (re-dispatch) or is skipped before any further provider call. Terminal rows stay.
 */
export const claim = Effect.fn("claim")(
  (caller: Caller, workspaceId: WorkspaceId, id: DeliveryId) =>
    Effect.flatMap(CoreStore, (store) =>
      store.transaction(
        Effect.gen(function* () {
          const repo = yield* DeliveriesRepo;
          const row = yield* repo.lock(workspaceId, id);
          if (isTerminal(row.status)) return row.status;
          const reason = yield* ineligible(caller, workspaceId, row);
          if (row.status === "sending" && reason === null) return row.status;
          // A sending row may have reached the provider (a job that died before recording the
          // attempt), so skipping it keeps that uncertainty and its reminder step (isReleased).
          const next = yield* transition(workspaceId, id, () =>
            reason === null
              ? { status: "sending" }
              : row.status === "sending"
                ? {
                    status: "skipped",
                    failure: reason,
                    lastOutcome: row.lastOutcome ?? "outcome_unknown",
                  }
                : { status: "skipped", failure: reason },
          );
          return next.status;
        }),
      ),
    ),
);

/** Sends a `sending` delivery; any other status is returned unchanged without sending. */
export const dispatch = Effect.fn("dispatch")(function* (workspaceId: WorkspaceId, id: DeliveryId) {
  const store = yield* CoreStore;
  const row = yield* (yield* DeliveriesRepo).get(workspaceId, id);
  if (row.status !== "sending") return row.status;
  const bytes = yield* (yield* DocumentDeliveryReads).render(
    row.view,
    {
      template: row.attachment.template,
      language: row.language,
    },
    workspaceId,
  );
  const email = yield* EmailSender;
  const outcome = yield* email
    .send(
      {
        to: row.to,
        // OutboundEmail.replyTo is required; an Issuing Entity without an email leaves it to
        // the adapter's default sender (empty string).
        replyTo: row.replyTo ?? "",
        subject: row.subject,
        html: `<p>${escapeHtml(row.subject)}</p>`,
        text: row.subject,
        attachments: [
          { filename: row.attachment.filename, contentType: row.attachment.contentType, bytes },
        ],
        tags: {
          template: row.purpose,
          workspaceId,
          documentId: row.documentId,
          deliveryId: row.id,
          language: row.language,
        },
      },
      { idempotencyKey: row.id },
    )
    .pipe(Effect.result);
  // Counted from the locked row: overlapping attempts (a reconcile re-start) never lose one.
  // A confirmed acceptance is recorded even when retry exhaustion (giveUp) marked the row
  // failed while this attempt was in flight: the email did go out. Otherwise an attempt that
  // finds the delivery terminal leaves its status alone.
  const next = yield* store.transaction(
    transition(workspaceId, id, (current) => {
      const attempts = current.attempts + 1;
      if (outcome._tag === "Success" && current.status !== "sent") {
        return {
          status: "sent",
          attempts,
          failure: null,
          provider: outcome.success.provider,
          providerMessageId: outcome.success.providerMessageId,
        };
      }
      if (current.status !== "sending" || outcome._tag === "Success") return { attempts };
      return outcome.failure._tag === "EmailRejected"
        ? { status: "failed", attempts, failure: "rejected" }
        : {
            attempts,
            lastOutcome:
              outcome.failure._tag === "EmailNotAccepted" ? "not_accepted" : "outcome_unknown",
          };
    }),
  );
  if (
    next.status === "sending" &&
    outcome._tag === "Failure" &&
    outcome.failure._tag !== "EmailRejected"
  ) {
    return yield* DeliveryRetry.make({
      deliveryId: id,
      cause: outcome.failure._tag === "EmailNotAccepted" ? "not_accepted" : "outcome_unknown",
    });
  }
  return next.status;
});

/** sending -> failed after the workflow exhausted its retries. */
export const giveUp = Effect.fnUntraced(function* (
  workspaceId: WorkspaceId,
  id: DeliveryId,
  reason = "retries_exhausted",
) {
  const store = yield* CoreStore;
  const updated = yield* store.transaction(
    transition(workspaceId, id, (row) =>
      row.status === "sending" ? { status: "failed", failure: reason } : null,
    ),
  );
  return updated.status;
});

/** claim, then dispatch when claimed: the delivery's terminal (or retryable) outcome. */
export const deliver = Effect.fn("deliver")(
  (caller: Caller, workspaceId: WorkspaceId, id: DeliveryId) =>
    Effect.filterOrElse(
      claim(caller, workspaceId, id),
      (status) => isTerminal(status),
      () => dispatch(workspaceId, id),
    ),
);

/**
 * OutboxReconcile for deliveries (J1a, cross-tenant; integration runs it from a cron). Restarts
 * the DocumentDelivery job, keyed by the delivery id, for every delivery still `queued` or
 * `sending` whose `updatedAt` is more than `olderThanMillis` old: the job start was lost after
 * the queueing commit, or the job died after `claim` (before or after the provider call).
 *
 * `claim` and every recorded dispatch attempt advance `updatedAt`, so a job that is still
 * working is selected only after it has been silent for the threshold. Even then the start
 * attaches to its live execution by key (J1, `DeliveryJobs`); a start that overlaps a running
 * dispatch anyway can only send again with the same provider key (J2, at least once), and
 * `dispatch` counts attempts from the locked row. The restarted job runs `deliver`: `claim`
 * re-checks eligibility for a queued row (J3), a sending row is dispatched again. One start's
 * failure is logged and does not stop the others. Returns every delivery it tried to restart,
 * including those whose start failed (see the log).
 */
export const reconcileStaleDeliveries = Effect.fn("reconcileStaleDeliveries")(function* (
  olderThanMillis: number,
) {
  const store = yield* CoreStore;
  const repo = yield* DeliveriesRepo;
  const jobs = yield* DeliveryJobs;
  const instant = yield* DateTime.now;
  const before = instant.pipe(DateTime.subtractDuration(olderThanMillis), DateTime.formatIso);
  const rows = yield* store.transaction(repo.findStaleQueuedOrSending(before));
  const restarted = EffectArray.map(rows, (row) => ({
    workspaceId: row.workspaceId,
    deliveryId: row.id,
    status: row.status,
  }));
  yield* Effect.forEach(
    restarted,
    (delivery) =>
      jobs.start(delivery.workspaceId, delivery.deliveryId).pipe(
        // Interruption (shutdown, cron cancel) stops the pass; other failures are logged.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("OutboxReconcile: delivery start failed", delivery, cause),
        ),
      ),
    { discard: true, concurrency: 1 },
  );
  return restarted;
});

const ESCAPE_HTML = new Map([
  ["&", "&#38;"],
  ["<", "&#60;"],
  [">", "&#62;"],
  ['"', "&#34;"],
  ["'", "&#39;"],
]);

const escapeHtml = (s: string) =>
  EffectArray.join(
    EffectArray.map(
      EffectArray.fromIterable(s),
      (character) => ESCAPE_HTML.get(character) ?? character,
    ),
    "",
  );
