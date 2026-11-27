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

test("Git includes the net branch changes and untracked paths with their literal names", () =>
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
    yield* git("add", ".");
    yield* commit("Base");
    const { base } = yield* readChanges(root, "HEAD");
    yield* git("branch", "comparison");
    yield* write("committed.ts", "export {};\n");
    yield* git("add", "committed.ts");
    yield* commit("Branch change");
    yield* fs.rename(path.join(root, "old file.ts"), path.join(root, "nový file.ts"));
    yield* git("add", "-A");
    yield* write("modified.ts", "export const value = 2;\n");
    yield* write("untracked\nfile.ts", "export {};\n");
    yield* write("ignore.ts", "export {};\n");

    const changed = yield* readChanges(root, "comparison");
    expect(changed).toEqual({
      base,
      files: ["committed.ts", "modified.ts", "nový file.ts", "old file.ts", "untracked\nfile.ts"],
    });
    const invalid = yield* Effect.result(readChanges(root, "invalid-ref"));
    expect(Result.isFailure(invalid) && String(invalid.failure)).toContain("git merge-base");
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

test("nearby tests include colocated variants, mirrored tests, and directly changed tests", () => {
  expect(
    selectTests({
      changed: [
        "packages/core/src/engines/vat.ts",
        "scripts/run.ts",
        "scripts/standalone.test.ts",
        "apps/web/e2e/smoke.spec.ts",
      ],
      candidates: [
        "packages/core/src/engines/vat.browser.test.ts",
        "packages/core/test/engines/vat.property.test.ts",
        "packages/core/test/engines/vat.spec.ts",
        "packages/core/test/engines/vat-rounding.test.ts",
        "packages/core/test/engines/vat.other/unrelated.test.ts",
        "scripts/run.test.ts",
        "scripts/standalone.test.ts",
        "scripts/unrelated.test.ts",
        "apps/web/e2e/smoke.spec.ts",
      ],
    }),
  ).toEqual([
    "packages/core/src/engines/vat.browser.test.ts",
    "packages/core/test/engines/vat.property.test.ts",
    "packages/core/test/engines/vat.spec.ts",
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
    ["test", "./packages/core/test/deleted.test.ts"],
    ["run", "verify:formal", "--check-digests"],
  ]);
});

test("shared compiler inputs and workspace manifest changes typecheck the whole repo", () => {
  for (const file of ["tsconfig.effect.json", "apps/removed/package.json"]) {
    const plan = planChecks({
      files: [file],
      present: [],
      workspaces: [],
      tests: [],
      covered: new Set(),
    });
    expect(Arr.map(plan, (check) => check.args)).toEqual([
      ...(Str.endsWith("package.json")(file) ? [["run", "knip:check"]] : []),
      ["run", "turbo", "run", "typecheck"],
      ["run", "typecheck:scripts"],
      ["run", "typecheck:formal"],
    ]);
  }
});

test("a changed formal manifest checks digests, while documentation does not schedule code checks", () => {
  const input = { present: [], workspaces: [], tests: [], covered: new Set<string>() };
  expect(
    Arr.map(planChecks({ ...input, files: ["formal/manifest.json"] }), (check) => check.args),
  ).toEqual([
    ["run", "typecheck:formal"],
    ["run", "verify:formal", "--check-digests"],
  ]);
  expect(planChecks({ ...input, files: ["docs/notes.md"] })).toEqual([]);
});
