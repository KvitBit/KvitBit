import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { planChecks, readChanges, selectTests } from "./check-changed";

test("Git includes committed, staged, unstaged, and untracked changes with literal names", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-check-changed-" });
    const git = (...args: string[]) =>
      spawner
        .exitCode(
          ChildProcess.make("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root }),
        )
        .pipe(Effect.tap((code) => Effect.sync(() => expect(Number(code)).toBe(0))));
    const write = (file: string, contents: string) =>
      fs.writeFileString(path.join(root, file), contents);
    const commit = (message: string) =>
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message);
    yield* git("init");
    yield* write(".gitignore", "ignore.ts\n");
    yield* write("old file.ts", "export const value = 1;\n");
    yield* write("modified.ts", "export const value = 1;\n");
    yield* write("staged.ts", "export const value = 1;\n");
    yield* git("add", ".");
    yield* commit("Base");
    const { base } = yield* readChanges(root, "HEAD");
    yield* git("branch", "comparison");
    yield* write("committed.ts", "export {};\n");
    yield* git("add", "committed.ts");
    yield* commit("Branch change");
    yield* fs.rename(path.join(root, "old file.ts"), path.join(root, "nový file.ts"));
    yield* write("staged.ts", "export const value = 2;\n");
    yield* git("add", "-A");
    yield* write("staged.ts", "export const value = 1;\n");
    yield* write("modified.ts", "export const value = 2;\n");
    yield* write("untracked\nfile.ts", "export {};\n");
    yield* write("ignore.ts", "export {};\n");

    const changed = yield* readChanges(root, "comparison");
    expect(changed).toEqual({
      base,
      files: [
        "committed.ts",
        "modified.ts",
        "nový file.ts",
        "old file.ts",
        "staged.ts",
        "untracked\nfile.ts",
      ],
    });
    const invalid = yield* Effect.result(readChanges(root, "invalid-ref"));
    expect(Result.isFailure(invalid) && String(invalid.failure)).toContain("git merge-base");
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

test("nearby tests include colocated variants, mirrored tests, and directly changed tests", () => {
  expect(
    selectTests({
      changed: [
        "packages/core/src/engines/vat.ts",
        "packages/core/src/modules/documents/internal.ts",
        "scripts/run.ts",
        "scripts/release/mobile-release.ts",
        "scripts/standalone.test.ts",
        "apps/web/e2e/smoke.spec.ts",
      ],
      candidates: [
        "apps/mobile/release/mobile-release-cli.test.ts",
        "packages/core/src/engines/vat.browser.test.ts",
        "packages/core/test/engines/vat.property.test.ts",
        "packages/core/test/engines/vat.spec.ts",
        "packages/core/test/engines/vat-rounding.test.ts",
        "packages/core/test/engines/vat.other/unrelated.test.ts",
        "packages/core/test/modules/documents/records.test.ts",
        "packages/core/test/modules/other.test.ts",
        "scripts/run.test.ts",
        "scripts/standalone.test.ts",
        "scripts/unrelated.test.ts",
        "apps/web/e2e/smoke.spec.ts",
      ],
    }),
  ).toEqual([
    "apps/mobile/release/mobile-release-cli.test.ts",
    "packages/core/src/engines/vat.browser.test.ts",
    "packages/core/test/engines/vat-rounding.test.ts",
    "packages/core/test/engines/vat.property.test.ts",
    "packages/core/test/engines/vat.spec.ts",
    "packages/core/test/modules/documents/records.test.ts",
    "scripts/run.test.ts",
    "scripts/standalone.test.ts",
  ]);
});

test("the plan checks surviving files and includes deleted code in Knip, Turbo, and formal coverage", () => {
  const plan = planChecks({
    files: ["packages/core/src/deleted.ts", "packages/domain/src/new.ts"],
    present: ["packages/domain/src/new.ts"],
    workspaces: [
      { name: "@kvitbit/core", path: "packages/core" },
      { name: "@kvitbit/domain", path: "packages/domain" },
      { name: "@kvitbit/web", path: "apps/web" },
    ],
    tests: ["packages/core/test/deleted.test.ts"],
    covered: new Set(["packages/core/src/deleted.ts"]),
  });
  expect(Arr.map(plan, (check) => check.args)).toEqual([
    [
      "run",
      "biome",
      "format",
      "--error-on-warnings",
      "--no-errors-on-unmatched",
      "--",
      "packages/domain/src/new.ts",
    ],
    [
      "run",
      "biome",
      "check",
      "--formatter-enabled=false",
      "--error-on-warnings",
      "--no-errors-on-unmatched",
      "--",
      "packages/domain/src/new.ts",
    ],
    ["run", "knip:check"],
    [
      "run",
      "turbo",
      "run",
      "typecheck",
      "--filter=...@kvitbit/core",
      "--filter=...@kvitbit/domain",
    ],
    ["run", "typecheck:formal"],
    ["test", "./test/deleted.test.ts"],
    ["run", "verify:formal", "--check-digests"],
  ]);
  expect(plan).toContainEqual({
    name: "Nearby tests (packages/core)",
    args: ["test", "./test/deleted.test.ts"],
    cwd: "packages/core",
  });
});

test("shared compiler inputs and deleted workspace manifests typecheck the whole repo", () => {
  for (const file of ["tsconfig.effect.json", "apps/removed/package.json"]) {
    const plan = planChecks({
      files: [file],
      present: [],
      workspaces: [],
      tests: [],
      covered: new Set(),
    });
    expect(Arr.map(plan, (check) => check.args)).toEqual([
      ["run", "knip:check"],
      ["run", "turbo", "run", "typecheck"],
      ["run", "typecheck:scripts"],
      ["run", "typecheck:formal"],
    ]);
  }
});

test("a surviving workspace manifest scopes typecheck to its workspace and dependents", () => {
  const plan = planChecks({
    files: ["apps/web/package.json"],
    present: ["apps/web/package.json"],
    workspaces: [
      { name: "@kvitbit/web", path: "apps/web" },
      { name: "@kvitbit/mobile", path: "apps/mobile" },
    ],
    tests: [],
    covered: new Set(),
  });
  expect(plan).toContainEqual({ name: "Knip", args: ["run", "knip:check"] });
  expect(Arr.filter(plan, (check) => Str.includes("typecheck")(check.name))).toEqual([
    {
      name: "Workspace typechecks",
      args: ["run", "turbo", "run", "typecheck", "--filter=...@kvitbit/web"],
    },
  ]);
});

test("mobile release changes typecheck the scripts project and run tests from their workspace", () => {
  const plan = planChecks({
    files: ["apps/mobile/release/storage-layout.ts"],
    present: [],
    workspaces: [{ name: "@kvitbit/mobile", path: "apps/mobile" }],
    tests: ["apps/mobile/release/storage-layout.test.ts", "scripts/check-changed.test.ts"],
    covered: new Set(),
  });
  expect(plan).toContainEqual({ name: "Scripts typecheck", args: ["run", "typecheck:scripts"] });
  expect(plan).toContainEqual({
    name: "Nearby tests (apps/mobile)",
    args: ["test", "./release/storage-layout.test.ts"],
    cwd: "apps/mobile",
  });
  expect(plan).toContainEqual({
    name: "Nearby tests",
    args: ["test", "./scripts/check-changed.test.ts"],
    cwd: ".",
  });
});

test("a changed formal manifest checks digests, while documentation does not schedule code checks", () => {
  const input = { present: [], workspaces: [], tests: [], covered: new Set<string>() };
  expect(
    Arr.map(planChecks({ ...input, files: ["formal/manifest.json"] }), (check) => check.args),
  ).toEqual([
    ["run", "knip:check"],
    ["run", "typecheck:formal"],
    ["run", "verify:formal", "--check-digests"],
  ]);
  expect(planChecks({ ...input, files: ["docs/notes.md"] })).toEqual([]);
});

test("Knip checks changes to graph inputs referenced by its plugins", () => {
  const input = { present: [], workspaces: [], tests: [], covered: new Set<string>() };
  for (const file of [
    ".github/workflows/ci.yml",
    "apps/mobile/bunfig.toml",
    "apps/mobile/src/metadata.json",
    "packages/brand/.gitignore",
  ]) {
    const plan = planChecks({ ...input, files: [file] });
    expect(plan).toContainEqual({ name: "Knip", args: ["run", "knip:check"] });
  }
});

test("rule and tool configuration changes run the lint fixtures, including deleted rules", () => {
  const input = { present: [], workspaces: [], tests: [], covered: new Set<string>() };
  for (const file of ["biome.json", "packages/db/biome.json", "lint/removed.grit", "bun.lock"]) {
    const plan = planChecks({ ...input, files: [file] });
    expect(plan).toContainEqual({ name: "Lint rule fixtures", args: ["run", "test:lint-rules"] });
  }
  const plan = planChecks({
    ...input,
    files: ["biome.json", "lint/lint-rules.test.ts"],
    tests: ["lint/lint-rules.test.ts"],
  });
  expect(plan).toContainEqual({
    name: "Nearby tests",
    args: ["test", "./lint/lint-rules.test.ts"],
    cwd: ".",
  });
  expect(plan).not.toContainEqual({ name: "Lint rule fixtures", args: ["run", "test:lint-rules"] });
});
