import { parseArgs } from "node:util";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { runCommand } from "./command";
import {
  defaultRepository,
  githubIssueTracker,
  resolveRepository,
  verifyProjectOrigin,
} from "./github";
import { IssuePool, PoolError, runIssuePool } from "./pool";
import { resolveT3Project, t3WorkerRunner } from "./t3";

const positiveInteger = /^[1-9][0-9]*$/;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const readArgs = Effect.try({
  try: () =>
    parseArgs({
      options: {
        apply: { type: "boolean", default: false },
        "max-workers": { type: "string", default: "2" },
        project: { type: "string", default: process.cwd() },
        repo: { type: "string", default: defaultRepository },
        state: { type: "string" },
      },
    }).values,
  catch: (error) =>
    PoolError.make({
      message: error instanceof TypeError ? error.message : "Unable to read arguments",
    }),
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const values = yield* readArgs;
  const { apply, state } = values;
  if (apply && (state === undefined || state === "")) {
    return yield* PoolError.make({ message: "--apply requires --state" });
  }
  const maxWorkers = Number(values["max-workers"]);
  if (!(positiveInteger.test(values["max-workers"]) && Number.isSafeInteger(maxWorkers))) {
    return yield* PoolError.make({ message: "--max-workers must be a positive integer" });
  }

  const project = yield* resolveT3Project(values.project);
  const repository = yield* resolveRepository({ run: runCommand, slug: values.repo });
  yield* verifyProjectOrigin({ run: runCommand, project: project.root, repository });
  if (apply && state !== undefined) {
    process.umask(0o077);
    yield* fs.makeDirectory(path.dirname(state), { recursive: true, mode: 0o700 });
  }

  const useState = state !== undefined && state !== "" && (apply || (yield* fs.exists(state)));
  const pool = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new IssuePool(useState ? state : ":memory:", repository.id, useState && !apply),
      catch: () => PoolError.make({ message: "Unable to open issue pool state" }),
    }),
    (store) => Effect.sync(() => store.close()),
  );
  const runner = yield* t3WorkerRunner({
    repo: repository,
    project,
    run: runCommand,
    hasWorkerBinding: (issue, threadId) => pool.hasWorkerBinding(issue, threadId),
  });
  const tracker = yield* githubIssueTracker({ repository, run: runCommand });
  const result = yield* runIssuePool({
    apply,
    maxWorkers,
    pool,
    runner,
    tracker,
    fetchMain: () =>
      runCommand({ executable: "git", args: ["-C", project.root, "fetch", "origin", "main"] }).pipe(
        Effect.asVoid,
      ),
  });
  const output = yield* encodeJson({ apply, repo: repository.full_name, ...result });
  process.stdout.write(`${output}\n`);
  if (result.failures.length > 0) process.exitCode = 1;
});

const reportFailure = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });

await main.pipe(
  Effect.scoped,
  Effect.catch((error) =>
    reportFailure(Schema.is(PoolError)(error) ? error.message : "Issue pool pass failed"),
  ),
  Effect.catchDefect((defect) =>
    reportFailure(Schema.is(PoolError)(defect) ? defect.message : "Issue pool pass failed"),
  ),
  Effect.provide(BunServices.layer),
  Effect.runPromise,
);
