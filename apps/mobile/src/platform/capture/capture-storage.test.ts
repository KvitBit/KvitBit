import { expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { captureStorage } from "./capture-storage";

test("native capture locks serialize work per scope and release after a failure", async () => {
  const gate = Deferred.makeUnsafe<void>();
  const started: string[] = [];

  const first = captureStorage.lock("workspace-a", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        started.push("first");
        yield* Deferred.await(gate);
        return yield* Effect.fail("write failed");
      }),
    ),
  );
  const firstSettled = first.then(
    () => "fulfilled",
    () => "rejected",
  );
  const second = captureStorage.lock("workspace-a", () =>
    Effect.runPromise(Effect.sync(() => started.push("second"))),
  );

  const other = await captureStorage.lock("workspace-b", () =>
    Effect.runPromise(Effect.succeed("other scope")),
  );
  const whileLocked = [...started];
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  const firstResult = await firstSettled;
  await second;

  expect(firstResult).toBe("rejected");
  expect(other).toBe("other scope");
  expect(whileLocked).toEqual(["first"]);
  expect(started).toEqual(["first", "second"]);
});
