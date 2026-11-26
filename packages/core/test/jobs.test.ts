import { describe, expect, test } from "bun:test";
import type {
  ContactId,
  DocumentId,
  IsoDate,
  ScheduleId,
  TemplateId,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Contacts,
  CurrentCaller,
  Documents,
  Reports,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { deliveryJob, exportJob, invitationJob, recurringJob, reminderJob } from "../src/jobs";
import { DeliveriesRepo } from "../src/modules/documents/deliveries/repo";
import { WorkspacesRepo } from "../src/modules/workspaces/repo";
import { TestCore } from "../src/testing/TestCore";
import { account } from "./helpers/callers";
import { dec } from "./modules/documents/fixtures";
import { templateInput } from "./modules/recurring/fixtures";

const OWNER = "01960000-0000-7000-8000-000000000001" as UserId;
const TEST_TIME = Date.parse("2026-04-15T10:00:00.000Z");

const runWithCore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
    ) as Effect.Effect<A, E, never>,
  );

const setupWorkspaceAndContact = () =>
  Effect.gen(function* () {
    const ownerCaller = yield* Effect.flatMap(Workspaces, (w) =>
      w.create({ name: "Acme s.r.o." } as never),
    ).pipe(
      Effect.provideService(CurrentCaller, account({ userId: OWNER, email: "owner@test.cz" })),
    );

    const workspaceId = ownerCaller.workspaceId;
    const contact = yield* Effect.flatMap(Contacts, (c) =>
      c.save({ name: "Buyer s.r.o.", billingEmails: ["billing@buyer.cz"] } as never),
    ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

    return {
      workspaceId,
      ownerCaller,
      contactId: (contact as unknown as { readonly id: ContactId }).id,
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
              issuedOn: "2026-04-15",
              lines: [{ description: "Consulting", quantity: dec("1"), unitPrice: dec("1000") }],
            } as never,
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
              issuedOn: "2026-04-01",
              due: { on: "2026-04-10" },
              lines: [{ description: "Work", quantity: dec("1"), unitPrice: dec("500") }],
            } as never,
          }),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        // Send document so reminders are armed (default offsets [3, 10, 30] -> due 2026-04-13)
        yield* Effect.flatMap(Documents, (d) => d.send(doc.id)).pipe(
          Effect.provideService(CurrentCaller, ownerCaller),
        );

        const swept = yield* reminderJob.sweepWorkspaces([workspaceId], "2026-04-15" as IsoDate);
        const deliveries = yield* Effect.flatMap(DeliveriesRepo, (r) =>
          r.byDocument(workspaceId, doc.id as DocumentId),
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

        const scheduled = yield* Effect.flatMap(Templates, (t) =>
          t.schedule(
            tpl.id as TemplateId,
            {
              every: { months: 1 },
              startOn: "2026-04-15" as IsoDate,
              issueAs: "invoice",
              autoSend: true,
            } as never,
            tpl.revision,
          ),
        ).pipe(Effect.provideService(CurrentCaller, ownerCaller));

        const scheduleId = (
          scheduled as unknown as {
            readonly schedule: { readonly id: ScheduleId; readonly nextOccurrence: IsoDate };
          }
        ).schedule.id;
        const first = (
          scheduled as unknown as {
            readonly schedule: { readonly id: ScheduleId; readonly nextOccurrence: IsoDate };
          }
        ).schedule.nextOccurrence;
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
          workspaceId as WorkspaceId,
          inv.id,
          "2026-04-15T10:00:00.000Z",
        );
        const expiredEarly = yield* invitationJob.expirePending(
          workspaceId as WorkspaceId,
          inv.id,
          "2026-04-15T10:00:00.000Z",
        );
        const expiredLater = yield* invitationJob.expirePending(
          workspaceId as WorkspaceId,
          inv.id,
          "2026-05-01T00:00:00.000Z",
        );
        const rowAfter = yield* Effect.flatMap(WorkspacesRepo, (r) =>
          r.getInvitation(workspaceId as WorkspaceId, inv.id),
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
