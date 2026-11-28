/**
 * Regression: a Core built inside an effect that already has a TestCaller (or RequestOutcome)
 * must still read them per call. WorkspacesLive, and later DocumentsLive, DocumentSenderLive and
 * PaymentsLive, captured the whole build-time context and provided it on every call, so the
 * build-time services overrode or stood in for the call-site ones.
 */
import { describe, expect, test } from "bun:test";
import type { DocumentInput } from "@kvitbit/domain/contract";
import {
  Contacts,
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
import { account, TEST_NOW } from "../helpers";
import { dec, fixing, onboard, registry } from "./documents-fixtures";

describe("Account and Member calls on one core layer", () => {
  test("an Account creates a Workspace and the resulting Member can use it", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const ws = yield* Workspaces;
        const owner = yield* ws.create(account(), { name: "Kvitbit s.r.o." });
        const series = yield* ws.listSeries(owner);
        const before = (yield* ws.current(owner)).revision;
        const updated = yield* ws.updateIssuingEntity(
          owner,
          IssuingEntityPatch.make({ name: "Kvitbit a.s." }),
          before,
        );
        const contact = yield* Effect.flatMap(Contacts, (c) =>
          c.save(owner, { name: "Acme s.r.o." }),
        );
        return {
          series: series.length,
          revisionBumped: updated.revision > before,
          contact: contact["name"],
        };
      }).pipe(Effect.provide(Layer.merge(TestCore(), TestClock.layer()))),
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
        const { owner, buyer } = yield* onboard(account(), "vat_payer");
        // The call sites below have no RequestOutcome; only the layer build saw `built`.
        type ReplayServices = Documents | Payments;
        const withoutOutcome = Effect.updateContext<ReplayServices, ReplayServices>((context) =>
          Context.pick(Documents, Payments)(context),
        );
        return yield* Effect.gen(function* () {
          const docs = yield* Documents;
          const payments = yield* Payments;
          const input: DocumentInput = {
            kind: "invoice",
            contact: buyer,
            lines: [{ description: "Konzultace", quantity: dec("1"), unitPrice: dec("1000") }],
          };
          const issue = docs.issue(owner, { input }, key("issue"));
          const id = DocumentId.make((yield* issue).id);
          const send = docs.send(owner, id, undefined, key("send"));
          const pay = payments.record(owner, { target: { document: id } }, key("pay"));
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
        }).pipe(withoutOutcome);
      }).pipe(
        // Provided outside the layer: TestCore builds under this RequestOutcome.
        Effect.provide(
          Layer.merge(
            TestCore({ registry, fixings: [fixing({ date: "2026-11-23", eur: "25.000" })] }),
            TestClock.layer(),
          ),
        ),
        Effect.provideServiceEffect(RequestOutcome, makeRequestOutcome),
      ),
    );
    expect(exit).toEqual(
      Exit.succeed({ bare: false, issue: true, send: true, pay: true, built: false }),
    );
  });
});
