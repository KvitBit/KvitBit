import * as Effect from "effect/Effect";
import { PoolError } from "./pool";

export type Command = (options: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly input?: string;
}) => Effect.Effect<string, PoolError>;

export const runCommand: Command = Effect.fn("IssuePool.runCommand")(function* ({
  executable,
  args,
  input,
}) {
  const failed = () => PoolError.make({ message: `${executable} failed to run` });
  const child = yield* Effect.try({
    try: () =>
      Bun.spawn([executable, ...args], {
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "ignore",
        timeout: 90_000,
        killSignal: "SIGKILL",
        env: { ...Bun.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      }),
    catch: failed,
  });
  return yield* Effect.gen(function* () {
    const [output, status] = yield* Effect.all(
      [
        Effect.tryPromise({ try: () => new Response(child.stdout).text(), catch: failed }),
        Effect.tryPromise({ try: () => child.exited, catch: failed }),
      ],
      { concurrency: 2 },
    );
    if (status !== 0)
      return yield* PoolError.make({ message: `${executable} failed with exit status ${status}` });
    return output;
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => child.kill())));
});
