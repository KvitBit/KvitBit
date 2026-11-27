import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimedLabel, feedbackLabel, humanNeeded, type runIssuePool } from "./pool";

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
    const repo = fixture.repository ?? { id: 100, full_name: "KvitBit/KvitBit", owner: { id: 1, type: "User" } };
    const base = "repos/" + repo.full_name;
    if (fixture.githubFailure) process.exit(67);
    if (path === base || (fixture.aliases ?? []).includes(path)) {
      output(repo);
    } else if (fixture.otherRepositories?.[path]) {
      output(fixture.otherRepositories[path]);
    } else if (path.startsWith(base + "/issues?")) {
      output([fixture.issues, fixture.moreIssues ?? []]);
    } else if (path.startsWith(base + "/collaborators?")) {
      output([fixture.collaborators ?? []]);
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
      if (resource?.startsWith("comments?")) {
        output([fixture.comments?.[number] ?? []]);
      } else if (resource === "labels" && args[4] === "POST") {
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
    } else if (args[1] === "send") {
      if (fixture.sendFailure) process.exit(71);
      output({ queued: true });
    } else {
      process.exit(92);
    }
    break;
  }
}
`;

const service = join(import.meta.dir, "service.ts");
const issue = (number: number, ...labels: string[]) => ({
  number,
  state: "open",
  labels: [feedbackLabel, ...labels].map((name) => ({ name })),
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
const comment = (id: number, author: number, body: string, type = "User") => ({
  id,
  body,
  user: { id: author, type },
});

interface Call {
  executable: string;
  args: string[];
  input?: string;
}

type Output = Awaited<ReturnType<typeof runIssuePool>> & { apply: boolean; repo: string };

interface Fixture {
  threads?: (ReturnType<typeof thread> & { archived?: boolean })[];
  [key: string]: unknown;
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
  const project = await mkdtemp(join(tmpdir(), "kvitbit-issue-pool-"));
  const fixturePath = join(project, "github-and-t3.json");
  const fake = join(project, "fake.mjs");
  const bin = join(project, "bin");
  const state = join(project, "db", "pool.sqlite");
  const t3Home = join(project, "t3");
  const t3State = join(t3Home, "userdata");
  await mkdir(t3State, { recursive: true });
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
    await mkdir(bin);
    await writeFile(fake, fakeCommand);
    await Promise.all(
      ["gh", "git", "t3"].map(async (command) => {
        const path = join(bin, command);
        await writeFile(
          path,
          `#!/bin/sh\nexec "$ISSUE_POOL_TEST_BUN" "$ISSUE_POOL_TEST_FAKE" ${command} "$@"\n`,
        );
        await chmod(path, 0o700);
      }),
    );
    await testCase({
      project,
      state,
      async setFixture(fixture) {
        await writeFile(fixturePath, JSON.stringify(fixture));
        registry.exec("DELETE FROM projection_threads");
        for (const { threadId, branch, archived } of fixture.threads ?? []) {
          registry.run("INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?)", [
            threadId,
            "test-project",
            branch,
            archived ? "2026-11-27" : null,
          ]);
        }
      },
      async run(...args) {
        const log = join(project, `calls-${runId++}.jsonl`);
        await writeFile(log, "");
        const child = Bun.spawn([process.execPath, service, "--project", project, ...args], {
          env: {
            ...Bun.env,
            PATH: `${bin}:${Bun.env.PATH}`,
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
        const calls: Call[] = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return { status, result: stdout ? JSON.parse(stdout) : null, stderr, calls };
      },
    });
  } finally {
    registry.close();
    await rm(project, { recursive: true, force: true });
  }
}

const starts = (calls: Call[]) =>
  calls.filter(({ executable, args }) => executable === "t3" && args[1] === "start");
const sends = (calls: Call[]) =>
  calls.filter(({ executable, args }) => executable === "t3" && args[1] === "send");
const writes = (calls: Call[]) =>
  calls.filter(
    ({ executable, args }) =>
      (executable === "git" && args[2] === "fetch") ||
      (executable === "gh" && args.includes("--method")) ||
      (executable === "t3" && ["start", "send"].includes(args[1] ?? "")),
  );

function testCli(name: string, testCase: Parameters<typeof withCli>[0]): void {
  test(name, () => withCli(testCase), 30_000);
}

testCli(
  "defaults to a read-only, capped plan across GitHub pages",
  async ({ run, setFixture, state }) => {
    await setFixture({
      issues: [issue(9), { ...issue(2), pull_request: {} }],
      moreIssues: [issue(7), { ...issue(1), labels: [] }, issue(4)],
    });
    const pass = await run("--state", state);
    expect(pass.status).toBe(0);
    expect(pass.result).toMatchObject({
      apply: false,
      repo: "KvitBit/KvitBit",
      plannedAssignments: [4, 7],
      started: [],
    });
    expect(writes(pass.calls)).toEqual([]);
    expect(await Bun.file(state).exists()).toBe(false);
  },
);

testCli(
  "claims before starting, fetches once, and deduplicates across passes",
  async ({ project, run, setFixture, state }) => {
    await setFixture({ issues: [issue(9), issue(8), issue(7), issue(6)] });
    const pass = await run("--apply", "--state", state);
    expect(pass.status).toBe(0);
    expect(pass.result?.started).toEqual([6, 7]);
    const effects = writes(pass.calls);
    expect(effects.map(({ executable }) => executable)).toEqual(["git", "gh", "t3", "gh", "t3"]);
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
      humanNeeded,
      "t3_thread_organize",
    ]) {
      expect(brief).toContain(text);
    }

    const before = await Bun.file(state).bytes();
    const dry = await run("--state", state);
    expect(dry.result?.plannedAssignments).toEqual([8, 9]);
    expect(writes(dry.calls)).toEqual([]);
    expect(await Bun.file(state).bytes()).toEqual(before);
    const next = await run("--apply", "--state", state, "--max-workers", "1");
    expect(next.result?.started).toEqual([8]);
    expect(starts(next.calls)).toHaveLength(1);
  },
);

testCli(
  "skips claims, open PRs, assignees and known T3 threads",
  async ({ run, setFixture, state }) => {
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
    expect(pass.status).toBe(0);
    expect(pass.result).toMatchObject({ plannedAssignments: [], started: [], adopted: [4, 5] });
    expect(writes(pass.calls)).toEqual([]);
  },
);

testCli(
  "relays later comments from authenticated maintainers and owners once",
  async ({ run, setFixture, state }) => {
    await setFixture({
      issues: [issue(4, claimedLabel), issue(5, claimedLabel)],
      threads: [thread(4), thread(5)],
      collaborators: [
        { id: 2, type: "User", permissions: { maintain: true } },
        { id: 3, type: "User", permissions: { push: true } },
      ],
      comments: {
        4: [
          comment(14, 1, "Owner follow-up"),
          comment(10, 1, `Which browser?\r\n${humanNeeded}`),
          comment(15, 3, humanNeeded),
          comment(11, 3, "Write collaborator is not a maintainer"),
          comment(12, 2, "Bot impersonation", "Bot"),
          comment(13, 2, "Firefox"),
          comment(16, 1, "<!-- kvitbit-agent:completed -->"),
          comment(9, 1, "Before the question"),
        ],
        5: [comment(21, 3, humanNeeded), comment(22, 1, "Do not relay this")],
      },
    });
    const planned = await run();
    expect(planned.status).toBe(0);
    expect(planned.result?.plannedReplies).toEqual([13]);
    expect(writes(planned.calls)).toEqual([]);

    const apply = ["--apply", "--state", state];
    const first = await run(...apply);
    expect(first.result?.replied).toEqual([13]);
    expect(sends(first.calls)).toEqual([
      {
        executable: "t3",
        args: ["thread", "send", "--log-level", "none", "--json", "worker-4", "-"],
        input: "<!-- issue-pool-reply:13 -->\nMaintainer reply from GitHub comment 13\n\nFirefox",
      },
    ]);
    expect((await run(...apply)).result?.replied).toEqual([14]);
    expect(sends((await run(...apply)).calls)).toEqual([]);
  },
);

testCli(
  "reconciles lost T3 start and reply acknowledgments without reissuing them",
  async ({ run, setFixture, state }) => {
    const apply = ["--apply", "--state", state];
    await setFixture({ issues: [issue(4)], startFailure: true });
    const startFailed = await run(...apply);
    expect(startFailed.status).toBe(1);
    expect(starts(startFailed.calls)).toHaveLength(1);

    await setFixture({ issues: [] });
    const awaiting = await run(...apply);
    expect(awaiting.status).toBe(1);
    expect(starts(awaiting.calls)).toEqual([]);

    const waiting = {
      issues: [issue(4, claimedLabel)],
      threads: [thread(4)],
      comments: { 4: [comment(21, 1, humanNeeded), comment(22, 1, "Use Firefox")] },
    };
    await setFixture({ ...waiting, sendFailure: true });
    const replyFailed = await run(...apply);
    expect(replyFailed.status).toBe(1);
    expect(replyFailed.result?.adopted).toEqual([4]);
    expect(sends(replyFailed.calls)).toHaveLength(1);

    const text = "<!-- issue-pool-reply:22 -->\nMaintainer reply";
    await setFixture({
      ...waiting,
      comments: { 4: [comment(30, 1, humanNeeded), comment(31, 1, "New answer")] },
      threads: [{ ...thread(4), messages: [...thread(4).messages, { role: "assistant", text }] }],
    });
    const ignored = await run(...apply);
    expect(ignored.status).toBe(1);
    expect(sends(ignored.calls)).toEqual([]);

    await setFixture({
      ...waiting,
      issues: [],
      threads: [
        {
          ...thread(4),
          messages: [
            ...thread(4).messages,
            { role: "user", text },
            ...Array.from({ length: 100 }, () => ({ role: "assistant", text: "Later message" })),
          ],
        },
      ],
    });
    const recovered = await run(...apply);
    expect(recovered.status).toBe(0);
    expect(recovered.result?.recoveredReplies).toEqual([22]);
    expect(writes(recovered.calls)).toEqual([]);
  },
);

testCli(
  "a concurrent pass reserves the same issue only once",
  async ({ run, setFixture, state }) => {
    await setFixture({ issues: [issue(4)] });
    const passes = await Promise.all([
      run("--apply", "--state", state),
      run("--apply", "--state", state),
    ]);
    expect(passes.flatMap(({ calls }) => starts(calls))).toHaveLength(1);
    expect(passes.flatMap(({ result }) => result?.started ?? [])).toEqual([4]);
  },
);

testCli(
  "keeps a failed GitHub claim visible and retries only while unclaimed",
  async ({ run, setFixture, state }) => {
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
  },
);

testCli(
  "an archived worker still makes the assignment ambiguous after Git branch deletion",
  async ({ run, setFixture, state }) => {
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
  },
);

testCli("rejects cross-repository launch and relay", async ({ run, setFixture, state }) => {
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
    comments: { 4: [comment(50, 1, humanNeeded), comment(51, 1, "Private to the other repo")] },
  };
  const apply = ["--apply", "--state", state, "--repo", repository.full_name];
  await setFixture(github);
  const wrongProject = await run(...apply);
  expect(wrongProject.status).toBe(1);
  expect(wrongProject.stderr).toContain("The project origin does not match");
  expect(wrongProject.calls.some(({ executable }) => executable === "t3")).toBe(false);
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
});

testCli(
  "recognizes the same repository after a GitHub transfer",
  async ({ run, setFixture, state }) => {
    await setFixture({
      repository: { id: 100, full_name: "KvitBit/KvitBit", owner: { id: 1, type: "User" } },
      aliases: ["repos/totalolage/kvitbit"],
      origin: "git@github.com:totalolage/kvitbit.git",
      issues: [issue(4, claimedLabel)],
      threads: [thread(4)],
      comments: { 4: [comment(50, 1, humanNeeded), comment(51, 1, "Use Firefox")] },
    });
    const pass = await run("--apply", "--state", state, "--repo", "totalolage/kvitbit");
    expect(pass.status).toBe(0);
    expect(pass.result).toMatchObject({ repo: "KvitBit/KvitBit", adopted: [4], replied: [51] });
    expect(writes(pass.calls)).toEqual(sends(pass.calls));
    expect(sends(pass.calls)[0]?.args).toContain("worker-4");
  },
);

testCli(
  "rejects a nested checkout that would resolve to a different T3 workspace root",
  async ({ project, run, setFixture, state }) => {
    const nested = join(project, "nested");
    await mkdir(nested);
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
  },
);

testCli(
  "a reused GitHub name cannot take over an older worker",
  async ({ run, setFixture, state }) => {
    const apply = ["--apply", "--state", state];
    const worker = thread(4);
    await setFixture({ issues: [issue(4, claimedLabel)], threads: [worker] });
    expect((await run(...apply)).result?.adopted).toEqual([4]);

    const reassignedName = {
      repository: { id: 200, full_name: "other/new", owner: { id: 1, type: "User" } },
      aliases: ["repos/KvitBit/KvitBit"],
      origin: "https://github.com/other/new.git",
      threads: [worker],
      issues: [issue(4, claimedLabel)],
      comments: { 4: [comment(50, 1, humanNeeded), comment(51, 1, "Maintainer answer")] },
    };
    await setFixture(reassignedName);
    const selection = ["--repo", "other/new", "--state", state];
    const dry = await run(...selection);
    expect(dry.result?.plannedReplies).toEqual([]);
    expect(dry.status).toBe(1);
    const pass = await run("--apply", ...selection);
    expect(pass.status).toBe(1);
    expect(pass.result?.adopted).toEqual([]);
    expect(writes(dry.calls)).toEqual([]);
    expect(writes(pass.calls)).toEqual([]);
    const withoutSavedState = await run("--repo", "other/new");
    expect(withoutSavedState.status).toBe(1);
    expect(withoutSavedState.result?.plannedReplies).toEqual([]);

    await setFixture({ ...reassignedName, threads: [thread(4, "Legacy worker", null)] });
    const legacy = await run("--apply", ...selection);
    expect(legacy.status).toBe(1);
    expect(legacy.result?.failures[0]?.reason).toContain("conflicting saved assignment");
    expect(writes(legacy.calls)).toEqual([]);
  },
);

testCli(
  "a legacy worker requires one matching saved assignment",
  async ({ run, setFixture, state }) => {
    const apply = ["--apply", "--state", state];
    const fixture = {
      issues: [issue(4, claimedLabel)],
      threads: [thread(4, "Legacy worker", null)],
      comments: { 4: [comment(50, 1, humanNeeded), comment(51, 1, "Maintainer answer")] },
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
      expect(known.result?.plannedReplies).toEqual([51]);
      expect(writes(known.calls)).toEqual([]);

      save.run(200, 4, "worker-4");
      const ambiguous = await run(...apply);
      expect(ambiguous.status).toBe(1);
      expect(ambiguous.result?.failures[0]?.reason).toContain("conflicting saved assignment");
      expect(writes(ambiguous.calls)).toEqual([]);
    } finally {
      db.close();
    }
  },
);

testCli(
  "checks the initial brief before using a saved assignment for a reply",
  async ({ run, setFixture, state }) => {
    const apply = ["--apply", "--state", state];
    const worker = thread(4);
    const fixture = { issues: [issue(4, claimedLabel)], threads: [worker] };
    await setFixture(fixture);
    const initial = await run(...apply);
    expect(initial.status).toBe(0);
    expect(initial.result?.adopted).toEqual([4]);

    await setFixture({
      ...fixture,
      threads: [
        {
          ...worker,
          messages: [
            ...worker.messages.map(({ role, text }) => ({
              role,
              text: text.replace("issue-pool-repository-id:100", "issue-pool-repository-id:101"),
            })),
            ...worker.messages,
          ],
        },
      ],
      comments: { 4: [comment(50, 1, humanNeeded), comment(51, 1, "Maintainer answer")] },
    });
    const pass = await run(...apply);
    expect(pass.status).toBe(1);
    expect(pass.result?.failures).toMatchObject([
      { issue: 4, operation: "reply", reason: expect.stringContaining("no matching issue brief") },
    ]);
    expect(pass.result?.plannedReplies).toEqual([]);
    expect(writes(pass.calls)).toEqual([]);
  },
);

testCli(
  "a local worker branch without a T3 record blocks launch",
  async ({ run, setFixture, state }) => {
    await setFixture({ issues: [issue(4)], branches: [thread(4).branch] });
    const pass = await run("--apply", "--state", state);
    expect(pass.status).toBe(1);
    expect(pass.result?.failures[0]?.reason).toContain("without a matching T3 thread");
    expect(writes(pass.calls)).toEqual([]);
  },
);

testCli("an idle apply pass never invokes T3 or fetches", async ({ run, setFixture, state }) => {
  await setFixture({ issues: [] });
  const pass = await run("--apply", "--state", state);
  expect(pass.status).toBe(0);
  expect(pass.result?.plannedAssignments).toEqual([]);
  expect(pass.calls.map(({ executable }) => executable)).toEqual(["gh", "git", "gh"]);
  expect(writes(pass.calls)).toEqual([]);
});

testCli(
  "reports configuration, GitHub, fetch and claim failures without starting a worker",
  async ({ run, setFixture, state }) => {
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
  },
);
