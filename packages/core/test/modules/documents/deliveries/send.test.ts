import { TestCaller } from "../../../helpers/callerContext";
/** Documents.send / previewSend and the DocumentDelivery job steps on real layers. */

import { describe, expect, test } from "bun:test";
import type { DeliveryId } from "@kvitbit/domain/contract";
import {
  Conflict,
  DocumentId,
  Documents,
  Forbidden,
  Invalid,
  IsoDate,
  NotFound,
  RequestKey,
  ScheduleId,
} from "@kvitbit/domain/contract";
import { EmailNotAccepted, EmailSender } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { DocumentsModule } from "../../../../src/index";
import { systemCaller } from "../../../../src/internal/system";
import {
  claim,
  DeliveriesRepo,
  DeliveryRetry,
  DocumentsRepo,
  deliver,
  dispatch,
  StartedDeliveries,
} from "../../../../src/modules/documents";
import { CoreStore } from "../../../../src/store/CoreStore";
import { CaptureEmailSender } from "../../../../src/testing";
import { member, system, WORKSPACE_A, WORKSPACE_B } from "../../../helpers";
import { as, B_BUYER, DE_BUYER, dec, invoiceInput } from "../fixtures";
import { issueInvoice, patchDocument, deliveryScenario as run } from "./helpers";

const worker = system();

const delivery = (id: DeliveryId) => Effect.flatMap(DeliveriesRepo, (r) => r.get(WORKSPACE_A, id));
const sent = Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.sent));
const attempts = Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.attempts));

describe("Documents.send", () => {
  test("queues a delivery with its snapshot, stores the reminder choice, audits, starts the job", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const before = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        const result = yield* d.send(testCaller, id);
        expect(result.status).toBe("queued");
        const row = yield* delivery(result.deliveryId);
        expect(row).toMatchObject({
          documentId: id,
          purpose: "document",
          status: "queued",
          to: ["fakturace@odberatel.cz"],
          language: "cs",
          reminder: null,
          documentRevision: before.revision + 1,
        });
        expect(row.subject).toBe(`Faktura ${before.number} – Dodavatel s.r.o.`);
        expect(row.attachment.filename).toBe(`${before.number}.pdf`);
        const after = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        expect(after).toMatchObject({ remindersChoice: "inherit", remindersOn: true });
        expect(after.revision).toBe(before.revision + 1);
        const StartedDeliveries_1 = yield* StartedDeliveries;
        const started = yield* Ref.get(StartedDeliveries_1);
        expect(started).toEqual([{ workspaceId: WORKSPACE_A, deliveryId: result.deliveryId }]);
        const history = yield* d.history(testCaller, id);
        const audit = history.at(-1);
        expect(audit?.action).toBe("document.send");
        expect(audit?.changes).toContainEqual({
          path: "delivery",
          before: null,
          after: result.deliveryId,
        });
        // Each send is a new delivery (D13); an unchanged choice leaves the revision alone.
        const again = yield* d.send(testCaller, id);
        expect(again.deliveryId).not.toBe(result.deliveryId);
        expect((yield* (yield* DocumentsRepo).get(WORKSPACE_A, id)).revision).toBe(after.revision);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("explicit recipients and language; invalid or missing recipients are Invalid", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const r = yield* d.send(testCaller, id, { to: [" a@b.cz ", "a@b.cz"], language: "en" });
        const row = yield* delivery(r.deliveryId);
        expect(row.to).toEqual(["a@b.cz"]);
        expect(EffectString.startsWith("Invoice ")(row.subject)).toBe(true);
        const bad = yield* Effect.flip(d.send(testCaller, id, { to: ["nope"] }));
        expect(bad).toBeInstanceOf(Invalid);
        Schema.asserts(Invalid, bad);
        expect(bad.issues[0]).toMatchObject({
          path: ["to", 0],
          params: { reason: "email_invalid" },
        });
        const none = yield* Effect.flip(d.send(testCaller, id, { to: [] }));
        Schema.asserts(Invalid, none);
        expect(none.issues[0]?.params).toEqual({ reason: "recipients_required" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("authorization: document.send needs a writer; scoped read keys are Forbidden", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const accountant = yield* Effect.flip(
          as(member("accountant"), d.send(member("accountant"), id)),
        );
        expect(accountant).toBeInstanceOf(Forbidden);
        const reader = member("owner", { scopes: ["documents:read"] });
        const sendFailure = yield* Effect.flip(as(reader, d.send(reader, id)));
        expect(sendFailure).toBeInstanceOf(Forbidden);
        const previewSendFailure = yield* Effect.flip(as(reader, d.previewSend(reader, id)));
        expect(previewSendFailure).toBeInstanceOf(Forbidden);
        // The member role writes documents.
        yield* as(member("member"), d.send(member("member"), id));
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("another Workspace's document is NotFound", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const bCaller = member("owner", { workspaceId: WORKSPACE_B });
        const inB = yield* as(
          bCaller,
          d.issue(bCaller, {
            input: invoiceInput({
              contact: B_BUYER,
              lines: [{ description: "Služba", unitPrice: dec("100") }],
            }),
          }),
        );
        const sendFailure = yield* Effect.flip(d.send(testCaller, inB.id));
        expect(sendFailure).toBeInstanceOf(NotFound);
        const previewSendFailure = yield* Effect.flip(d.previewSend(testCaller, inB.id));
        expect(previewSendFailure).toBeInstanceOf(NotFound);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("drafts and cancelled documents are illegal transitions (D13)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const draft = yield* d.createDraft(testCaller, invoiceInput());
        const e1 = yield* Effect.flip(d.send(testCaller, draft.id));
        expect(e1).toEqual(Conflict.make({ reason: "illegal_transition" }));
        const flipResult = yield* Effect.flip(d.previewSend(testCaller, draft.id));
        expect(flipResult).toEqual(Conflict.make({ reason: "illegal_transition" }));
        // A non-tax (non_vat_payer-like) cancel: Proformas are always non-tax.
        const proforma = yield* d.issue(testCaller, { input: invoiceInput({ kind: "proforma" }) });
        yield* d.cancel(testCaller, proforma.id, { reason: "chyba" });
        const flipResult2 = yield* Effect.flip(d.send(testCaller, proforma.id));
        expect(flipResult2).toEqual(Conflict.make({ reason: "illegal_transition" }));
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a send bumps the document revision: a stale edit is a revision conflict", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const before = yield* d.get(testCaller, id);
        yield* d.send(testCaller, id, { reminders: false });
        const stale = yield* Effect.flip(d.edit(testCaller, id, { note: "x" }, before.revision));
        expect(stale).toMatchObject({ _tag: "Conflict", reason: "revision_changed" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("requestKey replays the same delivery; a different payload is a mismatch (C3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const key = { requestKey: RequestKey.make("send-1") };
        const first = yield* d.send(testCaller, id, { reminders: true }, key);
        const replay = yield* d.send(testCaller, id, { reminders: true }, key);
        expect(replay).toEqual(first);
        const byDocumentResult = yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id);
        expect(byDocumentResult).toHaveLength(1);
        const mismatch = yield* Effect.flip(d.send(testCaller, id, { reminders: false }, key));
        expect(mismatch).toMatchObject({ _tag: "Conflict", reason: "idempotency_mismatch" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("issue with send queues the delivery inside issue's transaction", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const view = yield* d.issue(
          testCaller,
          { input: invoiceInput() },
          { requestKey: RequestKey.make("issue-send"), send: { reminders: false } },
        );
        const rows = yield* (yield* DeliveriesRepo).byDocument(
          WORKSPACE_A,
          DocumentId.make(view.id),
        );
        expect(EffectArray.map(rows, (r) => r.status)).toEqual(["queued"]);
        expect((yield* (yield* DocumentsRepo).get(WORKSPACE_A, view.id)).remindersChoice).toBe(
          "off",
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("System caller (recurring issuance, #399): send without requestKey nested in its transaction", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const recurring = systemCaller(WORKSPACE_A, {
          _tag: "RecurringIssuance",
          scheduleId: ScheduleId.make("01900000-0000-7000-8000-0000000000aa"),
          occurrence: IsoDate.make("2026-11-23"),
        });
        const store = yield* CoreStore;
        const result = yield* as(
          recurring,
          store.transaction(
            Effect.gen(function* () {
              const view = yield* d.issue(recurring, { input: invoiceInput() }, undefined);
              return yield* d.send(recurring, view.id, undefined, undefined);
            }),
          ),
        );
        const row = yield* delivery(result.deliveryId);
        expect(row.status).toBe("queued");
        const history = yield* d.history(testCaller, row.documentId);
        expect(history.at(-1)?.actor).toMatchObject({ _tag: "System" });
        const startedDeliveries = yield* StartedDeliveries;
        // Started only after the outer commit.
        const started = yield* Ref.get(startedDeliveries);
        expect(EffectArray.map(started, (entry) => entry.deliveryId)).toEqual([result.deliveryId]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a failing outer transaction drops the queued delivery and its job start", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const store = yield* CoreStore;
        const failed = yield* Effect.exit(
          store.transaction(Effect.andThen(d.send(testCaller, id), Effect.fail("boom" as const))),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        const byDocumentResult = yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id);
        expect(byDocumentResult).toHaveLength(0);
        const startedDeliveries = yield* StartedDeliveries;
        const getResult = yield* Ref.get(startedDeliveries);
        expect(getResult).toHaveLength(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("Documents.previewSend", () => {
  test("reports what send would do and stores nothing (D15)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const before = yield* d.get(testCaller, id);
        const preview = yield* d.previewSend(testCaller, id);
        expect(preview).toEqual({
          purpose: "document",
          to: ["fakturace@odberatel.cz"],
          language: "cs",
          subject: `Faktura ${before.number} – Dodavatel s.r.o.`,
          attachments: [{ filename: `${before.number}.pdf`, contentType: "application/pdf" }],
          armsReminders: true,
        });
        expect((yield* d.previewSend(testCaller, id, { reminders: false })).armsReminders).toBe(
          false,
        );
        expect((yield* d.previewSend(testCaller, id, { purpose: "reminder" })).armsReminders).toBe(
          false,
        );
        expect((yield* d.get(testCaller, id)).revision).toBe(before.revision);
        const byDocumentResult = yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id);
        expect(byDocumentResult).toHaveLength(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("manual reminder (D14)", () => {
  test("needs an owed Invoice or Proforma and never changes the reminder choice", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* d.send(testCaller, id, { reminders: false });
        const before = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        const r = yield* d.send(testCaller, id, { purpose: "reminder", reminders: true });
        const row = yield* delivery(r.deliveryId);
        expect(row).toMatchObject({ purpose: "reminder", reminder: null });
        expect(EffectString.startsWith("Upomínka: Faktura")(row.subject)).toBe(true);
        const after = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        expect(after).toMatchObject({ remindersChoice: "off", remindersOn: false });
        expect(after.revision).toBe(before.revision);
        // A paid document is settled.
        yield* patchDocument(id, { settlement: "paid" });
        const settled = yield* Effect.flip(d.send(testCaller, id, { purpose: "reminder" }));
        expect(settled).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "reminder.document_settled" }),
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("DocumentDelivery job steps", () => {
  const queued = Effect.gen(function* () {
    const testCaller = yield* TestCaller;
    const id = yield* issueInvoice();
    const { deliveryId } = yield* (yield* Documents).send(testCaller, id);
    return { id, deliveryId };
  });

  test("claim then dispatch sends once with the delivery id as key and the rendered PDF", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        const result = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("sent");
        const emails = yield* sent;
        expect(emails).toHaveLength(1);
        expect(emails[0]?.idempotencyKey).toBe(deliveryId);
        expect(emails[0]?.message.to).toEqual(["fakturace@odberatel.cz"]);
        expect(emails[0]?.message.attachments[0]?.contentType).toBe("application/pdf");
        expect(emails[0]?.message.attachments[0]?.bytes.length).toBeGreaterThan(0);
        const result2 = yield* delivery(deliveryId);
        expect(result2).toMatchObject({
          status: "sent",
          attempts: 1,
          provider: "capture",
        });
        const result3 = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        // Replays are no-ops (idempotent by status).
        expect(result3).toBe("sent");
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(1);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("the snapshot is sent even after the document was edited (J3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const { id, deliveryId } = yield* queued;
        const queuedView = (yield* delivery(deliveryId)).view;
        const current = yield* d.get(testCaller, id);
        yield* d.edit(testCaller, id, { note: "Nová poznámka" }, current.revision);
        yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect((yield* delivery(deliveryId)).view).toEqual(queuedView);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("EmailRejected fails the delivery and is never retried", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        yield* CaptureEmailSender.failNext("rejected");
        const result = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("failed");
        const result2 = yield* delivery(deliveryId);
        expect(result2).toMatchObject({
          status: "failed",
          failure: "rejected",
        });
        const result3 = yield* as(worker, dispatch(WORKSPACE_A, deliveryId));
        expect(result3).toBe("failed");
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(1);
        const sent_1 = yield* sent;
        expect(sent_1).toHaveLength(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("EmailNotAccepted stays sending and retries safely with the same key", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        yield* CaptureEmailSender.failNext("not_accepted");
        const retry = yield* Effect.flip(as(worker, deliver(worker, WORKSPACE_A, deliveryId)));
        expect(retry).toEqual(DeliveryRetry.make({ deliveryId, cause: "not_accepted" }));
        const result = yield* delivery(deliveryId);
        expect(result).toMatchObject({
          status: "sending",
          attempts: 1,
          lastOutcome: "not_accepted",
        });
        const result2 = yield* as(worker, claim(worker, WORKSPACE_A, deliveryId));
        // A reconcile re-start claims nothing new and re-dispatches.
        expect(result2).toBe("sending");
        const result3 = yield* as(worker, dispatch(WORKSPACE_A, deliveryId));
        expect(result3).toBe("sent");
        const emails = yield* sent;
        expect(EffectArray.map(emails, (e) => e.idempotencyKey)).toEqual([deliveryId]);
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(2);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("EmailOutcomeUnknown retries with the same key; exhausted retries fail the delivery", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        yield* CaptureEmailSender.failNext("outcome_unknown", "outcome_unknown");
        const first = yield* Effect.flip(as(worker, deliver(worker, WORKSPACE_A, deliveryId)));
        expect(first).toEqual(DeliveryRetry.make({ deliveryId, cause: "outcome_unknown" }));
        const second = yield* Effect.flip(as(worker, dispatch(WORKSPACE_A, deliveryId)));
        expect(second).toEqual(DeliveryRetry.make({ deliveryId, cause: "outcome_unknown" }));
        const result = yield* delivery(deliveryId);
        expect(result).toMatchObject({
          status: "sending",
          lastOutcome: "outcome_unknown",
        });
        const result2 = yield* as(worker, DocumentsModule.giveUp(WORKSPACE_A, deliveryId));
        expect(result2).toBe("failed");
        const result3 = yield* delivery(deliveryId);
        expect(result3).toMatchObject({
          status: "failed",
          attempts: 2,
          failure: "retries_exhausted",
        });
        const result4 = yield* as(worker, dispatch(WORKSPACE_A, deliveryId));
        expect(result4).toBe("failed");
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(2);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a document cancelled after queueing is skipped at claim (J3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const proforma = yield* d.issue(testCaller, { input: invoiceInput({ kind: "proforma" }) });
        const { deliveryId } = yield* d.send(testCaller, proforma.id);
        yield* d.cancel(testCaller, proforma.id, { reason: "chyba" });
        const result = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("skipped");
        const result2 = yield* delivery(deliveryId);
        expect(result2).toMatchObject({ failure: "document_cancelled" });
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("job steps are Workspace scoped", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        const other = system(undefined, WORKSPACE_B);
        const failureResult = yield* Effect.flip(as(other, claim(other, WORKSPACE_B, deliveryId)));
        expect(failureResult).toBeInstanceOf(NotFound);
        const statuses = yield* (yield* DeliveriesRepo).statuses(WORKSPACE_B, [deliveryId]);
        expect(statuses.size).toBe(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("council round: ordering, language, overlapping attempts", () => {
  const queued = Effect.gen(function* () {
    const testCaller = yield* TestCaller;
    const id = yield* issueInvoice();
    const { deliveryId } = yield* (yield* Documents).send(testCaller, id);
    return { id, deliveryId };
  });

  test("the snapshot is taken in the delivery's language (statutory notes)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const view = yield* d.issue(testCaller, {
          input: invoiceInput({
            contact: DE_BUYER,
            lines: [{ description: "Consulting", unitPrice: dec("1000") }],
          }),
        });
        const cs = yield* d.send(testCaller, view.id, { language: "cs" });
        const en = yield* d.send(testCaller, view.id, { language: "en" });
        const notes = (id: DeliveryId) =>
          Effect.map(delivery(id), (row) => row.view.statutoryNotes);
        const csNotes = yield* notes(cs.deliveryId);
        expect(csNotes.length).toBeGreaterThan(0);
        const result = yield* notes(en.deliveryId);
        expect(result).not.toEqual(csNotes);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("deliveries carry a per-document sequence, also for sends in one transaction at one instant", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const store = yield* CoreStore;
        yield* store.transaction(
          Effect.andThen(
            d.send(testCaller, id, { to: ["a@x.cz"] }),
            d.send(testCaller, id, { to: ["b@x.cz"] }),
          ),
        );
        const rows = yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id);
        expect(EffectArray.map(rows, (r) => [r.sequence, r.to])).toEqual([
          [1, ["a@x.cz"]],
          [2, ["b@x.cz"]],
        ]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a retryable attempt that completes after another attempt sent the delivery raises no retry", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        const result = yield* as(worker, claim(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("sending");
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const slow = EmailSender.of({
          send: () =>
            Effect.andThen(
              Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate)),
              Effect.fail(EmailNotAccepted.make({})),
            ),
        });
        const first = yield* Effect.forkChild(
          as(worker, dispatch(WORKSPACE_A, deliveryId)).pipe(
            Effect.provideService(EmailSender, slow),
          ),
        );
        yield* Deferred.await(reached);
        const result2 = yield* as(worker, dispatch(WORKSPACE_A, deliveryId));
        expect(result2).toBe("sent");
        yield* Deferred.succeed(gate, undefined);
        const joinResult = yield* Fiber.join(first);
        expect(joinResult).toBe("sent");
        const result3 = yield* delivery(deliveryId);
        expect(result3).toMatchObject({ status: "sent", attempts: 2 });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("an accepted email in flight while retries were exhausted is recorded as sent", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        const result = yield* as(worker, claim(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("sending");
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const slow = EmailSender.of({
          send: () =>
            Effect.andThen(
              Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(gate)),
              Effect.succeed({ provider: "slow", providerMessageId: "slow-1" }),
            ),
        });
        const inFlight = yield* Effect.forkChild(
          as(worker, dispatch(WORKSPACE_A, deliveryId)).pipe(
            Effect.provideService(EmailSender, slow),
          ),
        );
        yield* Deferred.await(reached);
        const result2 = yield* as(
          worker,
          DocumentsModule.giveUp(WORKSPACE_A, deliveryId, "operator_cancelled"),
        );
        expect(result2).toBe("failed");
        const failed = yield* delivery(deliveryId);
        expect(failed).toMatchObject({ failure: "operator_cancelled" });
        yield* Deferred.succeed(gate, undefined);
        const joinResult = yield* Fiber.join(inFlight);
        expect(joinResult).toBe("sent");
        const result3 = yield* delivery(deliveryId);
        expect(result3).toMatchObject({
          status: "sent",
          failure: null,
          provider: "slow",
          providerMessageId: "slow-1",
        });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
