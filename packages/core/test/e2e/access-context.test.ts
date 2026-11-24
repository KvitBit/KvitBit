/**
 * Regression: a Core built inside an effect that already has a CurrentCaller must still read the
 * caller per call. WorkspacesLive once captured the whole build-time context and provided it on
 * every call, so the build-time caller overrode the call-site one.
 */
import { describe, expect, test } from "bun:test";
import { Contacts, CurrentCaller, Workspaces } from "@kvitbit/domain/contract";
import { Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import { TestCore } from "../../src/testing";
import { account, asCaller, TEST_NOW } from "../helpers";

describe("Core built under caller X, called as caller Y", () => {
  test("Workspaces and Contacts see the call-site caller, not the build-time one", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(TEST_NOW);
        const ws = yield* Workspaces;
        const owner = yield* ws.create({ name: "Kvitbit s.r.o." } as never);
        return yield* asCaller(
          owner,
          Effect.gen(function* () {
            const series = yield* ws.listSeries;
            const before = (yield* ws.current).revision;
            const updated = yield* ws.updateIssuingEntity(
              { name: "Kvitbit a.s." } as never,
              before,
            );
            const contact = yield* Effect.flatMap(Contacts, (c) =>
              c.save({ name: "Acme s.r.o." } as never),
            );
            return {
              series: series.length,
              revisionBumped: updated.revision > before,
              contact: contact.name,
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
