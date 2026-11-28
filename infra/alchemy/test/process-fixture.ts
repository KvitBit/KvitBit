import * as BunServices from "@effect/platform-bun/BunServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const [fixtureFileSystem, fixturePath] = Effect.all([FileSystem.FileSystem, Path.Path], {
  concurrency: "unbounded",
}).pipe(Effect.provide(BunServices.layer), Effect.runSync);

export const systemPath = Config.String("PATH").pipe(
  Config.withDefault("/usr/bin:/bin"),
  Effect.runSync,
);

interface Command {
  readonly command: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: Uint8Array;
}

const capture = Effect.fn("captureCommand")(function* ({ command, ...options }: Command) {
  const child = yield* Effect.sync(() =>
    Bun.spawn([...command], { ...options, stdout: "pipe", stderr: "pipe" }),
  );
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      Effect.promise(() => child.exited),
      Effect.promise(() => new Response(child.stdout).text()),
      Effect.promise(() => new Response(child.stderr).text()),
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode, stdout, stderr };
});

export const runCommand = (command: Command) => capture(command).pipe(Effect.runPromise);

export const runSerial =
  <A>(items: Iterable<A>) =>
  (run: (item: A) => Promise<void>) =>
    Effect.forEach(items, (item) => Effect.promise(() => run(item)), {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.runPromise);
