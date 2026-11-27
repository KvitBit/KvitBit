import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  checkFormalManifestCoverage,
  checkRootScriptTests,
  checkTurboCacheGraph,
  checkWorkspaceTestCoverage,
  formatGuardReport,
  matchesTurboInputs,
  parseBunTestTargets,
} from "./check";

const REPO_ROOT = resolve(import.meta.dir, "../..");

const tempDirs: Array<string> = [];

const makeTempRepo = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), "kvitbit-turbo-guard-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return dir;
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const baseFixture = (): Record<string, string> => ({
  "package.json": json({
    name: "fixture",
    private: true,
    workspaces: ["packages/*"],
    scripts: {
      test: "turbo run test:suite //#test:scripts",
      "test:scripts": "bun test scripts/demo",
      "formal:selftest": "bun formal/run-formal.ts --selftest",
      "formal:digests": "bun formal/run-formal.ts --check-digests",
      "formal:tlc:model": "bun formal/run-formal.ts --only demo.model",
      "formal:wide:model": "bun formal/run-formal.ts --wide --only demo.model",
      "formal:replay:model": "bun formal/run-formal.ts --only demo.replay",
    },
  }),
  "turbo.json": json({
    tasks: {
      test: {
        inputs: ["$TURBO_DEFAULT$"],
        outputs: [],
      },
      "test:suite": {
        dependsOn: ["test"],
        cache: false,
      },
      "//#test:scripts": {
        inputs: ["scripts/demo/**"],
        outputs: [],
      },
      "//#formal:selftest": {
        inputs: ["formal/run-formal.ts", "formal/manifest.json"],
        outputs: [],
      },
      "//#formal:digests": {
        inputs: ["formal/run-formal.ts", "formal/manifest.json", "packages/alpha/src/**"],
        outputs: [],
      },
      "//#formal:tlc:model": {
        inputs: [
          "formal/run-formal.ts",
          "formal/manifest.json",
          "formal/demo/*.tla",
          "formal/demo/*.cfg",
        ],
        outputs: [],
      },
      "//#formal:wide:model": {
        inputs: [
          "formal/run-formal.ts",
          "formal/manifest.json",
          "formal/demo/*.tla",
          "formal/demo/*.cfg",
        ],
        outputs: [],
      },
      "//#formal:replay:model": {
        inputs: ["formal/run-formal.ts", "formal/manifest.json", "formal/demo/demo.replay.test.ts"],
        outputs: [],
      },
      "//#formal:all": {
        dependsOn: [
          "//#formal:selftest",
          "//#formal:digests",
          "//#formal:tlc:model",
          "//#formal:replay:model",
        ],
        cache: false,
      },
      "//#formal:wide": {
        dependsOn: [
          "//#formal:selftest",
          "//#formal:digests",
          "//#formal:wide:model",
          "//#formal:replay:model",
        ],
        cache: false,
      },
    },
  }),
  "formal/manifest.json": json({
    schemaVersion: 1,
    checks: [
      {
        id: "demo.model",
        kind: "tlc",
        spec: "formal/demo/Demo.tla",
        config: "formal/demo/Demo.cfg",
        wideConfig: "formal/demo/Demo_wide.cfg",
        mutants: [{ name: "m1", config: "formal/demo/Demo_mutant.cfg" }],
        coveredFiles: [{ path: "packages/alpha/src/core.ts" }],
      },
      {
        id: "demo.replay",
        kind: "replay",
        replay: ["formal/demo/demo.replay.test.ts"],
        coveredFiles: [{ path: "packages/alpha/src/core.ts" }],
      },
    ],
  }),
  "packages/alpha/package.json": json({
    name: "@fixture/alpha",
    scripts: {
      "test:suite": ":",
      "test:a": "bun test test/a.test.ts",
      "test:b": "bun test test/sub",
    },
  }),
  "packages/alpha/turbo.json": json({
    extends: ["//"],
    tasks: {
      "test:suite": {
        dependsOn: ["test:a", "test:b"],
        cache: false,
      },
      "test:a": {
        inputs: ["package.json", "src/**", "test/a.test.ts"],
        outputs: [],
      },
      "test:b": {
        inputs: ["package.json", "src/**", "test/sub/**"],
        outputs: [],
      },
    },
  }),
  "packages/alpha/test/a.test.ts": "export {};\n",
  "packages/alpha/test/sub/b.test.ts": "export {};\n",
  "packages/alpha/e2e/browser.spec.ts": "export {};\n",
  "packages/alpha/test/db.integration.ts": "export {};\n",
  "packages/alpha/test/lock.contention.ts": "export {};\n",
  "scripts/demo/demo.test.ts": "export {};\n",
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("repository turbo cache graph", () => {
  test("covers every workspace unit test, root script test, and active formal check without drift", () => {
    const report = checkTurboCacheGraph(REPO_ROOT);

    expect(report.stats.workspacesChecked).toBeGreaterThan(0);
    expect(report.stats.workspaceTestFiles).toBeGreaterThan(0);
    expect(report.stats.rootScriptTestFiles).toBeGreaterThan(0);
    expect(report.stats.formalChecksChecked).toBeGreaterThan(0);
    expect(report.stats.formalCoveredFilesChecked).toBeGreaterThan(0);
    expect(report.issues, formatGuardReport(report)).toEqual([]);
  });
});

describe("helpers", () => {
  test("parseBunTestTargets handles flags, values, and positional paths", () => {
    expect(parseBunTestTargets("bun test --pass-with-no-tests")).toEqual({ kind: "all" });
    expect(
      parseBunTestTargets("bun test --cwd packages/core --timeout 5000 ./test/a.test.ts test/sub/"),
    ).toEqual({
      kind: "targets",
      cwd: "packages/core",
      targets: ["test/a.test.ts", "test/sub"],
    });
    expect(parseBunTestTargets("vitest run")).toMatchObject({ kind: "invalid" });
  });

  test("matchesTurboInputs respects $TURBO_DEFAULT$, negations, and $TURBO_ROOT$", () => {
    expect(
      matchesTurboInputs(
        "test/public/altcha.test.ts",
        ["test/public/**", "!test/public/altcha.test.ts"],
        {
          isRoot: false,
        },
      ),
    ).toBe(false);
    expect(
      matchesTurboInputs(
        "test/public/other.test.ts",
        ["test/public/**", "!test/public/altcha.test.ts"],
        {
          isRoot: false,
        },
      ),
    ).toBe(true);
    expect(
      matchesTurboInputs("packages/core/src/a.ts", ["$TURBO_ROOT$/packages/core/src/**"], {
        isRoot: true,
      }),
    ).toBe(true);
    expect(
      matchesTurboInputs("packages/core/src/a.ts", ["$TURBO_ROOT$/packages/core/src/**"], {
        isRoot: false,
      }),
    ).toBe(false);
  });
});

describe("drift detection on synthetic fixtures", () => {
  test("passes a clean fixture while ignoring e2e, integration, and contention suites", () => {
    const dir = makeTempRepo(baseFixture());
    const report = checkTurboCacheGraph(dir);
    expect(report.issues, formatGuardReport(report)).toEqual([]);
  });

  test("catches an uncovered unit test file in a workspace", () => {
    const files = baseFixture();
    files["packages/alpha/test/orphan.test.ts"] = "export {};\n";
    const dir = makeTempRepo(files);

    const result = checkWorkspaceTestCoverage(dir);
    expect(result.issues).toEqual([
      {
        scope: "workspace-tests",
        message:
          'packages/alpha: unit test "test/orphan.test.ts" is not covered by any task in test:suite (test:a, test:b)',
      },
    ]);
  });

  test("catches duplicate test coverage across two tasks in test:suite", () => {
    const files = baseFixture();
    files["packages/alpha/package.json"] = json({
      name: "@fixture/alpha",
      scripts: {
        "test:suite": ":",
        "test:a": "bun test test/a.test.ts test/sub/b.test.ts",
        "test:b": "bun test test/sub",
      },
    });
    files["packages/alpha/turbo.json"] = json({
      extends: ["//"],
      tasks: {
        "test:suite": { dependsOn: ["test:a", "test:b"], cache: false },
        "test:a": { inputs: ["package.json", "test/**"], outputs: [] },
        "test:b": { inputs: ["package.json", "test/sub/**"], outputs: [] },
      },
    });
    const dir = makeTempRepo(files);

    const result = checkWorkspaceTestCoverage(dir);
    expect(result.issues).toContainEqual({
      scope: "workspace-tests",
      message:
        'packages/alpha: unit test "test/sub/b.test.ts" is covered by multiple tasks in test:suite (test:a, test:b)',
    });
  });

  test("catches a test file executed by package.json but missing from turbo.json inputs", () => {
    const files = baseFixture();
    files["packages/alpha/turbo.json"] = json({
      extends: ["//"],
      tasks: {
        "test:suite": { dependsOn: ["test:a", "test:b"], cache: false },
        "test:a": { inputs: ["package.json", "src/**"], outputs: [] },
        "test:b": { inputs: ["package.json", "src/**", "test/sub/**"], outputs: [] },
      },
    });
    const dir = makeTempRepo(files);

    const result = checkWorkspaceTestCoverage(dir);
    expect(result.issues).toContainEqual({
      scope: "workspace-tests",
      message:
        'packages/alpha#test:a: executes "test/a.test.ts", which is not matched by its turbo.json inputs',
    });
  });

  test("catches an uncovered unit test under scripts/", () => {
    const files = baseFixture();
    files["scripts/other/unwired.test.ts"] = "export {};\n";
    const dir = makeTempRepo(files);

    const result = checkRootScriptTests(dir);
    expect(result.issues).toContainEqual({
      scope: "root-script-tests",
      message:
        'scripts unit test "scripts/other/unwired.test.ts" is not covered by any //#task in root package.json "test" script',
    });
  });

  test("catches missing TLC/replay checks, missing wide tasks, stale tasks, and missing digest inputs", () => {
    const files = baseFixture();
    files["formal/manifest.json"] = json({
      schemaVersion: 1,
      checks: [
        {
          id: "demo.model",
          kind: "tlc",
          spec: "formal/demo/Demo.tla",
          config: "formal/demo/Demo.cfg",
          wideConfig: "formal/demo/Demo_wide.cfg",
          mutants: [{ name: "m1", config: "formal/demo/Demo_mutant.cfg" }],
          coveredFiles: [{ path: "packages/alpha/src/core.ts" }],
        },
        {
          id: "new.model",
          kind: "tlc",
          spec: "formal/new/New.tla",
          config: "formal/new/New.cfg",
          wideConfig: "formal/new/New_wide.cfg",
          coveredFiles: [{ path: "packages/untracked/src/file.ts" }],
        },
        {
          id: "blocked.model",
          kind: "tlc",
          status: "blocked",
          spec: "formal/blocked/Blocked.tla",
          config: "formal/blocked/Blocked.cfg",
        },
      ],
    });
    const dir = makeTempRepo(files);

    const result = checkFormalManifestCoverage(dir);
    const messages = result.issues.map((issue) => issue.message);

    expect(messages).toContain(
      '//#formal:all: active tlc check "new.model" from formal/manifest.json is not wired in turbo.json',
    );
    expect(messages).toContain(
      '//#formal:wide: active tlc check "new.model" from formal/manifest.json is not wired in turbo.json',
    );
    expect(messages).toContain(
      '//#formal:all -> //#formal:replay:model: references "demo.replay", which is not an active tlc/replay check in formal/manifest.json',
    );
    expect(messages).toContain(
      '//#formal:digests: required input "packages/untracked/src/file.ts" is not matched by its turbo.json inputs',
    );
    expect(messages.some((message) => message.includes("blocked.model"))).toBe(false);
  });
});
