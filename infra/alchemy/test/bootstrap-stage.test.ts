import { expect, test } from "bun:test";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
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
  const state = State.inMemoryState({
    [KVITBIT_STACK_NAME]: {
      prod: {
        KvitbitServer: {
          status: "created",
          logicalId: "KvitbitServer",
          fqn: "KvitbitServer",
          resourceType: "GCP.CloudRun.Service",
          namespace: undefined,
          instanceId: "server-instance",
          providerVersion: 1,
          downstream: [],
          bindings: [],
          props: {},
          attr: {},
        },
      },
    },
  });
  let inspectedState = false;
  const inspectState = Effect.gen(function* () {
    inspectedState = true;
    const stateService = yield* State.State;
    return yield* stateService;
  }).pipe(Effect.provide(state));
  const compile = Stack.make({
    name: KVITBIT_STACK_NAME,
    state,
    providers: Layer.empty,
  }) as <Out>(
    effect: Effect.Effect<Out, unknown, unknown>,
  ) => Effect.Effect<Stack.CompiledStack<Out, unknown>, unknown, Stage>;

  const result = await Effect.runPromise(
    Effect.scoped(Effect.result(compile(declareKvitbitStack(config, { inspectState })))).pipe(
      Effect.provideService(Stage, "prod"),
    ),
  );
  expect(Result.getFailure(result)).toMatchObject({
    value: {
      _tag: "StackStageMismatchError",
      alchemyStage: "prod",
      configStage: "staging",
    },
  });
  expect(inspectedState).toBe(false);
});
