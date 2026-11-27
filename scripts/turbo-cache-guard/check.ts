import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GuardIssue {
  readonly scope: "workspace-tests" | "root-script-tests" | "formal-manifest";
  readonly message: string;
}

export interface GuardReport {
  readonly issues: ReadonlyArray<GuardIssue>;
  readonly stats: {
    readonly workspacesChecked: number;
    readonly workspaceTestFiles: number;
    readonly rootScriptTestFiles: number;
    readonly formalChecksChecked: number;
    readonly formalCoveredFilesChecked: number;
  };
}

interface PackageJson {
  readonly name?: string;
  readonly workspaces?: ReadonlyArray<string> | { readonly packages?: ReadonlyArray<string> };
  readonly scripts?: Readonly<Record<string, string>>;
}

interface TurboTask {
  readonly dependsOn?: ReadonlyArray<string>;
  readonly inputs?: ReadonlyArray<string>;
}

interface TurboConfig {
  readonly tasks?: Readonly<Record<string, TurboTask>>;
}

interface FormalManifestMutant {
  readonly name: string;
  readonly config: string;
}

interface FormalManifestCoveredFile {
  readonly path: string;
}

interface FormalManifestCheck {
  readonly id: string;
  readonly kind: string;
  readonly status?: string;
  readonly spec?: string;
  readonly config?: string;
  readonly wideConfig?: string;
  readonly mutants?: ReadonlyArray<FormalManifestMutant>;
  readonly replay?: ReadonlyArray<string>;
  readonly coveredFiles?: ReadonlyArray<FormalManifestCoveredFile>;
}

interface FormalManifest {
  readonly checks: ReadonlyArray<FormalManifestCheck>;
}

export type ParsedBunTestTargets =
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "all"; readonly cwd?: string }
  | { readonly kind: "targets"; readonly targets: ReadonlyArray<string>; readonly cwd?: string };

interface ParsedFormalScript {
  readonly isFormalRunner: boolean;
  readonly selftest: boolean;
  readonly checkDigests: boolean;
  readonly wide: boolean;
  readonly only?: string;
}

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/;
const IGNORED_SEGMENT_PATTERN = /(^|\/)(node_modules|dist|\.turbo|\.expo|\.cache)(\/|$)/;
const EXCLUDED_UNIT_FILE_PATTERN = /\.(integration|contention)\./;

const BUN_TEST_FLAGS_WITH_VALUE = new Set([
  "--cwd",
  "--preload",
  "--timeout",
  "--bail",
  "--concurrency",
  "--max-concurrency",
  "-t",
  "--test-name-pattern",
  "--rerun-each",
  "--seed",
  "--reporter",
  "--reporter-outfile",
  "--coverage-dir",
  "--coverage-reporter",
  "--coverage-threshold",
]);

const normalizeRelPath = (value: string): string =>
  value
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");

const readJsonFile = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, "utf8")) as T;

const readOptionalJsonFile = <T>(filePath: string): T | undefined =>
  existsSync(filePath) ? readJsonFile<T>(filePath) : undefined;

const tokenizeCommand = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === undefined) continue;

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
};

export const parseBunTestTargets = (script: string): ParsedBunTestTargets => {
  const tokens = tokenizeCommand(script);
  if (tokens[0] !== "bun" || tokens[1] !== "test") {
    return { kind: "invalid", reason: `expected "bun test ...", got "${script}"` };
  }

  let cwd: string | undefined;
  const targets: Array<string> = [];

  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (token === "--") {
      for (let j = i + 1; j < tokens.length; j += 1) {
        const rest = tokens[j];
        if (rest !== undefined) targets.push(normalizeRelPath(rest));
      }
      break;
    }

    if (token.startsWith("--cwd=")) {
      cwd = normalizeRelPath(token.slice("--cwd=".length));
      continue;
    }

    if (token === "--cwd") {
      const next = tokens[i + 1];
      if (next !== undefined) {
        cwd = normalizeRelPath(next);
        i += 1;
      }
      continue;
    }

    if (token.startsWith("-")) {
      if (!token.includes("=") && BUN_TEST_FLAGS_WITH_VALUE.has(token)) {
        i += 1;
      }
      continue;
    }

    targets.push(normalizeRelPath(token));
  }

  if (targets.length === 0) {
    return cwd !== undefined ? { kind: "all", cwd } : { kind: "all" };
  }

  return cwd !== undefined ? { kind: "targets", targets, cwd } : { kind: "targets", targets };
};

const matchSingleGlob = (relPath: string, rawPattern: string): boolean => {
  const pattern = normalizeRelPath(rawPattern);
  if (pattern === relPath) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return new Bun.Glob(pattern).match(relPath);
};

export const matchesTurboInputs = (
  relPath: string,
  inputs: ReadonlyArray<string> | undefined,
  options: { readonly isRoot: boolean },
): boolean => {
  if (inputs === undefined) return true;

  const normalized = normalizeRelPath(relPath);
  let matched = false;

  for (const rawEntry of inputs) {
    if (rawEntry === "$TURBO_DEFAULT$") {
      matched = true;
      continue;
    }

    const negated = rawEntry.startsWith("!");
    const body = negated ? rawEntry.slice(1) : rawEntry;

    let pattern = body;
    if (body.startsWith("$TURBO_ROOT$/")) {
      if (!options.isRoot) continue;
      pattern = body.slice("$TURBO_ROOT$/".length);
    }

    if (matchSingleGlob(normalized, pattern)) {
      matched = !negated;
    }
  }

  return matched;
};

const discoverUnitTestFiles = (
  dirAbs: string,
  options: { readonly excludeTopLevelE2e: boolean },
): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const glob = new Bun.Glob("**/*");

  for (const rawPath of glob.scanSync({ cwd: dirAbs, onlyFiles: true })) {
    const relPath = normalizeRelPath(rawPath);
    if (IGNORED_SEGMENT_PATTERN.test(relPath)) continue;
    if (!TEST_FILE_PATTERN.test(relPath)) continue;
    if (EXCLUDED_UNIT_FILE_PATTERN.test(relPath)) continue;
    if (options.excludeTopLevelE2e && relPath.startsWith("e2e/")) continue;
    found.push(relPath);
  }

  return found.sort();
};

const getWorkspacePatterns = (rootPkg: PackageJson): ReadonlyArray<string> => {
  const { workspaces } = rootPkg;
  if (workspaces === undefined) return [];
  if (Array.isArray(workspaces)) return workspaces;
  return "packages" in workspaces && Array.isArray(workspaces.packages) ? workspaces.packages : [];
};

const discoverWorkspaces = (rootAbs: string, rootPkg: PackageJson): ReadonlyArray<string> => {
  const workspaces = new Set<string>();

  for (const rawPattern of getWorkspacePatterns(rootPkg)) {
    const pattern = normalizeRelPath(rawPattern);
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const pkgPath of glob.scanSync({ cwd: rootAbs, onlyFiles: true })) {
      const normalizedPkg = normalizeRelPath(pkgPath);
      if (IGNORED_SEGMENT_PATTERN.test(normalizedPkg)) continue;
      workspaces.add(normalizeRelPath(dirname(normalizedPkg)));
    }
  }

  return [...workspaces].sort();
};

const targetMatchesFile = (relPath: string, target: string): boolean =>
  relPath === target || relPath.startsWith(`${target}/`);

export const checkWorkspaceTestCoverage = (
  root: string,
): {
  readonly issues: ReadonlyArray<GuardIssue>;
  readonly workspacesChecked: number;
  readonly workspaceTestFiles: number;
} => {
  const rootAbs = resolve(root);
  const rootPkg = readJsonFile<PackageJson>(join(rootAbs, "package.json"));
  const rootTurbo = readJsonFile<TurboConfig>(join(rootAbs, "turbo.json"));
  const rootTasks = rootTurbo.tasks ?? {};
  const workspaces = discoverWorkspaces(rootAbs, rootPkg);

  const issues: Array<GuardIssue> = [];
  let workspaceTestFiles = 0;

  for (const wsRel of workspaces) {
    const wsAbs = join(rootAbs, wsRel);
    const wsPkg = readJsonFile<PackageJson>(join(wsAbs, "package.json"));
    const wsTurbo = readOptionalJsonFile<TurboConfig>(join(wsAbs, "turbo.json"));
    const wsTasks = wsTurbo?.tasks ?? {};

    const testFiles = discoverUnitTestFiles(wsAbs, { excludeTopLevelE2e: true });
    workspaceTestFiles += testFiles.length;

    const suiteTask = wsTasks["test:suite"] ?? rootTasks["test:suite"];
    const dependsOn = suiteTask?.dependsOn ?? [];

    if (dependsOn.length === 0) {
      if (testFiles.length > 0) {
        issues.push({
          scope: "workspace-tests",
          message: `${wsRel}: has ${testFiles.length} unit test file(s) but test:suite has no dependsOn tasks`,
        });
      }
      continue;
    }

    const fileOwners = new Map<string, Array<string>>();

    for (const dep of dependsOn) {
      if (dep.startsWith("^") || dep.startsWith("//#")) continue;

      const script = wsPkg.scripts?.[dep];
      if (script === undefined) {
        issues.push({
          scope: "workspace-tests",
          message: `${wsRel}: test:suite depends on "${dep}", but ${wsRel}/package.json has no "${dep}" script`,
        });
        continue;
      }

      const parsed = parseBunTestTargets(script);
      if (parsed.kind === "invalid") {
        issues.push({
          scope: "workspace-tests",
          message: `${wsRel}#${dep}: ${parsed.reason}`,
        });
        continue;
      }

      const taskDef = wsTasks[dep] ?? rootTasks[dep];
      if (taskDef === undefined) {
        issues.push({
          scope: "workspace-tests",
          message: `${wsRel}#${dep}: task is listed in test:suite.dependsOn but missing from ${wsRel}/turbo.json and root turbo.json`,
        });
      }

      const matchedInTask = new Set<string>();

      if (parsed.kind === "all") {
        const prefix = parsed.cwd !== undefined ? normalizeRelPath(parsed.cwd) : undefined;
        for (const file of testFiles) {
          if (prefix === undefined || targetMatchesFile(file, prefix)) {
            matchedInTask.add(file);
          }
        }
      } else {
        for (const rawTarget of parsed.targets) {
          const target =
            parsed.cwd !== undefined
              ? normalizeRelPath(`${parsed.cwd}/${rawTarget}`)
              : normalizeRelPath(rawTarget);

          if (!existsSync(join(wsAbs, target))) {
            issues.push({
              scope: "workspace-tests",
              message: `${wsRel}#${dep}: test target "${target}" does not exist`,
            });
            continue;
          }

          let targetMatchedAny = false;
          for (const file of testFiles) {
            if (!targetMatchesFile(file, target)) continue;
            targetMatchedAny = true;
            if (matchedInTask.has(file)) {
              issues.push({
                scope: "workspace-tests",
                message: `${wsRel}#${dep}: test file "${file}" is matched more than once in the same script`,
              });
            }
            matchedInTask.add(file);
          }

          if (!targetMatchedAny) {
            issues.push({
              scope: "workspace-tests",
              message: `${wsRel}#${dep}: target "${target}" matches no unit test files`,
            });
          }
        }
      }

      for (const file of matchedInTask) {
        const owners = fileOwners.get(file) ?? [];
        owners.push(dep);
        fileOwners.set(file, owners);

        if (taskDef !== undefined && !matchesTurboInputs(file, taskDef.inputs, { isRoot: false })) {
          issues.push({
            scope: "workspace-tests",
            message: `${wsRel}#${dep}: executes "${file}", which is not matched by its turbo.json inputs`,
          });
        }
      }
    }

    for (const file of testFiles) {
      const owners = fileOwners.get(file) ?? [];
      if (owners.length === 0) {
        issues.push({
          scope: "workspace-tests",
          message: `${wsRel}: unit test "${file}" is not covered by any task in test:suite (${dependsOn.join(", ")})`,
        });
      } else if (owners.length > 1) {
        issues.push({
          scope: "workspace-tests",
          message: `${wsRel}: unit test "${file}" is covered by multiple tasks in test:suite (${owners.join(", ")})`,
        });
      }
    }
  }

  return {
    issues,
    workspacesChecked: workspaces.length,
    workspaceTestFiles,
  };
};

export const checkRootScriptTests = (
  root: string,
): {
  readonly issues: ReadonlyArray<GuardIssue>;
  readonly rootScriptTestFiles: number;
} => {
  const rootAbs = resolve(root);
  const rootPkg = readJsonFile<PackageJson>(join(rootAbs, "package.json"));
  const rootTurbo = readJsonFile<TurboConfig>(join(rootAbs, "turbo.json"));
  const rootTasks = rootTurbo.tasks ?? {};
  const scriptsDirAbs = join(rootAbs, "scripts");

  const testFiles = existsSync(scriptsDirAbs)
    ? discoverUnitTestFiles(scriptsDirAbs, { excludeTopLevelE2e: false }).map(
        (rel) => `scripts/${rel}`,
      )
    : [];

  const issues: Array<GuardIssue> = [];
  const rootTestScript = rootPkg.scripts?.test ?? "";
  const rootTaskRefs = tokenizeCommand(rootTestScript).filter((token) => token.startsWith("//#"));

  const fileOwners = new Map<string, Array<string>>();

  for (const taskKey of rootTaskRefs) {
    const scriptName = taskKey.slice(3);
    const script = rootPkg.scripts?.[scriptName];
    if (script === undefined) {
      issues.push({
        scope: "root-script-tests",
        message: `root test script references "${taskKey}", but root package.json has no "${scriptName}" script`,
      });
      continue;
    }

    const taskDef = rootTasks[taskKey];
    if (taskDef === undefined) {
      issues.push({
        scope: "root-script-tests",
        message: `root test script references "${taskKey}", but root turbo.json has no "${taskKey}" task`,
      });
    }

    const parsed = parseBunTestTargets(script);
    if (parsed.kind === "invalid") {
      issues.push({
        scope: "root-script-tests",
        message: `${taskKey}: ${parsed.reason}`,
      });
      continue;
    }

    const matchedInTask = new Set<string>();
    if (parsed.kind === "all") {
      const prefix = parsed.cwd !== undefined ? normalizeRelPath(parsed.cwd) : undefined;
      for (const file of testFiles) {
        if (prefix === undefined || targetMatchesFile(file, prefix)) {
          matchedInTask.add(file);
        }
      }
    } else {
      for (const rawTarget of parsed.targets) {
        const target =
          parsed.cwd !== undefined
            ? normalizeRelPath(`${parsed.cwd}/${rawTarget}`)
            : normalizeRelPath(rawTarget);

        if (!existsSync(join(rootAbs, target))) {
          issues.push({
            scope: "root-script-tests",
            message: `${taskKey}: test target "${target}" does not exist`,
          });
          continue;
        }

        let targetMatchedAny = false;
        for (const file of testFiles) {
          if (!targetMatchesFile(file, target)) continue;
          targetMatchedAny = true;
          matchedInTask.add(file);
        }

        if (!targetMatchedAny) {
          issues.push({
            scope: "root-script-tests",
            message: `${taskKey}: target "${target}" matches no unit test files under scripts/`,
          });
        }
      }
    }

    for (const file of matchedInTask) {
      const owners = fileOwners.get(file) ?? [];
      owners.push(taskKey);
      fileOwners.set(file, owners);

      if (taskDef !== undefined && !matchesTurboInputs(file, taskDef.inputs, { isRoot: true })) {
        issues.push({
          scope: "root-script-tests",
          message: `${taskKey}: executes "${file}", which is not matched by its turbo.json inputs`,
        });
      }
    }
  }

  for (const file of testFiles) {
    const owners = fileOwners.get(file) ?? [];
    if (owners.length === 0) {
      issues.push({
        scope: "root-script-tests",
        message: `scripts unit test "${file}" is not covered by any //#task in root package.json "test" script`,
      });
    } else if (owners.length > 1) {
      issues.push({
        scope: "root-script-tests",
        message: `scripts unit test "${file}" is covered by multiple tasks in root package.json "test" script (${owners.join(", ")})`,
      });
    }
  }

  return {
    issues,
    rootScriptTestFiles: testFiles.length,
  };
};

const parseFormalScript = (script: string): ParsedFormalScript => {
  const tokens = tokenizeCommand(script);
  const isFormalRunner =
    tokens[0] === "bun" && normalizeRelPath(tokens[1] ?? "") === "formal/run-formal.ts";

  let selftest = false;
  let checkDigests = false;
  let wide = false;
  let only: string | undefined;

  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--selftest") selftest = true;
    else if (token === "--check-digests") checkDigests = true;
    else if (token === "--wide") wide = true;
    else if (token === "--only") {
      const next = tokens[i + 1];
      if (next !== undefined) {
        only = next;
        i += 1;
      }
    } else if (token?.startsWith("--only=")) {
      only = token.slice("--only=".length);
    }
  }

  return only !== undefined
    ? { isFormalRunner, selftest, checkDigests, wide, only }
    : { isFormalRunner, selftest, checkDigests, wide };
};

interface WiredFormalTask {
  readonly taskKey: string;
  readonly taskDef: TurboTask;
  readonly parsed: ParsedFormalScript;
}

const collectFormalAggregate = (
  aggregateKey: string,
  rootTasks: Readonly<Record<string, TurboTask>>,
  rootScripts: Readonly<Record<string, string>>,
  issues: Array<GuardIssue>,
): {
  readonly byOnlyId: ReadonlyMap<string, WiredFormalTask>;
  readonly hasSelftest: boolean;
  readonly digestsTask?: TurboTask;
} => {
  const aggregate = rootTasks[aggregateKey];
  const byOnlyId = new Map<string, WiredFormalTask>();
  let hasSelftest = false;
  let digestsTask: TurboTask | undefined;

  if (aggregate === undefined) {
    issues.push({
      scope: "formal-manifest",
      message: `root turbo.json is missing required formal aggregate task "${aggregateKey}"`,
    });
    return { byOnlyId, hasSelftest };
  }

  for (const dep of aggregate.dependsOn ?? []) {
    if (!dep.startsWith("//#")) {
      issues.push({
        scope: "formal-manifest",
        message: `${aggregateKey}: expected root task dependency starting with "//#", got "${dep}"`,
      });
      continue;
    }

    const taskDef = rootTasks[dep];
    if (taskDef === undefined) {
      issues.push({
        scope: "formal-manifest",
        message: `${aggregateKey}: depends on "${dep}", which is missing from root turbo.json`,
      });
      continue;
    }

    const scriptName = dep.slice(3);
    const script = rootScripts[scriptName];
    if (script === undefined) {
      issues.push({
        scope: "formal-manifest",
        message: `${aggregateKey}: depends on "${dep}", but root package.json has no "${scriptName}" script`,
      });
      continue;
    }

    const parsed = parseFormalScript(script);
    if (!parsed.isFormalRunner) {
      issues.push({
        scope: "formal-manifest",
        message: `${aggregateKey} -> ${dep}: expected "bun formal/run-formal.ts ...", got "${script}"`,
      });
      continue;
    }

    if (parsed.selftest) hasSelftest = true;
    if (parsed.checkDigests) digestsTask = taskDef;

    if (parsed.only !== undefined) {
      const existing = byOnlyId.get(parsed.only);
      if (existing !== undefined) {
        issues.push({
          scope: "formal-manifest",
          message: `${aggregateKey}: formal check "${parsed.only}" is wired more than once (${existing.taskKey}, ${dep})`,
        });
      } else {
        byOnlyId.set(parsed.only, { taskKey: dep, taskDef, parsed });
      }
    }
  }

  if (!hasSelftest) {
    issues.push({
      scope: "formal-manifest",
      message: `${aggregateKey}: must depend on a --selftest formal task`,
    });
  }
  if (digestsTask === undefined) {
    issues.push({
      scope: "formal-manifest",
      message: `${aggregateKey}: must depend on a --check-digests formal task`,
    });
  }

  return digestsTask !== undefined
    ? { byOnlyId, hasSelftest, digestsTask }
    : { byOnlyId, hasSelftest };
};

const verifyFormalTaskInputs = (
  taskKey: string,
  taskDef: TurboTask,
  requiredPaths: ReadonlyArray<string>,
  issues: Array<GuardIssue>,
): void => {
  for (const requiredPath of requiredPaths) {
    if (!matchesTurboInputs(requiredPath, taskDef.inputs, { isRoot: true })) {
      issues.push({
        scope: "formal-manifest",
        message: `${taskKey}: required input "${requiredPath}" is not matched by its turbo.json inputs`,
      });
    }
  }
};

export const checkFormalManifestCoverage = (
  root: string,
): {
  readonly issues: ReadonlyArray<GuardIssue>;
  readonly formalChecksChecked: number;
  readonly formalCoveredFilesChecked: number;
} => {
  const rootAbs = resolve(root);
  const rootPkg = readJsonFile<PackageJson>(join(rootAbs, "package.json"));
  const rootTurbo = readJsonFile<TurboConfig>(join(rootAbs, "turbo.json"));
  const manifest = readJsonFile<FormalManifest>(join(rootAbs, "formal/manifest.json"));

  const rootTasks = rootTurbo.tasks ?? {};
  const rootScripts = rootPkg.scripts ?? {};
  const issues: Array<GuardIssue> = [];

  const allAggregate = collectFormalAggregate("//#formal:all", rootTasks, rootScripts, issues);
  const wideAggregate = collectFormalAggregate("//#formal:wide", rootTasks, rootScripts, issues);

  const activeFormalRunnerIds = new Set<string>();
  const allCoveredFiles = new Set<string>();

  for (const check of manifest.checks) {
    for (const covered of check.coveredFiles ?? []) {
      allCoveredFiles.add(normalizeRelPath(covered.path));
    }

    if (check.status === "blocked") continue;
    if (check.kind !== "tlc" && check.kind !== "replay") continue;

    activeFormalRunnerIds.add(check.id);

    const allWired = allAggregate.byOnlyId.get(check.id);
    if (allWired === undefined) {
      issues.push({
        scope: "formal-manifest",
        message: `//#formal:all: active ${check.kind} check "${check.id}" from formal/manifest.json is not wired in turbo.json`,
      });
    } else {
      if (allWired.parsed.wide) {
        issues.push({
          scope: "formal-manifest",
          message: `//#formal:all -> ${allWired.taskKey}: check "${check.id}" should not pass --wide in //#formal:all`,
        });
      }
      const requiredInputs: Array<string> = ["formal/run-formal.ts", "formal/manifest.json"];
      if (check.kind === "tlc") {
        if (check.spec !== undefined) requiredInputs.push(check.spec);
        if (check.config !== undefined) requiredInputs.push(check.config);
        for (const mutant of check.mutants ?? []) {
          requiredInputs.push(mutant.config);
        }
      } else if (check.kind === "replay") {
        for (const replayPath of check.replay ?? []) {
          requiredInputs.push(replayPath);
        }
      }
      verifyFormalTaskInputs(allWired.taskKey, allWired.taskDef, requiredInputs, issues);
    }

    const wideWired = wideAggregate.byOnlyId.get(check.id);
    const expectsWide = check.kind === "tlc" && check.wideConfig !== undefined;
    if (wideWired === undefined) {
      issues.push({
        scope: "formal-manifest",
        message: `//#formal:wide: active ${check.kind} check "${check.id}" from formal/manifest.json is not wired in turbo.json`,
      });
    } else {
      if (expectsWide && !wideWired.parsed.wide) {
        issues.push({
          scope: "formal-manifest",
          message: `//#formal:wide -> ${wideWired.taskKey}: check "${check.id}" has wideConfig in formal/manifest.json and must run with --wide`,
        });
      }
      if (!expectsWide && wideWired.parsed.wide) {
        issues.push({
          scope: "formal-manifest",
          message: `//#formal:wide -> ${wideWired.taskKey}: check "${check.id}" has no wideConfig in formal/manifest.json and must not pass --wide`,
        });
      }
      const requiredInputs: Array<string> = ["formal/run-formal.ts", "formal/manifest.json"];
      if (check.kind === "tlc") {
        if (check.spec !== undefined) requiredInputs.push(check.spec);
        const cfg = expectsWide ? check.wideConfig : check.config;
        if (cfg !== undefined) requiredInputs.push(cfg);
        for (const mutant of check.mutants ?? []) {
          requiredInputs.push(mutant.config);
        }
      } else if (check.kind === "replay") {
        for (const replayPath of check.replay ?? []) {
          requiredInputs.push(replayPath);
        }
      }
      verifyFormalTaskInputs(wideWired.taskKey, wideWired.taskDef, requiredInputs, issues);
    }
  }

  for (const [id, wired] of allAggregate.byOnlyId) {
    if (!activeFormalRunnerIds.has(id)) {
      issues.push({
        scope: "formal-manifest",
        message: `//#formal:all -> ${wired.taskKey}: references "${id}", which is not an active tlc/replay check in formal/manifest.json`,
      });
    }
  }

  for (const [id, wired] of wideAggregate.byOnlyId) {
    if (!activeFormalRunnerIds.has(id)) {
      issues.push({
        scope: "formal-manifest",
        message: `//#formal:wide -> ${wired.taskKey}: references "${id}", which is not an active tlc/replay check in formal/manifest.json`,
      });
    }
  }

  const digestsTask = allAggregate.digestsTask ?? rootTasks["//#formal:digests"];
  if (digestsTask !== undefined) {
    verifyFormalTaskInputs(
      "//#formal:digests",
      digestsTask,
      ["formal/run-formal.ts", "formal/manifest.json", ...[...allCoveredFiles].sort()],
      issues,
    );
  }

  return {
    issues,
    formalChecksChecked: activeFormalRunnerIds.size,
    formalCoveredFilesChecked: allCoveredFiles.size,
  };
};

export const checkTurboCacheGraph = (root: string): GuardReport => {
  const workspaceResult = checkWorkspaceTestCoverage(root);
  const rootScriptsResult = checkRootScriptTests(root);
  const formalResult = checkFormalManifestCoverage(root);

  return {
    issues: [...workspaceResult.issues, ...rootScriptsResult.issues, ...formalResult.issues],
    stats: {
      workspacesChecked: workspaceResult.workspacesChecked,
      workspaceTestFiles: workspaceResult.workspaceTestFiles,
      rootScriptTestFiles: rootScriptsResult.rootScriptTestFiles,
      formalChecksChecked: formalResult.formalChecksChecked,
      formalCoveredFilesChecked: formalResult.formalCoveredFilesChecked,
    },
  };
};

export const formatGuardReport = (report: GuardReport): string => {
  if (report.issues.length === 0) {
    return "Turbo cache graph verified with zero drift issues.";
  }
  const lines = report.issues.map((issue) => `- [${issue.scope}] ${issue.message}`);
  return `Turbo cache graph drift detected:\n${lines.join("\n")}`;
};
