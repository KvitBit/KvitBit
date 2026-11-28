/**
 * The Document state machine (core-ports 4.4 lifecycle; rules D2, D3a, D5, D6, D13): one table
 * of lifecycle state x action, shared by every Documents method (P2 lifecycle, P3 corrections
 * and the Final Invoice, the payments seam and stage-2 delivery/share links).
 *
 * The table covers what the state alone decides. Rules that depend on the document's kind,
 * payments or links are the named guards below it (`paymentsBlockCancel`, `hasFinalInvoice`,
 * `hasDependents`); `settlementOf` (credit.ts) derives the stored settlement.
 */

import type { ConflictReason } from "@kvitbit/domain/contract";
import { Conflict } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import type { DocumentRecord } from "./record";

/** `issued` split by the Document Lock; a cancelled document is always locked (D5). */
export type LifecycleState = "draft" | "issued" | "locked" | "cancelled";

export type LifecycleAction =
  | "edit"
  | "discard"
  | "issue"
  | "lock"
  | "unlock"
  | "cancel"
  | "correct"
  | "finalInvoice"
  | "send"
  | "share"
  | "recordPayment";

export const LIFECYCLE_STATES: ReadonlyArray<LifecycleState> = [
  "draft",
  "issued",
  "locked",
  "cancelled",
];

export const LIFECYCLE_ACTIONS: ReadonlyArray<LifecycleAction> = [
  "edit",
  "discard",
  "issue",
  "lock",
  "unlock",
  "cancel",
  "correct",
  "finalInvoice",
  "send",
  "share",
  "recordPayment",
];

/**
 * `ok`: the action runs. `noop`: already in the target state; the method returns the current
 * view without a write or an audit entry (lock is idempotent, D5). Otherwise the Conflict reason.
 */
export type TransitionOutcome =
  | "ok"
  | "noop"
  | Extract<ConflictReason, "illegal_transition" | "document_locked">;

const ILLEGAL = "illegal_transition" as const;
const LOCKED = "document_locked" as const;

export const TRANSITIONS: Readonly<
  Record<LifecycleState, Readonly<Record<LifecycleAction, TransitionOutcome>>>
> = {
  // D13: send, share, lock, cancel, correct and issueFinalInvoice need an issued document.
  draft: {
    edit: "ok",
    discard: "ok",
    issue: "ok",
    lock: ILLEGAL,
    unlock: ILLEGAL,
    cancel: ILLEGAL,
    correct: ILLEGAL,
    finalInvoice: ILLEGAL,
    send: ILLEGAL,
    share: ILLEGAL,
    recordPayment: ILLEGAL,
  },
  // D2: no hard delete after issue; issuing twice never allocates a second number.
  issued: {
    edit: "ok",
    discard: ILLEGAL,
    issue: ILLEGAL,
    lock: "ok",
    unlock: "noop",
    cancel: "ok",
    correct: "ok",
    finalInvoice: "ok",
    send: "ok",
    share: "ok",
    recordPayment: "ok",
  },
  // D5: edit, cancel and correct fail on a locked document; payments, sending, sharing work.
  locked: {
    edit: LOCKED,
    discard: ILLEGAL,
    issue: ILLEGAL,
    lock: "noop",
    unlock: "ok",
    cancel: LOCKED,
    correct: LOCKED,
    finalInvoice: "ok",
    send: "ok",
    share: "ok",
    recordPayment: "ok",
  },
  // D3a: a cancelled document accepts no edits; it is always locked (D5), so lock is a no-op.
  cancelled: {
    edit: ILLEGAL,
    discard: ILLEGAL,
    issue: ILLEGAL,
    lock: "noop",
    unlock: ILLEGAL,
    cancel: ILLEGAL,
    correct: ILLEGAL,
    finalInvoice: ILLEGAL,
    send: ILLEGAL,
    share: ILLEGAL,
    recordPayment: ILLEGAL,
  },
};

export const stateOf = (row: Pick<DocumentRecord, "status" | "locked">): LifecycleState =>
  row.status === "issued" ? (row.locked ? "locked" : "issued") : row.status;

export const outcomeOf: {
  (action: LifecycleAction): (row: Pick<DocumentRecord, "status" | "locked">) => TransitionOutcome;
  (row: Pick<DocumentRecord, "status" | "locked">, action: LifecycleAction): TransitionOutcome;
} = Fn.dual(
  2,
  (row: Pick<DocumentRecord, "status" | "locked">, action: LifecycleAction): TransitionOutcome =>
    TRANSITIONS[stateOf(row)][action],
);

/**
 * Checks `action` against the table: succeeds with `ok` or `noop`, fails with the Conflict
 * (no `detail`) otherwise.
 */
export const guard: {
  (
    action: LifecycleAction,
  ): (row: Pick<DocumentRecord, "status" | "locked">) => Effect.Effect<"ok" | "noop", Conflict>;
  (
    row: Pick<DocumentRecord, "status" | "locked">,
    action: LifecycleAction,
  ): Effect.Effect<"ok" | "noop", Conflict>;
} = Fn.dual(
  2,
  (
    row: Pick<DocumentRecord, "status" | "locked">,
    action: LifecycleAction,
  ): Effect.Effect<"ok" | "noop", Conflict> => {
    const outcome = outcomeOf(row, action);
    return outcome === "ok" || outcome === "noop"
      ? Effect.succeed(outcome)
      : Effect.fail(Conflict.make({ reason: outcome }));
  },
);

/** The document has a Final Invoice (rule D8 link on the Proforma). */
export const hasFinalInvoice = (row: Pick<DocumentRecord, "links">): boolean =>
  EffectArray.some(row.links, (l) => l.relation === "final_invoice_for");

/** D6: a document with recorded payments cannot be cancelled until they are removed. */
export const paymentsBlockCancel = (row: Pick<DocumentRecord, "payments">): boolean =>
  row.payments > 0;

/**
 * D3a: another document depends on this one's lines, currency and tax point: a Proforma with
 * payments (its Payment Tax Documents follow them) or a Final Invoice; an Invoice or Payment
 * Tax Document with a Credit Note.
 */
export const hasDependents = (row: Pick<DocumentRecord, "kind" | "payments" | "links">): boolean =>
  (row.kind === "proforma" && row.payments > 0) ||
  EffectArray.some(
    row.links,
    (l) => l.relation === "corrected_by" || l.relation === "final_invoice_for",
  );
