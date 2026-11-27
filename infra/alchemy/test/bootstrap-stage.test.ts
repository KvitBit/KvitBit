import { expect, test } from "bun:test";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { declareKvitbitStack, KVITBIT_STACK_NAME } from "../src/bootstrap";
import { loadStackConfig } from "../src/config";

test("bootstrap rejects a staging config for the Alchemy prod stage before inspecting state", async () => {
  const config = await Effect.runPromise(
    loadStackConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { KVITBIT_STAGE: "staging", KVITBIT_BOOTSTRAP_FOUNDATION: "true" },
          }),
        ),
      ),
    ),
  );
  let inspectedState = false;
  const state = Layer.succeed(
    State.State,
    Effect.suspend(() => {
      inspectedState = true;
      return State.InMemoryService();
    }),
  );
  const stack = Stack(
    KVITBIT_STACK_NAME,
    { state, providers: Layer.empty },
    declareKvitbitStack(config).pipe(Effect.orDie),
  );
  const compiled = Effect.runPromise(
    Effect.scoped(stack).pipe(Effect.provideService(Stage, "prod")),
  );
  await expect(compiled).rejects.toMatchObject({
    _tag: "StackStageMismatchError",
    alchemyStage: "prod",
    configStage: "staging",
  });
  expect(inspectedState).toBe(false);
});
