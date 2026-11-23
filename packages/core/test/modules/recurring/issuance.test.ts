import { describe, expect, test } from "bun:test";
import type {
  IsoDate,
  ScheduleId,
  TemplateId,
  TemplateInput,
  TemplateSchedule,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  Invalid,
  NotFound,
  Templates,
  Unavailable,
} from "@kvitbit/domain/contract";
import { BigDecimal, Cause, Context, Effect, Exit, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { TemplateViewValue } from "../../../src/modules/recurring";
import {
  FakeDeliveryStatuses,
  FakeDocumentLinks,
  RecurringIssuance,
  RecurringIssuanceLive,
  RecurringRepo,
  RecurringRepoMemory,
  TemplatesLive,
} from "../../../src/modules/recurring";
import { member, runTest, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import {
  as,
  DocumentsStub,
  DocumentsStubLayer,
  job,
  MISSING_CONTACT,
  ok,
  scenario,
  templateInput,
} from "./fixtures";

const d = (s: string) => s as IsoDate;
const at = (iso: string) => TestClock.setTime(Date.parse(iso));
const view = (v: unknown) => v as TemplateViewValue;

const MONTHLY: TemplateSchedule = {
  every: { months: 1 },
  startOn: d("2026-11-23"),
  issueAs: "invoice",
  autoSend: false,
};

/** Creates a template with `schedule` attached; returns its ids. */
const setup = (schedule: TemplateSchedule, input: TemplateInput = templateInput()) =>
  Effect.gen(function* () {
    const t = yield* Templates;
    const created = view(yield* t.save(input));
    const scheduled = view(yield* t.schedule(created.id as TemplateId, schedule, 1));
    return {
      templateId: created.id as TemplateId,
      scheduleId: scheduled.schedule?.id as ScheduleId,
      next: scheduled.schedule?.nextOccurrence ?? null,
    };
  });

const runOccurrence = (scheduleId: ScheduleId, occurrence: IsoDate) =>
  as(job(scheduleId, occurrence))(
    Effect.flatMap(RecurringIssuance, (r) => r.run(scheduleId, occurrence)),
  );

/** One sweep tick whose `start` runs the workflow body inline. */
const sweep = Effect.flatMap(RecurringIssuance, (r) =>
  r.sweep((decision) => Effect.asVoid(r.run(decision.scheduleId, decision.occurrence))),
);

const getTemplate = (id: TemplateId) =>
  Effect.map(
    Effect.flatMap(Templates, (t) => t.get(id)),
    view,
  );
const runsOf = (id: TemplateId, page?: { cursor?: string; limit?: number }) =>
  Effect.flatMap(Templates, (t) => t.runs(id, page));
const documents = Effect.flatMap(DocumentsStub, (s) => s.documents(WORKSPACE_A));
const deliveries = Effect.flatMap(DocumentsStub, (s) => s.deliveries(WORKSPACE_A));

describe("Templates.schedule", () => {
  test("validates the rule through Schedules.validate", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        return [
          yield* Effect.exit(t.schedule(id, { ...MONTHLY, every: { months: 0 } }, 1)),
          yield* Effect.exit(t.schedule(id, { ...MONTHLY, endOn: d("2026-11-01") }, 1)),
          yield* Effect.exit(t.schedule(id, { ...MONTHLY, startOn: d("2026-02-30") }, 1)),
          yield* Effect.exit(t.schedule(id, { ...MONTHLY, issueAs: "credit_note" as never }, 1)),
        ];
      }),
    );
    for (const result of ok(exit)) {
      expect(Exit.isFailure(result)).toBe(true);
      const error = Exit.isFailure(result) ? JSON.stringify(result.cause) : "";
      expect(error).toContain("schedule.cadence_invalid");
    }
  });

  test("attaches at the next occurrence (month end), bumps the revision, detaches with null", async () => {
    const exit = await scenario(
      member("member"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        const attached = view(yield* t.schedule(id, { ...MONTHLY, startOn: d("2026-01-31") }, 1));
        const stale = yield* Effect.exit(t.schedule(id, null, 1));
        const detached = view(yield* t.schedule(id, null, 2));
        return { attached, stale, detached };
      }),
    );
    const { attached, stale, detached } = ok(exit);
    expect(attached.revision).toBe(2);
    expect(attached.schedule?.nextOccurrence).toBe(d("2026-11-30"));
    expect(attached.schedule?.paused).toBe(false);
    expect(attached.schedule?.pausedReason).toBeNull();
    expect(Exit.isFailure(stale) && JSON.stringify(stale.cause)).toContain("revision_changed");
    expect(detached.revision).toBe(3);
    expect(detached.schedule).toBeNull();
  });

  test("resume of a running schedule changes nothing; without a schedule it conflicts", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const bare = view(yield* t.save(templateInput())).id as TemplateId;
        const { templateId } = yield* setup(MONTHLY);
        const running = view(yield* t.resume(templateId));
        const none = yield* Effect.exit(t.resume(bare));
        return { running, none };
      }),
    );
    const { running, none } = ok(exit);
    expect(running.revision).toBe(2);
    expect(Exit.isFailure(none) && JSON.stringify(none.cause)).toContain("illegal_transition");
  });
});

describe("RecurringIssuance: exactly once", () => {
  test("a due occurrence issues one document as System and advances the schedule", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup(MONTHLY);
        const decisions = yield* sweep;
        const again = yield* sweep;
        const rerun = yield* runOccurrence(scheduleId, d("2026-11-23"));
        const stub = yield* DocumentsStub;
        return {
          decisions,
          again,
          rerun,
          docs: yield* documents,
          attempts: yield* Ref.get(stub.attempts),
          template: yield* getTemplate(templateId),
          runs: yield* runsOf(templateId),
        };
      }),
    );
    const r = ok(exit);
    expect<unknown>(r.decisions.map((x) => [x.occurrence, x.action])).toEqual([
      ["2026-11-23", "issue"],
    ]);
    expect(r.again).toEqual([]);
    expect(r.rerun.issue._tag).toBe("Issued");
    expect(r.rerun.issue._tag === "Issued" && r.rerun.issue.replayed).toBe(true);
    expect(r.docs).toHaveLength(1);
    expect(r.attempts.issue).toBe(1);
    const doc = r.docs[0];
    expect(doc?.actor).toBe("System:RecurringIssuance");
    expect(doc?.input.issuedOn).toBe(d("2026-11-23"));
    expect(doc?.input.taxableSupplyOn).toBe(d("2026-11-23"));
    expect(doc?.input.due).toEqual({ inDays: 14 });
    expect(r.template.schedule?.nextOccurrence).toBe(d("2026-12-23"));
    expect(r.runs.items).toEqual([
      {
        occurrence: d("2026-11-23"),
        outcome: "issued",
        at: "2026-11-23T09:00:00.000Z",
        document: { id: doc?.id as never, number: "2026-0001" },
        delivery: null,
        failure: null,
      },
    ]);
  });

  test("concurrent runs of one occurrence issue one document", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { scheduleId } = yield* setup(MONTHLY);
        const results = yield* Effect.all(
          [runOccurrence(scheduleId, d("2026-11-23")), runOccurrence(scheduleId, d("2026-11-23"))],
          { concurrency: "unbounded" },
        );
        return { results, docs: yield* documents };
      }),
    );
    const { results, docs } = ok(exit);
    expect(docs).toHaveLength(1);
    const replayed = results.map((x) => x.issue._tag === "Issued" && x.issue.replayed).sort();
    expect(replayed).toEqual([false, true]);
  });

  test("a crash inside the issue transaction rolls the document back; the rerun issues one", async () => {
    class Crash extends Context.Service<Crash, Ref.Ref<boolean>>()("test/Crash") {}
    const crashingRepo = Layer.effectContext(
      Effect.gen(function* () {
        const repo = yield* RecurringRepo;
        const crash = yield* Ref.make(false);
        return Context.make(
          RecurringRepo,
          RecurringRepo.of({
            ...repo,
            insertRun: (row) =>
              Effect.flatMap(Ref.getAndSet(crash, false), (die) =>
                die ? Effect.die("crash before the run row") : repo.insertRun(row),
              ),
          }),
        ).pipe(Context.add(Crash, crash));
      }),
    ).pipe(Layer.provide(RecurringRepoMemory));
    const layer = Layer.mergeAll(TemplatesLive, RecurringIssuanceLive).pipe(
      Layer.provideMerge(
        Layer.mergeAll(crashingRepo, FakeDeliveryStatuses.layer, FakeDocumentLinks.layer),
      ),
      Layer.provideMerge(DocumentsStubLayer),
    );
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup(MONTHLY);
        yield* Ref.set(yield* Crash, true);
        const crashed = yield* Effect.exit(runOccurrence(scheduleId, d("2026-11-23")));
        const afterCrash = { docs: yield* documents, template: yield* getTemplate(templateId) };
        const rerun = yield* runOccurrence(scheduleId, d("2026-11-23"));
        return { crashed, afterCrash, rerun, docs: yield* documents };
      }).pipe(Effect.provide(layer)),
    );
    const r = ok(exit);
    expect(Exit.isFailure(r.crashed)).toBe(true);
    expect(r.afterCrash.docs).toHaveLength(0);
    expect(r.afterCrash.template.schedule?.nextOccurrence).toBe(d("2026-11-23"));
    expect(r.rerun.issue._tag === "Issued" && !r.rerun.issue.replayed).toBe(true);
    expect(r.docs).toHaveLength(1);
  });

  test("a crash between issue and send: the rerun sends only, once", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const occurrence = d("2026-11-23");
        // The workflow died after the "issue" Activity committed.
        const issuedOnly = yield* as(job(scheduleId, occurrence))(
          Effect.flatMap(RecurringIssuance, (r) => r.issue(scheduleId, occurrence)),
        );
        const pendingRuns = yield* runsOf(templateId);
        const resumed = yield* runOccurrence(scheduleId, occurrence);
        const replay = yield* runOccurrence(scheduleId, occurrence);
        const stub = yield* DocumentsStub;
        const sent = yield* deliveries;
        const fake = yield* FakeDeliveryStatuses;
        yield* fake.set(WORKSPACE_A, sent[0]?.id as never, "sent");
        return {
          issuedOnly,
          pendingRuns,
          resumed,
          replay,
          docs: yield* documents,
          sent,
          attempts: yield* Ref.get(stub.attempts),
          runs: yield* runsOf(templateId),
        };
      }),
    );
    const r = ok(exit);
    expect(r.issuedOnly._tag === "Issued" && r.issuedOnly.run.send).toBe("pending");
    expect(r.pendingRuns.items[0]?.delivery).toBeNull();
    expect(r.resumed.issue._tag === "Issued" && r.resumed.issue.replayed).toBe(true);
    expect(r.resumed.send?._tag).toBe("Queued");
    expect(r.replay.send?._tag === "Queued" && r.replay.send.replayed).toBe(true);
    expect(r.docs).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
    expect(r.attempts).toEqual({ issue: 1, send: 1 });
    expect(r.runs.items[0]?.delivery).toEqual({ id: r.sent[0]?.id as never, status: "sent" });
  });

  test("a crash inside the send step rolls the delivery back; the rerun queues one", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const stub = yield* DocumentsStub;
        yield* Ref.set(stub.crashNextSend, true);
        const crashed = yield* Effect.exit(runOccurrence(scheduleId, d("2026-11-23")));
        const afterCrash = yield* deliveries;
        const rerun = yield* runOccurrence(scheduleId, d("2026-11-23"));
        return { crashed, afterCrash, rerun, docs: yield* documents, sent: yield* deliveries };
      }),
    );
    const r = ok(exit);
    expect(Exit.isFailure(r.crashed)).toBe(true);
    expect(r.afterCrash).toHaveLength(0);
    expect(r.rerun.send?._tag === "Queued" && !r.rerun.send.replayed).toBe(true);
    expect(r.docs).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
  });
});

describe("RecurringIssuance: failures pause the schedule", () => {
  test("Invalid from Documents pauses with its code; resume issues the same occurrence", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId } = yield* setup(MONTHLY);
        const stub = yield* DocumentsStub;
        yield* Ref.set(
          stub.failNextIssue,
          new Invalid({ issues: [{ path: ["contact"], code: "document.buyer_vat_id_required" }] }),
        );
        yield* sweep;
        const paused = yield* getTemplate(templateId);
        const failedRuns = yield* runsOf(templateId);
        const whilePaused = yield* sweep;
        const resumed = yield* Effect.flatMap(Templates, (t) => t.resume(templateId));
        yield* sweep;
        return {
          paused,
          failedRuns,
          whilePaused,
          resumed: view(resumed),
          docs: yield* documents,
          runs: yield* runsOf(templateId),
        };
      }),
    );
    const r = ok(exit);
    expect(r.paused.schedule?.paused).toBe(true);
    expect(r.paused.schedule?.pausedReason).toBe("document.buyer_vat_id_required");
    expect(r.failedRuns.items.map((x) => [x.outcome, x.failure, x.document])).toEqual([
      ["failed", "document.buyer_vat_id_required", null],
    ]);
    expect(r.whilePaused).toEqual([]);
    expect(r.resumed.schedule?.paused).toBe(false);
    expect(r.resumed.revision).toBe(3);
    expect(r.docs.map((x) => x.input.issuedOn)).toEqual([d("2026-11-23")]);
    expect<unknown>(r.runs.items.map((x) => [x.occurrence, x.outcome, x.failure])).toEqual([
      ["2026-11-23", "issued", null],
    ]);
  });

  test("NotFound from Documents pauses with no IssueCode", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId } = yield* setup(MONTHLY, templateInput({ contact: MISSING_CONTACT }));
        yield* sweep;
        return yield* getTemplate(templateId);
      }),
    );
    const template = ok(exit);
    expect(template.schedule?.paused).toBe(true);
    expect(template.schedule?.pausedReason).toBeNull();
  });

  test("Unavailable fails the step for retry without pausing", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup(MONTHLY);
        const stub = yield* DocumentsStub;
        yield* Ref.set(stub.failNextIssue, new Unavailable({ dependency: "database" }));
        const failed = yield* Effect.exit(runOccurrence(scheduleId, d("2026-11-23")));
        const between = {
          template: yield* getTemplate(templateId),
          runs: yield* runsOf(templateId),
        };
        const retried = yield* runOccurrence(scheduleId, d("2026-11-23"));
        return { failed, between, retried };
      }),
    );
    const r = ok(exit);
    expect(r.failed).toEqual(Exit.fail(new Unavailable({ dependency: "database" })));
    expect(r.between.template.schedule?.paused).toBe(false);
    expect(r.between.runs.items).toEqual([]);
    expect(r.retried.issue._tag).toBe("Issued");
  });

  test("a refused send keeps the document and pauses the schedule", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const stub = yield* DocumentsStub;
        yield* Ref.set(
          stub.failNextSend,
          new Invalid({ issues: [{ path: ["to"], code: "request.malformed" }] }),
        );
        const result = yield* runOccurrence(scheduleId, d("2026-11-23"));
        const rerun = yield* runOccurrence(scheduleId, d("2026-11-23"));
        return {
          result,
          rerun,
          docs: yield* documents,
          sent: yield* deliveries,
          template: yield* getTemplate(templateId),
          runs: yield* runsOf(templateId),
        };
      }),
    );
    const r = ok(exit);
    expect(r.result.send?._tag).toBe("Paused");
    expect(r.rerun.send?._tag).toBe("Paused");
    expect(r.docs).toHaveLength(1);
    expect(r.sent).toHaveLength(0);
    expect(r.template.schedule?.pausedReason).toBe("request.malformed");
    expect(r.runs.items.map((x) => [x.outcome, x.failure])).toEqual([
      ["issued", "request.malformed"],
    ]);
  });
});

describe("RecurringSweep: due occurrences on the Prague calendar", () => {
  test("up to 7 days late issues; more pauses with schedule.missed_occurrences; resume catches up in order", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        yield* at("2026-11-01T09:00:00Z");
        const weekly = { ...MONTHLY, every: { weeks: 1 }, startOn: d("2026-11-01") };
        const late = yield* setup(weekly);
        const missed = yield* setup(weekly);
        yield* at("2026-11-08T09:00:00Z");
        // `late`: 2026-11-01 is exactly 7 days late; pause `missed` by hand via the cap later.
        const onTime = yield* as(job(late.scheduleId, d("2026-11-01")))(
          Effect.flatMap(RecurringIssuance, (r) => r.run(late.scheduleId, d("2026-11-01"))),
        );
        yield* at("2026-11-23T09:00:00Z");
        const capped = yield* as(job(missed.scheduleId, d("2026-11-01")))(
          Effect.flatMap(RecurringIssuance, (r) =>
            r.pauseMissed(missed.scheduleId, d("2026-11-01")),
          ),
        );
        const pausedView = yield* getTemplate(missed.templateId);
        const cappedRuns = yield* runsOf(missed.templateId);
        yield* Effect.flatMap(Templates, (t) => t.resume(missed.templateId));
        const ticks = [];
        for (let i = 0; i < 5; i++) ticks.push(yield* sweep);
        return { onTime, capped, pausedView, cappedRuns, ticks, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.onTime.issue._tag).toBe("Issued");
    expect(r.capped._tag).toBe("Paused");
    expect(r.pausedView.schedule?.pausedReason).toBe("schedule.missed_occurrences");
    expect<unknown>(r.cappedRuns.items.map((x) => [x.occurrence, x.outcome, x.failure])).toEqual([
      ["2026-11-01", "skipped_missed", "schedule.missed_occurrences"],
    ]);
    // `late` (next 11-08, 15 days late on 11-23) pauses on the first tick; `missed` catches up.
    const first = r.ticks[0] ?? [];
    expect<unknown>(first.map((x) => [x.occurrence, x.action])).toEqual([
      ["2026-11-01", "issue"],
      ["2026-11-08", "pause_missed"],
    ]);
    expect(r.ticks.map((t) => t.length)).toEqual([2, 1, 1, 1, 0]);
    const missedDocs = r.docs.map((x) => x.input.issuedOn).sort();
    expect(missedDocs).toEqual([
      d("2026-11-01"),
      d("2026-11-01"),
      d("2026-11-08"),
      d("2026-11-15"),
      d("2026-11-22"),
    ]);
  });

  test("the sweep tick pauses a schedule past the cap", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        yield* at("2026-11-01T09:00:00Z");
        const { templateId } = yield* setup({ ...MONTHLY, startOn: d("2026-11-01") });
        yield* at("2026-11-09T09:00:00Z");
        const decisions = yield* sweep;
        return { decisions, template: yield* getTemplate(templateId), docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.decisions.map((x) => x.action)).toEqual(["pause_missed"]);
    expect(r.template.schedule?.pausedReason).toBe("schedule.missed_occurrences");
    expect(r.docs).toHaveLength(0);
  });

  test("the Prague date decides what is due across both DST changes", async () => {
    const dueAt = (iso: string) =>
      Effect.andThen(
        at(iso),
        Effect.flatMap(RecurringIssuance, (r) => r.due),
      );
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        yield* at("2026-03-28T09:00:00Z");
        yield* setup({ ...MONTHLY, startOn: d("2026-03-29") });
        const spring = [
          yield* dueAt("2026-03-28T22:59:00Z"), // 23:59 CET, 28 Mar
          yield* dueAt("2026-03-28T23:00:00Z"), // 00:00 CET, 29 Mar (DST starts 02:00)
        ];
        return { spring };
      }),
    );
    const autumn = await scenario(
      member("owner"),
      Effect.gen(function* () {
        yield* at("2026-10-24T09:00:00Z");
        yield* setup({ ...MONTHLY, startOn: d("2026-10-25") });
        return [
          yield* dueAt("2026-10-24T21:59:00Z"), // 23:59 CEST, 24 Oct
          yield* dueAt("2026-10-24T22:00:00Z"), // 00:00 CEST, 25 Oct (DST ends 03:00)
        ];
      }),
    );
    expect(ok(exit).spring.map((x) => x.length)).toEqual([0, 1]);
    expect<unknown>(ok(autumn).map((x) => x.map((y) => y.occurrence))).toEqual([
      [],
      ["2026-10-25"],
    ]);
  });

  test("a monthly schedule from the 31st issues on month ends; endOn ends it", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId } = yield* setup({
          ...MONTHLY,
          startOn: d("2026-01-31"),
          endOn: d("2027-01-15"),
        });
        yield* at("2026-11-30T09:00:00Z");
        yield* sweep;
        yield* at("2026-12-31T09:00:00Z");
        yield* sweep;
        return { docs: yield* documents, template: yield* getTemplate(templateId) };
      }),
    );
    const r = ok(exit);
    expect(r.docs.map((x) => x.input.issuedOn)).toEqual([d("2026-11-30"), d("2026-12-31")]);
    expect(r.template.schedule?.nextOccurrence).toBeNull();
  });

  test("changing a schedule affects future occurrences only", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId } = yield* setup(MONTHLY);
        yield* sweep;
        const t = yield* Templates;
        const current = yield* getTemplate(templateId);
        const changed = view(
          yield* t.schedule(templateId, { ...MONTHLY, issueAs: "proforma" }, current.revision),
        );
        const tick = yield* sweep;
        return { changed, tick, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.changed.schedule?.nextOccurrence).toBe(d("2026-12-23"));
    expect(r.changed.schedule?.issueAs).toBe("proforma");
    expect(r.tick).toEqual([]);
    expect(r.docs).toHaveLength(1);
  });

  test("a stale or detached occurrence is a no-op", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup(MONTHLY);
        const stale = yield* runOccurrence(scheduleId, d("2026-10-23"));
        yield* Effect.flatMap(Templates, (t) => t.schedule(templateId, null, 2));
        const detached = yield* runOccurrence(scheduleId, d("2026-11-23"));
        return { stale, detached, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.stale.issue).toEqual({ _tag: "Skipped", reason: "not_next" });
    expect(r.detached.issue).toEqual({ _tag: "Skipped", reason: "detached" });
    expect(r.docs).toHaveLength(0);
  });
});

describe("RecurringIssuance authorization (R4, R5)", () => {
  test("only the System caller of this occurrence's job may run its steps", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { scheduleId } = yield* setup(MONTHLY);
        const r = yield* RecurringIssuance;
        const occurrence = d("2026-11-23");
        return {
          scheduleId,
          memberIssue: yield* Effect.exit(r.issue(scheduleId, occurrence)),
          memberSend: yield* Effect.exit(r.send(scheduleId, occurrence)),
          memberPause: yield* Effect.exit(r.pauseMissed(scheduleId, occurrence)),
          otherJob: yield* Effect.exit(as(system())(r.issue(scheduleId, occurrence))),
          otherOccurrence: yield* Effect.exit(
            as(job(scheduleId, d("2026-12-23")))(r.issue(scheduleId, occurrence)),
          ),
          otherWorkspace: yield* Effect.exit(
            as(job(scheduleId, occurrence, WORKSPACE_B))(r.issue(scheduleId, occurrence)),
          ),
          docs: yield* documents,
        };
      }),
    );
    const r = ok(exit);
    expect(r.memberIssue).toEqual(Exit.fail(new Forbidden({ action: "document.issue" })));
    expect(r.memberSend).toEqual(Exit.fail(new Forbidden({ action: "document.send" })));
    expect(r.memberPause).toEqual(Exit.fail(new Forbidden({ action: "document.issue" })));
    expect(r.otherJob).toEqual(Exit.fail(new Forbidden({ action: "document.issue" })));
    expect(r.otherOccurrence).toEqual(Exit.fail(new Forbidden({ action: "document.issue" })));
    expect(r.otherWorkspace).toEqual(
      Exit.fail(new NotFound({ entity: "Schedule", id: r.scheduleId })),
    );
    expect(r.docs).toHaveLength(0);
  });
});

describe("Templates.runs", () => {
  test("pages newest occurrence first; a cursor is bound to its template", async () => {
    const exit = await scenario(
      member("accountant"),
      Effect.gen(function* () {
        const owner = as(member("owner"));
        yield* at("2026-11-01T09:00:00Z");
        const weekly = { ...MONTHLY, every: { weeks: 1 }, startOn: d("2026-11-01") };
        const { templateId } = yield* owner(setup(weekly));
        const other = yield* owner(setup(MONTHLY));
        for (const day of ["2026-11-01", "2026-11-08", "2026-11-15"]) {
          yield* at(`${day}T09:00:00Z`);
          yield* sweep;
        }
        const first = yield* runsOf(templateId, { limit: 2 });
        const second = yield* runsOf(templateId, { limit: 2, cursor: first.nextCursor ?? "" });
        const foreign = yield* Effect.exit(
          runsOf(other.templateId, { cursor: first.nextCursor ?? "" }),
        );
        const badLimit = yield* Effect.exit(runsOf(templateId, { limit: 0 }));
        return { first, second, foreign, badLimit };
      }),
    );
    const r = ok(exit);
    expect<unknown>(r.first.items.map((x) => x.occurrence)).toEqual(["2026-11-15", "2026-11-08"]);
    expect(r.first.nextCursor).not.toBeNull();
    expect<unknown>(r.second.items.map((x) => x.occurrence)).toEqual(["2026-11-01"]);
    expect(r.second.nextCursor).toBeNull();
    expect(r.foreign).toEqual(
      Exit.fail(new Invalid({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] })),
    );
    // Out-of-range limits are clamped (PageRequest bounds are checked at decode).
    expect(Exit.isSuccess(r.badLimit)).toBe(true);
  });
});

describe("council follow-ups", () => {
  test("an issued document is linked to its schedule and occurrence", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { scheduleId } = yield* setup(MONTHLY);
        yield* sweep;
        const links = yield* Effect.flatMap(FakeDocumentLinks, (l) => l.all);
        return { scheduleId, links, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.links).toEqual([
      { document: r.docs[0]?.id as string, scheduleId: r.scheduleId, occurrence: d("2026-11-23") },
    ]);
  });

  test("a run that starts past the catch-up cap pauses instead of issuing", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        yield* at("2026-11-01T09:00:00Z");
        const { templateId, scheduleId } = yield* setup({ ...MONTHLY, startOn: d("2026-11-01") });
        yield* at("2026-11-09T09:00:00Z");
        const result = yield* runOccurrence(scheduleId, d("2026-11-01"));
        return { result, template: yield* getTemplate(templateId), docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.result.issue._tag).toBe("Paused");
    expect(r.template.schedule?.pausedReason).toBe("schedule.missed_occurrences");
    expect(r.docs).toHaveLength(0);
  });

  test("permanent Conflicts and NotFound pause with a visible error; a revision race retries", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const stub = yield* DocumentsStub;
        const a = yield* setup(MONTHLY);
        yield* Ref.set(stub.failNextIssue, new Conflict({ reason: "duplicate" }));
        yield* runOccurrence(a.scheduleId, d("2026-11-23"));
        const b = yield* setup(MONTHLY, templateInput({ contact: MISSING_CONTACT }));
        yield* runOccurrence(b.scheduleId, d("2026-11-23"));
        const c = yield* setup(MONTHLY);
        yield* Ref.set(
          stub.failNextIssue,
          new Conflict({ reason: "revision_changed", currentRevision: 2 }),
        );
        const race = yield* Effect.exit(runOccurrence(c.scheduleId, d("2026-11-23")));
        return {
          a: yield* getTemplate(a.templateId),
          b: yield* getTemplate(b.templateId),
          c: yield* getTemplate(c.templateId),
          race,
        };
      }),
    );
    const r = ok(exit);
    expect([r.a.schedule?.paused, r.a.schedule?.pausedError]).toEqual([true, "Conflict:duplicate"]);
    expect([r.b.schedule?.paused, r.b.schedule?.pausedError]).toEqual([true, "NotFound:Contact"]);
    expect(Exit.isFailure(r.race)).toBe(true);
    expect(r.c.schedule?.paused).toBe(false);
  });

  test("pendingSends lists issued occurrences whose send is still pending", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const { scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const r = yield* RecurringIssuance;
        yield* as(job(scheduleId, d("2026-11-23")))(r.issue(scheduleId, d("2026-11-23")));
        const fresh = yield* r.pendingSends(60_000);
        yield* TestClock.adjust(120_000);
        const stale = yield* r.pendingSends(60_000);
        yield* runOccurrence(scheduleId, d("2026-11-23"));
        const after = yield* r.pendingSends(0);
        return { scheduleId, fresh, stale, after };
      }),
    );
    const r = ok(exit);
    expect(r.fresh).toEqual([]);
    expect(r.stale).toEqual([
      { workspaceId: WORKSPACE_A, scheduleId: r.scheduleId, occurrence: d("2026-11-23") },
    ]);
    expect(r.after).toEqual([]);
  });

  test("an interrupted start stops the sweep tick instead of being logged", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        yield* setup(MONTHLY);
        const r = yield* RecurringIssuance;
        return yield* Effect.exit(r.sweep(() => Effect.interrupt));
      }),
    );
    const result = ok(exit);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
  });

  test("use authorizes the document action before reading the template", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        return {
          accountant: yield* Effect.exit(as(member("accountant"))(t.use(id))),
          readToken: yield* Effect.exit(
            as(member("owner", { scopes: ["templates:read"] }))(t.use(id, { as: "issued" })),
          ),
        };
      }),
    );
    const r = ok(exit);
    expect(r.accountant).toEqual(Exit.fail(new Forbidden({ action: "document.draft" })));
    expect(r.readToken).toEqual(Exit.fail(new Forbidden({ action: "document.issue" })));
  });
});

describe("review round 1 regressions", () => {
  test("detaching and reattaching never bills an issued date twice", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const { templateId } = yield* setup(MONTHLY);
        yield* sweep;
        const detached = view(yield* t.schedule(templateId, null, 2));
        const reattached = view(yield* t.schedule(templateId, MONTHLY, detached.revision));
        const tick = yield* sweep;
        return { reattached, tick, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.reattached.schedule?.nextOccurrence).toBe(d("2026-12-23"));
    expect(r.tick).toEqual([]);
    expect(r.docs.map((x) => x.input.issuedOn)).toEqual([d("2026-11-23")]);
  });

  test("an edit waits while an occurrence is due; settings-only edits keep the next date", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const weekly = { ...MONTHLY, every: { weeks: 1 } };
        const { templateId } = yield* setup(weekly);
        yield* at("2026-11-30T08:00:00Z");
        const blocked = yield* Effect.exit(
          t.schedule(templateId, { ...MONTHLY, issueAs: "proforma", autoSend: true }, 2),
        );
        // The due backlog issues under the rule and settings it was due under.
        yield* sweep;
        yield* sweep;
        const sendOn = view(yield* t.schedule(templateId, { ...weekly, autoSend: true }, 2));
        return { blocked, sendOn, docs: yield* documents, sent: yield* deliveries };
      }),
    );
    const r = ok(exit);
    expect(r.blocked).toEqual(Exit.fail(new Conflict({ reason: "illegal_transition" })));
    expect(r.docs.map((x) => [x.kind, x.input.issuedOn])).toEqual([
      ["invoice", d("2026-11-23")],
      ["invoice", d("2026-11-30")],
    ]);
    expect(r.sent).toHaveLength(0);
    expect(r.sendOn.schedule?.nextOccurrence).toBe(d("2026-12-07"));
    expect(r.sendOn.schedule?.autoSend).toBe(true);
  });

  test("a stale or foreign schedule call reports the revision or NotFound before Invalid", async () => {
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        const bad = { ...MONTHLY, every: { months: 0 } };
        return {
          id,
          stale: yield* Effect.exit(t.schedule(id, bad, 7)),
          foreign: yield* Effect.exit(
            as(member("owner", { workspaceId: WORKSPACE_B }))(t.schedule(id, bad, 1)),
          ),
        };
      }),
    );
    const r = ok(exit);
    expect(r.stale).toEqual(
      Exit.fail(new Conflict({ reason: "revision_changed", currentRevision: 1 })),
    );
    expect(r.foreign).toEqual(Exit.fail(new NotFound({ entity: "Template", id: r.id })));
  });

  test("keyed use replays the original view, decimals and all, even after a discard", async () => {
    const KEY = "req-use-1" as never;
    const exit = await scenario(
      member("owner"),
      Effect.gen(function* () {
        const t = yield* Templates;
        const id = view(yield* t.save(templateInput())).id as TemplateId;
        const first = yield* t.use(id, {}, { requestKey: KEY });
        const docs = yield* Documents;
        yield* docs.discardDraft(first.id, first.revision);
        const replay = yield* t.use(id, {}, { requestKey: KEY });
        const mismatch = yield* Effect.exit(
          t.use(id, { patch: { note: "x" } }, { requestKey: KEY }),
        );
        return { first, replay, mismatch, left: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.replay).toEqual(r.first);
    const line = (
      r.replay as unknown as { lines: ReadonlyArray<{ unitPrice: BigDecimal.BigDecimal }> }
    ).lines[0];
    expect(BigDecimal.isBigDecimal(line?.unitPrice)).toBe(true);
    expect(line?.unitPrice).toEqual(BigDecimal.fromStringUnsafe("1250.50"));
    expect(r.left).toHaveLength(0);
    expect(r.mismatch).toEqual(Exit.fail(new Conflict({ reason: "idempotency_mismatch" })));
  });
});
