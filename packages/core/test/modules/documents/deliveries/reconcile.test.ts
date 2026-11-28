import { TestCaller } from "../../../helpers/callerContext";
/** reconcileStaleDeliveries: the delivery half of OutboxReconcile (core-ports J1a). */

import { describe, expect, test } from "bun:test";
import type { DeliveryId, WorkspaceId } from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  claim,
  DeliveriesRepo,
  DeliveryJobs,
  deliver,
  reconcileStaleDeliveries,
  StartedDeliveries,
} from "../../../../src/modules/documents";
import { CaptureEmailSender } from "../../../../src/testing";
import { member, system, WORKSPACE_A, WORKSPACE_B } from "../../../helpers";
import { as, B_BUYER, dec, invoiceInput } from "../fixtures";
import { issueInvoice, deliveryScenario as run } from "./helpers";

const worker = system();
/** The OutboxReconcile threshold of core-ports 7.3 (2 min). */
const THRESHOLD = 120_000;

const queued = Effect.gen(function* () {
  const testCaller = yield* TestCaller;
  const id = yield* issueInvoice();
  return (yield* (yield* Documents).send(testCaller, id)).deliveryId;
});
const delivery = (id: DeliveryId, workspaceId: WorkspaceId = WORKSPACE_A) =>
  Effect.flatMap(DeliveriesRepo, (r) => r.get(workspaceId, id));
const started = Effect.flatMap(StartedDeliveries, Ref.get);
const clearStarted = Effect.flatMap(StartedDeliveries, (r) => Ref.set(r, []));
const attempts = Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.attempts));
const sentKeys = Effect.map(
  Effect.flatMap(CaptureEmailSender, (c) => Ref.get(c.sent)),
  (emails) => EffectArray.map(emails, (e) => e.idempotencyKey),
);
const reconcile = reconcileStaleDeliveries(THRESHOLD);

describe("reconcileStaleDeliveries (J1a)", () => {
  test("restarts stale queued and sending deliveries of every Workspace, oldest first, by id", async () => {
    const exit = await run(
      Effect.gen(function* () {
        // t0: a queued delivery whose job start was lost.
        const lostStart = yield* queued;
        yield* TestClock.adjust("30 seconds");
        // t0+30s: a Workspace B delivery, also never started.
        const inB = yield* as(
          member("owner", { workspaceId: WORKSPACE_B }),
          Effect.gen(function* () {
            const d = yield* Documents;
            const doc = yield* d.issue(member("owner", { workspaceId: WORKSPACE_B }), {
              input: invoiceInput({
                contact: B_BUYER,
                lines: [{ description: "Služba", unitPrice: dec("100") }],
              }),
            });
            return (yield* d.send(member("owner", { workspaceId: WORKSPACE_B }), doc.id))
              .deliveryId;
          }),
        );
        yield* TestClock.adjust("30 seconds");
        // t0+60s: a job that died after claim (H3), and one that finished.
        const claimed = yield* queued;
        const result = yield* as(worker, claim(worker, WORKSPACE_A, claimed));
        expect(result).toBe("sending");
        const done = yield* queued;
        const result2 = yield* as(worker, deliver(worker, WORKSPACE_A, done));
        expect(result2).toBe("sent");
        yield* clearStarted;

        // t0+150s: only the row last changed before t0+30s is stale.
        yield* TestClock.adjust("90 seconds");
        const reconcile_1 = yield* reconcile;
        expect(reconcile_1).toEqual([
          { workspaceId: WORKSPACE_A, deliveryId: lostStart, status: "queued" },
        ]);

        // t0+190s: the Workspace B row and the claimed row are stale too; the sent one never is.
        yield* TestClock.adjust("40 seconds");
        yield* clearStarted;
        const restarted = yield* reconcile;
        expect(restarted).toEqual([
          { workspaceId: WORKSPACE_A, deliveryId: lostStart, status: "queued" },
          { workspaceId: WORKSPACE_B, deliveryId: inB, status: "queued" },
          { workspaceId: WORKSPACE_A, deliveryId: claimed, status: "sending" },
        ]);
        const started_1 = yield* started;
        expect(started_1).toEqual([
          { workspaceId: WORKSPACE_A, deliveryId: lostStart },
          { workspaceId: WORKSPACE_B, deliveryId: inB },
          { workspaceId: WORKSPACE_A, deliveryId: claimed },
        ]);
        // Reconcile only starts jobs: it changes no row and calls no provider.
        expect((yield* delivery(lostStart)).status).toBe("queued");
        expect((yield* delivery(claimed)).status).toBe("sending");
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(1);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("H3: a delivery whose job died after claim is sent once by the restarted job, same key", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const id = yield* queued;
        const result = yield* as(worker, claim(worker, WORKSPACE_A, id));
        expect(result).toBe("sending");
        // The job's process dies here: claimed, provider never called.
        yield* TestClock.adjust("3 minutes");
        yield* clearStarted;
        const reconciled = yield* reconcile;
        expect(EffectArray.map(reconciled, (r) => r.deliveryId)).toEqual([id]);
        const started_1 = yield* started;
        expect(started_1).toEqual([{ workspaceId: WORKSPACE_A, deliveryId: id }]);
        const result2 = yield* as(worker, deliver(worker, WORKSPACE_A, id));
        // The restarted DocumentDelivery job runs deliver.
        expect(result2).toBe("sent");
        const sentKeys_1 = yield* sentKeys;
        expect(sentKeys_1).toEqual([id]);
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(1);
        // Terminal now: a later pass finds nothing.
        yield* TestClock.adjust("3 minutes");
        const reconcile_1 = yield* reconcile;
        expect(reconcile_1).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a lost start for a document cancelled since is skipped by the restarted claim (J3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const proforma = yield* d.issue(testCaller, { input: invoiceInput({ kind: "proforma" }) });
        const { deliveryId } = yield* d.send(testCaller, proforma.id);
        yield* d.cancel(testCaller, proforma.id, { reason: "chyba" });
        yield* TestClock.adjust("3 minutes");
        const reconciled = yield* reconcile;
        expect(EffectArray.map(reconciled, (r) => r.deliveryId)).toEqual([deliveryId]);
        const result = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("skipped");
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(0);
        const reconcile_1 = yield* reconcile;
        expect(reconcile_1).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a claimed delivery whose document was cancelled while its job was down is skipped (J3)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const testCaller = yield* TestCaller;
        const d = yield* Documents;
        const proforma = yield* d.issue(testCaller, { input: invoiceInput({ kind: "proforma" }) });
        const { deliveryId } = yield* d.send(testCaller, proforma.id);
        const result = yield* as(worker, claim(worker, WORKSPACE_A, deliveryId));
        expect(result).toBe("sending");
        // The job dies before the provider call; the proforma is cancelled meanwhile.
        yield* d.cancel(testCaller, proforma.id, { reason: "chyba" });
        yield* TestClock.adjust("3 minutes");
        const reconciled = yield* reconcile;
        expect(EffectArray.map(reconciled, (r) => r.status)).toEqual(["sending"]);
        const result2 = yield* as(worker, deliver(worker, WORKSPACE_A, deliveryId));
        expect(result2).toBe("skipped");
        const result3 = yield* delivery(deliveryId);
        expect(result3).toMatchObject({ failure: "document_cancelled" });
        const attempts_1 = yield* attempts;
        expect(attempts_1).toBe(0);
        const reconcile_1 = yield* reconcile;
        expect(reconcile_1).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("a recorded dispatch attempt renews the lease: a job retrying is not restarted early", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const id = yield* queued;
        const result = yield* as(worker, claim(worker, WORKSPACE_A, id));
        expect(result).toBe("sending");
        yield* TestClock.adjust("100 seconds");
        yield* CaptureEmailSender.failNext("not_accepted");
        yield* Effect.flip(as(worker, deliver(worker, WORKSPACE_A, id)));
        // Claimed 160 s ago, but its last attempt was recorded 60 s ago.
        yield* TestClock.adjust("60 seconds");
        const reconcile_1 = yield* reconcile;
        expect(reconcile_1).toEqual([]);
        yield* TestClock.adjust("61 seconds");
        const reconciled = yield* reconcile;
        expect(EffectArray.map(reconciled, (r) => r.status)).toEqual(["sending"]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("one failing start is logged and the other deliveries are still restarted", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const first = yield* queued;
        const second = yield* queued;
        yield* TestClock.adjust("3 minutes");
        const jobs = yield* DeliveryJobs;
        const restarted = yield* reconcile.pipe(
          Effect.provideService(
            DeliveryJobs,
            DeliveryJobs.of({
              start: (workspaceId, deliveryId) =>
                deliveryId === first
                  ? Effect.die("workflow engine unavailable")
                  : jobs.start(workspaceId, deliveryId),
            }),
          ),
        );
        expect(EffectArray.map(restarted, (r) => r.deliveryId)).toEqual([first, second]);
        const restartedJobs = yield* started;
        expect(EffectArray.map(restartedJobs, (s) => s.deliveryId)).toEqual([
          first,
          second,
          second,
        ]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("an interrupted start stops the pass: later deliveries are not started", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const first = yield* queued;
        yield* queued;
        yield* TestClock.adjust("3 minutes");
        yield* clearStarted;
        const jobs = yield* DeliveryJobs;
        const pass = yield* Effect.exit(
          reconcile.pipe(
            Effect.provideService(
              DeliveryJobs,
              DeliveryJobs.of({
                start: (workspaceId, deliveryId) =>
                  deliveryId === first ? Effect.interrupt : jobs.start(workspaceId, deliveryId),
              }),
            ),
          ),
        );
        pass.pipe(Exit.hasInterrupts, expect).toBe(true);
        const started_1 = yield* started;
        expect(started_1).toEqual([]);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
