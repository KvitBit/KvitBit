/**
 * Regression: a Core built inside an effect that already has a CurrentCaller (or RequestOutcome)
 * must still read them per call. WorkspacesLive, and later DocumentsLive, DocumentSenderLive and
 * PaymentsLive, captured the whole build-time context and provided it on every call, so the
 * build-time services overrode or stood in for the call-site ones.
 */
import { describe, expect, test } from "bun:test";
import type { DocumentInput } from "@kvitbit/domain/contract";
import {
  Contacts,
  CurrentCaller,
  DocumentId,
  Documents,
  IssuingEntityPatch,
  Payments,
  RequestKey,
  Workspaces,
} from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { makeRequestOutcome } from "../../src/shared/requestOutcome";
import { TestCore } from "../../src/testing";
import { account, asCaller, TEST_NOW } from "../helpers";
import { dec, fixing, onboard, registry } from "./documents-fixtures";

describe("Core built under caller X, called as caller Y", () => {
  test("Workspaces and Contacts see the call-site caller, not the build-time one", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const ws = yield* Workspaces;
        const owner = yield* ws.create({ name: "Kvitbit s.r.o." });
        return yield* asCaller(
          owner,
          Effect.gen(function* () {
            const series = yield* ws.listSeries;
            const before = (yield* ws.current).revision;
            const updated = yield* ws.updateIssuingEntity(
              IssuingEntityPatch.make({ name: "Kvitbit a.s." }),
              before,
            );
            const contact = yield* Effect.flatMap(Contacts, (c) => c.save({ name: "Acme s.r.o." }));
            return {
              series: series.length,
              revisionBumped: updated.revision > before,
              contact: contact["name"],
            };
          }),
        );
      }).pipe(
        // Provided outside the layer: TestCore builds while CurrentCaller is the Account.
        Effect.provide(Layer.merge(TestCore(), TestClock.layer())),
        Effect.provideService(CurrentCaller, account()),
      ),
    );
    expect(exit).toEqual(Exit.succeed({ series: 3, revisionBumped: true, contact: "Acme s.r.o." }));
  });
});

describe("Core built under a RequestOutcome, called without or with another", () => {
  test("keyed replays mark only the call-site RequestOutcome, never the build-time one", async () => {
    const key = (k: string) => ({ requestKey: RequestKey.make(k) });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const built = yield* RequestOutcome;
        const { owner, buyer } = yield* onboard("vat_payer");
        // The call sites below have no RequestOutcome; only the layer build saw `built`.
        type ReplayServices = CurrentCaller | Documents | Payments;
        const withoutOutcome = Effect.updateContext<ReplayServices, ReplayServices>((context) =>
          Context.pick(CurrentCaller, Documents, Payments)(context),
        );
        return yield* asCaller(
          owner,
          Effect.gen(function* () {
            const docs = yield* Documents;
            const payments = yield* Payments;
            const input: DocumentInput = {
              kind: "invoice",
              contact: buyer,
              lines: [{ description: "Konzultace", quantity: dec("1"), unitPrice: dec("1000") }],
            };
            const issue = docs.issue({ input }, key("issue"));
            const id = DocumentId.make((yield* issue).id);
            const send = docs.send(id, undefined, key("send"));
            const pay = payments.record({ target: { document: id } }, key("pay"));
            yield* send;
            yield* pay;
            // Replays with no RequestOutcome at the call site (MCP, workflows).
            yield* issue;
            yield* send;
            yield* pay;
            const bare = yield* built.replayed;
            // Replays under their own per-request outcome.
            const replayedUnder = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const outcome = yield* makeRequestOutcome;
                yield* Effect.provideService(effect, RequestOutcome, outcome);
                return yield* outcome.replayed;
              });
            return {
              bare,
              issue: yield* replayedUnder(issue),
              send: yield* replayedUnder(send),
              pay: yield* replayedUnder(pay),
              built: yield* built.replayed,
            };
          }).pipe(withoutOutcome),
        );
      }).pipe(
        // Provided outside the layer: TestCore builds under the Account and this RequestOutcome.
        Effect.provide(
          Layer.merge(
            TestCore({ registry, fixings: [fixing({ date: "2026-11-23", eur: "25.000" })] }),
            TestClock.layer(),
          ),
        ),
        Effect.provideServiceEffect(RequestOutcome, makeRequestOutcome),
        Effect.provideService(CurrentCaller, account()),
      ),
    );
    expect(exit).toEqual(
      Exit.succeed({ bare: false, issue: true, send: true, pay: true, built: false }),
    );
  });
});
