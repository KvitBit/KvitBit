/**
 * Job steps of the future `DocumentDelivery` workflow (core-ports 7.2; no workflow is defined
 * this phase). Each runs as the workflow's System caller in its own transaction and is
 * idempotent by the delivery's status, so a replayed Activity or a reconcile re-start (J1a)
 * is harmless:
 * - `claim`: queued -> sending when still eligible (J3 re-check), else skipped;
 * - `dispatch`: sending -> sent, or failed on `EmailRejected` (never retried); the retryable
 *   outcomes leave it sending and fail with `DeliveryRetry` for the Activity's retry policy;
 *   the EmailSender key is always the delivery id (J2);
 * - `giveUp`: sending -> failed once retries are exhausted.
 * `deliver` runs claim then dispatch.
 */
import type { DeliveryId, WorkspaceId } from "@kvitbit/domain/contract";
import { EmailSender } from "@kvitbit/domain/ports";
import { Data, Effect } from "effect";
import { CoreStore } from "../../../store/CoreStore";
import { DocumentDeliveryReads } from "../delivery";
import { reminderState, stepBlock } from "../reminders/eligibility";
import { stillOwed } from "../reminders/policy";
import { DocumentsRepo } from "../repo";
import { now } from "../support";
import type { DeliveryRecord } from "./record";
import { isTerminal } from "./record";
import { DeliveriesRepo } from "./repo";

/**
 * The provider did not take the message for certain (`not_accepted`: retrying or failing
 * over is safe) or may have (`outcome_unknown`: retry the same provider with the same key
 * only). The delivery stays `sending`; the workflow retries `dispatch`, then `giveUp`.
 */
export class DeliveryRetry extends Data.TaggedError("DeliveryRetry")<{
  readonly deliveryId: DeliveryId;
  readonly cause: "not_accepted" | "outcome_unknown";
}> {}

/** Why a queued delivery is no longer sent (J3), or null when it still is. */
const ineligible = (workspaceId: WorkspaceId, delivery: DeliveryRecord) =>
  Effect.gen(function* () {
    const record = yield* (yield* DocumentsRepo).get(workspaceId, delivery.documentId);
    if (record.status === "cancelled") return "document_cancelled";
    if (delivery.purpose === "document") return null;
    if (!stillOwed(record)) return "document_settled";
    if (delivery.reminder === null) return null; // a manual reminder (D14)
    // Automatic reminder: the same check as selection and enqueue (reminders/eligibility.ts).
    const { today } = yield* now;
    const state = yield* reminderState(workspaceId, record, today);
    return stepBlock(state, record, delivery.reminder, today, delivery.id);
  });

const transition = (
  workspaceId: WorkspaceId,
  id: DeliveryId,
  change: (row: DeliveryRecord) => Partial<DeliveryRecord> | null,
) =>
  Effect.gen(function* () {
    const repo = yield* DeliveriesRepo;
    const row = yield* repo.lock(workspaceId, id);
    const patch = change(row);
    if (patch === null) return row;
    const { at } = yield* now;
    return yield* repo
      .update({ ...row, ...patch, updatedAt: at }, row.revision)
      .pipe(Effect.catchTag("Conflict", (e) => Effect.die(e)));
  });

/** queued -> sending | skipped. A sending row stays sending (re-dispatch); terminal rows stay. */
export const claim = (workspaceId: WorkspaceId, id: DeliveryId) =>
  Effect.flatMap(CoreStore, (store) =>
    store.transaction(
      Effect.gen(function* () {
        const repo = yield* DeliveriesRepo;
        const row = yield* repo.lock(workspaceId, id);
        if (row.status !== "queued") return row.status;
        const reason = yield* ineligible(workspaceId, row);
        const next = yield* transition(workspaceId, id, () =>
          reason === null ? { status: "sending" } : { status: "skipped", failure: reason },
        );
        return next.status;
      }),
    ),
  );

/** Sends a `sending` delivery; any other status is returned unchanged without sending. */
export const dispatch = (workspaceId: WorkspaceId, id: DeliveryId) =>
  Effect.gen(function* () {
    const store = yield* CoreStore;
    const row = yield* (yield* DeliveriesRepo).get(workspaceId, id);
    if (row.status !== "sending") return row.status;
    const bytes = yield* (yield* DocumentDeliveryReads).render(row.view, {
      template: row.attachment.template,
      language: row.language,
    });
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
    const attempts = row.attempts + 1;
    const next = yield* store.transaction(
      transition(workspaceId, id, (current) => {
        if (current.status !== "sending") return null;
        if (outcome._tag === "Success") {
          return {
            status: "sent",
            attempts,
            failure: null,
            provider: outcome.success.provider,
            providerMessageId: outcome.success.providerMessageId,
          };
        }
        return outcome.failure._tag === "EmailRejected"
          ? { status: "failed", attempts, failure: "rejected" }
          : {
              attempts,
              lastOutcome:
                outcome.failure._tag === "EmailNotAccepted" ? "not_accepted" : "outcome_unknown",
            };
      }),
    );
    if (outcome._tag === "Failure" && outcome.failure._tag !== "EmailRejected") {
      return yield* new DeliveryRetry({
        deliveryId: id,
        cause: outcome.failure._tag === "EmailNotAccepted" ? "not_accepted" : "outcome_unknown",
      });
    }
    return next.status;
  });

/** sending -> failed after the workflow exhausted its retries. */
export const giveUp = (workspaceId: WorkspaceId, id: DeliveryId, reason = "retries_exhausted") =>
  Effect.flatMap(CoreStore, (store) =>
    store.transaction(
      Effect.map(
        transition(workspaceId, id, (row) =>
          row.status === "sending" ? { status: "failed", failure: reason } : null,
        ),
        (row) => row.status,
      ),
    ),
  );

/** claim, then dispatch when claimed: the delivery's terminal (or retryable) outcome. */
export const deliver = (workspaceId: WorkspaceId, id: DeliveryId) =>
  Effect.flatMap(claim(workspaceId, id), (status) =>
    isTerminal(status) ? Effect.succeed(status) : dispatch(workspaceId, id),
  );

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
