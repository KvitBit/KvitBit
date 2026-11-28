import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

export const runReleaseProcess = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const process = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [Stream.runCollect(process.stdout), Stream.runCollect(process.stderr), process.exitCode],
      { concurrency: "unbounded" },
    );
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString(),
      exitCode: Number(exitCode),
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
