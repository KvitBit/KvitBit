import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCommand } from "./command";
import {
  defaultRepository,
  githubIssueTracker,
  resolveRepository,
  verifyProjectOrigin,
} from "./github";
import { IssuePool, PoolError, runIssuePool } from "./pool";
import { t3WorkerRunner } from "./t3";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "max-workers": { type: "string", default: "2" },
      project: { type: "string", default: process.cwd() },
      repo: { type: "string", default: defaultRepository },
      state: { type: "string" },
    },
  });
  const { apply, state } = values;
  if (apply && !state) throw new PoolError("--apply requires --state");
  const maxWorkers = Number(values["max-workers"]);
  if (!/^[1-9][0-9]*$/.test(values["max-workers"]) || !Number.isSafeInteger(maxWorkers)) {
    throw new PoolError("--max-workers must be a positive integer");
  }

  const project = resolve(values.project);
  const repo = await resolveRepository(runCommand, values.repo);
  await verifyProjectOrigin(runCommand, project, repo);
  if (apply && state) {
    process.umask(0o077);
    await mkdir(dirname(state), { recursive: true, mode: 0o700 });
  }

  const pool =
    state && (apply || (await Bun.file(state).exists()))
      ? new IssuePool(state, repo.id, !apply)
      : new IssuePool(":memory:", repo.id);
  try {
    const result = await runIssuePool({
      apply,
      maxWorkers,
      pool,
      runner: t3WorkerRunner({ repo: repo.full_name, project, run: runCommand }),
      tracker: githubIssueTracker(repo, runCommand),
      async fetchMain() {
        await runCommand("git", ["-C", project, "fetch", "origin", "main"]);
      },
    });
    process.stdout.write(`${JSON.stringify({ apply, repo: repo.full_name, ...result })}\n`);
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    pool.close();
  }
}

await main().catch((error: unknown) => {
  const message =
    error instanceof PoolError || error instanceof TypeError
      ? error.message
      : "Issue pool pass failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
