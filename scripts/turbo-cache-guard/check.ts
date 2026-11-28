import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const normalizeRelPathPattern = /\/+$/;
const normalizeRelPathPattern2 = /^(\.\/)+/;
const tokenizeCommandPattern = /\s/;

interface GuardIssue {
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

const PackageJsonSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  workspaces: Schema.optionalKey(
    Schema.Union([
      Schema.Array(Schema.String),
      Schema.Struct({ packages: Fn.pipe(Schema.Array(Schema.String), Schema.optionalKey) }),
    ]),
  ),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const TurboTaskSchema = Schema.Struct({
  dependsOn: Fn.pipe(Schema.Array(Schema.String), Schema.optionalKey),
  inputs: Fn.pipe(Schema.Array(Schema.String), Schema.optionalKey),
});

const TurboConfigSchema = Schema.Struct({
  tasks: Schema.optionalKey(Schema.Record(Schema.String, TurboTaskSchema)),
});

const FormalManifestCheckSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  status: Schema.optionalKey(Schema.String),
  spec: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.String),
  wideConfig: Schema.optionalKey(Schema.String),
  mutants: Fn.pipe(
    Schema.Array(Schema.Struct({ name: Schema.String, config: Schema.String })),
    Schema.optionalKey,
  ),
  replay: Fn.pipe(Schema.Array(Schema.String), Schema.optionalKey),
  coveredFiles: Fn.pipe(Schema.Array(Schema.Struct({ path: Schema.String })), Schema.optionalKey),
});

const FormalManifestSchema = Schema.Struct({ checks: Schema.Array(FormalManifestCheckSchema) });

type PackageJson = typeof PackageJsonSchema.Type;
type TurboTask = typeof TurboTaskSchema.Type;

const decodePackageJson = Schema.decodeUnknownResult(Schema.fromJsonString(PackageJsonSchema));
const decodeTurboConfig = Schema.decodeUnknownResult(Schema.fromJsonString(TurboConfigSchema));
const decodeFormalManifest = Schema.decodeUnknownResult(
  Schema.fromJsonString(FormalManifestSchema),
);

type ParsedBunTestTargets =
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
  Str.replace(
    normalizeRelPathPattern,
    "",
  )(Str.replace(normalizeRelPathPattern2, "")(Str.replaceAll("\\", "/")(value)));

const readJsonFile = Effect.fn("CacheGuard.readJsonFile")(function* <T>({
  filePath,
  decode,
}: {
  readonly filePath: string;
  readonly decode: (text: string) => Result.Result<T, Schema.SchemaError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.map((text) => Result.getOrThrow(decode(text))));
});

const readOptionalTurboConfig = Effect.fn("CacheGuard.readOptionalTurboConfig")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(filePath);
  return exists ? yield* readJsonFile({ filePath, decode: decodeTurboConfig }) : undefined;
});

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

    if (tokenizeCommandPattern.test(ch)) {
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

    if (Str.startsWith("--cwd=")(token)) {
      cwd = normalizeRelPath(Str.slice("--cwd=".length)(token));
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

    if (Str.startsWith("-")(token)) {
      if (!Str.includes("=")(token) && BUN_TEST_FLAGS_WITH_VALUE.has(token)) {
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
  if (Str.endsWith("/**")(pattern)) {
    const prefix = Str.slice(0, -3)(pattern);
    if (relPath === prefix || Str.startsWith(`${prefix}/`)(relPath)) {
      return true;
    }
  }
  return new Bun.Glob(pattern).match(relPath);
};

const matchesTurboInputsImpl = (
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

    const negated = Str.startsWith("!")(rawEntry);
    const body = negated ? Str.slice(1)(rawEntry) : rawEntry;

    let pattern = body;
    if (Str.startsWith("$TURBO_ROOT$/")(body)) {
      if (!options.isRoot) continue;
      pattern = Str.slice("$TURBO_ROOT$/".length)(body);
    }

    if (matchSingleGlob(normalized, pattern)) {
      matched = !negated;
    }
  }

  return matched;
};

export const matchesTurboInputs: {
  (
    inputs: ReadonlyArray<string> | undefined,
    options: { readonly isRoot: boolean },
  ): (relPath: string) => boolean;
  (
    relPath: string,
    inputs: ReadonlyArray<string> | undefined,
    options: { readonly isRoot: boolean },
  ): boolean;
} = Fn.dual(3, matchesTurboInputsImpl);

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
    if (options.excludeTopLevelE2e && Str.startsWith("e2e/")(relPath)) continue;
    found.push(relPath);
  }

  return found.sort(Order.String);
};

const getWorkspacePatterns = (rootPkg: PackageJson): ReadonlyArray<string> => {
  const { workspaces } = rootPkg;
  if (workspaces === undefined) return [];
  if (Arr.isArray(workspaces)) return Arr.filter(workspaces, Predicate.isString);
  return "packages" in workspaces && Arr.isArray(workspaces.packages) ? workspaces.packages : [];
};

const discoverWorkspaces = (
  rootAbs: string,
  rootPkg: PackageJson,
  path: Path.Path,
): ReadonlyArray<string> => {
  const workspaces = new Set<string>();

  for (const rawPattern of getWorkspacePatterns(rootPkg)) {
    const pattern = normalizeRelPath(rawPattern);
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const pkgPath of glob.scanSync({ cwd: rootAbs, onlyFiles: true })) {
      const normalizedPkg = normalizeRelPath(pkgPath);
      if (IGNORED_SEGMENT_PATTERN.test(normalizedPkg)) continue;
      workspaces.add(normalizeRelPath(path.dirname(normalizedPkg)));
    }
  }

  return [...workspaces].sort(Order.String);
};

const targetMatchesFile = (relPath: string, target: string): boolean =>
  relPath === target || Str.startsWith(`${target}/`)(relPath);

export const checkWorkspaceTestCoverage = Effect.fn("CacheGuard.checkWorkspaceTestCoverage")(
  function* (root: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const rootAbs = path.resolve(root);
    const rootPkg = yield* readJsonFile({
      filePath: path.join(rootAbs, "package.json"),
      decode: decodePackageJson,
    });
    const rootTurbo = yield* readJsonFile({
      filePath: path.join(rootAbs, "turbo.json"),
      decode: decodeTurboConfig,
    });
    const rootTasks = rootTurbo.tasks ?? {};
    const workspaces = discoverWorkspaces(rootAbs, rootPkg, path);

    const issues: Array<GuardIssue> = [];
    let workspaceTestFiles = 0;

    for (const wsRel of workspaces) {
      const wsAbs = path.join(rootAbs, wsRel);
      const wsPkg = yield* readJsonFile({
        filePath: path.join(wsAbs, "package.json"),
        decode: decodePackageJson,
      });
      const wsTurbo = yield* readOptionalTurboConfig(path.join(wsAbs, "turbo.json"));
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
        if (Str.startsWith("^")(dep) || Str.startsWith("//#")(dep)) continue;

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

            if (!(yield* fs.exists(path.join(wsAbs, target)))) {
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

          if (
            taskDef !== undefined &&
            !matchesTurboInputs(file, taskDef.inputs, { isRoot: false })
          ) {
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
            message: `${wsRel}: unit test "${file}" is not covered by any task in test:suite (${Arr.join(dependsOn, ", ")})`,
          });
        } else if (owners.length > 1) {
          issues.push({
            scope: "workspace-tests",
            message: `${wsRel}: unit test "${file}" is covered by multiple tasks in test:suite (${Arr.join(owners, ", ")})`,
          });
        }
      }
    }

    return {
      issues,
      workspacesChecked: workspaces.length,
      workspaceTestFiles,
    };
  },
);

export const checkRootScriptTests = Effect.fn("CacheGuard.checkRootScriptTests")(function* (
  root: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const rootAbs = path.resolve(root);
  const rootPkg = yield* readJsonFile({
    filePath: path.join(rootAbs, "package.json"),
    decode: decodePackageJson,
  });
  const rootTurbo = yield* readJsonFile({
    filePath: path.join(rootAbs, "turbo.json"),
    decode: decodeTurboConfig,
  });
  const rootTasks = rootTurbo.tasks ?? {};
  const scriptsDirAbs = path.join(rootAbs, "scripts");

  const scriptsExist = yield* fs.exists(scriptsDirAbs);
  const testFiles = scriptsExist
    ? Arr.map(
        discoverUnitTestFiles(scriptsDirAbs, { excludeTopLevelE2e: false }),
        (rel) => `scripts/${rel}`,
      )
    : [];

  const issues: Array<GuardIssue> = [];
  const rootTestScript = rootPkg.scripts?.["test"] ?? "";
  const rootTaskRefs = Arr.filter(tokenizeCommand(rootTestScript), (token) =>
    Str.startsWith("//#")(token),
  );

  const fileOwners = new Map<string, Array<string>>();

  for (const taskKey of rootTaskRefs) {
    const scriptName = Str.slice(3)(taskKey);
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

        if (!(yield* fs.exists(path.join(rootAbs, target)))) {
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
        message: `scripts unit test "${file}" is covered by multiple tasks in root package.json "test" script (${Arr.join(owners, ", ")})`,
      });
    }
  }

  return {
    issues,
    rootScriptTestFiles: testFiles.length,
  };
});

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
    } else if (token !== undefined && Str.startsWith("--only=")(token)) {
      only = Str.slice("--only=".length)(token);
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
    if (!Str.startsWith("//#")(dep)) {
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

    const scriptName = Str.slice(3)(dep);
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

export const checkFormalManifestCoverage = Effect.fn("CacheGuard.checkFormalManifestCoverage")(
  function* (root: string) {
    const path = yield* Path.Path;
    const rootAbs = path.resolve(root);
    const rootPkg = yield* readJsonFile({
      filePath: path.join(rootAbs, "package.json"),
      decode: decodePackageJson,
    });
    const rootTurbo = yield* readJsonFile({
      filePath: path.join(rootAbs, "turbo.json"),
      decode: decodeTurboConfig,
    });
    const manifest = yield* readJsonFile({
      filePath: path.join(rootAbs, "formal/manifest.json"),
      decode: decodeFormalManifest,
    });

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
        [
          "formal/run-formal.ts",
          "formal/manifest.json",
          ...[...allCoveredFiles].sort(Order.String),
        ],
        issues,
      );
    }

    return {
      issues,
      formalChecksChecked: activeFormalRunnerIds.size,
      formalCoveredFilesChecked: allCoveredFiles.size,
    };
  },
);

export const checkTurboCacheGraph = Effect.fn("CacheGuard.check")(function* (root: string) {
  const workspaceResult = yield* checkWorkspaceTestCoverage(root);
  const rootScriptsResult = yield* checkRootScriptTests(root);
  const formalResult = yield* checkFormalManifestCoverage(root);

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
});

export const formatGuardReport = (report: GuardReport): string => {
  if (report.issues.length === 0) {
    return "Turbo cache graph verified with zero drift issues.";
  }
  const lines = Arr.map(report.issues, (issue) => `- [${issue.scope}] ${issue.message}`);
  return `Turbo cache graph drift detected:\n${Arr.join(lines, "\n")}`;
};
