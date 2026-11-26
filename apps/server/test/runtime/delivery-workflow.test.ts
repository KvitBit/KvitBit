import { expect, test } from "bun:test";
import {
  Caller,
  ContactId,
  Contacts,
  CurrencyCode,
  Documents,
  IsoDate,
  UserId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { EmailNotAccepted, EmailSender } from "@kvitbit/domain/ports";
import { BigDecimal, Cause, Duration, Effect, Layer, Schedule, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  DEFAULT_DELIVERY_RETRY_SCHEDULE,
  DocumentDeliveryWorkflow,
  makeWorkflowHandlersLayer,
} from "../../src/runtime/workflows";
import { asCaller, runSqlCore } from "../persistence/conformance/sqlCore";

test.each([
  { succeeds: true, expectedAttempts: 2, terminal: "sent" },
  { succeeds: false, expectedAttempts: 3, terminal: "failed" },
])(
  "delivery persists $terminal after $expectedAttempts attempts",
  async ({ succeeds, expectedAttempts, terminal }) => {
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
    expect(new Set(attemptedKeys).size).toBe(1);
  },
  30_000,
);

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
