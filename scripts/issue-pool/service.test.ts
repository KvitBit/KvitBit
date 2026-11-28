import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { claimedLabel, feedbackLabel } from "./pool";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const humanNeededInPattern = /human-needed|in a comment|pool to relay/i;

// Run the real CLI and SQLite with deterministic stand-ins for the external processes.
const fakeCommand = String.raw`
const [executable, ...args] = process.argv.slice(2);
const fixture = await Bun.file(Bun.env.ISSUE_POOL_FIXTURE).json();
const input = args.at(-1) === "-" ? await Bun.stdin.text() : undefined;
const { appendFile } = await import("node:fs/promises");
await appendFile(Bun.env.ISSUE_POOL_LOG, JSON.stringify({ executable, args, input }) + "\n");
const output = (value) => process.stdout.write(JSON.stringify(value));
const claimLabel = "visual-feedback:claimed";

switch (executable) {
  case "gh": {
    const path = ["--paginate", "--method"].includes(args[3]) ? args[5] : args[3];
    const repo = fixture.repository ?? { id: 100, full_name: "KvitBit/KvitBit", owner: { id: 1 } };
    const base = "repos/" + repo.full_name;
    if (fixture.githubFailure) process.exit(67);
    if (path === base || (fixture.aliases ?? []).includes(path)) {
      output(repo);
    } else if (fixture.otherRepositories?.[path]) {
      output(fixture.otherRepositories[path]);
    } else if (path.startsWith(base + "/issues?")) {
      output([fixture.issues, fixture.moreIssues ?? []]);
    } else if (path.startsWith(base + "/labels?")) {
      output([[{ name: claimLabel }]]);
    } else if (path.startsWith(base + "/pulls?")) {
      output((fixture.branchPRs ?? []).some((number) => path.includes("issue-" + number + "&")) ? [{}] : []);
    } else if (path === "graphql") {
      const number = Number(args.at(-1).split("=")[1]);
      output({ data: { repository: { issue: { closedByPullRequestsReferences: {
        nodes: (fixture.linkedPRs ?? []).includes(number) ? [{ state: "OPEN" }] : [],
      } } } } });
    } else {
      const [number, resource] = path.slice((base + "/issues/").length).split("/");
      if (resource === "labels" && args[4] === "POST") {
        if (fixture.claimFailure) process.exit(68);
        if (args.at(-1) !== "labels[]=" + claimLabel) process.exit(93);
        output([{ name: claimLabel }]);
      } else if (path === base + "/issues/" + number && /^\d+$/.test(number)) {
        output([...fixture.issues, ...(fixture.moreIssues ?? [])].find((issue) => issue.number === Number(number)));
      } else {
        process.exit(90);
      }
    }
    break;
  }
  case "git": {
    if (args.slice(2).join(" ") === "remote get-url origin") {
      process.stdout.write(fixture.origins?.[args[1]] ?? fixture.origin ?? "git@github.com:KvitBit/KvitBit.git");
    } else if (args[2] === "fetch") {
      if (fixture.fetchFailure) process.exit(69);
    } else if (args[2] === "for-each-ref") {
      process.stdout.write((fixture.branches ?? []).map((branch) => "refs/heads/" + branch).join("\n"));
    } else {
      process.exit(91);
    }
    break;
  }
  case "t3": {
    if (args[1] === "show") {
      const thread = fixture.threads.find(({ threadId }) => threadId === args.at(-1));
      output({ thread, messages: args[3] === "0" ? [] : (thread.messages ?? []).slice(-Number(args[3])) });
    } else if (args[1] === "start") {
      if (fixture.startFailure) process.exit(70);
      output({ threadId: "worker-" + args[7].split("-").at(-1) });
    } else {
      process.exit(92);
    }
    break;
  }
}
`;

const service = fileURLToPath(new URL("./service.ts", import.meta.url));
interface FixtureIssue {
  number: number;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  pull_request?: { url?: string };
}

const issue = (number: number, ...labels: string[]): FixtureIssue => ({
  number,
  state: "open",
  labels: Arr.map([feedbackLabel, ...labels], (name) => ({ name })),
  assignees: [],
});
const thread = (
  number: number,
  title = `Kvitbit issue #${number}`,
  repoId: number | null = 100,
) => ({
  threadId: `worker-${number}`,
  title,
  branch: `issue-pool/issue-${number}`,
  projectId: "test-project",
  parentThreadId: null,
  messages: [
    {
      role: "user",
      text: `$full-send\n\n${repoId === null ? "" : `<!-- issue-pool-repository-id:${repoId} -->\n\n`}Own https://github.com/KvitBit/KvitBit/issues/${number} through investigation.`,
    },
  ],
});
interface Call {
  executable: string;
  args: string[];
  input?: string;
}

const outputSchema = Schema.Struct({
  apply: Schema.Boolean,
  repo: Schema.String,
  plannedAssignments: Schema.Array(Schema.Int),
  started: Schema.Array(Schema.Int),
  adopted: Schema.Array(Schema.Int),
  failures: Schema.Array(
    Schema.Struct({
      issue: Schema.Int,
      operation: Schema.Literal("assignment"),
      reason: Schema.String,
    }),
  ),
});
type Output = typeof outputSchema.Type;
const decodeOutput = Fn.flow(
  Schema.decodeResult(Schema.fromJsonString(outputSchema)),
  Result.getOrThrow,
);
const decodeCall = Fn.flow(
  Schema.decodeResult(
    Schema.fromJsonString(
      Schema.Struct({
        executable: Schema.String,
        args: Schema.String.pipe(Schema.Array, Schema.mutable),
        input: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  Result.getOrThrow,
);

const [fs, fixturePathService] = Effect.all([FileSystem.FileSystem, Path.Path], {
  concurrency: "unbounded",
}).pipe(Effect.provide(BunServices.layer), Effect.runSync);
const { join } = fixturePathService;

interface FixtureRepository {
  id: number;
  full_name: string;
  owner: { id: number; type?: string };
}

interface Fixture {
  aliases?: string[];
  branchPRs?: number[];
  branches?: string[];
  claimFailure?: boolean;
  fetchFailure?: boolean;
  githubFailure?: boolean;
  issues?: ReturnType<typeof issue>[];
  linkedPRs?: number[];
  moreIssues?: ReturnType<typeof issue>[];
  origin?: string;
  origins?: Record<string, string>;
  otherRepositories?: Record<string, FixtureRepository>;
  repository?: FixtureRepository;
  startFailure?: boolean;
  threads?: (ReturnType<typeof thread> & { archived?: boolean })[];
}

async function withCli(
  testCase: (cli: {
    project: string;
    state: string;
    setFixture(fixture: Fixture): Promise<void>;
    run(...args: string[]): Promise<{
      status: number;
      result: Output | null;
      stderr: string;
      calls: Call[];
    }>;
  }) => Promise<void>,
): Promise<void> {
  const project = await Effect.runPromise(fs.makeTempDirectory({ prefix: "kvitbit-issue-pool-" }));
  const fixturePath = join(project, "github-and-t3.json");
  const fake = join(project, "fake.mjs");
  const bin = join(project, "bin");
  const state = join(project, "db", "pool.sqlite");
  const t3Home = join(project, "t3");
  const t3State = join(t3Home, "userdata");
  await Effect.runPromise(fs.makeDirectory(t3State, { recursive: true }));
  const registry = new Database(join(t3State, "statev2.sqlite"));
  let runId = 0;
  try {
    registry.exec(`
      CREATE TABLE projection_projects (
        project_id TEXT, workspace_root TEXT, deleted_at TEXT, archived_at TEXT
      );
      CREATE TABLE projection_threads (
        thread_id TEXT, project_id TEXT, branch TEXT, deleted_at TEXT, archived_at TEXT
      );
    `);
    registry.run("INSERT INTO projection_projects VALUES (?, ?, NULL, NULL)", [
      "test-project",
      project,
    ]);
    await Effect.runPromise(fs.makeDirectory(bin));
    await Effect.runPromise(fs.writeFileString(fake, fakeCommand));
    await Promise.all(
      Arr.map(["gh", "git", "t3"], async (command) => {
        const path = join(bin, command);
        await Effect.runPromise(
          fs.writeFileString(
            path,
            `#!/bin/sh\nexec "$ISSUE_POOL_TEST_BUN" "$ISSUE_POOL_TEST_FAKE" ${command} "$@"\n`,
          ),
        );
        await Effect.runPromise(fs.chmod(path, 0o700));
      }),
    );
    await testCase({
      project,
      state,
      async setFixture(fixture) {
        await Effect.runPromise(fs.writeFileString(fixturePath, encodeJson(fixture)));
        registry.exec("DELETE FROM projection_threads");
        for (const { threadId, branch, archived } of fixture.threads ?? []) {
          registry.run("INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?)", [
            threadId,
            "test-project",
            branch,
            archived !== undefined ? "2026-11-27" : null,
          ]);
        }
      },
      async run(...args) {
        const log = join(project, `calls-${runId++}.jsonl`);
        await Effect.runPromise(fs.writeFileString(log, ""));
        const child = Bun.spawn([process.execPath, service, "--project", project, ...args], {
          env: {
            ...Bun.env,
            PATH: `${bin}:${Bun.env["PATH"]}`,
            ISSUE_POOL_FIXTURE: fixturePath,
            ISSUE_POOL_LOG: log,
            ISSUE_POOL_TEST_BUN: process.execPath,
            ISSUE_POOL_TEST_FAKE: fake,
            T3CODE_HOME: t3Home,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const calls: Call[] = Arr.map(
          Arr.filter(
            Str.split(Str.trim(await Effect.runPromise(fs.readFileString(log))), "\n"),
            Boolean,
          ),
          (line) => decodeCall(line),
        );
        return { status, result: stdout !== "" ? decodeOutput(stdout) : null, stderr, calls };
      },
    });
  } finally {
    registry.close();
    await Effect.runPromise(fs.remove(project, { recursive: true, force: true }));
  }
}

const starts = (calls: Call[]) =>
  Arr.filter(calls, ({ executable, args }) => executable === "t3" && args[1] === "start");
const writes = (calls: Call[]) =>
  Arr.filter(
    calls,
    ({ executable, args }) =>
      (executable === "git" && args[2] === "fetch") ||
      (executable === "gh" && args.includes("--method")) ||
      (executable === "t3" && ["start", "send"].includes(args[1] ?? "")),
  );

test(
  "defaults to a read-only, capped plan across GitHub pages",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({
        issues: [issue(9), { ...issue(2), pull_request: {} }],
        moreIssues: [issue(7), { ...issue(1), labels: [] }, issue(4)],
      });
      const pass = await run("--state", state);
      expect(pass.status, pass.stderr).toBe(0);
      expect(pass.result).toMatchObject({
        apply: false,
        repo: "KvitBit/KvitBit",
        plannedAssignments: [4, 7],
        started: [],
      });
      expect(writes(pass.calls)).toEqual([]);
      expect(await Bun.file(state).exists()).toBe(false);
    }),
  30_000,
);

test(
  "claims before starting, fetches once, and deduplicates across passes",
  () =>
    withCli(async ({ project, run, setFixture, state }) => {
      await setFixture({ issues: [issue(9), issue(8), issue(7), issue(6)] });
      const pass = await run("--apply", "--state", state);
      expect(pass.status, pass.stderr).toBe(0);
      expect(pass.result?.started).toEqual([6, 7]);
      const effects = writes(pass.calls);
      expect(Arr.map(effects, ({ executable }) => executable)).toEqual([
        "git",
        "gh",
        "t3",
        "gh",
        "t3",
      ]);
      expect(effects[0]?.args).toEqual(["-C", project, "fetch", "origin", "main"]);
      expect(effects[1]?.args).toContain("repos/KvitBit/KvitBit/issues/6/labels");
      expect(starts(pass.calls)[0]).toMatchObject({
        args: [
          "thread",
          "start",
          "--title",
          "Kvitbit issue #6",
          "--worktree",
          "origin/main",
          "--branch",
          "issue-pool/issue-6",
          "--log-level",
          "none",
          "--json",
          "test-project",
          "-",
        ],
      });
      const brief = starts(pass.calls)[0]?.input;
      expect(brief).toStartWith("$full-send\n");
      for (const text of [
        "<!-- issue-pool-repository-id:100 -->",
        "https://github.com/KvitBit/KvitBit/issues/6",
        "Fixes #6",
        "AGENTS.md",
        "verify-*",
        "ask directly in this T3 Code session",
        "interactive user input",
        "ask in the thread so the user can reply here",
        "request_secret",
        "Leave this thread open and unsnoozed",
        "t3_thread_organize",
      ]) {
        expect(brief).toContain(text);
      }

      expect(brief).not.toMatch(humanNeededInPattern);

      const before = await Bun.file(state).bytes();
      const dry = await run("--state", state);
      expect(dry.result?.plannedAssignments).toEqual([8, 9]);
      expect(writes(dry.calls)).toEqual([]);
      expect(await Bun.file(state).bytes()).toEqual(before);
      const next = await run("--apply", "--state", state, "--max-workers", "1");
      expect(next.result?.started).toEqual([8]);
      expect(starts(next.calls)).toHaveLength(1);
    }),
  30_000,
);

test(
  "skips claims, open PRs, assignees and known T3 threads",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({
        issues: [
          issue(1, claimedLabel),
          issue(2),
          issue(3),
          issue(4, claimedLabel),
          issue(5),
          { ...issue(6), assignees: [{ login: "owner" }] },
        ],
        linkedPRs: [2],
        branchPRs: [3],
        threads: [thread(4), thread(5, "Renamed worker")],
      });
      const pass = await run("--apply", "--state", state);
      expect(pass.status, pass.stderr).toBe(0);
      expect(pass.result).toMatchObject({ plannedAssignments: [], started: [], adopted: [4, 5] });
      expect(writes(pass.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "ignores existing reply reservations in dry-run and apply",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const worker = thread(4);
      await setFixture({ issues: [issue(4, claimedLabel)], threads: [worker] });
      const adopted = await run("--apply", "--state", state);
      expect(adopted.status).toBe(0);
      expect(adopted.result?.adopted).toEqual([4]);
      expect(writes(adopted.calls)).toEqual([]);

      const db = new Database(state);
      try {
        db.exec(`
        CREATE TABLE worker_reply (
          repo_id INTEGER NOT NULL,
          comment_id INTEGER NOT NULL,
          issue INTEGER NOT NULL,
          question_id INTEGER NOT NULL,
          thread_id TEXT NOT NULL,
          accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
          PRIMARY KEY (repo_id, comment_id)
        ) STRICT;
        INSERT INTO worker_reply VALUES (100, 22, 4, 21, 'worker-4', 0);
      `);
        const before = await Bun.file(state).bytes();
        for (const apply of [false, true]) {
          const pass = await run("--state", state, ...(apply ? ["--apply"] : []));
          expect(pass.status, pass.stderr).toBe(0);
          expect(pass.result).toEqual({
            apply,
            repo: "KvitBit/KvitBit",
            plannedAssignments: [],
            started: [],
            adopted: [],
            failures: [],
          });
          expect(Arr.map(pass.calls, ({ executable, args }) => [executable, args.at(-1)])).toEqual([
            ["gh", "repos/KvitBit/KvitBit"],
            ["git", "origin"],
            ["gh", "repos/KvitBit/KvitBit/issues?state=open&labels=visual-feedback&per_page=100"],
          ]);
          expect(await Bun.file(state).bytes()).toEqual(before);
        }
      } finally {
        db.close();
      }
    }),
  30_000,
);

test(
  "reconciles a lost T3 start acknowledgment without starting another worker",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const apply = ["--apply", "--state", state];
      await setFixture({ issues: [issue(4)], startFailure: true });
      const startFailed = await run(...apply);
      expect(startFailed.status).toBe(1);
      expect(starts(startFailed.calls)).toHaveLength(1);

      await setFixture({ issues: [] });
      const awaiting = await run(...apply);
      expect(awaiting.status).toBe(1);
      expect(starts(awaiting.calls)).toEqual([]);

      const worker = thread(4);
      await setFixture({
        issues: [],
        threads: [
          {
            ...worker,
            messages: [
              ...worker.messages,
              ...Array.from({ length: 100 }, () => ({ role: "assistant", text: "Later message" })),
            ],
          },
        ],
      });
      const recovered = await run(...apply);
      expect(recovered.status).toBe(0);
      expect(recovered.result?.adopted).toEqual([4]);
      expect(writes(recovered.calls)).toEqual([]);

      const next = await run(...apply);
      expect(next.status).toBe(0);
      expect(next.result?.adopted).toEqual([]);
      expect(Arr.some(next.calls, ({ executable }) => executable === "t3")).toBe(false);
    }),
  30_000,
);

test(
  "a concurrent pass reserves the same issue only once",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({ issues: [issue(4)] });
      const passes = await Promise.all([
        run("--apply", "--state", state),
        run("--apply", "--state", state),
      ]);
      expect(Arr.flatMap(passes, ({ calls }) => starts(calls))).toHaveLength(1);
      expect(Arr.flatMap(passes, ({ result }) => result?.started ?? [])).toEqual([4]);
    }),
  30_000,
);

test(
  "keeps a failed GitHub claim visible and retries only while unclaimed",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const apply = ["--apply", "--state", state];
      await setFixture({ issues: [issue(4)], claimFailure: true });
      const lost = await run(...apply);
      expect(lost.status).toBe(1);
      expect(starts(lost.calls)).toEqual([]);

      await setFixture({ issues: [issue(4, claimedLabel)] });
      const unconfirmed = await run(...apply);
      expect(unconfirmed.status).toBe(1);
      expect(unconfirmed.result?.failures).toMatchObject([{ issue: 4, operation: "assignment" }]);
      expect(writes(unconfirmed.calls)).toEqual([]);

      await setFixture({ issues: [issue(4)] });
      const retry = await run(...apply);
      expect(retry.status).toBe(0);
      expect(retry.result?.started).toEqual([4]);
    }),
  30_000,
);

test(
  "an archived worker still makes the assignment ambiguous after Git branch deletion",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({
        issues: [issue(4)],
        threads: [
          thread(4),
          { ...thread(4, "Renamed worker"), threadId: "old-worker-4", archived: true },
        ],
      });
      const pass = await run("--apply", "--state", state);
      expect(pass.status).toBe(1);
      expect(pass.result?.failures).toMatchObject([{ issue: 4, operation: "assignment" }]);
      expect(pass.result?.adopted).toEqual([]);
      expect(writes(pass.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "rejects cross-repository launch and worker adoption",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const repository = { id: 101, full_name: "another/feedback", owner: { id: 1, type: "User" } };
      const github = {
        repository,
        otherRepositories: {
          "repos/KvitBit/KvitBit": {
            id: 100,
            full_name: "KvitBit/KvitBit",
            owner: { id: 1, type: "User" },
          },
        },
        issues: [issue(4)],
        threads: [thread(4)],
      };
      const apply = ["--apply", "--state", state, "--repo", repository.full_name];
      await setFixture(github);
      const wrongProject = await run(...apply);
      expect(wrongProject.status).toBe(1);
      expect(wrongProject.stderr).toContain("The project origin does not match");
      expect(Arr.some(wrongProject.calls, ({ executable }) => executable === "t3")).toBe(false);
      expect(await Bun.file(state).exists()).toBe(false);

      // An old thread can outlive a change to the project's remote.
      await setFixture({ ...github, origin: "ssh://git@ssh.github.com:443/another/feedback.git" });
      const wrongWorker = await run(...apply);
      expect(wrongWorker.status).toBe(1);
      expect(wrongWorker.result?.failures).toMatchObject([
        {
          issue: 4,
          operation: "assignment",
          reason: expect.stringContaining("no matching issue brief"),
        },
      ]);
      expect(wrongWorker.result?.adopted).toEqual([]);
      expect(writes(wrongWorker.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "recognizes the same repository after a GitHub transfer",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({
        repository: { id: 100, full_name: "KvitBit/KvitBit", owner: { id: 1, type: "User" } },
        aliases: ["repos/totalolage/kvitbit"],
        origin: "git@github.com:totalolage/kvitbit.git",
        issues: [issue(4, claimedLabel)],
        threads: [thread(4)],
      });
      const pass = await run("--apply", "--state", state, "--repo", "totalolage/kvitbit");
      expect(pass.status, pass.stderr).toBe(0);
      expect(pass.result).toMatchObject({ repo: "KvitBit/KvitBit", adopted: [4] });
      expect(writes(pass.calls)).toEqual([]);
      expect(
        Arr.some(
          pass.calls,
          ({ executable, args }) =>
            executable === "gh" && args.at(-1) === "repos/totalolage/kvitbit",
        ),
      ).toBe(true);
    }),
  30_000,
);

test(
  "rejects a nested checkout that would resolve to a different T3 workspace root",
  () =>
    withCli(async ({ project, run, setFixture, state }) => {
      const nested = join(project, "nested");
      await Effect.runPromise(fs.makeDirectory(nested));
      await setFixture({
        repository: { id: 101, full_name: "another/feedback", owner: { id: 1, type: "User" } },
        origins: {
          [project]: "https://github.com/KvitBit/KvitBit.git",
          [nested]: "https://github.com/another/feedback.git",
        },
        issues: [issue(4)],
      });
      const pass = await run(
        "--apply",
        "--state",
        state,
        "--project",
        nested,
        "--repo",
        "another/feedback",
      );
      expect(pass.status).toBe(1);
      expect(pass.stderr).toContain("registered T3 workspace root");
      expect(writes(pass.calls)).toEqual([]);
      expect(await Bun.file(state).exists()).toBe(false);
    }),
  30_000,
);

test(
  "a reused GitHub name cannot take over an older worker",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const apply = ["--apply", "--state", state];
      const worker = thread(4);
      await setFixture({ issues: [issue(4, claimedLabel)], threads: [worker] });
      expect((await run(...apply)).result?.adopted).toEqual([4]);

      const reassignedName = {
        repository: { id: 200, full_name: "KvitBit/KvitBit", owner: { id: 2 } },
        threads: [worker],
        issues: [issue(4, claimedLabel)],
      };
      await setFixture(reassignedName);
      const selection = ["--state", state];
      const dry = await run(...selection);
      expect(dry.result?.plannedAssignments).toEqual([]);
      expect(dry.status).toBe(1);
      const pass = await run("--apply", ...selection);
      expect(pass.status).toBe(1);
      expect(pass.result?.adopted).toEqual([]);
      expect(writes(dry.calls)).toEqual([]);
      expect(writes(pass.calls)).toEqual([]);
      const withoutSavedState = await run();
      expect(withoutSavedState.status).toBe(1);
      expect(withoutSavedState.result?.plannedAssignments).toEqual([]);

      await setFixture({ ...reassignedName, threads: [thread(4, "Legacy worker", null)] });
      const legacy = await run("--apply", ...selection);
      expect(legacy.status).toBe(1);
      expect(legacy.result?.failures[0]?.reason).toContain("conflicting saved assignment");
      expect(writes(legacy.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "a legacy worker requires one matching saved assignment",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const apply = ["--apply", "--state", state];
      const fixture = {
        issues: [issue(4, claimedLabel)],
        threads: [thread(4, "Legacy worker", null)],
      };
      await setFixture(fixture);
      const unknown = await run(...apply);
      expect(unknown.status).toBe(1);
      expect(unknown.result?.failures[0]?.reason).toContain("no saved repository binding");
      expect(writes(unknown.calls)).toEqual([]);

      const db = new Database(state);
      try {
        const save = db.query("INSERT INTO assignment VALUES (?, ?, 'assigned', ?)");
        save.run(100, 4, "worker-4");
        const known = await run("--state", state);
        expect(known.status).toBe(0);
        expect(known.result?.plannedAssignments).toEqual([]);
        expect(writes(known.calls)).toEqual([]);

        save.run(200, 4, "worker-4");
        const ambiguous = await run(...apply);
        expect(ambiguous.status).toBe(1);
        expect(ambiguous.result?.failures[0]?.reason).toContain("conflicting saved assignment");
        expect(writes(ambiguous.calls)).toEqual([]);
      } finally {
        db.close();
      }
    }),
  30_000,
);

test(
  "checks the initial brief before adopting a discovered worker",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const apply = ["--apply", "--state", state];
      const worker = thread(4);
      const fixture = { issues: [issue(4, claimedLabel)], threads: [worker] };
      await setFixture({
        ...fixture,
        threads: [
          {
            ...worker,
            messages: [
              ...Arr.map(worker.messages, ({ role, text }) => ({
                role,
                text: Str.replace(
                  "issue-pool-repository-id:100",
                  "issue-pool-repository-id:101",
                )(text),
              })),
              ...worker.messages,
            ],
          },
        ],
      });
      const pass = await run(...apply);
      expect(pass.status).toBe(1);
      expect(pass.result?.failures).toMatchObject([
        {
          issue: 4,
          operation: "assignment",
          reason: expect.stringContaining("no matching issue brief"),
        },
      ]);
      expect(pass.result?.adopted).toEqual([]);
      expect(writes(pass.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "a local worker branch without a T3 record blocks launch",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({ issues: [issue(4)], branches: [thread(4).branch] });
      const pass = await run("--apply", "--state", state);
      expect(pass.status).toBe(1);
      expect(pass.result?.failures[0]?.reason).toContain("without a matching T3 thread");
      expect(writes(pass.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "an idle apply pass never invokes T3 or fetches",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      await setFixture({ issues: [] });
      const pass = await run("--apply", "--state", state);
      expect(pass.status, pass.stderr).toBe(0);
      expect(pass.result?.plannedAssignments).toEqual([]);
      expect(Arr.map(pass.calls, ({ executable }) => executable)).toEqual(["gh", "git", "gh"]);
      expect(writes(pass.calls)).toEqual([]);
    }),
  30_000,
);

test(
  "reports configuration, GitHub, fetch and claim failures without starting a worker",
  () =>
    withCli(async ({ run, setFixture, state }) => {
      const missingState = await run("--apply");
      expect(missingState.status).toBe(1);
      expect(missingState.stderr).toContain("--apply requires --state");
      expect(missingState.calls).toEqual([]);
      const invalidCap = await run("--max-workers", "0");
      expect(invalidCap.status).toBe(1);
      expect(invalidCap.calls).toEqual([]);

      for (const failure of ["githubFailure", "fetchFailure", "claimFailure"]) {
        await setFixture({ issues: [issue(4)], [failure]: true });
        const pass = await run("--apply", "--state", state);
        expect(pass.status).toBe(1);
        expect(starts(pass.calls)).toEqual([]);
      }

      const repository = { id: 101, full_name: "another/feedback", owner: { id: 1, type: "User" } };
      await setFixture({
        issues: [issue(4)],
        repository,
        origin: "https://github.com/another/feedback.git",
      });
      const successful = await run("--apply", "--state", state, "--repo", repository.full_name);
      expect(successful.status).toBe(0);
      expect(successful.result?.started).toEqual([4]);
      expect(starts(successful.calls)[0]?.input).toContain(
        "https://github.com/another/feedback/issues/4",
      );
    }),
  30_000,
);
