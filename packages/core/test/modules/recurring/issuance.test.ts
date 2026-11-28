import { describe, expect, test } from "bun:test";
import type { TemplateInput, TemplateSchedule } from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  Invalid,
  IsoDate,
  NotFound,
  RequestKey,
  type ScheduleId,
  type TemplateId,
  Templates,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { SweepDecision } from "../../../src/modules/recurring";
import {
  FakeDeliveryStatuses,
  FakeDocumentLinks,
  RecurringIssuance,
  RecurringIssuanceLive,
  RecurringRepo,
  RecurringRepoMemory,
  TemplatesLive,
} from "../../../src/modules/recurring";
import { sha256Hex } from "../../../src/shared/hash";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, runTest, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { TestCaller } from "../../helpers/callerContext";
import { withoutStackTrace } from "../../helpers/run";
import {
  as,
  DocumentsStub,
  DocumentsStubLayer,
  job,
  MISSING_CONTACT,
  ok,
  scenario,
  templateInput,
  templateView,
} from "./fixtures";

const d = (s: string) => IsoDate.make(s);
const at = (iso: string) => TestClock.setTime(Date.parse(iso));

const MONTHLY: TemplateSchedule = {
  every: { months: 1 },
  startOn: d("2026-11-23"),
  issueAs: "invoice",
  autoSend: false,
};

/** Creates a template with `schedule` attached; returns its ids. */
const setup = (schedule: TemplateSchedule, input: TemplateInput = templateInput()) =>
  Effect.gen(function* () {
    const testCaller = yield* TestCaller;
    const t = yield* Templates;
    const saveResult = yield* t.save(testCaller, input);
    const created = yield* templateView(saveResult);
    const scheduleResult = yield* t.schedule(testCaller, created.id, schedule, 1);
    const scheduled = yield* templateView(scheduleResult);
    if (scheduled.schedule === null) return yield* Effect.die("Expected an attached schedule");
    return { templateId: created.id, scheduleId: scheduled.schedule.id };
  });

const runOccurrence = (scheduleId: ScheduleId, occurrence: IsoDate) =>
  as(job(scheduleId)(occurrence))(
    Effect.flatMap(RecurringIssuance, (r) =>
      r.run(job(scheduleId)(occurrence), scheduleId, occurrence),
    ),
  );

/** One sweep tick whose `start` runs the workflow body inline. */
const sweep = Effect.flatMap(RecurringIssuance, (r) =>
  r.sweep((caller, decision) =>
    Effect.asVoid(r.run(caller, decision.scheduleId, decision.occurrence)),
  ),
);

const getTemplate = (id: TemplateId) =>
  Templates.pipe(
    Effect.flatMap((t) => Effect.flatMap(TestCaller, (caller) => t.get(caller, id))),
    Effect.flatMap(templateView),
  );
const runsOf = (id: TemplateId, page?: { cursor?: string; limit?: number }) =>
  Effect.flatMap(Templates, (t) =>
    Effect.flatMap(TestCaller, (caller) => t.runs(caller, id, page)),
  );
const documents = Effect.flatMap(DocumentsStub, (s) => s.documents(WORKSPACE_A));
const deliveries = Effect.flatMap(DocumentsStub, (s) => s.deliveries(WORKSPACE_A));

describe("Templates.schedule", () => {
  test("validates the rule through Schedules.validate", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(member("owner"), templateInput());
        const id = (yield* templateView(saveResult)).id;
        // Simulate malformed data reaching the scheduler without a transport decoder.
        const invalidDate = IsoDate.make("2026-02-30", { disableChecks: true });
        const invalidKind = { ...MONTHLY };
        Reflect.set(invalidKind, "issueAs", "credit_note");
        return [
          yield* Effect.exit(
            t.schedule(member("owner"), id, { ...MONTHLY, every: { months: 0 } }, 1),
          ),
          yield* Effect.exit(
            t.schedule(member("owner"), id, { ...MONTHLY, endOn: d("2026-11-01") }, 1),
          ),
          yield* Effect.exit(
            t.schedule(member("owner"), id, { ...MONTHLY, startOn: invalidDate }, 1),
          ),
          yield* Effect.exit(t.schedule(member("owner"), id, invalidKind, 1)),
        ];
      }),
    );
    for (const result of ok(exit)) {
      expect(Exit.isFailure(result)).toBe(true);
      const error = result.pipe(Exit.findErrorOption, Option.getOrUndefined);
      expect(
        error?._tag === "Invalid" && EffectArray.map(error.issues, (issue) => issue.code),
      ).toContain("schedule.cadence_invalid");
    }
  });

  test("attaches at the next occurrence (month end), bumps the revision, detaches with null", async () => {
    const exit = await scenario(member("member"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(member("member"), templateInput());
        const id = (yield* templateView(saveResult)).id;
        const scheduleResult = yield* t.schedule(
          member("member"),
          id,
          { ...MONTHLY, startOn: d("2026-01-31") },
          1,
        );
        const attached = yield* templateView(scheduleResult);
        const stale = yield* Effect.exit(t.schedule(member("member"), id, null, 1));
        const scheduleResult2 = yield* t.schedule(member("member"), id, null, 2);
        const detached = yield* templateView(scheduleResult2);
        return { attached, stale, detached };
      }),
    );
    const { attached, stale, detached } = ok(exit);
    expect(attached.revision).toBe(2);
    expect(attached.schedule?.nextOccurrence).toBe(d("2026-11-30"));
    expect(attached.schedule?.paused).toBe(false);
    expect(attached.schedule?.pausedReason).toBeNull();
    const error = stale.pipe(Exit.findErrorOption, Option.getOrUndefined);
    expect(error?._tag === "Conflict" && error.reason).toBe("revision_changed");
    expect(detached.revision).toBe(3);
    expect(detached.schedule).toBeNull();
  });

  test("resume of a running schedule changes nothing; without a schedule it conflicts", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(member("owner"), templateInput());
        const bare = (yield* templateView(saveResult)).id;
        const { templateId } = yield* setup(MONTHLY);
        const resumeResult = yield* t.resume(member("owner"), templateId);
        const running = yield* templateView(resumeResult);
        const none = yield* Effect.exit(t.resume(member("owner"), bare));
        return { running, none };
      }),
    );
    const { running, none } = ok(exit);
    expect(running.revision).toBe(2);
    const error = none.pipe(Exit.findErrorOption, Option.getOrUndefined);
    expect(error?._tag === "Conflict" && error.reason).toBe("illegal_transition");
  });
});

describe("RecurringIssuance: exactly once", () => {
  test("a due occurrence issues one document as System and advances the schedule", async () => {
    const exit = await scenario(member("owner"))(
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
    expect<unknown>(EffectArray.map(r.decisions, (x) => [x.occurrence, x.action])).toEqual([
      ["2026-11-23", "issue"],
    ]);
    expect(r.again).toEqual([]);
    expect(r.rerun.issue._tag).toBe("Issued");
    expect(r.rerun.issue._tag === "Issued" && r.rerun.issue.replayed).toBe(true);
    expect(r.docs).toHaveLength(1);
    expect(r.attempts.issue).toBe(1);
    const doc = Option.getOrThrow(EffectArray.head(r.docs));
    expect(doc.actor).toBe("System:RecurringIssuance");
    expect(doc.input.issuedOn).toBe(d("2026-11-23"));
    expect(doc.input.taxableSupplyOn).toBe(d("2026-11-23"));
    expect(doc.input.due).toEqual({ inDays: 14 });
    expect(r.template.schedule?.nextOccurrence).toBe(d("2026-12-23"));
    expect(r.runs.items).toEqual([
      {
        occurrence: d("2026-11-23"),
        outcome: "issued",
        at: "2026-11-23T09:00:00.000Z",
        document: { id: doc.id, number: "2026-0001" },
        delivery: null,
        failure: null,
      },
    ]);
  });

  test("concurrent runs of one occurrence issue one document", async () => {
    const exit = await scenario(member("owner"))(
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
    const replayed = EffectArray.map(
      results,
      (x) => x.issue._tag === "Issued" && x.issue.replayed,
    ).sort();
    expect(replayed).toEqual([false, true]);
  });

  test("a crash inside the issue transaction rolls the document back; the rerun issues one", async () => {
    class Crash extends Context.Service<Crash, Ref.Ref<boolean>>()(
      "@kvitbit/core/test/modules/recurring/issuance.test/Crash",
    ) {}
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
        const crash = yield* Crash;
        yield* Ref.set(crash, true);
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const occurrence = d("2026-11-23");
        // The workflow died after the "issue" Activity committed.
        const issuedOnly = yield* as(job(scheduleId)(occurrence))(
          Effect.flatMap(RecurringIssuance, (issuance) =>
            issuance.issue(job(scheduleId)(occurrence), scheduleId, occurrence),
          ),
        );
        const pendingRuns = yield* runsOf(templateId);
        const resumed = yield* runOccurrence(scheduleId, occurrence);
        const replay = yield* runOccurrence(scheduleId, occurrence);
        const stub = yield* DocumentsStub;
        const sent = yield* deliveries;
        const delivery = sent[0];
        if (delivery === undefined) return yield* Effect.die("Expected a queued delivery");
        const fake = yield* FakeDeliveryStatuses;
        yield* fake.set(WORKSPACE_A, delivery.id, "sent");
        return {
          issuedOnly,
          pendingRuns,
          resumed,
          replay,
          docs: yield* documents,
          sent,
          deliveryId: delivery.id,
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
    expect(r.runs.items[0]?.delivery).toEqual({ id: r.deliveryId, status: "sent" });
  });

  test("a crash inside the send step rolls the delivery back; the rerun queues one", async () => {
    const exit = await scenario(member("owner"))(
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { templateId } = yield* setup(MONTHLY);
        const stub = yield* DocumentsStub;
        yield* Ref.set(
          stub.failNextIssue,
          Invalid.make({ issues: [{ path: ["contact"], code: "document.buyer_vat_id_required" }] }),
        );
        yield* sweep;
        const paused = yield* getTemplate(templateId);
        const failedRuns = yield* runsOf(templateId);
        const whilePaused = yield* sweep;
        const resumed = yield* Effect.flatMap(Templates, (t) =>
          t.resume(member("owner"), templateId),
        );
        yield* sweep;
        return {
          paused,
          failedRuns,
          whilePaused,
          resumed: yield* templateView(resumed),
          docs: yield* documents,
          runs: yield* runsOf(templateId),
        };
      }),
    );
    const r = ok(exit);
    expect(r.paused.schedule?.paused).toBe(true);
    expect(r.paused.schedule?.pausedReason).toBe("document.buyer_vat_id_required");
    expect(EffectArray.map(r.failedRuns.items, (x) => [x.outcome, x.failure, x.document])).toEqual([
      ["failed", "document.buyer_vat_id_required", null],
    ]);
    expect(r.whilePaused).toEqual([]);
    expect(r.resumed.schedule?.paused).toBe(false);
    expect(r.resumed.revision).toBe(3);
    expect(EffectArray.map(r.docs, (x) => x.input.issuedOn)).toEqual([d("2026-11-23")]);
    expect<unknown>(
      EffectArray.map(r.runs.items, (x) => [x.occurrence, x.outcome, x.failure]),
    ).toEqual([["2026-11-23", "issued", null]]);
  });

  test("NotFound from Documents pauses with no IssueCode", async () => {
    const exit = await scenario(member("owner"))(
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup(MONTHLY);
        const stub = yield* DocumentsStub;
        yield* Ref.set(stub.failNextIssue, Unavailable.make({ dependency: "database" }));
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
    expect(r.failed.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Unavailable.make({ dependency: "database" })),
    );
    expect(r.between.template.schedule?.paused).toBe(false);
    expect(r.between.runs.items).toEqual([]);
    expect(r.retried.issue._tag).toBe("Issued");
  });

  test("a refused send keeps the document and pauses the schedule", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const stub = yield* DocumentsStub;
        yield* Ref.set(
          stub.failNextSend,
          Invalid.make({ issues: [{ path: ["to"], code: "request.malformed" }] }),
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
    expect(EffectArray.map(r.runs.items, (x) => [x.outcome, x.failure])).toEqual([
      ["issued", "request.malformed"],
    ]);
  });
});

describe("RecurringSweep: due occurrences on the Prague calendar", () => {
  test("up to 7 days late issues; more pauses with schedule.missed_occurrences; resume catches up in order", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        yield* at("2026-11-01T09:00:00Z");
        const weekly = { ...MONTHLY, every: { weeks: 1 }, startOn: d("2026-11-01") };
        const late = yield* setup(weekly);
        const missed = yield* setup(weekly);
        yield* at("2026-11-08T09:00:00Z");
        // `late`: 2026-11-01 is exactly 7 days late; pause `missed` by hand via the cap later.
        const onTime = yield* as(job(late.scheduleId)(d("2026-11-01")))(
          Effect.flatMap(RecurringIssuance, (issuance) =>
            issuance.run(job(late.scheduleId)(d("2026-11-01")), late.scheduleId, d("2026-11-01")),
          ),
        );
        yield* at("2026-11-23T09:00:00Z");
        const capped = yield* as(job(missed.scheduleId)(d("2026-11-01")))(
          Effect.flatMap(RecurringIssuance, (issuance) =>
            issuance.pauseMissed(
              job(missed.scheduleId)(d("2026-11-01")),
              missed.scheduleId,
              d("2026-11-01"),
            ),
          ),
        );
        const pausedView = yield* getTemplate(missed.templateId);
        const cappedRuns = yield* runsOf(missed.templateId);
        yield* Effect.flatMap(Templates, (t) => t.resume(member("owner"), missed.templateId));
        const ticks: Array<ReadonlyArray<SweepDecision>> = [];
        for (let i = 0; i < 5; i++) {
          const decisions = yield* sweep;
          ticks.push(decisions);
        }
        return { onTime, capped, pausedView, cappedRuns, ticks, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.onTime.issue._tag).toBe("Issued");
    expect(r.capped._tag).toBe("Paused");
    expect(r.pausedView.schedule?.pausedReason).toBe("schedule.missed_occurrences");
    expect<unknown>(
      EffectArray.map(r.cappedRuns.items, (x) => [x.occurrence, x.outcome, x.failure]),
    ).toEqual([["2026-11-01", "skipped_missed", "schedule.missed_occurrences"]]);
    // `late` (next 11-08, 15 days late on 11-23) pauses on the first tick; `missed` catches up.
    const first = r.ticks[0] ?? [];
    expect<unknown>(EffectArray.map(first, (x) => [x.occurrence, x.action])).toEqual([
      ["2026-11-01", "issue"],
      ["2026-11-08", "pause_missed"],
    ]);
    expect(EffectArray.map(r.ticks, (t) => t.length)).toEqual([2, 1, 1, 1, 0]);
    const missedDocs = EffectArray.map(r.docs, (x) => x.input.issuedOn).sort();
    expect(missedDocs).toEqual([
      d("2026-11-01"),
      d("2026-11-01"),
      d("2026-11-08"),
      d("2026-11-15"),
      d("2026-11-22"),
    ]);
  });

  test("the sweep tick pauses a schedule past the cap", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        yield* at("2026-11-01T09:00:00Z");
        const { templateId } = yield* setup({ ...MONTHLY, startOn: d("2026-11-01") });
        yield* at("2026-11-09T09:00:00Z");
        const decisions = yield* sweep;
        return { decisions, template: yield* getTemplate(templateId), docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(EffectArray.map(r.decisions, (x) => x.action)).toEqual(["pause_missed"]);
    expect(r.template.schedule?.pausedReason).toBe("schedule.missed_occurrences");
    expect(r.docs).toHaveLength(0);
  });

  test("the Prague date decides what is due across both DST changes", async () => {
    const dueAt = (iso: string) =>
      Effect.andThen(
        at(iso),
        Effect.flatMap(RecurringIssuance, (r) => r.due),
      );
    const exit = await scenario(member("owner"))(
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
    const autumn = await scenario(member("owner"))(
      Effect.gen(function* () {
        yield* at("2026-10-24T09:00:00Z");
        yield* setup({ ...MONTHLY, startOn: d("2026-10-25") });
        return [
          yield* dueAt("2026-10-24T21:59:00Z"), // 23:59 CEST, 24 Oct
          yield* dueAt("2026-10-24T22:00:00Z"), // 00:00 CEST, 25 Oct (DST ends 03:00)
        ];
      }),
    );
    expect(EffectArray.map(ok(exit).spring, (x) => x.length)).toEqual([0, 1]);
    const autumnTicks = ok(autumn);
    expect(
      EffectArray.map(autumnTicks, (tick) => EffectArray.map(tick, (x) => x.occurrence)),
    ).toEqual([[], [d("2026-10-25")]]);
  });

  test("a monthly schedule from the 31st issues on month ends; endOn ends it", async () => {
    const exit = await scenario(member("owner"))(
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
    expect(EffectArray.map(r.docs, (x) => x.input.issuedOn)).toEqual([
      d("2026-11-30"),
      d("2026-12-31"),
    ]);
    expect(r.template.schedule?.nextOccurrence).toBeNull();
  });

  test("changing a schedule affects future occurrences only", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { templateId } = yield* setup(MONTHLY);
        yield* sweep;
        const t = yield* Templates;
        const current = yield* getTemplate(templateId);
        const scheduleResult = yield* t.schedule(
          member("owner"),
          templateId,
          { ...MONTHLY, issueAs: "proforma" },
          current.revision,
        );
        const changed = yield* templateView(scheduleResult);
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { templateId, scheduleId } = yield* setup(MONTHLY);
        const stale = yield* runOccurrence(scheduleId, d("2026-10-23"));
        yield* Effect.flatMap(Templates, (t) => t.schedule(member("owner"), templateId, null, 2));
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { scheduleId } = yield* setup(MONTHLY);
        const r = yield* RecurringIssuance;
        const occurrence = d("2026-11-23");
        return {
          scheduleId,
          memberIssue: yield* Effect.exit(r.issue(member("owner"), scheduleId, occurrence)),
          memberSend: yield* Effect.exit(r.send(member("owner"), scheduleId, occurrence)),
          memberPause: yield* Effect.exit(r.pauseMissed(member("owner"), scheduleId, occurrence)),
          otherJob: yield* r
            .issue(system(), scheduleId, occurrence)
            .pipe(as(system()), Effect.exit),
          otherOccurrence: yield* r
            .issue(job(scheduleId)(d("2026-12-23")), scheduleId, occurrence)
            .pipe(as(job(scheduleId)(d("2026-12-23"))), Effect.exit),
          otherWorkspace: yield* r
            .issue(job(scheduleId)(occurrence, WORKSPACE_B), scheduleId, occurrence)
            .pipe(as(job(scheduleId)(occurrence, WORKSPACE_B)), Effect.exit),
          docs: yield* documents,
        };
      }),
    );
    const r = ok(exit);
    expect(r.memberIssue.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.issue" })),
    );
    expect(r.memberSend.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.send" })),
    );
    expect(r.memberPause.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.issue" })),
    );
    expect(r.otherJob.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.issue" })),
    );
    expect(r.otherOccurrence.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.issue" })),
    );
    expect(r.otherWorkspace.pipe(withoutStackTrace)).toEqual(
      Exit.fail(NotFound.make({ entity: "Schedule", id: r.scheduleId })),
    );
    expect(r.docs).toHaveLength(0);
  });
});

describe("Templates.runs", () => {
  test("pages newest occurrence first; a cursor is bound to its template", async () => {
    const exit = await scenario(member("accountant"))(
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
    expect<unknown>(EffectArray.map(r.first.items, (x) => x.occurrence)).toEqual([
      "2026-11-15",
      "2026-11-08",
    ]);
    expect(r.first.nextCursor).not.toBeNull();
    expect<unknown>(EffectArray.map(r.second.items, (x) => x.occurrence)).toEqual(["2026-11-01"]);
    expect(r.second.nextCursor).toBeNull();
    expect(r.foreign.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Invalid.make({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] })),
    );
    // Out-of-range limits are clamped (PageRequest bounds are checked at decode).
    expect(Exit.isSuccess(r.badLimit)).toBe(true);
  });
});

describe("council follow-ups", () => {
  test("an issued document is linked to its schedule and occurrence", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { scheduleId } = yield* setup(MONTHLY);
        yield* sweep;
        const links = yield* Effect.flatMap(FakeDocumentLinks, (l) => l.all);
        return { scheduleId, links, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    const doc = Option.getOrThrow(EffectArray.head(r.docs));
    expect(r.links).toEqual([
      { document: doc.id, scheduleId: r.scheduleId, occurrence: d("2026-11-23") },
    ]);
  });

  test("a run that starts past the catch-up cap pauses instead of issuing", async () => {
    const exit = await scenario(member("owner"))(
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const stub = yield* DocumentsStub;
        const a = yield* setup(MONTHLY);
        yield* Ref.set(stub.failNextIssue, Conflict.make({ reason: "duplicate" }));
        yield* runOccurrence(a.scheduleId, d("2026-11-23"));
        const b = yield* setup(MONTHLY, templateInput({ contact: MISSING_CONTACT }));
        yield* runOccurrence(b.scheduleId, d("2026-11-23"));
        const c = yield* setup(MONTHLY);
        yield* Ref.set(
          stub.failNextIssue,
          Conflict.make({ reason: "revision_changed", currentRevision: 2 }),
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const { scheduleId } = yield* setup({ ...MONTHLY, autoSend: true });
        const r = yield* RecurringIssuance;
        yield* as(job(scheduleId)(d("2026-11-23")))(
          r.issue(job(scheduleId)(d("2026-11-23")), scheduleId, d("2026-11-23")),
        );
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
    const exit = await scenario(member("owner"))(
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
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(member("owner"), templateInput());
        const id = (yield* templateView(saveResult)).id;
        return {
          accountant: yield* t
            .use(member("accountant"), id)
            .pipe(as(member("accountant")), Effect.exit),
          readToken: yield* t
            .use(member("owner", { scopes: ["templates:read"] }), id, { as: "issued" })
            .pipe(as(member("owner", { scopes: ["templates:read"] })), Effect.exit),
        };
      }),
    );
    const r = ok(exit);
    expect(r.accountant.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.draft" })),
    );
    expect(r.readToken.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Forbidden.make({ action: "document.issue" })),
    );
  });
});

describe("review round 1 regressions", () => {
  test("detaching and reattaching never bills an issued date twice", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const { templateId } = yield* setup(MONTHLY);
        yield* sweep;
        const scheduleResult = yield* t.schedule(member("owner"), templateId, null, 2);
        const detached = yield* templateView(scheduleResult);
        const scheduleResult2 = yield* t.schedule(
          member("owner"),
          templateId,
          MONTHLY,
          detached.revision,
        );
        const reattached = yield* templateView(scheduleResult2);
        const tick = yield* sweep;
        return { reattached, tick, docs: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.reattached.schedule?.nextOccurrence).toBe(d("2026-12-23"));
    expect(r.tick).toEqual([]);
    expect(EffectArray.map(r.docs, (x) => x.input.issuedOn)).toEqual([d("2026-11-23")]);
  });

  test("an edit waits while an occurrence is due; settings-only edits keep the next date", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const weekly = { ...MONTHLY, every: { weeks: 1 } };
        const { templateId } = yield* setup(weekly);
        yield* at("2026-11-30T08:00:00Z");
        const blocked = yield* Effect.exit(
          t.schedule(
            member("owner"),
            templateId,
            { ...MONTHLY, issueAs: "proforma", autoSend: true },
            2,
          ),
        );
        // The due backlog issues under the rule and settings it was due under.
        yield* sweep;
        yield* sweep;
        const scheduleResult = yield* t.schedule(
          member("owner"),
          templateId,
          { ...weekly, autoSend: true },
          2,
        );
        const sendOn = yield* templateView(scheduleResult);
        return { blocked, sendOn, docs: yield* documents, sent: yield* deliveries };
      }),
    );
    const r = ok(exit);
    expect(r.blocked.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "illegal_transition" })),
    );
    expect(EffectArray.map(r.docs, (x) => [x.kind, x.input.issuedOn])).toEqual([
      ["invoice", d("2026-11-23")],
      ["invoice", d("2026-11-30")],
    ]);
    expect(r.sent).toHaveLength(0);
    expect(r.sendOn.schedule?.nextOccurrence).toBe(d("2026-12-07"));
    expect(r.sendOn.schedule?.autoSend).toBe(true);
  });

  test("a stale or foreign schedule call reports the revision or NotFound before Invalid", async () => {
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(member("owner"), templateInput());
        const id = (yield* templateView(saveResult)).id;
        const bad = { ...MONTHLY, every: { months: 0 } };
        return {
          id,
          stale: yield* Effect.exit(t.schedule(member("owner"), id, bad, 7)),
          foreign: yield* t
            .schedule(member("owner", { workspaceId: WORKSPACE_B }), id, bad, 1)
            .pipe(as(member("owner", { workspaceId: WORKSPACE_B })), Effect.exit),
        };
      }),
    );
    const r = ok(exit);
    expect(r.stale.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "revision_changed", currentRevision: 1 })),
    );
    expect(r.foreign.pipe(withoutStackTrace)).toEqual(
      Exit.fail(NotFound.make({ entity: "Template", id: r.id })),
    );
  });

  test("keyed use replays the original view, decimals and all, even after a discard", async () => {
    const KEY = RequestKey.make("req-use-1");
    const exit = await scenario(member("owner"))(
      Effect.gen(function* () {
        const t = yield* Templates;
        const saveResult = yield* t.save(member("owner"), templateInput());
        const id = (yield* templateView(saveResult)).id;
        const first = yield* t.use(member("owner"), id, {}, { requestKey: KEY });
        const docs = yield* Documents;
        yield* docs.discardDraft(member("owner"), first.id, first.revision);
        const replay = yield* t.use(member("owner"), id, {}, { requestKey: KEY });
        const legacyKey = RequestKey.make("req-use-legacy");
        const store = yield* CoreStore;
        const scope = { _tag: "Workspace", workspaceId: WORKSPACE_A } as const;
        const now = "2026-11-23T09:00:00.000Z";
        const claim = yield* store.transaction(store.requestLog.claim(scope, KEY, now));
        if (claim._tag !== "Existing") return yield* Effect.die("Expected a committed snapshot");
        const stored = yield* Schema.decodeUnknownEffect(Schema.Struct({ json: Schema.String }))(
          claim.entry.result,
        );
        const snapshot = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
        )(stored.json);
        const legacyJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          ...snapshot,
          legacyField: "retained",
        });
        // The previous payload omitted `patch` when absent.
        const fingerprint = yield* sha256Hex(`["Templates.use",{"as":"draft","template":"${id}"}]`);
        yield* store.transaction(
          Effect.andThen(
            store.requestLog.claim(scope, legacyKey, now),
            store.requestLog.complete({
              ...claim.entry,
              key: legacyKey,
              fingerprint,
              result: { json: legacyJson },
            }),
          ),
        );
        const legacy = yield* t.use(member("owner"), id, undefined, { requestKey: legacyKey });
        const mismatch = yield* Effect.exit(
          t.use(member("owner"), id, { patch: { note: "x" } }, { requestKey: KEY }),
        );
        return { first, replay, legacy, mismatch, left: yield* documents };
      }),
    );
    const r = ok(exit);
    expect(r.replay).toEqual(r.first);
    const legacyView = { ...r.first, legacyField: "retained" };
    expect(r.legacy).toEqual(legacyView);
    const hasUnitPrice = Schema.is(Schema.Struct({ unitPrice: Schema.Unknown }));
    const line = r.replay.lines[0];
    const unitPrice = hasUnitPrice(line) ? line.unitPrice : undefined;
    expect(BigDecimal.isBigDecimal(unitPrice)).toBe(true);
    expect(unitPrice).toEqual(BigDecimal.fromStringUnsafe("1250.50"));
    expect(r.left).toHaveLength(0);
    expect(r.mismatch.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Conflict.make({ reason: "idempotency_mismatch" })),
    );
  });
});
