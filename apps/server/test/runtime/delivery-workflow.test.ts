import { expect, test } from "bun:test";
import { DeliveryJobs } from "@kvitbit/core";
import {
  Caller,
  ContactId,
  Contacts,
  CurrencyCode,
  DeliveryId,
  Documents,
  IsoDate,
  UserId,
  WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { EmailNotAccepted, EmailSender } from "@kvitbit/domain/ports";
import { BigDecimal, Cause, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import * as DurableClock from "effect/workflow/DurableClock";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { PgliteTestDatabase } from "../../src/persistence";
import {
  DEFAULT_DELIVERY_RETRY_SCHEDULE,
  DocumentDeliveryWorkflow,
  makeWorkflowHandlersLayer,
} from "../../src/runtime/workflows";
import { DeliveryJobsLive } from "../../src/wiring/workflows";
import { asCaller, runSqlCore } from "../persistence/conformance/sqlCore";

test.each([
  { succeeds: true, expired: false, expectedAttempts: 2, terminal: "sent" },
  { succeeds: false, expired: false, expectedAttempts: 3, terminal: "failed" },
  { succeeds: false, expired: true, expectedAttempts: 0, terminal: "failed" },
])(
  "delivery persists $terminal after $expectedAttempts attempts",
  async ({ succeeds, expired, expectedAttempts, terminal }) => {
    const user = {
      userId: UserId.make("01950000-0000-7000-8000-000000000001"),
      name: "Owner",
      email: "owner@example.test",
    };
    const attemptedKeys: string[] = [];
    const workflow = makeWorkflowHandlersLayer({ deliveryRetrySchedule: Schedule.recurs(2) }).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory),
    );
    const email = EmailSender.of({
      send: (_, { idempotencyKey }) =>
        Effect.suspend(() => {
          attemptedKeys.push(idempotencyKey);
          return succeeds && attemptedKeys.length === 2
            ? Effect.succeed({ provider: "fixture", providerMessageId: "sent" })
            : Effect.fail(new EmailNotAccepted({}));
        }),
    });
    const exit = await runSqlCore(
      Caller.account({ ...user, channel: "web", locale: "cs" }),
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const contacts = yield* Contacts;
        const documents = yield* Documents;
        const caller = yield* workspaces.create({ name: "Delivery fixture" });
        return yield* asCaller(
          caller,
          Effect.gen(function* () {
            const contact = yield* contacts.save({ name: "Buyer", roles: ["customer"] });
            const doc = yield* documents.issue({
              input: {
                kind: "invoice",
                contact: Schema.decodeUnknownSync(ContactId)(contact.id),
                issuedOn: IsoDate.make("2026-11-23"),
                currency: CurrencyCode.make("CZK"),
                due: { inDays: 14 },
                paymentMethod: "cash",
                lines: [
                  {
                    description: "Fixture",
                    quantity: BigDecimal.fromBigInt(1n),
                    unitPrice: BigDecimal.fromBigInt(50n),
                  },
                ],
              },
            });
            const { deliveryId: id } = yield* documents.send(doc.id, {
              to: ["buyer@example.test"],
            });
            if (expired) {
              // A recovered intent keeps its original time budget even without a live execution.
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE deliveries SET workflow_started_at = '2020-01-01T00:00:00Z'
                WHERE workspace_id = ${caller.workspaceId} AND id = ${id}`;
            }
            const outcome = yield* DocumentDeliveryWorkflow.execute({
              workspaceId: caller.workspaceId,
              deliveryId: id,
            }).pipe(Effect.provide(workflow), Effect.provideService(EmailSender, email));
            const updated = yield* documents.get(doc.id);
            return {
              id,
              outcome,
              status: updated.deliveries.find((entry) => entry.id === id)?.status,
            };
          }),
        );
      }),
      { users: [user] },
    );
    expect(exit).toMatchObject({
      _tag: "Success",
      value: { outcome: terminal, status: terminal },
    });
    expect(attemptedKeys).toHaveLength(expectedAttempts);
    if (!expired) expect(new Set(attemptedKeys).size).toBe(1);
  },
  30_000,
);

test("reconciliation tracks active retries even when older workflow history was pruned", async () => {
  const workspaceId = WorkspaceId.make("01950000-0000-7000-8000-000000000001");
  const deliveryId = DeliveryId.make("01950000-0000-7000-8000-000000000002");
  const prunedDeliveryId = DeliveryId.make("01950000-0000-7000-8000-000000000003");
  const contactId = "01950000-0000-7000-8000-000000000004";
  const documentId = "01950000-0000-7000-8000-000000000005";
  const launched: number[] = [];
  const workflows = DocumentDeliveryWorkflow.toLayer(({ attempt = 0 }) =>
    Effect.gen(function* () {
      launched.push(attempt);
      if (attempt === 0) return yield* Effect.die(new Error("synthetic completed worker failure"));
      yield* DurableClock.sleep({ name: "recovery-backoff", duration: "1 hour" });
      return "sent" as const;
    }),
  ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory));
  await Effect.runPromise(
    Effect.gen(function* () {
      const jobs = yield* DeliveryJobs;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO workspaces (id, slug, name) VALUES (${workspaceId}, 'fixture', 'Fixture')`;
      yield* sql`INSERT INTO contacts (id, workspace_id, name) VALUES (${contactId}, ${workspaceId}, 'Fixture')`;
      yield* sql`INSERT INTO documents (id, workspace_id, kind, contact_id, currency, language, payment_method)
        VALUES (${documentId}, ${workspaceId}, 'invoice', ${contactId}, 'CZK', 'cs', 'bank_transfer')`;
      yield* sql`INSERT INTO deliveries (id, workspace_id, document_id, document_revision, sequence,
          status, purpose, recipients, language, subject, render_model, workflow_attempt)
        VALUES (${deliveryId}, ${workspaceId}, ${documentId}, 1, 1, 'sending', 'document',
          '{buyer@example.test}', 'cs', 'Fixture', '{}', 0),
          (${prunedDeliveryId}, ${workspaceId}, ${documentId}, 1, 2, 'sending', 'document',
          '{buyer@example.test}', 'cs', 'Fixture', '{}', 4)`;

      const awaitResult = (id: DeliveryId, attempt: number) =>
        Effect.gen(function* () {
          const executionId = yield* DocumentDeliveryWorkflow.executionId({
            workspaceId,
            deliveryId: id,
            attempt,
          });
          for (let wait = 0; wait < 100; wait++) {
            const result = yield* DocumentDeliveryWorkflow.poll(executionId);
            if (Option.isSome(result)) return result.value;
            yield* Effect.promise(() => Bun.sleep(10));
          }
          return yield* Effect.die(new Error("The workflow did not publish its result"));
        });

      yield* jobs.start(workspaceId, deliveryId);
      expect((yield* awaitResult(deliveryId, 0))._tag).toBe("Complete");
      yield* Effect.all(
        [jobs.start(workspaceId, deliveryId), jobs.start(workspaceId, deliveryId)],
        { concurrency: 2 },
      );
      expect((yield* awaitResult(deliveryId, 1))._tag).toBe("Suspended");
      yield* jobs.start(workspaceId, prunedDeliveryId);
      expect((yield* awaitResult(prunedDeliveryId, 4))._tag).toBe("Suspended");
      yield* TestClock.adjust("3 minutes");
      yield* jobs.start(workspaceId, deliveryId);
      yield* jobs.start(workspaceId, prunedDeliveryId);
      yield* Effect.promise(() => Bun.sleep(50));
    }).pipe(
      Effect.provide(
        DeliveryJobsLive.pipe(
          Layer.provideMerge(workflows),
          Layer.provideMerge(TestClock.layer()),
          Layer.provideMerge(PgliteTestDatabase),
        ),
      ),
    ),
  );
  expect(launched).toEqual([0, 1, 4]);
}, 30_000);

test("the default delivery retry policy caps spacing and total elapsed time", async () => {
  const waits = await Effect.runPromise(
    Effect.gen(function* () {
      const schedule = yield* Schedule.toStep(DEFAULT_DELIVERY_RETRY_SCHEDULE);
      const delays: number[] = [];
      let elapsed = 0;
      for (;;) {
        const next = yield* schedule(elapsed, undefined).pipe(
          Effect.catchIf(Cause.isDone, () => Effect.succeed(null)),
        );
        if (next === null) return delays;
        const delay = Duration.toMillis(next[1]);
        delays.push(delay);
        elapsed += delay;
      }
    }),
  );
  expect(waits[0]).toBe(30_000);
  expect(waits[1]).toBe(60_000);
  expect(Math.max(...waits)).toBe(3_600_000);
  const total = waits.reduce((sum, delay) => sum + delay, 0);
  expect(total).toBeLessThanOrEqual(86_400_000);
  expect(total).toBeGreaterThan(86_400_000 - 3_600_000);
});
