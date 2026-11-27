import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

class CheckError extends Schema.TaggedError<CheckError, { readonly brand: unique symbol }>()(
  "CheckError",
  {
    message: Schema.String,
  },
) {}

const codeFile = /\.[cm]?[jt]sx?$/;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const workspacePath = /^(?:apps|infra|packages)\/[^/]+\//;
const workspaceManifest = /^(?:apps|infra|packages)\/[^/]+\/package\.json$/;
const sharedTypecheckInput = /^(?:package\.json|bun\.lock|tsconfig[^/]*\.json|turbo\.json)$/;
const knipInput = /(?:^|\/)package\.json$|\.sh$|^(?:knip\.jsonc?|bun\.lock)$/;
const formalManifest = "formal/manifest.json";
const formalDependencies = /^packages\/(?:api-contract|core|db|domain)\//;

const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      checks: Schema.Array(
        Schema.Struct({ coveredFiles: Schema.Array(Schema.Struct({ path: Schema.String })) }),
      ),
    }),
  ),
);

const Workspace = Schema.Struct({ name: Schema.String, path: Schema.String });
type Workspace = typeof Workspace.Type;
const decodeWorkspaces = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ packages: Schema.Struct({ items: Schema.Array(Workspace) }) }),
  ),
);

interface Check {
  readonly name: string;
  readonly args: readonly string[];
}

const readCommand = Effect.fn("CheckChanged.readCommand")(function* (
  root: string,
  executable: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(executable, args, { cwd: root }));
      return yield* Effect.all(
        {
          stdout: handle.stdout.pipe(Stream.decodeText, Stream.mkString),
          stderr: handle.stderr.pipe(Stream.decodeText, Stream.mkString),
          exitCode: handle.exitCode,
        },
        { concurrency: "unbounded" },
      );
    }),
  );

  if (result.exitCode !== 0) {
    return yield* CheckError.make({
      message: `${executable} ${Arr.join(args, " ")} exited with ${result.exitCode}\n${Str.trimEnd(result.stderr)}`,
    });
  }
  return result.stdout;
});

const splitPaths = (stdout: string) => Arr.filter(Str.split("\0")(stdout), Str.isNonEmpty);
const uniquePaths = (paths: Iterable<string>) => Arr.sort(Arr.dedupe(paths), Order.String);

export const readChanges = Effect.fn("CheckChanged.readChanges")(function* (
  root: string,
  ref: string,
) {
  const base = yield* readCommand(root, "git", ["merge-base", "--", "HEAD", ref]).pipe(
    Effect.map(Str.trim),
  );
  const [tracked, untracked] = yield* Effect.all(
    [
      readCommand(root, "git", ["diff", "--name-only", "--no-renames", "-z", base, "--"]),
      readCommand(root, "git", ["ls-files", "--others", "--exclude-standard", "-z"]),
    ],
    { concurrency: 2 },
  );
  return { base, files: uniquePaths([...splitPaths(tracked), ...splitPaths(untracked)]) };
});

const testPrefixesFor = (file: string) => {
  const stem = Str.replace(codeFile, "")(file);
  const [group, workspace, sourceTree, ...relative] = Str.split("/")(stem);
  if (workspace !== undefined && workspacePath.test(file) && sourceTree === "src") {
    const name = Arr.join(relative, "/");
    return [stem, `${group}/${workspace}/test/${name}`, `${group}/${workspace}/tests/${name}`];
  }
  return [stem];
};

export const selectTests = (input: {
  readonly changed: readonly string[];
  readonly candidates: readonly string[];
}) => {
  const { changed, candidates } = input;
  const prefixes = Fn.pipe(
    changed,
    Arr.filter((file) => codeFile.test(file)),
    Arr.flatMap(testPrefixesFor),
  );
  return uniquePaths(
    Arr.filter(candidates, (file) => {
      if (!testFile.test(file) || Str.startsWith("apps/web/e2e/")(file)) return false;
      if (changed.includes(file)) return true;
      const stem = Str.replace(testFile, "")(file);
      return Arr.some(
        prefixes,
        (prefix) =>
          stem === prefix ||
          (Str.startsWith(`${prefix}.`)(stem) && !Str.includes("/", prefix.length)(stem)),
      );
    }),
  );
};

const requiresAllTypechecks = (files: readonly string[]) =>
  Arr.some(files, (file) => sharedTypecheckInput.test(file) || workspaceManifest.test(file));

export const planChecks = (input: {
  readonly files: readonly string[];
  readonly present: readonly string[];
  readonly workspaces: readonly Workspace[] | undefined;
  readonly tests: readonly string[];
  readonly covered: ReadonlySet<string>;
}) => {
  const checks: Check[] = [];
  if (input.present.length > 0) {
    const files = ["--error-on-warnings", "--no-errors-on-unmatched", "--", ...input.present];
    checks.push(
      { name: "Biome format", args: ["run", "biome", "format", ...files] },
      {
        name: "Biome lint",
        args: ["run", "biome", "check", "--formatter-enabled=false", ...files],
      },
    );
  }
  if (Arr.some(input.files, (file) => codeFile.test(file) || knipInput.test(file))) {
    checks.push({ name: "Knip", args: ["run", "knip:check"] });
  }
  const allTypechecks = input.workspaces === undefined || requiresAllTypechecks(input.files);
  const filters = Fn.pipe(
    input.workspaces ?? [],
    Arr.filter(({ path }) => Arr.some(input.files, Str.startsWith(`${path}/`))),
    Arr.map((workspace) => `--filter=...${workspace.name}`),
    Arr.sort(Order.String),
  );
  if (allTypechecks || filters.length > 0) {
    checks.push({
      name: "Workspace typechecks",
      args: ["run", "turbo", "run", "typecheck", ...(allTypechecks ? [] : filters)],
    });
  }
  if (allTypechecks || Arr.some(input.files, Str.startsWith("scripts/"))) {
    checks.push({ name: "Scripts typecheck", args: ["run", "typecheck:scripts"] });
  }
  if (
    allTypechecks ||
    Arr.some(
      input.files,
      (file) => Str.startsWith("formal/")(file) || formalDependencies.test(file),
    )
  ) {
    checks.push({ name: "Formal typecheck", args: ["run", "typecheck:formal"] });
  }
  if (input.tests.length > 0) {
    checks.push({
      name: "Nearby tests",
      args: ["test", ...Arr.map(input.tests, (file) => `./${file}`)],
    });
  }
  if (Arr.some(input.files, (file) => file === formalManifest || input.covered.has(file))) {
    checks.push({ name: "Formal digests", args: ["run", "verify:formal", "--check-digests"] });
  }
  return checks;
};

const checkChanged = Effect.fn("CheckChanged.run")(function* (ref: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const { base, files } = yield* readChanges(root, ref);
  const comparison = `${Str.slice(0, 12)(base)} (${ref})`;
  if (files.length === 0) {
    yield* Console.log(`check:changed found no changes since ${comparison}.`);
    return;
  }
  yield* Console.log(`check:changed found ${files.length} changed paths since ${comparison}.`);
  const isFile = Effect.fn("CheckChanged.isFile")(function* (file: string) {
    const absolute = path.join(root, file);
    if (!(yield* fs.exists(absolute))) return false;
    return (yield* fs.stat(absolute)).type === "File";
  });
  const present = yield* Effect.filter(files, isFile);
  const workspaces =
    Arr.some(files, (file) => workspacePath.test(file)) && !requiresAllTypechecks(files)
      ? yield* readCommand(root, "bun", ["run", "turbo", "ls", "--output=json"]).pipe(
          Effect.flatMap(decodeWorkspaces),
          Effect.map(({ packages }) => packages.items),
          Effect.catch((error) =>
            Console.error("Could not list Turbo workspaces. Running all typechecks.", error).pipe(
              Effect.as(undefined),
            ),
          ),
        )
      : [];
  const tests = Arr.some(files, (file) => codeFile.test(file))
    ? yield* readCommand(root, "git", [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]).pipe(
        Effect.map((stdout) => selectTests({ changed: files, candidates: splitPaths(stdout) })),
        Effect.flatMap((candidates) => Effect.filter(candidates, isFile)),
      )
    : [];
  const covered = files.includes(formalManifest)
    ? new Set<string>()
    : yield* fs.readFileString(path.join(root, formalManifest)).pipe(
        Effect.flatMap(decodeManifest),
        Effect.map(
          ({ checks }) =>
            new Set(
              Arr.flatMap(checks, (check) => Arr.map(check.coveredFiles, (entry) => entry.path)),
            ),
        ),
      );
  const failed: string[] = [];
  for (const check of planChecks({ files, present, workspaces, tests, covered })) {
    yield* Console.log(`\n> ${check.name}`);
    const command = ChildProcess.make("bun", check.args, {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    const result = yield* Effect.result(spawner.exitCode(command));
    if (Result.isFailure(result)) {
      yield* Console.error(result.failure);
      failed.push(check.name);
    } else if (result.success !== 0) {
      failed.push(`${check.name} (${result.success})`);
    }
  }
  if (failed.length > 0) {
    return yield* CheckError.make({ message: `check:changed failed: ${Arr.join(failed, ", ")}` });
  }
});

if (import.meta.main) {
  const [ref = "origin/main", ...extra] = Bun.argv.slice(2);
  const program =
    extra.length > 0
      ? Effect.fail(CheckError.make({ message: "Usage: bun run check:changed [ref]" }))
      : ref === "--help" || ref === "-h"
        ? Console.log("Usage: bun run check:changed [ref]\nDefault ref: origin/main")
        : checkChanged(ref);
  BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
}
