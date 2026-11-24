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
import {
  CoreModulesLive,
  DeliveriesRepo,
  DeliveryJobs,
  DocumentsModule,
  RecurringModule,
  RecurringRepo,
} from "@kvitbit/core";
import {
  CaptureEmailSender,
  CoreReposMemory,
  InMemoryCorePorts,
  RecurringRepoMemory,
  StartedDeliveries,
  TestCoreFakes,
} from "@kvitbit/core/testing";
import type {
  ContactId,
  CurrentCaller as CurrentCallerTag,
  DeliveryId,
  DocumentId,
  IsoDate,
  MemberCaller,
  ScheduleId,
  SystemCaller,
  TemplateId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Caller,
  Contacts,
  CurrentCaller,
  Documents,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { EmailSender as EmailSenderShape, RegistryRecord } from "@kvitbit/domain/ports";
import { EmailSender } from "@kvitbit/domain/ports";
import { BigDecimal, Context, Effect, Exit, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

const { RecurringIssuance } = RecurringModule;
const { claim, deliver, dispatch, giveUp, reconcileStaleDeliveries } = DocumentsModule;

const TODAY = "2026-11-23" as IsoDate;
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
  "formal/outbox/CrashInSend",
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
  const repos = options.crashInSend
    ? Layer.merge(CoreReposMemory, crashingRunRepo)
    : CoreReposMemory;
  const fakes = options.loseStart ? Layer.merge(TestCoreFakes(), lostStart) : TestCoreFakes();
  return CoreModulesLive.pipe(
    Layer.provideMerge(Layer.merge(repos, fakes)),
    Layer.provideMerge(InMemoryCorePorts({ registry: { [ICO]: RECORD } })),
  );
};

interface World {
  readonly workspaceId: WorkspaceId;
  readonly templateId: TemplateId;
  readonly scheduleId: ScheduleId;
  /** The sealed System caller of TODAY's RecurringIssuance job, as the sweep hands it out. */
  readonly job: SystemCaller;
}

/** One sweep tick that only records the caller it gives TODAY's start (it starts nothing). */
const captureJobCaller = Effect.flatMap(RecurringIssuance, (r) =>
  Effect.flatMap(Ref.make<SystemCaller | null>(null), (ref) =>
    Effect.flatMap(
      r.sweep((decision) =>
        decision.occurrence !== TODAY
          ? Effect.void
          : Effect.gen(function* () {
              yield* Ref.set(ref, (yield* CurrentCaller) as SystemCaller);
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

type Services = Layer.Success<ReturnType<typeof core>> | CurrentCallerTag | CrashInSend;

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
      const owner = (yield* Effect.flatMap(Workspaces, (ws) =>
        ws.create({ name: "Alfa Beta s.r.o.", ico: ICO, taxRegime: "vat_payer" } as never),
      )) as MemberCaller;
      return yield* Effect.provideService(
        Effect.gen(function* () {
          yield* Effect.flatMap(Workspaces, (ws) =>
            ws.saveBankAccount({ iban: "CZ65 0800 0000 1920 0014 5399", currency: "CZK" } as never),
          );
          const customer = (yield* Effect.flatMap(Contacts, (c) =>
            c.save({
              name: "Odběratel a.s.",
              ico: "25596641",
              dic: "CZ25596641",
              address: { city: "Brno", country: "CZ" },
              roles: ["customer"],
              billingEmails: ["fakturace@odberatel.cz"],
            } as never),
          )) as unknown as { readonly id: ContactId };
          const t = yield* Templates;
          const created = (yield* t.save({
            name: "Monthly hosting",
            kind: "invoice",
            contact: customer.id,
            lines: [
              {
                description: "Hosting",
                quantity: BigDecimal.fromStringUnsafe("1"),
                unitPrice: BigDecimal.fromStringUnsafe("1250.50"),
              },
            ],
            due: { inDays: 14 },
          } as never)) as unknown as { readonly id: TemplateId; readonly revision: number };
          const scheduled = (yield* t.schedule(
            created.id,
            { every: { months: 1 }, startOn: TODAY, issueAs: "invoice", autoSend: true } as never,
            created.revision,
          )) as unknown as { readonly schedule: { readonly id: ScheduleId } };
          return yield* body({
            workspaceId: owner.workspaceId,
            templateId: created.id,
            scheduleId: scheduled.schedule.id,
            job: yield* captureJobCaller,
          });
        }),
        CurrentCaller,
        owner,
      );
    }).pipe(
      Effect.provideService(
        CurrentCaller,
        Caller.account({
          userId: "01900000-0000-7000-8000-0000000000a1" as never,
          email: "owner@example.cz",
          locale: "cs",
          channel: "web",
        }),
      ),
      Effect.provide(Layer.merge(layer, TestClock.layer())),
    ) as Effect.Effect<A, unknown, never>,
  );
};

/** Runs `effect` as the sealed System caller of TODAY's RecurringIssuance job. */
const asJob = <A, E, R>(w: World, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CurrentCaller, w.job);

const runOccurrence = (w: World) =>
  asJob(
    w,
    Effect.flatMap(RecurringIssuance, (r) => r.run(w.scheduleId, TODAY)),
  );

/** Issued invoices in the Workspace (OneDocumentPerOccurrence counts documents, not runs). */
const invoices = Effect.map(
  Effect.flatMap(Documents, (d) => d.list({ kind: "invoice" } as never)),
  (page) => page.items.length,
);

/** One RecurringSweep tick whose start runs the workflow body inline (as the sweep's caller). */
const sweep = Effect.flatMap(RecurringIssuance, (r) =>
  r.sweep((decision) => Effect.asVoid(r.run(decision.scheduleId, decision.occurrence))),
);

const runs = (w: World) =>
  Effect.map(
    Effect.flatMap(Templates, (t) => t.runs(w.templateId)),
    (page) =>
      page.items as unknown as ReadonlyArray<{
        readonly occurrence: IsoDate;
        readonly outcome: string;
        readonly document: { readonly id: string } | null;
        readonly delivery: { readonly id: DeliveryId; readonly status: string } | null;
      }>,
  );

const nextOccurrence = (w: World) =>
  Effect.map(
    Effect.flatMap(Templates, (t) => t.get(w.templateId)),
    (v) =>
      (v as unknown as { schedule: { nextOccurrence: IsoDate | null } }).schedule.nextOccurrence,
  );

const started = Effect.flatMap(StartedDeliveries, Ref.get);
const status = (w: World, id: DeliveryId) =>
  Effect.map(
    Effect.flatMap(DeliveriesRepo, (repo) => repo.get(w.workspaceId, id)),
    (row) => row.status,
  );
const provider = Effect.flatMap(CaptureEmailSender, (c) =>
  Effect.all({ sent: Ref.get(c.sent), attempts: Ref.get(c.attempts) }),
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
    const ends = yield* Effect.forEach(starts, (s) => deliver(s.workspaceId, s.deliveryId));
    return { restarted, starts: starts.map((s) => s.deliveryId), ends };
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
      const deliveryId = run?.delivery?.id as DeliveryId;
      const startedAfterSend = yield* started;
      const queued = yield* status(w, deliveryId);
      const end = yield* deliver(w.workspaceId, deliveryId);
      return {
        tick: tick.map((d) => [d.occurrence, d.action]),
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
  expect(r.next).toBe("2026-12-23" as IsoDate);
  // Hook: the start was issued after commit, keyed by the delivery id.
  expect(r.startedAfterSend.map((s) => s.deliveryId)).toEqual([r.deliveryId]);
  expect(r.queued).toBe("queued");
  expect(r.end).toBe("sent");
  expect(r.provider.sent.map((e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

test("DupStart, IssueCommit(replay), SendCommit(replay): concurrent and repeated runs issue and queue once", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      const both = yield* Effect.all([runOccurrence(w), runOccurrence(w)], { concurrency: 2 });
      const again = yield* runOccurrence(w);
      const all = yield* runs(w);
      return {
        both,
        again,
        runs: all,
        invoices: yield* invoices,
        rows: yield* Effect.flatMap(DeliveriesRepo, (repo) =>
          repo.byDocument(w.workspaceId, all[0]?.document?.id as DocumentId),
        ),
        started: yield* started,
      };
    }),
  );
  // OneDeliveryPerOccurrence: one delivery row for the occurrence's document.
  expect(r.rows).toHaveLength(1);
  const issued = r.both.map((x) => x.issue._tag === "Issued" && x.issue.replayed);
  expect(issued.sort()).toEqual([false, true]);
  expect(r.again.issue).toMatchObject({ _tag: "Issued", replayed: true });
  expect(r.again.send).toMatchObject({ _tag: "Queued", replayed: true });
  // OneDocumentPerOccurrence, OneDeliveryPerOccurrence.
  expect(r.runs).toHaveLength(1);
  expect(r.invoices).toBe(1);
  expect(r.started).toHaveLength(1);
  expect(r.started[0]?.deliveryId).toBe(r.runs[0]?.delivery?.id as DeliveryId);
});

test("SweepStart after the advance: a second tick the same day starts nothing", async () => {
  const r = await scenario((w) =>
    Effect.gen(function* () {
      yield* runOccurrence(w);
      const tick = yield* sweep;
      return { tick, runs: yield* runs(w), invoices: yield* invoices };
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
      const issued = yield* asJob(
        w,
        Effect.flatMap(RecurringIssuance, (ri) => ri.issue(w.scheduleId, TODAY)),
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
  expect(r.pending.map((p) => p.occurrence)).toEqual([TODAY]);
  expect(r.rerun.issue).toMatchObject({ _tag: "Issued", replayed: true });
  expect(r.rerun.send).toMatchObject({ _tag: "Queued", replayed: false });
  expect(r.runs).toHaveLength(1);
  expect(r.started).toHaveLength(1);
});

test("CrashWorker inside SendCommit: the delivery rolls back and no workflow starts (StartedOnlyCommitted)", async () => {
  const r = await scenario(
    (w) =>
      Effect.gen(function* () {
        yield* Ref.set(yield* CrashInSend, true);
        const crashed = yield* Effect.exit(runOccurrence(w));
        const crashedRuns = yield* runs(w);
        const documentId = crashedRuns[0]?.document?.id as DocumentId;
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
  expect(r.pending.map((p) => p.occurrence)).toEqual([TODAY]);
  expect(r.rerun.send).toMatchObject({ _tag: "Queued", replayed: false });
  expect(r.started).toHaveLength(1);
  expect(r.started[0]?.deliveryId).toBe(r.runs[0]?.delivery?.id as DeliveryId);
});

test("CrashWorker before Hook, ReconcileDelivery: the committed delivery stays queued and reconcile sends it", async () => {
  const r = await scenario(
    (w) =>
      Effect.gen(function* () {
        const deliveryId = yield* queuedDelivery(w);
        const afterCrash = yield* status(w, deliveryId);
        const pending = yield* pendingSends;
        // OutboxReconcile (J1a) restarts DocumentDelivery with the same key.
        const reconcile = yield* reconcileDeliveries(yield* recordingJobs);
        return { deliveryId, afterCrash, pending, reconcile, provider: yield* provider };
      }),
    { loseStart: true },
  );
  expect(r.afterCrash).toBe("queued");
  expect(r.pending).toHaveLength(0);
  expect(r.reconcile.restarted.map((d) => [d.deliveryId, d.status])).toEqual([
    [r.deliveryId, "queued"],
  ]);
  expect(r.reconcile.starts).toEqual([r.deliveryId]);
  expect(r.reconcile.ends).toEqual(["sent"]);
  expect(r.provider.sent.map((e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});

test("H3: Claim, CrashDelivery(dispatch), ReconcileRecurring, SweepStart, ReconcileDelivery, Claim(sending), Dispatch, Record: the claimed email is sent once", async () => {
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
  expect(r.reconcile.restarted.map((d) => [d.deliveryId, d.status])).toEqual([
    [r.deliveryId, "sending"],
  ]);
  expect(r.reconcile.starts).toEqual([r.deliveryId]);
  expect(r.reconcile.ends).toEqual(["sent"]);
  // Terminal now: the next pass restarts nothing.
  expect(r.again.restarted).toHaveLength(0);
  expect(r.provider.attempts).toBe(1);
  expect(r.provider.sent.map((e) => e.idempotencyKey)).toEqual([r.deliveryId]);
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
  expect(r.provider.sent.map((e) => e.idempotencyKey)).toEqual([r.deliveryId]);
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
  expect(r.provider.sent.map((e) => e.idempotencyKey)).toEqual([r.deliveryId]);
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
  expect(r.provider.sent.map((e) => e.idempotencyKey)).toEqual([r.deliveryId]);
});
