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
    const repo = fixture.repository ?? { id: 100, full_name: "totalolage/kvitbit", owner: { id: 1, type: "User" } };
    const base = "repos/" + repo.full_name;
    if (fixture.githubFailure) process.exit(67);
    if (path === base) {
      output(repo);
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
    if (args[2] === "fetch") {
      if (fixture.fetchFailure) process.exit(69);
    } else if (args[2] === "for-each-ref") {
      process.stdout.write((fixture.branches ?? []).map((branch) => "refs/heads/" + branch).join("\n"));
    } else {
      process.exit(91);
    }
    break;
  }
  case "t3": {
    if (args[1] === "list") {
      output((fixture.threads ?? []).map(({ threadId, title }) => ({ threadId, title })));
    } else if (args[1] === "show") {
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
const thread = (number: number, title = `Kvitbit issue #${number}`) => ({
  threadId: `worker-${number}`,
  title,
  branch: `issue-pool/issue-${number}`,
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

async function withCli(
  testCase: (cli: {
    project: string;
    state: string;
    setFixture(fixture: object): Promise<void>;
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
  let runId = 0;
  try {
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
      repo: "totalolage/kvitbit",
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
    expect(effects[1]?.args).toContain("repos/totalolage/kvitbit/issues/6/labels");
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
        project,
        "-",
      ],
    });
    const brief = starts(pass.calls)[0]?.input;
    expect(brief).toStartWith("$full-send\n");
    for (const text of [
      "https://github.com/totalolage/kvitbit/issues/6",
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
      branches: [thread(5).branch],
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
      threads: [{ ...thread(4), messages: [{ role: "assistant", text }] }],
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
  "multiple top-level threads on the same branch block launch and adoption",
  async ({ run, setFixture, state }) => {
    await setFixture({
      issues: [issue(4)],
      threads: [thread(4), { ...thread(4, "Renamed worker"), threadId: "old-worker-4" }],
      branches: [thread(4).branch],
    });
    const pass = await run("--apply", "--state", state);
    expect(pass.status).toBe(1);
    expect(pass.result?.failures).toMatchObject([{ issue: 4, operation: "assignment" }]);
    expect(pass.result?.adopted).toEqual([]);
    expect(writes(pass.calls)).toEqual([]);
  },
);

testCli("an idle apply pass never invokes T3 or fetches", async ({ run, setFixture, state }) => {
  await setFixture({ issues: [] });
  const pass = await run("--apply", "--state", state);
  expect(pass.status).toBe(0);
  expect(pass.result?.plannedAssignments).toEqual([]);
  expect(pass.calls.map(({ executable }) => executable)).toEqual(["gh", "gh"]);
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
    await setFixture({ issues: [issue(4)], repository });
    const successful = await run("--apply", "--state", state, "--repo", repository.full_name);
    expect(successful.status).toBe(0);
    expect(successful.result?.started).toEqual([4]);
    expect(starts(successful.calls)[0]?.input).toContain(
      "https://github.com/another/feedback/issues/4",
    );
  },
);
