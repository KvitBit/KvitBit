/** Documents.send / previewSend and the DocumentDelivery job steps on real layers. */
import { describe, expect, test } from "bun:test";
import type { DeliveryId, DocumentId, RequestKey } from "@kvitbit/domain/contract";
import { Conflict, Documents, Forbidden, Invalid, NotFound } from "@kvitbit/domain/contract";
import { Effect, Exit, Ref } from "effect";
import { systemCaller } from "../../../../src/internal/system";
import {
  claim,
  DeliveriesRepo,
  DeliveryRetry,
  DocumentsRepo,
  deliver,
  dispatch,
  giveUp,
  StartedDeliveries,
} from "../../../../src/modules/documents";
import { CoreStore } from "../../../../src/store/CoreStore";
import { CaptureEmailSender } from "../../../../src/testing";
import { member, system, WORKSPACE_A, WORKSPACE_B } from "../../../helpers";
import { as, B_BUYER, dec, invoiceInput } from "../fixtures";
import { deliveryScenario, issueInvoice, patchDocument } from "./helpers";

const run = deliveryScenario;

const worker = system();

const delivery = (id: DeliveryId) => Effect.flatMap(DeliveriesRepo, (r) => r.get(WORKSPACE_A, id));
const sent = Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.sent));
const attempts = Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.attempts));

describe("Documents.send", () => {
  test("queues a delivery with its snapshot, stores the reminder choice, audits, starts the job", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const before = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        const result = yield* d.send(id);
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
        const started = yield* Ref.get(yield* StartedDeliveries);
        expect(started).toEqual([{ workspaceId: WORKSPACE_A, deliveryId: result.deliveryId }]);
        const history = yield* d.history(id);
        const audit = history.at(-1);
        expect(audit?.action).toBe("document.send");
        expect(audit?.changes).toContainEqual({
          path: "delivery",
          before: null,
          after: result.deliveryId,
        });
        // Each send is a new delivery (D13); an unchanged choice leaves the revision alone.
        const again = yield* d.send(id);
        expect(again.deliveryId).not.toBe(result.deliveryId);
        expect((yield* (yield* DocumentsRepo).get(WORKSPACE_A, id)).revision).toBe(after.revision);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("explicit recipients and language; invalid or missing recipients are Invalid", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const r = yield* d.send(id, { to: [" a@b.cz ", "a@b.cz"], language: "en" });
        const row = yield* delivery(r.deliveryId);
        expect(row.to).toEqual(["a@b.cz"]);
        expect(row.subject.startsWith("Invoice ")).toBe(true);
        const bad = yield* Effect.flip(d.send(id, { to: ["nope"] }));
        expect(bad).toBeInstanceOf(Invalid);
        expect((bad as Invalid).issues[0]).toMatchObject({
          path: ["to", 0],
          params: { reason: "email_invalid" },
        });
        const none = yield* Effect.flip(d.send(id, { to: [] }));
        expect((none as Invalid).issues[0]?.params).toEqual({ reason: "recipients_required" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("authorization: document.send needs a writer; scoped read keys are Forbidden", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const accountant = yield* Effect.flip(as(member("accountant"), d.send(id)));
        expect(accountant).toBeInstanceOf(Forbidden);
        const reader = member("owner", { scopes: ["documents:read"] });
        expect(yield* Effect.flip(as(reader, d.send(id)))).toBeInstanceOf(Forbidden);
        expect(yield* Effect.flip(as(reader, d.previewSend(id)))).toBeInstanceOf(Forbidden);
        // The member role writes documents.
        yield* as(member("member"), d.send(id));
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("another Workspace's document is NotFound", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const bCaller = member("owner", { workspaceId: WORKSPACE_B });
        const inB = yield* as(
          bCaller,
          d.issue({
            input: invoiceInput({
              contact: B_BUYER,
              lines: [{ description: "Služba", unitPrice: dec("100") }],
            }),
          }),
        );
        expect(yield* Effect.flip(d.send(inB.id))).toBeInstanceOf(NotFound);
        expect(yield* Effect.flip(d.previewSend(inB.id))).toBeInstanceOf(NotFound);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("drafts and cancelled documents are illegal transitions (D13)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const draft = yield* d.createDraft(invoiceInput());
        const e1 = yield* Effect.flip(d.send(draft.id));
        expect(e1).toEqual(new Conflict({ reason: "illegal_transition" }));
        expect(yield* Effect.flip(d.previewSend(draft.id))).toEqual(
          new Conflict({ reason: "illegal_transition" }),
        );
        // A non-tax (non_vat_payer-like) cancel: Proformas are always non-tax.
        const proforma = yield* d.issue({ input: invoiceInput({ kind: "proforma" }) });
        yield* d.cancel(proforma.id, { reason: "chyba" });
        expect(yield* Effect.flip(d.send(proforma.id))).toEqual(
          new Conflict({ reason: "illegal_transition" }),
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a send bumps the document revision: a stale edit is a revision conflict", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const before = yield* d.get(id);
        yield* d.send(id, { reminders: false });
        const stale = yield* Effect.flip(d.edit(id, { note: "x" }, before.revision));
        expect(stale).toMatchObject({ _tag: "Conflict", reason: "revision_changed" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("requestKey replays the same delivery; a different payload is a mismatch (C3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const key = { requestKey: "send-1" as RequestKey };
        const first = yield* d.send(id, { reminders: true }, key);
        const replay = yield* d.send(id, { reminders: true }, key);
        expect(replay).toEqual(first);
        expect(yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id)).toHaveLength(1);
        const mismatch = yield* Effect.flip(d.send(id, { reminders: false }, key));
        expect(mismatch).toMatchObject({ _tag: "Conflict", reason: "idempotency_mismatch" });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("issue with send queues the delivery inside issue's transaction", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const view = yield* d.issue(
          { input: invoiceInput() },
          { requestKey: "issue-send" as RequestKey, send: { reminders: false } },
        );
        const rows = yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, view.id as DocumentId);
        expect(rows.map((r) => r.status)).toEqual(["queued"]);
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
        const d = yield* Documents;
        const recurring = systemCaller(WORKSPACE_A, {
          _tag: "RecurringIssuance",
          scheduleId: "01900000-0000-7000-8000-0000000000aa" as never,
          occurrence: "2026-11-23" as never,
        });
        const store = yield* CoreStore;
        const result = yield* as(
          recurring,
          store.transaction(
            Effect.gen(function* () {
              const view = yield* d.issue({ input: invoiceInput() }, undefined);
              return yield* d.send(view.id, undefined, undefined);
            }),
          ),
        );
        const row = yield* delivery(result.deliveryId);
        expect(row.status).toBe("queued");
        const history = yield* d.history(row.documentId);
        expect(history.at(-1)?.actor).toMatchObject({ _tag: "System" });
        // Started only after the outer commit.
        expect((yield* Ref.get(yield* StartedDeliveries)).map((s) => s.deliveryId)).toEqual([
          result.deliveryId,
        ]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a failing outer transaction drops the queued delivery and its job start", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const store = yield* CoreStore;
        const failed = yield* Effect.exit(
          store.transaction(Effect.andThen(d.send(id), Effect.fail("boom" as const))),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id)).toHaveLength(0);
        expect(yield* Ref.get(yield* StartedDeliveries)).toHaveLength(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("Documents.previewSend", () => {
  test("reports what send would do and stores nothing (D15)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        const before = yield* d.get(id);
        const preview = yield* d.previewSend(id);
        expect(preview).toEqual({
          purpose: "document",
          to: ["fakturace@odberatel.cz"],
          language: "cs",
          subject: `Faktura ${before.number} – Dodavatel s.r.o.`,
          attachments: [{ filename: `${before.number}.pdf`, contentType: "application/pdf" }],
          armsReminders: true,
        });
        expect((yield* d.previewSend(id, { reminders: false })).armsReminders).toBe(false);
        expect((yield* d.previewSend(id, { purpose: "reminder" })).armsReminders).toBe(false);
        expect((yield* d.get(id)).revision).toBe(before.revision);
        expect(yield* (yield* DeliveriesRepo).byDocument(WORKSPACE_A, id)).toHaveLength(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("manual reminder (D14)", () => {
  test("needs an owed Invoice or Proforma and never changes the reminder choice", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* d.send(id, { reminders: false });
        const before = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        const r = yield* d.send(id, { purpose: "reminder", reminders: true });
        const row = yield* delivery(r.deliveryId);
        expect(row).toMatchObject({ purpose: "reminder", reminder: null });
        expect(row.subject.startsWith("Upomínka: Faktura")).toBe(true);
        const after = yield* (yield* DocumentsRepo).get(WORKSPACE_A, id);
        expect(after).toMatchObject({ remindersChoice: "off", remindersOn: false });
        expect(after.revision).toBe(before.revision);
        // A paid document is settled.
        yield* patchDocument(id, { settlement: "paid" });
        const settled = yield* Effect.flip(d.send(id, { purpose: "reminder" }));
        expect(settled).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "reminder.document_settled" }),
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("DocumentDelivery job steps", () => {
  const queued = Effect.gen(function* () {
    const id = yield* issueInvoice();
    const { deliveryId } = yield* (yield* Documents).send(id);
    return { id, deliveryId };
  });

  test("claim then dispatch sends once with the delivery id as key and the rendered PDF", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        expect(yield* as(worker, deliver(WORKSPACE_A, deliveryId))).toBe("sent");
        const emails = yield* sent;
        expect(emails).toHaveLength(1);
        expect(emails[0]?.idempotencyKey).toBe(deliveryId);
        expect(emails[0]?.message.to).toEqual(["fakturace@odberatel.cz"]);
        expect(emails[0]?.message.attachments[0]?.contentType).toBe("application/pdf");
        expect(emails[0]?.message.attachments[0]?.bytes.length).toBeGreaterThan(0);
        expect(yield* delivery(deliveryId)).toMatchObject({
          status: "sent",
          attempts: 1,
          provider: "capture",
        });
        // Replays are no-ops (idempotent by status).
        expect(yield* as(worker, deliver(WORKSPACE_A, deliveryId))).toBe("sent");
        expect(yield* attempts).toBe(1);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("the snapshot is sent even after the document was edited (J3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const { id, deliveryId } = yield* queued;
        const queuedView = (yield* delivery(deliveryId)).view;
        const current = yield* d.get(id);
        yield* d.edit(id, { note: "Nová poznámka" }, current.revision);
        yield* as(worker, deliver(WORKSPACE_A, deliveryId));
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
        expect(yield* as(worker, deliver(WORKSPACE_A, deliveryId))).toBe("failed");
        expect(yield* delivery(deliveryId)).toMatchObject({
          status: "failed",
          failure: "rejected",
        });
        expect(yield* as(worker, dispatch(WORKSPACE_A, deliveryId))).toBe("failed");
        expect(yield* attempts).toBe(1);
        expect(yield* sent).toHaveLength(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("EmailNotAccepted stays sending and retries safely with the same key", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        yield* CaptureEmailSender.failNext("not_accepted");
        const retry = yield* Effect.flip(as(worker, deliver(WORKSPACE_A, deliveryId)));
        expect(retry).toEqual(new DeliveryRetry({ deliveryId, cause: "not_accepted" }));
        expect(yield* delivery(deliveryId)).toMatchObject({
          status: "sending",
          attempts: 1,
          lastOutcome: "not_accepted",
        });
        // A reconcile re-start claims nothing new and re-dispatches.
        expect(yield* as(worker, claim(WORKSPACE_A, deliveryId))).toBe("sending");
        expect(yield* as(worker, dispatch(WORKSPACE_A, deliveryId))).toBe("sent");
        const emails = yield* sent;
        expect(emails.map((e) => e.idempotencyKey)).toEqual([deliveryId]);
        expect(yield* attempts).toBe(2);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("EmailOutcomeUnknown retries with the same key; exhausted retries fail the delivery", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        yield* CaptureEmailSender.failNext("outcome_unknown", "outcome_unknown");
        const first = yield* Effect.flip(as(worker, deliver(WORKSPACE_A, deliveryId)));
        expect(first).toEqual(new DeliveryRetry({ deliveryId, cause: "outcome_unknown" }));
        const second = yield* Effect.flip(as(worker, dispatch(WORKSPACE_A, deliveryId)));
        expect(second).toEqual(new DeliveryRetry({ deliveryId, cause: "outcome_unknown" }));
        expect(yield* as(worker, giveUp(WORKSPACE_A, deliveryId))).toBe("failed");
        expect(yield* delivery(deliveryId)).toMatchObject({
          status: "failed",
          attempts: 2,
          failure: "retries_exhausted",
        });
        expect(yield* as(worker, dispatch(WORKSPACE_A, deliveryId))).toBe("failed");
        expect(yield* attempts).toBe(2);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a document cancelled after queueing is skipped at claim (J3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const d = yield* Documents;
        const proforma = yield* d.issue({ input: invoiceInput({ kind: "proforma" }) });
        const { deliveryId } = yield* d.send(proforma.id);
        yield* d.cancel(proforma.id, { reason: "chyba" });
        expect(yield* as(worker, deliver(WORKSPACE_A, deliveryId))).toBe("skipped");
        expect(yield* delivery(deliveryId)).toMatchObject({ failure: "document_cancelled" });
        expect(yield* attempts).toBe(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("job steps are Workspace scoped", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { deliveryId } = yield* queued;
        const other = system(undefined, WORKSPACE_B);
        expect(yield* Effect.flip(as(other, claim(WORKSPACE_B, deliveryId)))).toBeInstanceOf(
          NotFound,
        );
        const statuses = yield* (yield* DeliveriesRepo).statuses(WORKSPACE_B, [deliveryId]);
        expect(statuses.size).toBe(0);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
