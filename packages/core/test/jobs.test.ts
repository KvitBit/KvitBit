import { describe, expect, test } from "bun:test";
import {
  ContactId,
  Contacts,
  CurrentCaller,
  DocumentId,
  Documents,
  IsoDate,
  Reports,
  TemplateId,
  Templates,
  UserId,
  WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { deliveryJob, exportJob, invitationJob, recurringJob, reminderJob } from "../src/jobs";
import { DeliveriesRepo } from "../src/modules/documents/deliveries/repo";
import { ScheduleViewSchema } from "../src/modules/recurring/view";
import { WorkspacesRepo } from "../src/modules/workspaces/repo";
import { TestCore, type TestCoreServices } from "../src/testing/TestCore";
import { account } from "./helpers/callers";
import { dec } from "./modules/documents/fixtures";
import { templateInput } from "./modules/recurring/fixtures";

const OWNER = UserId.make("01960000-0000-7000-8000-000000000001");
const TEST_TIME = Date.parse("2026-04-15T10:00:00.000Z");

const runWithCore = <A, E>(effect: Effect.Effect<A, E, TestCoreServices>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(TEST_TIME);
      return yield* effect;
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestCore({ users: [{ userId: OWNER, name: "Owner", email: "owner@test.cz" }] }),
          TestClock.layer(),
        ),
      ),
    ),
  );

const setupWorkspaceAndContact = () =>
  Effect.gen(function* () {
    const ownerCaller = yield* Effect.flatMap(Workspaces, (w) =>
      w.create({ name: "Acme s.r.o." }),
    ).pipe(
      Effect.provideService(CurrentCaller, account({ userId: OWNER, email: "owner@test.cz" })),
    );

    const workspaceId = ownerCaller.workspaceId;
    const contact = yield* Effect.flatMap(Contacts, (c) =>
      c.save({ name: "Buyer s.r.o.", billingEmails: ["billing@buyer.cz"] }),
    ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

    const contactId = yield* Schema.decodeUnknownEffect(ContactId)(contact.id);
    return {
      workspaceId,
      ownerCaller,
      contactId,
    };
  });

describe("CoreJobs System-caller entry points (#894)", () => {
  test("deliveryJob claim/dispatch/deliver runs as sealed System caller", async () => {
    const status = await runWithCore(
      Effect.gen(function* () {
        const { workspaceId, ownerCaller, contactId } = yield* setupWorkspaceAndContact();
        const doc = yield* Effect.flatMap(Documents, (d) =>
          d.issue({
            input: {
              kind: "invoice",
              contact: contactId,
              issuedOn: IsoDate.make("2026-04-15"),
              lines: [{ description: "Consulting", quantity: dec("1"), unitPrice: dec("1000") }],
            },
          }),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        const sent = yield* Effect.flatMap(Documents, (d) => d.send(doc.id)).pipe(
          Effect.provideService(CurrentCaller, ownerCaller),
        );
        return yield* deliveryJob.deliver(workspaceId, sent.deliveryId);
      }),
    );
    expect(status).toBe("sent");
  });

  test("reminderJob sweepWorkspaces selects and enqueues due reminders without external caller", async () => {
    const results = await runWithCore(
      Effect.gen(function* () {
        const { workspaceId, ownerCaller, contactId } = yield* setupWorkspaceAndContact();
        const doc = yield* Effect.flatMap(Documents, (d) =>
          d.issue({
            input: {
              kind: "invoice",
              contact: contactId,
              issuedOn: IsoDate.make("2026-04-01"),
              due: { on: IsoDate.make("2026-04-10") },
              lines: [{ description: "Work", quantity: dec("1"), unitPrice: dec("500") }],
            },
          }),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        // Send document so reminders are armed (default offsets [3, 10, 30] -> due 2026-04-13)
        yield* Effect.flatMap(Documents, (d) => d.send(doc.id)).pipe(
          Effect.provideService(CurrentCaller, ownerCaller),
        );

        const swept = yield* reminderJob.sweepWorkspaces([workspaceId], IsoDate.make("2026-04-15"));
        const deliveries = yield* Effect.flatMap(DeliveriesRepo, (r) =>
          r.byDocument(workspaceId, DocumentId.make(doc.id)),
        );
        return { swept, deliveryCount: deliveries.length };
      }),
    );

    expect(results.swept).toHaveLength(1);
    expect(results.swept[0]?.deliveryIds).toHaveLength(1);
    expect(results.deliveryCount).toBe(2); // original send + reminder
  });

  test("recurringJob run issues a scheduled occurrence as sealed System caller", async () => {
    const result = await runWithCore(
      Effect.gen(function* () {
        const { workspaceId, ownerCaller, contactId } = yield* setupWorkspaceAndContact();
        const tpl = yield* Effect.flatMap(Templates, (t) =>
          t.save(templateInput({ contact: contactId })),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        const templateId = yield* Schema.decodeUnknownEffect(TemplateId)(tpl.id);
        const scheduled = yield* Effect.flatMap(Templates, (t) =>
          t.schedule(
            templateId,
            {
              every: { months: 1 },
              startOn: IsoDate.make("2026-04-15"),
              issueAs: "invoice",
              autoSend: true,
            },
            tpl.revision,
          ),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        const schedule = yield* Schema.decodeUnknownEffect(Schema.toType(ScheduleViewSchema))(
          scheduled.schedule,
        );
        const { id: scheduleId, nextOccurrence: first } = schedule;
        if (first === null) return yield* Effect.die("Expected a first recurring occurrence");
        return yield* recurringJob.run(workspaceId, scheduleId, first);
      }),
    );

    expect(result.issue._tag).toBe("Issued");
    expect(result.send?._tag).toBe("Queued");
  });

  test("exportJob reportingTables and finish run as sealed System caller", async () => {
    const out = await runWithCore(
      Effect.gen(function* () {
        const { workspaceId, ownerCaller } = yield* setupWorkspaceAndContact();
        const job = yield* Effect.flatMap(Reports, (r) => r.startExport()).pipe(
          Effect.provideService(CurrentCaller, ownerCaller),
        );
        const tables = yield* exportJob.reportingTables(workspaceId, job.id, "cs");
        const finished = yield* exportJob.finish(workspaceId, job.id, 1024);
        return {
          tableCount: tables.length,
          status: finished.status,
          sizeBytes: finished.sizeBytes,
        };
      }),
    );

    expect(out.tableCount).toBe(3);
    expect(out.status).toBe("ready");
    expect(out.sizeBytes).toBe(1024);
  });

  test("invitationJob getPending and expirePending manage invitation lifecycle", async () => {
    const out = await runWithCore(
      Effect.gen(function* () {
        const { workspaceId, ownerCaller } = yield* setupWorkspaceAndContact();
        const inv = yield* Effect.flatMap(Workspaces, (w) =>
          w.invite("new@acme.cz", "member"),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        const pendingNow = yield* invitationJob.getPending(
          WorkspaceId.make(workspaceId),
          inv.id,
          "2026-04-15T10:00:00.000Z",
        );
        const expiredEarly = yield* invitationJob.expirePending(
          WorkspaceId.make(workspaceId),
          inv.id,
          "2026-04-15T10:00:00.000Z",
        );
        const expiredLater = yield* invitationJob.expirePending(
          WorkspaceId.make(workspaceId),
          inv.id,
          "2026-05-01T00:00:00.000Z",
        );
        const rowAfter = yield* Effect.flatMap(WorkspacesRepo, (r) =>
          r.getInvitation(WorkspaceId.make(workspaceId), inv.id),
        );
        return {
          wasPending: pendingNow !== null,
          expiredEarly,
          expiredLater,
          statusAfter: rowAfter.status,
        };
      }),
    );

    expect(out.wasPending).toBe(true);
    expect(out.expiredEarly).toBe(false);
    expect(out.expiredLater).toBe(true);
    expect(out.statusAfter).toBe("expired");
  });
});
