import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const liveClock = Context.get(Context.empty(), Clock.Clock);

/** Waits in real time for work that settles on later tasks, even under a test clock. */
export const eventually = Effect.fn("Test.eventually")(function* (
  check: () => boolean,
  describe: () => string = () => "",
) {
  for (let turn = 0; turn < 500; turn++) {
    if (check()) return;
    yield* Effect.sleep(1).pipe(Effect.provideService(Clock.Clock, liveClock));
  }
  return yield* Effect.die(new Error(`the condition never held ${describe()}`));
});
