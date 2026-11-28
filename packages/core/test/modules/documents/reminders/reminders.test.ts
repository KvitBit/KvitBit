import { TestCaller } from "../../../helpers/callerContext";
/** Rule D16 automatic reminders: selection-time resolution, enqueue, claim re-check. */

import { describe, expect, test } from "bun:test";
import { type DeliveryId, DocumentId, Documents, IsoDate } from "@kvitbit/domain/contract";
import { EmailSender } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import {
  claim,
  DeliveriesRepo,
  DocumentFixtures,
  DocumentsRepo,
  deliver,
  dispatch,
  dueStep,
  enqueueReminder,
  reconcileStaleDeliveries,
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
import { as, CZ_NO_DIC, contact, invoiceInput, present } from "../fixtures";

const worker = system();
const reminderJob = (documentId: DocumentId) => system({ _tag: "PaymentReminders", documentId });

const select = (today: IsoDate) => as(worker, selectDueReminders(worker, WORKSPACE_A, today));

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
        enqueueReminder(reminderJob(reminder.documentId), WORKSPACE_A, reminder),
      );
      ids.push({ documentId: reminder.documentId, deliveryId, offset: reminder.offsetDays });
    }
    return ids;
  });

const reminderEmails = Effect.flatMap(CaptureEmailSender, (c) =>
  Effect.map(Ref.get(c.sent), (sent) =>
    EffectArray.filter(sent, (e) => EffectString.startsWith("Upomínka")(e.message.subject)),
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
    const testCaller = yield* TestCaller;
    const d = yield* Documents;
    const view = yield* d.get(testCaller, id);
    return yield* d.edit(testCaller, id, { due: { on: IsoDate.make(on) } }, view.revision);
  });

// Fixture policy: Workspace reminders enabled, Proformas off, offsets [3, 10]; Invoices issued
// 2026-11-23 with 14 days are due 2026-12-07 (steps 2026-12-10 and 2026-12-17).

describe("selection (D16, no stored schedule)", () => {
  test("only documents a send armed; steps follow dueOn + offsets; enqueue is idempotent", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const sent = yield* issueInvoice();
        yield* issueInvoice(); // never sent: no reminders
        yield* d.send(testCaller, sent);
        const result = yield* sweep("2026-12-09");
        expect(result).toEqual([]);
        const first = yield* sweep("2026-12-10");
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ documentId: sent, offset: 3 });
        const id = present(first[0]?.deliveryId);
        const row = yield* (yield* DeliveriesRepo).get(WORKSPACE_A, id);
        expect(row).toMatchObject({
          purpose: "reminder",
          status: "queued",
          reminder: { dueOn: "2026-12-07", offsetDays: 3 },
          to: ["fakturace@odberatel.cz"],
        });
        const makeResult = yield* select(IsoDate.make("2026-12-10"));
        // The same step is not selected again; enqueueing it again returns the same delivery.
        expect(makeResult).toEqual([]);
        const again = yield* as(
          reminderJob(sent),
          enqueueReminder(reminderJob(sent), WORKSPACE_A, {
            documentId: sent,
            dueOn: IsoDate.make("2026-12-07"),
            step: 0,
            armedBy: 1,
            offsetDays: 3,
            date: IsoDate.make("2026-12-10"),
          }),
        );
        expect(again).toBe(id);
        const result2 = yield* as(worker, deliver(worker, WORKSPACE_A, id));
        expect(result2).toBe("sent");
        const firstReminderEmails = yield* reminderEmails;
        expect(firstReminderEmails).toHaveLength(1);
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
        const testCaller = yield* TestCaller;
        const id = yield* issueInvoice();
        yield* (yield* Documents).send(testCaller, id);
        const late = yield* sweep("2026-12-18");
        expect(EffectArray.map(late, (r) => r.offset)).toEqual([10]);
        const result = yield* sweep("2026-12-30");
        expect(result).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("paid, cancelled or reminders-off documents are not selected", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const paid = yield* issueInvoice();
        const off = yield* issueInvoice();
        const proforma = DocumentId.make(
          (yield* d.issue(testCaller, { input: invoiceInput({ kind: "proforma" }) })).id,
        );
        yield* d.send(testCaller, paid);
        yield* d.send(testCaller, off, { reminders: false });
        yield* d.send(testCaller, proforma); // Workspace: Proformas off (inherit)
        yield* patchDocument(paid, { settlement: "paid" });
        const result = yield* sweep("2026-12-10");
        expect(result).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("REQUIRED D16", () => {
  test("turning reminders off between queueing and sending skips the delivery", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* d.send(testCaller, id);
        const [queued] = yield* sweep("2026-12-10");
        const deliveryId = present(queued?.deliveryId);
        expect((yield* (yield* DeliveriesRepo).get(WORKSPACE_A, deliveryId)).status).toBe("queued");
        // Reminders turned off on the document (a send with reminders: false stores "off").
        yield* d.send(testCaller, id, { reminders: false });
        const attemptsBefore = yield* Effect.flatMap(CaptureEmailSender, (c) =>
          Ref.get(c.attempts),
        );
        const result = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("skipped");
        const getResult = yield* (yield* DeliveriesRepo).get(WORKSPACE_A, deliveryId);
        expect(getResult).toMatchObject({
          status: "skipped",
          failure: "reminders_off",
        });
        const reminderEmails_1 = yield* reminderEmails;
        expect(reminderEmails_1).toHaveLength(0);
        const flatMapResult = yield* Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.attempts));
        expect(flatMapResult).toBe(attemptsBefore);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("explicit vs inherited choice across a Contact policy change and a due-date edit", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const explicit = yield* issueInvoice();
        const inherited = yield* issueInvoice();
        yield* d.send(testCaller, explicit, { reminders: true });
        yield* d.send(testCaller, inherited);
        // The Contact switches to disabled, then both due dates move to 2026-12-20.
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        yield* moveDue(explicit, "2026-12-20");
        yield* moveDue(inherited, "2026-12-20");
        const repo = yield* DocumentsRepo;
        expect((yield* repo.get(WORKSPACE_A, explicit)).remindersChoice).toBe("on");
        expect((yield* repo.get(WORKSPACE_A, inherited)).remindersChoice).toBe("inherit");
        const result = yield* dueOn(explicit);
        expect(result).toBe(IsoDate.make("2026-12-20"));
        const result2 = yield* sweep("2026-12-10");
        // The old dates (2026-12-10) no longer apply: dates moved with the due date.
        expect(result2).toEqual([]);
        // Explicit "on" keeps the Workspace offsets; inherited follows the disabled Contact.
        const moved = yield* sweep("2026-12-23");
        expect(EffectArray.map(moved, (r) => [r.documentId, r.offset])).toEqual([[explicit, 3]]);
        const row = yield* (yield* DeliveriesRepo).get(WORKSPACE_A, present(moved[0]?.deliveryId));
        expect(row.reminder).toMatchObject({ dueOn: IsoDate.make("2026-12-20"), offsetDays: 3 });
        // The Contact moves to custom [5]: the inherited choice follows it, explicit "on" too
        // (custom offsets apply to any choice but "off").
        yield* setContactDefaults({ reminderPolicy: { mode: "custom", offsetsDays: [5] } });
        const custom = yield* sweep("2026-12-25");
        const selected = EffectArray.sortWith(
          custom,
          (entry) => entry.documentId,
          EffectString.Order,
        );
        const expectedIds = EffectArray.sort([explicit, inherited], EffectString.Order);
        const expected = EffectArray.map(expectedIds, (documentId) => [documentId, 5]);
        expect(
          EffectArray.map(selected, (reminder) => [reminder.documentId, reminder.offset]),
        ).toEqual(expected);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("claim re-checks (J3, D16)", () => {
  test("a due-date change after queueing makes the queued step stale", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const id = yield* issueInvoice();
        yield* (yield* Documents).send(testCaller, id);
        const [queued] = yield* sweep("2026-12-10");
        yield* moveDue(id, "2026-12-31");
        const makeResult = yield* as(
          worker,
          claim(worker, WORKSPACE_A, present(queued?.deliveryId)),
        );
        expect(makeResult).toBe("skipped");
        expect(
          (yield* (yield* DeliveriesRepo).get(WORKSPACE_A, present(queued?.deliveryId))).failure,
        ).toBe("reminder_step_stale");
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("an inherited choice is skipped once the Contact disables reminders; paid is skipped", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const a = yield* issueInvoice();
        const b = yield* issueInvoice();
        yield* d.send(testCaller, a);
        yield* d.send(testCaller, b);
        const queued = yield* sweep("2026-12-10");
        const of = (id: DocumentId) =>
          present(
            Option.getOrUndefined(EffectArray.findFirst(queued, (q) => q.documentId === id))
              ?.deliveryId,
          );
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        const result = yield* as(worker, claim(worker, WORKSPACE_A, of(a)));
        expect(result).toBe("skipped");
        yield* setContactDefaults({ reminderPolicy: { mode: "inherit" } });
        yield* patchDocument(b, { settlement: "paid" });
        const result2 = yield* as(worker, claim(worker, WORKSPACE_A, of(b)));
        expect(result2).toBe("skipped");
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
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const inherited = yield* issueInvoice();
        const explicit = yield* issueInvoice();
        yield* d.send(testCaller, inherited);
        yield* d.send(testCaller, explicit, { reminders: true });
        yield* setWorkspaceReminders({ enabled: false, proformas: false, offsetsDays: [3, 10] });
        const due = yield* sweep("2026-12-10");
        expect(EffectArray.map(due, (r) => r.documentId)).toEqual([explicit]);
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
    expect(dueStep(IsoDate.make("2026-12-07"), none, IsoDate.make("2027-01-01"))).toBeNull();
  });

  test("a custom Contact arms a sent Proforma end to end", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        yield* setContactDefaults({ reminderPolicy: { mode: "custom", offsetsDays: [1] } });
        const proforma = yield* d.issue(testCaller, { input: invoiceInput({ kind: "proforma" }) });
        expect((yield* d.previewSend(testCaller, proforma.id)).armsReminders).toBe(true);
        yield* d.send(testCaller, proforma.id);
        const due = yield* sweep("2026-12-08");
        expect(EffectArray.map(due, (r) => [r.documentId, r.offset])).toEqual([[proforma.id, 1]]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("stored arm outcome and re-arm (D16, council terms)", () => {
  test("an inherited send under a disabled Contact stores remindersOn false; a policy change alone does not arm it, a due-date edit re-arms", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        expect((yield* d.previewSend(testCaller, id)).armsReminders).toBe(false);
        yield* d.send(testCaller, id);
        const repo = yield* DocumentsRepo;
        const getResult = yield* repo.get(WORKSPACE_A, id);
        expect(getResult).toMatchObject({
          remindersChoice: "inherit",
          remindersOn: false,
        });
        // The Contact returns to inherit: no arm without a re-arm event.
        yield* setContactDefaults({ reminderPolicy: { mode: "inherit" } });
        const result = yield* sweep("2026-12-10");
        expect(result).toEqual([]);
        // A due-date change re-arms from the stored choice and the current policies.
        yield* moveDue(id, "2026-12-14");
        const due = yield* sweep("2026-12-17");
        expect(EffectArray.map(due, (r) => [r.documentId, r.offset])).toEqual([[id, 3]]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("changed offsets never backfill a reminder earlier than one already sent", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const id = yield* issueInvoice();
        yield* (yield* Documents).send(testCaller, id);
        const [late] = yield* sweep("2026-12-17");
        expect(late?.offset).toBe(10);
        yield* as(worker, deliver(worker, WORKSPACE_A, present(late?.deliveryId)));
        yield* setWorkspaceReminders({ enabled: true, proformas: false, offsetsDays: [5] });
        const result = yield* sweep("2026-12-20");
        expect(result).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a step skipped before any attempt is released and can be queued again", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* d.send(testCaller, id);
        const [first] = yield* sweep("2026-12-10");
        yield* d.send(testCaller, id, { reminders: false });
        const makeResult = yield* as(
          worker,
          claim(worker, WORKSPACE_A, present(first?.deliveryId)),
        );
        expect(makeResult).toBe("skipped");
        yield* d.send(testCaller, id, { reminders: true });
        const [again] = yield* sweep("2026-12-11");
        expect(again).toMatchObject({ documentId: id, offset: 3 });
        expect(again?.deliveryId).not.toBe(first?.deliveryId);
        const makeResult2 = yield* as(
          worker,
          deliver(worker, WORKSPACE_A, present(again?.deliveryId)),
        );
        expect(makeResult2).toBe("sent");
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("latest send by sequence (council round)", () => {
  test("automatic reminders go to the latest send's recipients; a due-date edit re-arms from it", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        yield* d.send(testCaller, id, { to: ["a@x.cz"] });
        yield* d.send(testCaller, id, { to: ["b@x.cz"] });
        yield* setContactDefaults({ reminderPolicy: { mode: "inherit" } });
        yield* moveDue(id, "2026-12-14");
        const [due] = yield* sweep("2026-12-17");
        const row = yield* (yield* DeliveriesRepo).get(WORKSPACE_A, present(due?.deliveryId));
        expect(row.to).toEqual(["b@x.cz"]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("review round 1 regressions", () => {
  test("after a buyer change, automatic reminders go to the new buyer, never the old one", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const f = yield* DocumentFixtures;
        yield* f.putContact(WORKSPACE_A, {
          ...contact(CZ_NO_DIC, { dic: null }),
          billingEmails: ["novy@kupec.cz"],
        });
        const id = yield* issueInvoice();
        yield* d.send(testCaller, id, { to: ["stary@odberatel.cz"] });
        const view = yield* d.get(testCaller, id);
        yield* d.edit(testCaller, id, { contact: CZ_NO_DIC }, view.revision);
        const [due] = yield* sweep("2026-12-10");
        const row = yield* (yield* DeliveriesRepo).get(WORKSPACE_A, present(due?.deliveryId));
        expect(row.to).toEqual(["novy@kupec.cz"]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a reminder queued before reminders were turned off and on again is not revived", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* d.send(testCaller, id, { to: ["stary@odberatel.cz"] });
        const [old] = yield* sweep("2026-12-10");
        yield* d.send(testCaller, id, { reminders: false });
        yield* d.send(testCaller, id, { reminders: true, to: ["novy@odberatel.cz"] });
        const [fresh] = yield* sweep("2026-12-10");
        expect(fresh?.deliveryId).not.toBe(old?.deliveryId);
        const makeResult = yield* as(worker, claim(worker, WORKSPACE_A, present(old?.deliveryId)));
        expect(makeResult).toBe("skipped");
        expect(
          (yield* (yield* DeliveriesRepo).get(WORKSPACE_A, present(old?.deliveryId))).failure,
        ).toBe("reminder_rearmed");
        const makeResult2 = yield* as(
          worker,
          deliver(worker, WORKSPACE_A, present(fresh?.deliveryId)),
        );
        expect(makeResult2).toBe("sent");
        const emails = yield* reminderEmails;
        expect(EffectArray.map(emails, (e) => e.message.to)).toEqual([["novy@odberatel.cz"]]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("reminder dates past 9999-12-31 are never due", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice({ due: { on: IsoDate.make("9999-12-31") } });
        yield* d.send(testCaller, id);
        const result = yield* sweep("2026-12-10");
        expect(result).toEqual([]);
        expect(
          dueStep(
            IsoDate.make("9999-12-31"),
            { arms: true, offsetsDays: [3, 10] },
            IsoDate.make("2026-12-10"),
          ),
        ).toBeNull();
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("review round 2 regression", () => {
  test("a re-send after a due-date re-arm keeps the arm: the same reminder is not sent twice", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const id = yield* issueInvoice();
        yield* setContactDefaults({ reminderPolicy: { mode: "disabled" } });
        yield* d.send(testCaller, id);
        yield* setContactDefaults({ reminderPolicy: { mode: "inherit" } });
        yield* moveDue(id, "2026-12-14");
        const [first] = yield* sweep("2026-12-17");
        yield* as(worker, deliver(worker, WORKSPACE_A, present(first?.deliveryId)));
        const reminderEmailsAfterResend = yield* reminderEmails;
        expect(reminderEmailsAfterResend).toHaveLength(1);
        yield* d.send(testCaller, id);
        const result = yield* sweep("2026-12-17");
        expect(result).toEqual([]);
        const reminderEmails_1 = yield* reminderEmails;
        expect(reminderEmails_1).toHaveLength(1);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("reconcile of a claimed reminder (J1a, J3, D16)", () => {
  test("a claimed reminder skipped on restart keeps its step: restored eligibility sends no second one", async () => {
    const exit = await deliveryScenario(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const id = yield* issueInvoice();
        yield* (yield* Documents).send(testCaller, id);
        const [first] = yield* sweep("2026-12-10");
        const a = present(first?.deliveryId);
        yield* as(worker, claim(worker, WORKSPACE_A, a));
        // The provider accepts, then the job dies before the attempt is recorded.
        const real = yield* EmailSender;
        const crash = yield* Effect.exit(
          as(worker, dispatch(WORKSPACE_A, a)).pipe(
            Effect.provideService(EmailSender, {
              ...real,
              send: (message, opts) =>
                Effect.andThen(real.send(message, opts), Effect.die("crash after accept")),
            }),
          ),
        );
        expect(Exit.isFailure(crash)).toBe(true);
        // The step is no longer due when the job is restarted: claim skips the row.
        yield* setWorkspaceReminders({ enabled: true, proformas: false, offsetsDays: [10] });
        yield* TestClock.adjust("3 minutes");
        const reconciled = yield* reconcileStaleDeliveries(120_000);
        expect(EffectArray.map(reconciled, (r) => r.deliveryId)).toContain(a);
        const result = yield* as(worker, deliver(worker, WORKSPACE_A, a));
        expect(result).toBe("skipped");
        const repo = yield* DeliveriesRepo;
        const getResult = yield* repo.get(WORKSPACE_A, a);
        expect(getResult).toMatchObject({
          attempts: 0,
          lastOutcome: "outcome_unknown",
        });
        // The step is due again: the provider may already have the reminder, so it stays taken.
        yield* setWorkspaceReminders({ enabled: true, proformas: false, offsetsDays: [3, 10] });
        const result2 = yield* sweep("2026-12-11");
        expect(result2).toEqual([]);
        const emails = yield* reminderEmails;
        expect(EffectArray.map(emails, (e) => e.idempotencyKey)).toEqual([a]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
