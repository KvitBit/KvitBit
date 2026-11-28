/**
 * Replays OutboxRecurring.tla on the real core (CoreModulesLive on TestCore's memory ports and
 * fakes): the shortest path through each model action, each crash point, and the H3
 * interleaving (a crash between claim and the provider call). The test names give the model
 * actions they replay. Skill: .agents/skills/verify-outbox-recurring.
 *
 * Crash points use seams that exist in the code: a RecurringRepo wrapper that dies inside the
 * send transaction, a DeliveryJobs whose start dies after commit, an EmailSender wrapper that
 * dies after the provider accepted, and a delivery step that is simply not run after `claim`.
 * ReconcileDelivery is the real `reconcileStaleDeliveries` pass (J1a) past its 2 min
 * threshold; the job it restarts (Hook) is played by calling `deliver` for each delivery the
 * pass started, keyed by the delivery id. The H3 test shows the recurring entry points do not
 * recover a claimed delivery and the delivery reconcile does.
 * The job's sealed System caller comes from a RecurringSweep tick (sweep.ts provides it to
 * `start`), since the seal is not exported from any entry point.
 */

import { expect, test } from "bun:test";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  CoreModulesLive,
  DeliveriesRepo,
  DeliveryJobs,
  DocumentsModule,
  deliveryJob,
  RecurringModule,
  RecurringRepo,
} from "../../packages/core/src/index";
import {
  CaptureEmailSender,
  CoreReposMemory,
  InMemoryCorePorts,
  RecurringRepoMemory,
  StartedDeliveries,
  TestCoreFakes,
} from "../../packages/core/src/testing/index";
import type { MemberCaller, SystemCaller, WorkspaceId } from "../../packages/domain/src/contract";
import {
  BankAccountInput,
  Caller,
  ContactId,
  Contacts,
  type DeliveryId,
  Documents,
  IsoDate,
  ScheduleId,
  TemplateId,
  Templates,
  UserId,
  Workspaces,
} from "../../packages/domain/src/contract";
import type {
  EmailSender as EmailSenderShape,
  RegistryRecord,
} from "../../packages/domain/src/ports";
import { EmailSender } from "../../packages/domain/src/ports";

const { RecurringIssuance } = RecurringModule;
const { claim, deliver, dispatch, giveUp } = deliveryJob;
const { reconcileStaleDeliveries } = DocumentsModule;

const TODAY = IsoDate.make("2026-11-23");
const NOW = Date.UTC(2026, 10, 23, 9, 0, 0);
const ICO = "27082440";
const RECORD: RegistryRecord = {
  name: "Alfa Beta s.r.o.",
  address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27082440",
  legalForm: "s.r.o.",
  registerEntry: "C 12345 vedená u Městského soudu v Praze",
  terminatedOn: null,
};

// World ------------------------------------------------------------------------------------

/** Dies once inside the recurring send transaction, after Documents.send queued the delivery. */
class CrashInSend extends Context.Service<CrashInSend, Ref.Ref<boolean>>()(
  "kvitbit/formal/outbox/outbox.replay.test/CrashInSend",
) {}

const crashingRunRepo = Layer.effectContext(
  Effect.gen(function* () {
    const repo = yield* RecurringRepo;
    const armed = yield* Ref.make(false);
    return Context.make(
      RecurringRepo,
      RecurringRepo.of({
        ...repo,
        updateRun: (next, expected) =>
          next.send !== "queued"
            ? repo.updateRun(next, expected)
            : Effect.flatMap(Ref.getAndSet(armed, false), (die) =>
                die
                  ? Effect.die("process died before the send transaction committed")
                  : repo.updateRun(next, expected),
              ),
      }),
    ).pipe(Context.add(CrashInSend, armed));
  }),
).pipe(Layer.provide(RecurringRepoMemory));

/** The process dies after the commit, before the DocumentDelivery start. */
const lostStart = Layer.succeed(
  DeliveryJobs,
  DeliveryJobs.of({ start: () => Effect.die("process died before the workflow start") }),
);

const core = (options: { readonly crashInSend?: boolean; readonly loseStart?: boolean } = {}) => {
  const repos =
    options.crashInSend === true
      ? Layer.merge(CoreReposMemory, crashingRunRepo)
      : Layer.merge(CoreReposMemory, Layer.effect(CrashInSend, Ref.make(false)));
  const fakes =
    options.loseStart === true ? Layer.merge(TestCoreFakes(), lostStart) : TestCoreFakes();
  return CoreModulesLive.pipe(
    Layer.provideMerge(Layer.merge(repos, fakes)),
    Layer.provideMerge(InMemoryCorePorts({ registry: { [ICO]: RECORD } })),
  );
};

interface World {
  readonly workspaceId: WorkspaceId;
  readonly owner: MemberCaller;
  readonly templateId: TemplateId;
  readonly scheduleId: ScheduleId;
  /** The sealed System caller of TODAY's RecurringIssuance job, as the sweep hands it out. */
  readonly job: SystemCaller;
}

/** One sweep tick that only records the caller it gives TODAY's start (it starts nothing). */
const captureJobCaller = Effect.flatMap(RecurringIssuance, (r) =>
  Effect.flatMap(Ref.make<SystemCaller | null>(null), (ref) =>
    Effect.flatMap(
      r.sweep((caller, decision) =>
        decision.occurrence !== TODAY
          ? Effect.void
          : Effect.gen(function* () {
              if (caller._tag !== "System") return yield* Effect.die("expected a System caller");
              yield* Ref.set(ref, caller);
            }),
      ),
      () =>
        Effect.map(Ref.get(ref), (caller) => {
          if (caller === null) throw new Error("the sweep did not start TODAY's occurrence");
          return caller;
        }),
    ),
  ),
);

type Services = Layer.Success<ReturnType<typeof core>> | CrashInSend;

/**
 * A vat_payer Workspace with a customer and a monthly autoSend schedule starting TODAY; `body`
 * runs as its owner at NOW.
 */
const scenario = <A, E>(
  body: (world: World) => Effect.Effect<A, E, Services>,
  options: { readonly crashInSend?: boolean; readonly loseStart?: boolean } = {},
): Promise<A> => {
  const layer = core(options);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const account = Caller.account({
        userId: UserId.make("01900000-0000-7000-8000-0000000000a1"),
        email: "owner@example.cz",
        locale: "cs",
        channel: "web",
      });
      const owner = yield* Effect.flatMap(Workspaces, (ws) =>
        ws.create(account, { name: "Alfa Beta s.r.o.", ico: ICO, taxRegime: "vat_payer" }),
      );
      yield* Effect.flatMap(Workspaces, (ws) =>
        ws.saveBankAccount(
          owner,
          BankAccountInput.make({ iban: "CZ65 0800 0000 1920 0014 5399", currency: "CZK" }),
        ),
      );
      const customer = yield* Effect.flatMap(Contacts, (c) =>
        c.save(owner, {
          name: "Odběratel a.s.",
          ico: "25596641",
          dic: "CZ25596641",
          address: { city: "Brno", country: "CZ" },
          roles: ["customer"],
          billingEmails: ["fakturace@odberatel.cz"],
        }),
      );
      const contactId = yield* Schema.decodeUnknownEffect(ContactId)(customer["id"]).pipe(
        Effect.orDie,
      );
      const t = yield* Templates;
      const created = yield* t.save(owner, {
        name: "Monthly hosting",
        kind: "invoice",
        contact: contactId,
        lines: [
          {
            description: "Hosting",
            quantity: BigDecimal.fromStringUnsafe("1"),
            unitPrice: BigDecimal.fromStringUnsafe("1250.50"),
          },
        ],
        due: { inDays: 14 },
      });
      const templateId = yield* Schema.decodeUnknownEffect(TemplateId)(created["id"]).pipe(
        Effect.orDie,
      );
      const scheduled = yield* t.schedule(
        owner,
        templateId,
        { every: { months: 1 }, startOn: TODAY, issueAs: "invoice", autoSend: true },
        created.revision,
      );
      if (scheduled.schedule === null) return yield* Effect.die("expected a recurring schedule");
      const scheduleId = yield* Schema.decodeUnknownEffect(ScheduleId)(
        scheduled.schedule["id"],
      ).pipe(Effect.orDie);
      const job = yield* captureJobCaller;
      return yield* body({ workspaceId: owner.workspaceId, owner, templateId, scheduleId, job });
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
  );
};

const runOccurrence = (w: World) =>
  Effect.flatMap(RecurringIssuance, (r) => r.run(w.job, w.scheduleId, TODAY));

/** Issued invoices in the Workspace (OneDocumentPerOccurrence counts documents, not runs). */
const invoices = (w: World) =>
  Effect.map(
    Effect.flatMap(Documents, (d) => d.list(w.owner, { kind: "invoice" })),
    (page) => page.items.length,
  );

/** One RecurringSweep tick whose start runs the workflow body inline (as the sweep's caller). */
const sweep = Effect.flatMap(RecurringIssuance, (r) =>
  r.sweep((caller, decision) =>
    Effect.asVoid(r.run(caller, decision.scheduleId, decision.occurrence)),
  ),
);

const runs = (w: World) =>
  Effect.map(
    Effect.flatMap(Templates, (t) => t.runs(w.owner, w.templateId)),
    (page) => page.items,
  );

const nextOccurrence = (w: World) =>
  Effect.gen(function* () {
    const templates = yield* Templates;
    const view = yield* templates.get(w.owner, w.templateId);
    if (view.schedule === null) return yield* Effect.die("expected a recurring schedule");
    return yield* Schema.decodeUnknownEffect(Schema.NullOr(IsoDate))(
      view.schedule["nextOccurrence"],
    ).pipe(Effect.orDie);
  });

const started = Effect.flatMap(StartedDeliveries, Ref.get);
const status = (w: World, id: DeliveryId) =>
  Effect.map(
    Effect.flatMap(DeliveriesRepo, (repo) => repo.get(w.workspaceId, id)),
    (row) => row.status,
  );
const provider = Effect.flatMap(CaptureEmailSender, (c) =>
  Effect.all({ sent: Ref.get(c.sent), attempts: Ref.get(c.attempts) }, { concurrency: 1 }),
);

/** pendingSends after the reconcile threshold (2 min, core-ports J1a). */
const pendingSends = Effect.andThen(
  TestClock.adjust("3 minutes"),
  Effect.flatMap(RecurringIssuance, (r) => r.pendingSends(120_000)),
);

/**
 * ReconcileDelivery past the threshold (2 min, core-ports J1a): the real delivery reconcile
 * pass, then Hook: each DocumentDelivery job it started runs `deliver`. `jobs` stands in for the
 * scenario's DeliveryJobs (a restarted process whose start works again).
 */
const reconcileDeliveries = (jobs?: DeliveryJobs["Service"]) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("3 minutes");
    const before = (yield* started).length;
    const pass = reconcileStaleDeliveries(120_000);
    const restarted = yield* jobs === undefined
      ? pass
      : Effect.provideService(pass, DeliveryJobs, jobs);
    const starts = (yield* started).slice(before);
    const ends = yield* Effect.forEach(starts, (s) => deliver(s.workspaceId, s.deliveryId), {
      concurrency: 1,
    });
    return { restarted, starts: EffectArray.map(starts, (s) => s.deliveryId), ends };
  });

/** A DeliveryJobs that records its starts in StartedDeliveries (as DeliveryJobsMemory does). */
const recordingJobs = Effect.map(StartedDeliveries, (ref) =>
  DeliveryJobs.of({
    start: (workspaceId, deliveryId) =>
      Ref.update(ref, (all) => [...all, { workspaceId, deliveryId }]),
  }),
);

/** The issued occurrence's queued delivery id (SweepStart, IssueCommit, SendCommit, Hook). */
const queuedDelivery = (w: World) =>
  Effect.map(runOccurrence(w), (result) => {
    if (result.send?._tag !== "Queued")
      throw new Error(`expected Queued, got ${result.send?._tag}`);
    return result.send.deliveryId;
  });

// Shortest paths ---------------------------------------------------------------------------

test("SweepStart, IssueCommit, SendCommit, Hook, Claim, Dispatch(ok), Record: one document, one email", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const tick = yield* sweep;
      const [run] = yield* runs(w);
      const deliveryId = run?.delivery?.id;
      if (deliveryId === undefined) throw new Error("expected a delivery after the sweep");
      const startedAfterSend = yield* started;
      const queued = yield* status(w, deliveryId);
      const end = yield* deliver(w.workspaceId, deliveryId);
      return {
        tick: EffectArray.map(tick, (d) => [d.occurrence, d.action]),
        run,
        deliveryId,
        startedAfterSend,
        queued,
        end,
        next: yield* nextOccurrence(w),
        provider: yield* provider,
      };
    }),
  );
  expect<unknown>(r.tick).toEqual([[TODAY, "issue"]]);
  expect(r.run).toMatchObject({ occurrence: TODAY, outcome: "issued" });
  // NextFollowsIssued: the schedule advanced one occurrence.
  expect(r.next).toBe(IsoDate.make("2026-12-23"));
  // Hook: the start was issued after commit, keyed by the delivery id.
  expect(EffectArray.map(r.startedAfterSend, (s) => s.deliveryId)).toEqual([r.deliveryId]);
  expect(r.queued).toBe("queued");
  expect(r.end).toBe("sent");
  expect(EffectArray.map(r.provider.sent, (e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

test("DupStart, IssueCommit and SendCommit replays: concurrent and repeated runs issue and queue once", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const both = yield* Effect.all([runOccurrence(w), runOccurrence(w)], { concurrency: 2 });
      const again = yield* runOccurrence(w);
      const all = yield* runs(w);
      const documentId = all[0]?.document?.id;
      if (documentId === undefined) throw new Error("expected an issued document");
      return {
        both,
        again,
        runs: all,
        invoices: yield* invoices(w),
        rows: yield* Effect.flatMap(DeliveriesRepo, (repo) =>
          repo.byDocument(w.workspaceId, documentId),
        ),
        started: yield* started,
      };
    }),
  );
  // OneDeliveryPerOccurrence: one delivery row for the occurrence's document.
  expect(r.rows).toHaveLength(1);
  const issued = EffectArray.map(r.both, (x) => x.issue._tag === "Issued" && x.issue.replayed);
  expect(issued.sort()).toEqual([false, true]);
  expect(r.again.issue).toMatchObject({ _tag: "Issued", replayed: true });
  expect(r.again.send).toMatchObject({ _tag: "Queued", replayed: true });
  // OneDocumentPerOccurrence, OneDeliveryPerOccurrence.
  expect(r.runs).toHaveLength(1);
  expect(r.invoices).toBe(1);
  expect(r.started).toHaveLength(1);
  expect(r.started[0]?.deliveryId).toBe(r.runs[0]?.delivery?.id);
});

test("SweepStart after the advance: a second tick the same day starts nothing", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      yield* runOccurrence(w);
      const tick = yield* sweep;
      return { tick, runs: yield* runs(w), invoices: yield* invoices(w) };
    }),
  );
  expect(r.tick).toHaveLength(0);
  expect(r.runs).toHaveLength(1);
  expect(r.invoices).toBe(1);
});

// Crash points -----------------------------------------------------------------------------

test("CrashWorker after IssueCommit, ReconcileRecurring: pendingSends finds the run, the rerun sends only", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      // The process died after the issue transaction committed, before the send step.
      const issued = yield* Effect.flatMap(RecurringIssuance, (ri) =>
        ri.issue(w.job, w.scheduleId, TODAY),
      );
      const startedBefore = yield* started;
      const pending = yield* pendingSends;
      const rerun = yield* runOccurrence(w);
      return {
        issued,
        startedBefore,
        pending,
        rerun,
        runs: yield* runs(w),
        started: yield* started,
      };
    }),
  );
  expect(r.issued._tag === "Issued" && r.issued.run.send).toBe("pending");
  expect(r.startedBefore).toHaveLength(0);
  expect(EffectArray.map(r.pending, (p) => p.occurrence)).toEqual([TODAY]);
  expect(r.rerun.issue).toMatchObject({ _tag: "Issued", replayed: true });
  expect(r.rerun.send).toMatchObject({ _tag: "Queued", replayed: false });
  expect(r.runs).toHaveLength(1);
  expect(r.started).toHaveLength(1);
});

// CrashWorker during SendCommit exercises StartedOnlyCommitted.
test("A crash during the send transaction rolls back delivery and leaves no workflow", async () => {
  const r = await scenario(
    (w) =>
      Effect.gen(function* () {
        const crash = yield* CrashInSend;
        yield* Ref.set(crash, true);
        const crashed = yield* Effect.exit(runOccurrence(w));
        const crashedRuns = yield* runs(w);
        const documentId = crashedRuns[0]?.document?.id;
        if (documentId === undefined)
          throw new Error("expected an issued document after the crash");
        const afterCrash = {
          runs: crashedRuns,
          // The delivery row itself is gone, not only the run's link to it.
          rows: yield* Effect.flatMap(DeliveriesRepo, (repo) =>
            repo.byDocument(w.workspaceId, documentId),
          ),
          started: yield* started,
        };
        const pending = yield* pendingSends;
        const rerun = yield* runOccurrence(w);
        return {
          crashed,
          afterCrash,
          pending,
          rerun,
          runs: yield* runs(w),
          started: yield* started,
        };
      }),
    { crashInSend: true },
  );
  expect(Exit.isFailure(r.crashed)).toBe(true);
  expect(r.afterCrash.runs[0]?.delivery ?? null).toBeNull();
  expect(r.afterCrash.rows).toHaveLength(0);
  expect(r.afterCrash.started).toHaveLength(0);
  expect(EffectArray.map(r.pending, (p) => p.occurrence)).toEqual([TODAY]);
  expect(r.rerun.send).toMatchObject({ _tag: "Queued", replayed: false });
  expect(r.started).toHaveLength(1);
  expect(r.started[0]?.deliveryId).toBe(r.runs[0]?.delivery?.id);
});

test("CrashWorker before Hook, ReconcileDelivery: the committed delivery stays queued and reconcile sends it", async () => {
  const r = await scenario(
    (w) =>
      Effect.gen(function* () {
        const deliveryId = yield* queuedDelivery(w);
        const afterCrash = yield* status(w, deliveryId);
        const pending = yield* pendingSends;
        // OutboxReconcile (J1a) restarts DocumentDelivery with the same key.
        const jobs = yield* recordingJobs;
        const reconcile = yield* reconcileDeliveries(jobs);
        return { deliveryId, afterCrash, pending, reconcile, provider: yield* provider };
      }),
    { loseStart: true },
  );
  expect(r.afterCrash).toBe("queued");
  expect(r.pending).toHaveLength(0);
  expect(EffectArray.map(r.reconcile.restarted, (d) => [d.deliveryId, d.status])).toEqual([
    [r.deliveryId, "queued"],
  ]);
  expect(r.reconcile.starts).toEqual([r.deliveryId]);
  expect(r.reconcile.ends).toEqual(["sent"]);
  expect(EffectArray.map(r.provider.sent, (e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

// Claim, CrashDelivery(dispatch), ReconcileRecurring, SweepStart, ReconcileDelivery,
// Claim(sending), Dispatch, Record.
test("H3: Reconcile a claimed delivery after a crash and send the email once", async () => {
  // At 77a5bb7 no entry point recovered a claimed delivery (finding H3). The recurring entry
  // points still find no work; the delivery reconcile restarts the job, which sends.
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const deliveryId = yield* queuedDelivery(w);
      const startedBefore = (yield* started).length;
      const claimed = yield* claim(w.workspaceId, deliveryId);
      // The delivery job's process died here: claimed `sending`, provider never called.
      const pending1 = yield* pendingSends;
      const pending2 = yield* pendingSends;
      const rerun = yield* runOccurrence(w);
      const tick = yield* sweep;
      const afterRecurring = {
        startedAfter: (yield* started).length,
        status: yield* status(w, deliveryId),
        provider: yield* provider,
      };
      const reconcile = yield* reconcileDeliveries();
      const again = yield* reconcileDeliveries();
      return {
        deliveryId,
        claimed,
        pending: [...pending1, ...pending2],
        rerun,
        tick,
        startedBefore,
        afterRecurring,
        reconcile,
        again,
        provider: yield* provider,
      };
    }),
  );
  expect(r.claimed).toBe("sending");
  expect(r.pending).toHaveLength(0);
  expect(r.rerun.send).toMatchObject({ _tag: "Queued", replayed: true });
  expect(r.tick).toHaveLength(0);
  expect(r.afterRecurring.startedAfter).toBe(r.startedBefore);
  expect(r.afterRecurring.status).toBe("sending");
  expect(r.afterRecurring.provider.attempts).toBe(0);
  expect(EffectArray.map(r.reconcile.restarted, (d) => [d.deliveryId, d.status])).toEqual([
    [r.deliveryId, "sending"],
  ]);
  expect(r.reconcile.starts).toEqual([r.deliveryId]);
  expect(r.reconcile.ends).toEqual(["sent"]);
  // Terminal now: the next pass restarts nothing.
  expect(r.again.restarted).toHaveLength(0);
  expect(r.provider.attempts).toBe(1);
  expect(EffectArray.map(r.provider.sent, (e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

test("CrashDelivery(record): the provider accepted, the process died; the resend uses the same key", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const deliveryId = yield* queuedDelivery(w);
      yield* claim(w.workspaceId, deliveryId);
      const real = yield* EmailSender;
      const diesAfterAccept: EmailSenderShape["Service"] = {
        ...real,
        send: (message, opts) =>
          Effect.andThen(
            real.send(message, opts),
            Effect.die("process died before the outcome was recorded"),
          ),
      };
      const crashed = yield* Effect.exit(
        Effect.provideService(dispatch(w.workspaceId, deliveryId), EmailSender, diesAfterAccept),
      );
      const afterCrash = yield* status(w, deliveryId);
      const { ends } = yield* reconcileDeliveries();
      return { deliveryId, crashed, afterCrash, ends, provider: yield* provider };
    }),
  );
  expect(Exit.isFailure(r.crashed)).toBe(true);
  expect(r.afterCrash).toBe("sending");
  expect(r.ends).toEqual(["sent"]);
  // At least once: two provider calls with the delivery id as key (the fake dedupes them).
  expect(r.provider.attempts).toBe(2);
  expect(EffectArray.map(r.provider.sent, (e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

test("Dispatch failures, Record, GiveUp: not accepted retries then gives up, rejected fails, unknown retries to sent", async () => {
  const outcome = (kind: "not_accepted" | "rejected" | "outcome_unknown") =>
    scenario((w) =>
      Effect.gen(function* () {
        const deliveryId = yield* queuedDelivery(w);
        yield* CaptureEmailSender.failNext(kind);
        const first = yield* Effect.exit(deliver(w.workspaceId, deliveryId));
        const afterFirst = yield* status(w, deliveryId);
        const second =
          afterFirst !== "sending"
            ? null
            : kind === "not_accepted"
              ? yield* giveUp(w.workspaceId, deliveryId)
              : yield* dispatch(w.workspaceId, deliveryId);
        return { first, afterFirst, second, provider: yield* provider };
      }),
    );
  const notAccepted = await outcome("not_accepted");
  expect(Exit.isFailure(notAccepted.first)).toBe(true);
  expect(notAccepted.afterFirst).toBe("sending");
  expect(notAccepted.second).toBe("failed");
  expect(notAccepted.provider.sent).toHaveLength(0);

  const rejected = await outcome("rejected");
  expect(rejected.first).toEqual(Exit.succeed("failed"));
  expect(rejected.second).toBeNull();

  const unknown = await outcome("outcome_unknown");
  expect(Exit.isFailure(unknown.first)).toBe(true);
  expect(unknown.afterFirst).toBe("sending");
  expect(unknown.second).toBe("sent");
  expect(unknown.provider.sent).toHaveLength(1);
});

test("Dispatch(not_accepted), Record, CrashDelivery(giveup), ReconcileDelivery: the retried email is sent", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const deliveryId = yield* queuedDelivery(w);
      yield* CaptureEmailSender.failNext("not_accepted");
      const first = yield* Effect.exit(deliver(w.workspaceId, deliveryId));
      // Retries exhausted, the process died before giveUp ran: still sending.
      const afterCrash = yield* status(w, deliveryId);
      const { ends } = yield* reconcileDeliveries();
      return { deliveryId, first, afterCrash, ends, provider: yield* provider };
    }),
  );
  expect(Exit.isFailure(r.first)).toBe(true);
  expect(r.afterCrash).toBe("sending");
  expect(r.ends).toEqual(["sent"]);
  expect(r.provider.attempts).toBe(2);
  expect(EffectArray.map(r.provider.sent, (e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

test("Dispatch(not_accepted) twice, Record, CrashDelivery(giveup), ReconcileDelivery: sent on the third call", async () => {
  // The base model's bound: 2 retryable attempts per execution, then giveUp; the process
  // dies before giveUp runs, and the re-executed delivery sends.
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const deliveryId = yield* queuedDelivery(w);
      yield* CaptureEmailSender.failNext("not_accepted", "not_accepted");
      const first = yield* Effect.exit(deliver(w.workspaceId, deliveryId));
      const afterFirst = yield* status(w, deliveryId);
      const second = yield* Effect.exit(dispatch(w.workspaceId, deliveryId));
      const afterSecond = yield* status(w, deliveryId);
      const { ends } = yield* reconcileDeliveries();
      return {
        deliveryId,
        first,
        afterFirst,
        second,
        afterSecond,
        ends,
        provider: yield* provider,
      };
    }),
  );
  expect(Exit.isFailure(r.first)).toBe(true);
  expect(r.afterFirst).toBe("sending");
  expect(Exit.isFailure(r.second)).toBe(true);
  expect(r.afterSecond).toBe("sending");
  expect(r.ends).toEqual(["sent"]);
  expect(r.provider.attempts).toBe(3);
  expect(EffectArray.map(r.provider.sent, (e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});
