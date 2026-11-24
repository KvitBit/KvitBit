/** Rule D16 automatic reminders: selection-time resolution, enqueue, claim re-check. */
import { describe, expect, test } from "bun:test";
import type { DeliveryId, DocumentId, IsoDate } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import { Effect, Exit, Ref } from "effect";
import {
  claim,
  DeliveriesRepo,
  DocumentsRepo,
  deliver,
  dueStep,
  enqueueReminder,
  selectDueReminders,
} from "../../../../src/modules/documents";
import { resolveReminders } from "../../../../src/shared/overrides";
import { CaptureEmailSender } from "../../../../src/testing";
import { system, WORKSPACE_A } from "../../../helpers";
import {
  at,
  deliveryScenario,
  issueInvoice,
  patchDocument,
  setContactDefaults,
  setWorkspaceReminders,
} from "../deliveries/helpers";
import { as, invoiceInput } from "../fixtures";

const worker = system();
const reminderJob = (documentId: DocumentId) => system({ _tag: "PaymentReminders", documentId });

const select = (today: IsoDate) => as(worker, selectDueReminders(WORKSPACE_A, today));

/** Selects and enqueues the reminders due on `date` (clock moved there); returns their ids. */
const sweep = (date: string) =>
  Effect.gen(function* () {
    const today = yield* at(date);
    const due = yield* select(today);
    const ids: Array<{ documentId: DocumentId; deliveryId: DeliveryId | null; offset: number }> =
      [];
    for (const reminder of due) {
      const deliveryId = yield* as(
        reminderJob(reminder.documentId),
        enqueueReminder(WORKSPACE_A, reminder),
      );
      ids.push({ documentId: reminder.documentId, deliveryId, offset: reminder.offsetDays });
    }
    return ids;
  });

const reminderEmails = Effect.flatMap(CaptureEmailSender, (c) =>
  Effect.map(Ref.get(c.sent), (sent) =>
    sent.filter((e) => e.message.subject.startsWith("Upomínka")),
  ),
);

const dueOn = (id: DocumentId) =>
  Effect.map(
    Effect.flatMap(DocumentsRepo, (r) => r.get(WORKSPACE_A, id)),
    (row) => row.dueOn,
  );

/** Moves an issued document's due date through Documents.edit (as the owner). */
const moveDue = (id: DocumentId, on: string) =>
  Effect.gen(function* () {
    const d = yield* Documents;
    const view = yield* d.get(id);
    return yield* d.edit(id, { due: { on: on as IsoDate } }, view.revision);
  });

// Fixture policy: Workspace reminders enabled, Proformas off, offsets [3, 10]; Invoices issued
// 2026-11-23 with 14 days are due 2026-12-07 (steps 2026-12-10 and 2026-12-17).

describe("selection (D16, no stored schedule)", () => {
  test("only documents a send armed; steps follow dueOn + offsets; enqueue is idempotent", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        const sent = yield* issueInvoice();
        yield* issueInvoice(); // never sent: no reminders
        yield* d.send(sent);
        expect(yield* sweep("2026-12-09")).toEqual([]);
        const first = yield* sweep("2026-12-10");
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ documentId: sent, offset: 3 });
        const id = first[0]?.deliveryId as DeliveryId;
        const row = yield* (yield* DeliveriesRepo).get(WORKSPACE_A, id);
        expect(row).toMatchObject({
          purpose: "reminder",
          status: "queued",
          reminder: { dueOn: "2026-12-07", offsetDays: 3 },
          to: ["fakturace@odberatel.cz"],
        });
        // The same step is not selected again; enqueueing it again returns the same delivery.
        expect(yield* select("2026-12-10" as IsoDate)).toEqual([]);
        const again = yield* as(
          reminderJob(sent),
          enqueueReminder(WORKSPACE_A, {
            documentId: sent,
            dueOn: "2026-12-07" as IsoDate,
            step: 0,
            offsetDays: 3,
            date: "2026-12-10" as IsoDate,
          }),
        );
        expect(again).toBe(id);
        expect(yield* as(worker, deliver(WORKSPACE_A, id))).toBe("sent");
        expect(yield* reminderEmails).toHaveLength(1);
        // Automatic reminders leave the document's choice alone.
        expect((yield* (yield* DocumentsRepo).get(WORKSPACE_A, sent)).remindersChoice).toBe(
          "inherit",
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a late sweep sends the latest due step only; earlier missed steps are superseded", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const id = yield* issueInvoice();
        yield* (yield* Documents).send(id);
        const late = yield* sweep("2026-12-18");
        expect(late.map((r) => r.offset)).toEqual([10]);
        expect(yield* sweep("2026-12-30")).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("paid, cancelled or reminders-off documents are not selected", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        const paid = yield* issueInvoice();
        const off = yield* issueInvoice();
        const proforma = (yield* d.issue({ input: invoiceInput({ kind: "proforma" }) }))
          .id as DocumentId;
        yield* d.send(paid);
        yield* d.send(off, { reminders: false });
        yield* d.send(proforma); // Workspace: Proformas off (inherit)
        yield* patchDocument(paid, { settlement: "paid" });
        expect(yield* sweep("2026-12-10")).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("REQUIRED D16", () => {
  test("turning reminders off between queueing and sending skips the delivery", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* d.send(id);
        const [queued] = yield* sweep("2026-12-10");
        const deliveryId = queued?.deliveryId as DeliveryId;
        expect((yield* (yield* DeliveriesRepo).get(WORKSPACE_A, deliveryId)).status).toBe("queued");
        // Reminders turned off on the document (a send with reminders: false stores "off").
        yield* d.send(id, { reminders: false });
        const attemptsBefore = yield* Effect.flatMap(CaptureEmailSender, (c) =>
          Ref.get(c.attempts),
        );
        expect(yield* as(worker, deliver(WORKSPACE_A, deliveryId))).toBe("skipped");
        expect(yield* (yield* DeliveriesRepo).get(WORKSPACE_A, deliveryId)).toMatchObject({
          status: "skipped",
          failure: "reminders_off",
        });
        expect(yield* reminderEmails).toHaveLength(0);
        expect(yield* Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.attempts))).toBe(
          attemptsBefore,
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("explicit vs inherited choice across a Contact policy change and a due-date edit", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        const explicit = yield* issueInvoice();
        const inherited = yield* issueInvoice();
        yield* d.send(explicit, { reminders: true });
        yield* d.send(inherited);
        // The Contact switches to disabled, then both due dates move to 2026-12-20.
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        yield* moveDue(explicit, "2026-12-20");
        yield* moveDue(inherited, "2026-12-20");
        const repo = yield* DocumentsRepo;
        expect((yield* repo.get(WORKSPACE_A, explicit)).remindersChoice).toBe("on");
        expect((yield* repo.get(WORKSPACE_A, inherited)).remindersChoice).toBe("inherit");
        expect(yield* dueOn(explicit)).toBe("2026-12-20" as IsoDate);
        // The old dates (2026-12-10) no longer apply: dates moved with the due date.
        expect(yield* sweep("2026-12-10")).toEqual([]);
        // Explicit "on" keeps the Workspace offsets; inherited follows the disabled Contact.
        const moved = yield* sweep("2026-12-23");
        expect(moved.map((r) => [r.documentId, r.offset])).toEqual([[explicit, 3]]);
        const row = yield* (yield* DeliveriesRepo).get(
          WORKSPACE_A,
          moved[0]?.deliveryId as DeliveryId,
        );
        expect(row.reminder).toEqual({ dueOn: "2026-12-20" as IsoDate, offsetDays: 3 });
        // The Contact moves to custom [5]: the inherited choice follows it, explicit "on" too
        // (custom offsets apply to any choice but "off").
        yield* setContactDefaults({ reminderPolicy: { mode: "custom", offsetsDays: [5] } });
        const custom = yield* sweep("2026-12-25");
        expect(custom.map((r) => [r.documentId, r.offset]).sort()).toEqual(
          [
            [explicit, 5],
            [inherited, 5],
          ].sort(),
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("claim re-checks (J3, D16)", () => {
  test("a due-date change after queueing makes the queued step stale", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const id = yield* issueInvoice();
        yield* (yield* Documents).send(id);
        const [queued] = yield* sweep("2026-12-10");
        yield* moveDue(id, "2026-12-31");
        expect(yield* as(worker, claim(WORKSPACE_A, queued?.deliveryId as DeliveryId))).toBe(
          "skipped",
        );
        expect(
          (yield* (yield* DeliveriesRepo).get(WORKSPACE_A, queued?.deliveryId as DeliveryId))
            .failure,
        ).toBe("reminder_step_stale");
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("an inherited choice is skipped once the Contact disables reminders; paid is skipped", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        const a = yield* issueInvoice();
        const b = yield* issueInvoice();
        yield* d.send(a);
        yield* d.send(b);
        const queued = yield* sweep("2026-12-10");
        const of = (id: DocumentId) =>
          queued.find((q) => q.documentId === id)?.deliveryId as DeliveryId;
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        expect(yield* as(worker, claim(WORKSPACE_A, of(a)))).toBe("skipped");
        yield* setContactDefaults({ reminderPolicy: { mode: "inherit" } });
        yield* patchDocument(b, { settlement: "paid" });
        expect(yield* as(worker, claim(WORKSPACE_A, of(b)))).toBe("skipped");
        expect((yield* (yield* DeliveriesRepo).get(WORKSPACE_A, of(b))).failure).toBe(
          "document_settled",
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("the Workspace turning reminders off stops inherited reminders, not explicit ones", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        const inherited = yield* issueInvoice();
        const explicit = yield* issueInvoice();
        yield* d.send(inherited);
        yield* d.send(explicit, { reminders: true });
        yield* setWorkspaceReminders({ enabled: false, proformas: false, offsetsDays: [3, 10] });
        const due = yield* sweep("2026-12-10");
        expect(due.map((r) => r.documentId)).toEqual([explicit]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("resolution readings (overrides.ts resolveReminders)", () => {
  const workspace = { enabled: true, proformas: false, offsetsDays: [3, 10] };

  test("a Contact on custom arms Proformas although the Workspace Proforma setting is off", () => {
    expect(
      resolveReminders({
        kind: "proforma",
        choice: "inherit",
        contact: { mode: "custom", offsetsDays: [7] },
        workspace,
      }),
    ).toEqual({ arms: true, offsetsDays: [7] });
  });

  test("empty offsets arm nothing", () => {
    const none = resolveReminders({
      kind: "invoice",
      choice: "on",
      contact: { mode: "custom", offsetsDays: [] },
      workspace,
    });
    expect(none).toEqual({ arms: false, offsetsDays: [] });
    expect(dueStep("2026-12-07" as IsoDate, none, "2027-01-01" as IsoDate)).toBeNull();
  });

  test("a custom Contact arms a sent Proforma end to end", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const d = yield* Documents;
        yield* setContactDefaults({ reminderPolicy: { mode: "custom", offsetsDays: [1] } });
        const proforma = yield* d.issue({ input: invoiceInput({ kind: "proforma" }) });
        expect((yield* d.previewSend(proforma.id)).armsReminders).toBe(true);
        yield* d.send(proforma.id);
        const due = yield* sweep("2026-12-08");
        expect(due.map((r) => [r.documentId, r.offset])).toEqual([[proforma.id, 1]]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
