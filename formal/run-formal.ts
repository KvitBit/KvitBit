/**
 * `bun run verify:formal`: runs the checks listed in formal/manifest.json through the pinned
 * toolchain (formal/toolchain). The contract is documented in formal/README.md and ADR-0005.
 *
 *   bun formal/run-formal.ts                  runner self-test, digest check, every check
 *   bun formal/run-formal.ts --only <id>      one check (repeatable); skips self-test and digests
 *   bun formal/run-formal.ts --wide           use each TLC check's wideConfig (nightly)
 *   bun formal/run-formal.ts --check-digests  only compare covered-file sha256s with the tree
 *   bun formal/run-formal.ts --update-digests only rewrite covered-file sha256s
 *   bun formal/run-formal.ts --selftest       only prove the runner reports failures
 *
 * Exit 0 when everything passed, 1 when a check, digest or self-test failed, 2 on a usage or
 * manifest error. A TLC run passes only when TLC completed the whole search with no error; a
 * mutant passes only when TLC reports a genuine violation. Timeouts, parse, semantic and config
 * errors, and unexpected exceptions are failures either way.
 */
import { stripVTControlCharacters } from "node:util";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import {
  CACHE_DIR,
  ensureJar,
  ensureToolchain,
  sha256Of,
  type Toolchain,
} from "./toolchain/toolchain";
import pinned from "./toolchain/toolchain.json" with { type: "json" };

const REPO_ROOT = Bun.fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = Bun.fileURLToPath(new URL("./manifest.json", import.meta.url));

// ---------------------------------------------------------------------------------------------
// Manifest

const KINDS = ["tlc", "replay", "property", "exhaustive"] as const;
const VIOLATIONS = ["invariant", "action", "deadlock", "temporal", "assert"] as const;
const CheckKind = Schema.Literals(KINDS);
const ViolationKind = Schema.Literals(VIOLATIONS);
const Deadlock = Schema.Literals(["check", "allow"]);
type ViolationKind = typeof ViolationKind.Type;
type Deadlock = typeof Deadlock.Type;

const optional = Schema.optionalKey;
const Mutant = Schema.Struct({
  name: Schema.String,
  config: optional(Schema.String),
  spec: optional(Schema.String),
  expect: Schema.Literal("violation"),
  violates: optional(Schema.Struct({ kind: ViolationKind, name: optional(Schema.String) })),
  deadlock: optional(Deadlock),
  description: optional(Schema.String),
});

const Check = Schema.Struct({
  id: Schema.String,
  skill: Schema.String,
  tier: Schema.Finite,
  kind: CheckKind,
  status: optional(Schema.Literals(["active", "blocked"])),
  blockedReason: optional(Schema.String),
  syncCommit: optional(Schema.String),
  spec: optional(Schema.String),
  config: optional(Schema.String),
  wideConfig: optional(Schema.String),
  deadlock: optional(Deadlock),
  mutants: Mutant.pipe(Schema.Array, optional),
  replay: Schema.String.pipe(Schema.Array, optional),
  command: optional(Schema.String),
  timeoutSeconds: optional(Schema.Finite),
  wideTimeoutSeconds: optional(Schema.Finite),
  coveredFiles: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.mutableKey(Schema.String),
    }),
  ),
  guardedSymbols: Schema.Array(Schema.String),
  bounds: Schema.String,
  assumptions: Schema.Array(Schema.String),
  toolVersions: Schema.Record(Schema.String, Schema.String),
});
type Check = typeof Check.Type;

const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  syncCommit: Schema.String,
  toolchain: Schema.Struct({ tla2tools: Schema.String, java: Schema.Finite }),
  checks: Schema.Array(Check),
});
type Manifest = typeof Manifest.Type;

class ManifestError extends Schema.TaggedError<ManifestError, { readonly brand: unique symbol }>()(
  "ManifestError",
  {
    message: Schema.String,
  },
) {}

const isManifest = Schema.is(Manifest);

const isNonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value !== "";
const CFG_SPACE = /\s/;
const CFG_WORD = /[\w!]/;

/**
 * Tokens of a TLC .cfg, read the way TLC's lexer reads them: `\\*` comments run to the end
 * of the line, `(* ... *)` comments nest, and a string literal is one token that never equals a
 * name (it is returned with its quotes). Words are identifiers and numbers; other symbols are
 * one-character tokens. Empty if the file is unreadable.
 */
const cfgTokens = (text: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const two = Str.slice(i, i + 2)(text);
    if (two === "\\*") {
      // TLC ends a line comment at CR or LF, so a bare CR starts a new line too.
      let end = i + 2;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
      i = end;
    } else if (two === "(*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const t = Str.slice(i, i + 2)(text);
        if (t === "(*") {
          depth++;
          i += 2;
        } else if (t === "*)") {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      tokens.push(Str.slice(i, j + 1)(text));
      i = j + 1;
    } else if (CFG_SPACE.test(c)) i++;
    else if (CFG_WORD.test(c)) {
      let j = i;
      while (j < text.length && CFG_WORD.test(text[j] ?? "")) j++;
      tokens.push(Str.slice(i, j)(text));
      i = j;
    } else {
      tokens.push(c);
      i++;
    }
  }
  return tokens;
};
const cfgWords = Effect.fn("Formal.cfgWords")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return [];
  const text = yield* fs.readFileString(file);
  return cfgTokens(text);
});
const CFG_KEYWORDS = new Set([
  "CONSTANT",
  "CONSTANTS",
  "INIT",
  "NEXT",
  "SPECIFICATION",
  "INVARIANT",
  "INVARIANTS",
  "PROPERTY",
  "PROPERTIES",
  "CONSTRAINT",
  "CONSTRAINTS",
  "ACTION_CONSTRAINT",
  "ACTION_CONSTRAINTS",
  "SYMMETRY",
  "VIEW",
  "CHECK_DEADLOCK",
  "POSTCONDITION",
  "ALIAS",
]);
/** The names a .cfg declares under INVARIANT(S) and under PROPERTY/PROPERTIES. */
const cfgChecks = (words: string[]) => {
  const invariants = new Set<string>();
  const properties = new Set<string>();
  let into: Set<string> | undefined;
  for (const w of words) {
    if (CFG_KEYWORDS.has(w))
      into = Str.startsWith("INVARIANT")(w)
        ? invariants
        : Str.startsWith("PROPERT")(w)
          ? properties
          : undefined;
    else into?.add(w);
  }
  return { invariants, properties };
};
const disablesDeadlock = (words: string[]) =>
  Arr.some(words, (word, i) => word === "CHECK_DEADLOCK" && words[i + 1] === "FALSE");

/** Validates a parsed manifest and returns the list of problems (empty when valid). */
const validateManifest = Effect.fn("Formal.validateManifest")(function* (manifest: Manifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const problems: string[] = [];
  const bad = (where: string, what: string) => {
    problems.push(`${where}: ${what}`);
  };
  if (!isNonEmpty(manifest.syncCommit)) bad("manifest", "syncCommit must be a commit SHA");
  const toolchain = manifest.toolchain;
  if (toolchain.tla2tools !== pinned.tla2tools.version || toolchain.java !== pinned.java.major)
    bad(
      "manifest.toolchain",
      `must be {"tla2tools":"${pinned.tla2tools.version}","java":${pinned.java.major}} to match formal/toolchain/toolchain.json`,
    );

  const ids = new Set<string>();
  const exists = Effect.fnUntraced(function* (
    where: string,
    file: string | undefined,
    field: string,
  ) {
    if (!isNonEmpty(file)) bad(where, `${field} must be a repo-relative path`);
    else if (!(yield* fs.exists(path.join(REPO_ROOT, file))))
      bad(where, `${field} ${file} does not exist`);
  });
  const checkDeadlock = Effect.fnUntraced(function* (where: string, cfg: string | undefined) {
    if (!isNonEmpty(cfg)) return;
    const words = yield* cfgWords(path.join(REPO_ROOT, cfg));
    if (disablesDeadlock(words))
      bad(
        where,
        `${cfg} sets CHECK_DEADLOCK FALSE; declare deadlock: "allow" in the manifest instead`,
      );
  });

  for (const [i, check] of manifest.checks.entries()) {
    const where = `checks[${i}]${isNonEmpty(check.id) ? ` (${check.id})` : ""}`;
    if (!isNonEmpty(check.id)) bad(where, "id is required");
    else if (ids.has(check.id)) bad(where, "duplicate id");
    else ids.add(check.id);
    if (!isNonEmpty(check.skill)) bad(where, "skill is required");
    if (!Number.isInteger(check.tier) || check.tier < 0) bad(where, "tier must be an integer >= 0");
    if (check.status === "blocked" && !isNonEmpty(check.blockedReason))
      bad(where, "a blocked check needs blockedReason");
    if (check.coveredFiles.length === 0) bad(where, "coveredFiles must list at least one file");
    for (const [j, file] of check.coveredFiles.entries())
      if (!isNonEmpty(file.path)) bad(where, `coveredFiles[${j}] must be {path, sha256}`);
    if (!Arr.every(check.guardedSymbols, isNonEmpty))
      bad(where, "guardedSymbols must be a string array");
    if (!isNonEmpty(check.bounds)) bad(where, "bounds must describe the bounds checked");
    if (!Arr.every(check.assumptions, isNonEmpty)) bad(where, "assumptions must be a string array");
    if (check.timeoutSeconds !== undefined && check.timeoutSeconds <= 0)
      bad(where, "timeoutSeconds must be a positive number");
    if (check.wideTimeoutSeconds !== undefined && check.wideTimeoutSeconds <= 0)
      bad(where, "wideTimeoutSeconds must be a positive number");

    if (check.kind === "tlc") {
      yield* exists(where, check.spec, "spec");
      yield* exists(where, check.config, "config");
      if (check.wideConfig !== undefined) yield* exists(where, check.wideConfig, "wideConfig");
      // A mutant may inherit the base or wide config.
      yield* checkDeadlock(where, check.config);
      yield* checkDeadlock(where, check.wideConfig);
      if (check.toolVersions.tla2tools !== pinned.tla2tools.version)
        bad(
          where,
          `toolVersions.tla2tools must be ${pinned.tla2tools.version} (the pinned toolchain); rerun the check after a toolchain bump and update it`,
        );
      const mutants = check.mutants ?? [];
      if (mutants.length === 0) bad(where, "a tlc check needs at least one mutant that must fail");
      for (const [j, mutant] of mutants.entries()) {
        const mw = `${where}.mutants[${j}]`;
        if (!isNonEmpty(mutant.name)) bad(mw, "name is required");
        if (mutant.config === undefined && mutant.spec === undefined)
          bad(mw, "set config and/or spec (the mutated part)");
        if (mutant.config !== undefined) yield* exists(mw, mutant.config, "config");
        if (mutant.spec !== undefined) yield* exists(mw, mutant.spec, "spec");
        const violation = mutant.violates;
        if (violation === undefined) {
          bad(mw, `violates: {kind: ${Arr.join(VIOLATIONS, "|")}, name?} is required`);
        } else {
          if (
            (violation.kind === "invariant" || violation.kind === "action") &&
            !isNonEmpty(violation.name)
          )
            bad(
              mw,
              `violates.name is required for a${violation.kind === "invariant" ? "n" : ""} ${violation.kind} violation`,
            );
          // A constraint can prune violating states, so the property must be declared under
          // INVARIANT(S) or PROPERTY/PROPERTIES in the base and in the wide config.
          if (
            isNonEmpty(violation.name) &&
            violation.kind !== "deadlock" &&
            violation.kind !== "assert"
          ) {
            for (const cfg of [check.config, check.wideConfig]) {
              if (!isNonEmpty(cfg)) continue;
              const configPath = path.join(REPO_ROOT, cfg);
              if (!(yield* fs.exists(configPath))) continue;
              const words = yield* cfgWords(configPath);
              const declared = cfgChecks(words);
              const invariant = violation.kind === "invariant";
              if (!(invariant ? declared.invariants : declared.properties).has(violation.name))
                bad(
                  mw,
                  `violates.name ${violation.name} is not declared under ${invariant ? "INVARIANT" : "PROPERTY"} in ${cfg}`,
                );
            }
          }
          const deadlock = mutant.deadlock ?? check.deadlock ?? "check";
          if (violation.kind === "deadlock" && deadlock === "allow")
            bad(mw, "expects a deadlock violation but runs with deadlock: allow");
        }
        yield* checkDeadlock(mw, mutant.config);
      }
    }
    if (check.kind === "replay") {
      const replay = check.replay ?? [];
      if (replay.length === 0 || !Arr.every(replay, isNonEmpty))
        bad(where, "a replay check needs replay: [test file paths]");
      else for (const file of replay) yield* exists(where, file, "replay");
    }
    if ((check.kind === "property" || check.kind === "exhaustive") && !isNonEmpty(check.command))
      bad(where, "property/exhaustive checks need the command that runs them (under turbo test)");
  }
  return problems;
});

const loadManifest = Effect.fn("Formal.loadManifest")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(MANIFEST).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.mapError((error) => ManifestError.make({ message: `${MANIFEST}: ${error.message}` })),
  );
  if (!isManifest(raw))
    return yield* ManifestError.make({ message: `${MANIFEST} has invalid field types` });
  const problems = yield* validateManifest(raw);
  if (problems.length > 0)
    return yield* ManifestError.make({
      message: `${MANIFEST} is invalid:\n  ${Arr.join(problems, "\n  ")}`,
    });
  return raw;
});

// ---------------------------------------------------------------------------------------------
// TLC

/** Flags pinned for reproducible runs: one worker, fixed fingerprint seed, metadir in the cache. */
const TLC_FLAGS = ["-workers", "1", "-fp", "0", "-lncheck", "final", "-cleanup"] as const;

type TlcOutcome =
  | { readonly verdict: "pass"; readonly states: string }
  | {
      readonly verdict: "violation";
      readonly kind: ViolationKind;
      readonly name?: string;
      readonly states: string;
    }
  | { readonly verdict: "error"; readonly reason: string }
  | { readonly verdict: "timeout"; readonly seconds: number };

const VIOLATION_EXIT = new Map<number, readonly ViolationKind[]>([
  [11, ["deadlock"]],
  [12, ["invariant", "action"]],
  // TLC 1.7.4 exits 13 (VIOLATION_LIVENESS) for a violated action property such as [][A]_v.
  [13, ["temporal", "action"]],
  [14, ["assert"]],
]);

const TLC_DISTINCT_STATES = /(\d[\d,]*) distinct states found/g;
const TLC_ERROR = /^Error: .*$/m;
const TLC_PARSE_ERROR = /^\*\*\* ?(?:Errors|Abort messages|Parse Error)/m;
const TLC_FINAL_COUNTS =
  /^(\d[\d,]*) states generated, (\d[\d,]*) distinct states found, (\d[\d,]*) states left on queue\.$/m;
const TLC_COMPLETE = /^Model checking completed\. No error has been found\./m;
const TLC_INVARIANT_VIOLATION = /^Error: Invariant (\S+) is violated/m;
const TLC_ACTION_VIOLATION = /^Error: Action property (\S+) is violated/m;
const TLC_DEADLOCK = /^Error: Deadlock reached\./m;
const TLC_TEMPORAL_VIOLATION = /^Error: Temporal properties were violated\./m;
const TLC_INITIAL_VIOLATION = /^Error: Property (\S+) is violated by the initial state/m;
const TLC_ASSERTION_FAILURE = /^Error: The first argument of Assert evaluated to FALSE/m;

/**
 * Classifies one TLC run from its exit status and output. A pass needs exit 0, the completion
 * line and an empty queue; a violation needs a violation exit code and the matching error line.
 * Anything else (parse/semantic 150, config 151, exception 255, bad option 1, a missing marker)
 * is an error, so a broken model can never count as a passing base or a failing mutant.
 */
const classifyTlc = (status: number | null, output: string): TlcOutcome => {
  // Progress lines also report "distinct states found"; the last match is the final count.
  const states = [...Str.matchAll(TLC_DISTINCT_STATES)(output)].at(-1)?.[1] ?? "?";
  const firstError = TLC_ERROR.exec(output)?.[0];
  if (TLC_PARSE_ERROR.test(output) || status === 150)
    return { verdict: "error", reason: `parse or semantic error (exit ${status})` };
  if (status === 151)
    return { verdict: "error", reason: `config error: ${firstError ?? "exit 151"}` };
  if (status === 0) {
    const stats = TLC_FINAL_COUNTS.exec(output);
    if (!(TLC_COMPLETE.test(output) && stats !== null))
      return { verdict: "error", reason: "TLC exited 0 without completing the search" };
    if (stats[3] !== "0")
      return { verdict: "error", reason: `TLC stopped with ${stats[3]} states left on the queue` };
    // Zero states means Init is unsatisfiable, so every property holds vacuously.
    if (stats[2] === "0")
      return { verdict: "error", reason: "TLC found 0 distinct states (vacuous model)" };
    return { verdict: "pass", states };
  }
  const kinds = status === null ? undefined : VIOLATION_EXIT.get(status);
  if (kinds !== undefined) {
    const invariant = TLC_INVARIANT_VIOLATION.exec(output);
    if (kinds.includes("invariant") && invariant?.[1] !== undefined)
      return { verdict: "violation", kind: "invariant", name: invariant[1], states };
    const action = TLC_ACTION_VIOLATION.exec(output);
    if (kinds.includes("action") && action?.[1] !== undefined)
      return { verdict: "violation", kind: "action", name: action[1], states };
    if (kinds.includes("deadlock") && TLC_DEADLOCK.test(output))
      return { verdict: "violation", kind: "deadlock", states };
    if (kinds.includes("temporal") && TLC_TEMPORAL_VIOLATION.test(output))
      return { verdict: "violation", kind: "temporal", states };
    const initial = TLC_INITIAL_VIOLATION.exec(output);
    if (kinds.includes("temporal") && initial?.[1] !== undefined)
      return { verdict: "violation", kind: "temporal", name: initial[1], states };
    if (kinds.includes("assert") && TLC_ASSERTION_FAILURE.test(output))
      return { verdict: "violation", kind: "assert", states };
  }
  return {
    verdict: "error",
    reason: `TLC exit ${status}: ${firstError ?? "no violation named in the output"}`,
  };
};

interface RunResult {
  status: number | null;
  output: string;
  timedOut: boolean;
  seconds: number;
}

const run = Effect.fn("Formal.run")(function* (
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutSeconds: number,
  env?: Record<string, string | undefined>,
) {
  const started = performance.now();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.result(
    spawner.spawn(ChildProcess.make(cmd, args, { cwd, env, extendEnv: true, stdin: "ignore" })),
  );
  const seconds = () => (performance.now() - started) / 1000;
  if (Result.isFailure(result)) {
    return {
      status: null,
      output: `\nspawn failed: ${result.failure.message}`,
      timedOut: false,
      seconds: seconds(),
    } satisfies RunResult;
  }
  const child = result.success;
  const output = yield* child.all.pipe(Stream.decodeText, Stream.mkString, Effect.forkScoped);
  const completed = yield* Effect.all(
    { status: child.exitCode.pipe(Effect.orElseSucceed(() => null)), output: Fiber.join(output) },
    { concurrency: "unbounded" },
  ).pipe(Effect.timeoutOption(Duration.seconds(timeoutSeconds)));
  if (Option.isSome(completed)) {
    return { ...completed.value, timedOut: false, seconds: seconds() } satisfies RunResult;
  }
  yield* child.kill({ killSignal: "SIGKILL" });
  return {
    status: null,
    output: yield* Fiber.join(output),
    timedOut: true,
    seconds: seconds(),
  } satisfies RunResult;
}, Effect.scoped);

const rel = (path: Path.Path, p: string) => path.relative(REPO_ROOT, p) || ".";

interface TlcRun {
  readonly label: string;
  readonly spec: string;
  readonly config: string;
  readonly deadlock: Deadlock;
  readonly timeoutSeconds: number;
}

const TLC_LOG_SLUG_UNSAFE_CHARS = /[^\w.-]+/g;

const runTlc = Effect.fn("Formal.runTlc")(function* (
  tools: Pick<Toolchain, "jar" | "java">,
  r: TlcRun,
  logDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spec = path.resolve(REPO_ROOT, r.spec);
  const config = path.resolve(REPO_ROOT, r.config);
  const slug = Str.replace(TLC_LOG_SLUG_UNSAFE_CHARS, "_")(r.label);
  const metadir = path.join(CACHE_DIR, "tlc", slug);
  yield* fs.remove(metadir, { recursive: true, force: true });
  yield* fs.makeDirectory(logDir, { recursive: true });
  const args = [
    "-XX:+UseParallelGC",
    "-cp",
    tools.jar,
    "tlc2.TLC",
    ...TLC_FLAGS,
    ...(r.deadlock === "allow" ? ["-deadlock"] : []),
    "-metadir",
    metadir,
    "-config",
    config,
    spec,
  ];
  const res = yield* run(tools.java, args, path.dirname(spec), r.timeoutSeconds);
  const log = path.join(logDir, `${slug}.log`);
  yield* fs.writeFileString(log, `$ ${tools.java} ${Arr.join(args, " ")}\n${res.output}`);
  yield* fs.remove(metadir, { recursive: true, force: true });
  const outcome: TlcOutcome = res.timedOut
    ? { verdict: "timeout", seconds: r.timeoutSeconds }
    : classifyTlc(res.status, res.output);
  return { outcome, seconds: res.seconds, log };
});

// ---------------------------------------------------------------------------------------------
// Checks

const DEFAULT_TIMEOUT = 300;
const LOG_DIR = `${CACHE_DIR}/logs`;

interface CheckResult {
  readonly id: string;
  readonly ok: boolean;
  readonly skipped?: string;
  readonly seconds: number;
  readonly lines: string[];
}

const describe = (o: TlcOutcome): string => {
  switch (o.verdict) {
    case "pass":
      return `passed, ${o.states} distinct states`;
    case "violation":
      return `${o.kind} violation${o.name !== undefined && o.name !== "" ? ` of ${o.name}` : ""} after ${o.states} distinct states`;
    case "error":
      return `error: ${o.reason}`;
    case "timeout":
      return `timeout after ${o.seconds}s (an incomplete search is a failure)`;
  }
};

const tail = Effect.fn("Formal.logTail")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(file);
  return Arr.takeRight(Str.split(Str.trimEnd(contents), "\n"), 25);
});

const runTlcCheck = Effect.fn("Formal.runTlcCheck")(function* (
  check: Check,
  tools: Pick<Toolchain, "jar" | "java">,
  opts: { wide: boolean; logDir?: string },
) {
  const path = yield* Path.Path;
  const logDir = opts.logDir ?? LOG_DIR;
  const lines: string[] = [];
  let ok = true;
  let seconds = 0;
  const wide = opts.wide && check.wideConfig !== undefined;
  const timeout =
    (wide ? check.wideTimeoutSeconds : undefined) ?? check.timeoutSeconds ?? DEFAULT_TIMEOUT;
  const base = yield* runTlc(
    tools,
    {
      label: `${check.id}.${wide ? "wide" : "base"}`,
      spec: check.spec ?? "",
      config: (wide ? check.wideConfig : check.config) ?? "",
      deadlock: check.deadlock ?? "check",
      timeoutSeconds: timeout,
    },
    logDir,
  );
  seconds += base.seconds;
  const baseOk = base.outcome.verdict === "pass";
  ok &&= baseOk;
  lines.push(
    `${baseOk ? "ok  " : "FAIL"} ${wide ? "wide" : "base"} ${rel(path, path.resolve(REPO_ROOT, (wide ? check.wideConfig : check.config) ?? ""))}: ${describe(base.outcome)} (${base.seconds.toFixed(1)}s)`,
  );
  if (!baseOk) {
    const logTail = yield* tail(base.log);
    lines.push(`     log ${rel(path, base.log)}:`, ...Arr.map(logTail, (l) => `     | ${l}`));
  }
  for (const m of check.mutants ?? []) {
    const res = yield* runTlc(
      tools,
      {
        label: `${check.id}.mutant.${m.name}`,
        spec: m.spec ?? check.spec ?? "",
        config: m.config ?? check.config ?? "",
        deadlock: m.deadlock ?? check.deadlock ?? "check",
        timeoutSeconds: check.timeoutSeconds ?? DEFAULT_TIMEOUT,
      },
      logDir,
    );
    seconds += res.seconds;
    const o = res.outcome;
    let mutantOk = o.verdict === "violation";
    let why = "";
    if (o.verdict === "pass")
      why = " -- the mutant must fail, so the model cannot detect this break";
    if (o.verdict === "violation" && m.violates !== undefined) {
      const kindOk = o.kind === m.violates.kind;
      const nameOk = m.violates.name === undefined || o.name === m.violates.name;
      if (!(kindOk && nameOk)) {
        mutantOk = false;
        why = ` -- expected ${m.violates.kind}${m.violates.name !== undefined && m.violates.name !== "" ? ` of ${m.violates.name}` : ""}`;
      }
    }
    if (o.verdict === "error" || o.verdict === "timeout")
      why = " -- only a genuine violation counts for a mutant";
    ok &&= mutantOk;
    lines.push(
      `${mutantOk ? "ok  " : "FAIL"} mutant ${m.name}: ${describe(o)}${why} (${res.seconds.toFixed(1)}s)`,
    );
    if (!mutantOk) {
      const logTail = yield* tail(res.log);
      lines.push(`     log ${rel(path, res.log)}:`, ...Arr.map(logTail, (l) => `     | ${l}`));
    }
  }
  return { id: check.id, ok, seconds, lines } satisfies CheckResult;
});

/**
 * Runs each replay harness in its own `bun test` so every file must execute at least one
 * passing test: an empty or all-skipped harness would otherwise pass while checking nothing.
 */
const runReplayCheck = Effect.fn("Formal.runReplayCheck")(function* (
  check: Check,
  env?: Record<string, string | undefined>,
) {
  const path = yield* Path.Path;
  const timeout = check.timeoutSeconds ?? DEFAULT_TIMEOUT;
  const lines: string[] = [];
  let ok = true;
  let seconds = 0;
  for (const f of check.replay ?? []) {
    const file = `./${path.normalize(f)}`;
    const res = yield* run(process.execPath, ["test", file], REPO_ROOT, timeout, env);
    seconds += res.seconds;
    const plain = stripVTControlCharacters(res.output);
    const count = (word: string) =>
      Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(plain)?.[1] ?? 0);
    const [pass, fail, skip, todo] = [count("pass"), count("fail"), count("skip"), count("todo")];
    let why = "";
    if (res.timedOut) why = `timeout after ${timeout}s`;
    else if (res.status !== 0) why = `exit ${res.status}`;
    else if (pass === 0) why = "no test ran (an empty replay checks nothing)";
    else if (skip + todo > 0)
      why = `${skip + todo} skipped or todo tests (a replay runs every step)`;
    const fileOk = why === "";
    ok &&= fileOk;
    lines.push(
      `${fileOk ? "ok  " : "FAIL"} bun test ${file}: ${pass} pass, ${fail} fail, ${skip} skip, ${todo} todo${why !== "" ? ` -- ${why}` : ""} (${res.seconds.toFixed(1)}s)`,
    );
    if (!fileOk)
      lines.push(
        ...Arr.map(Str.split(Str.trimEnd(res.output), "\n").slice(-30), (l) => `     | ${l}`),
      );
  }
  return { id: check.id, ok, seconds, lines } satisfies CheckResult;
});

// ---------------------------------------------------------------------------------------------
// Digests

interface DigestDrift {
  readonly check: Check;
  readonly files: { readonly path: string; readonly problem: "changed" | "missing" }[];
}

const digestDrift = Effect.fn("Formal.digestDrift")(function* (manifest: Manifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const drift: DigestDrift[] = [];
  for (const check of manifest.checks) {
    const files: DigestDrift["files"] = [];
    for (const file of check.coveredFiles) {
      const fullPath = path.join(REPO_ROOT, file.path);
      if (!(yield* fs.exists(fullPath))) files.push({ path: file.path, problem: "missing" });
      else if ((yield* sha256Of(fullPath)) !== file.sha256)
        files.push({ path: file.path, problem: "changed" });
    }
    if (files.length > 0) drift.push({ check, files });
  }
  return drift;
});

/** Tier 0 and 1 drift fails the PR gate; tier 2+ and blocked checks only warn. */
const driftBlocks = (d: DigestDrift) => d.check.tier <= 1 && d.check.status !== "blocked";

/**
 * Rewrites covered-file sha256s for the checks in `only` (every check when empty). A blocked
 * check keeps its digests unless `only` names it, so its drift stays visible.
 */
const encodeManifestJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const updateDigests = Effect.fn("Formal.updateDigests")(function* (
  manifest: Manifest,
  only: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const changed: string[] = [];
  for (const check of manifest.checks) {
    if (only.length > 0 ? !only.includes(check.id) : check.status === "blocked") continue;
    for (const file of check.coveredFiles) {
      const fullPath = path.join(REPO_ROOT, file.path);
      if (!(yield* fs.exists(fullPath)))
        return yield* ManifestError.make({
          message: `${check.id}: covered file ${file.path} is missing`,
        });
      const sha = yield* sha256Of(fullPath);
      if (sha !== file.sha256) {
        changed.push(`${check.id}: ${file.path}`);
        file.sha256 = sha;
      }
    }
  }
  const json = yield* encodeManifestJson(manifest);
  yield* fs.writeFileString(MANIFEST, `${json}\n`);
  // Keep the file in Biome's JSON style so `bun run lint` stays green after an update.
  const biome = path.join(REPO_ROOT, "node_modules/.bin/biome");
  if (yield* fs.exists(biome)) {
    yield* spawner
      .exitCode(
        ChildProcess.make(biome, ["format", "--write", MANIFEST], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.ignore);
  }
  return changed;
});

// ---------------------------------------------------------------------------------------------
// Runner self-test: each fixture must be reported as a failure, or the runner cannot be trusted.

const SELFTEST = "formal/selftest";

const selftestCheck = (over: Partial<Check>): Check => ({
  id: "selftest.negative",
  skill: "selftest",
  tier: 0,
  kind: "tlc",
  spec: `${SELFTEST}/Counter.tla`,
  config: `${SELFTEST}/Counter.cfg`,
  mutants: [
    {
      name: "bound",
      config: `${SELFTEST}/Counter_mutant_bound.cfg`,
      expect: "violation",
      violates: { kind: "invariant", name: "WithinBound" },
    },
  ],
  timeoutSeconds: 60,
  coveredFiles: [],
  guardedSymbols: [],
  bounds: "",
  assumptions: [],
  toolVersions: {},
  ...over,
});

const SELFTEST_MUTANT_PASSED = /mutant vacuous: passed/;
const SELFTEST_BASE_VIOLATION = /base .*invariant violation of WithinBound/;
const SELFTEST_MUTANT_PARSE_ERROR = /mutant parse: error: parse or semantic error/;
const SELFTEST_BASE_PARSE_ERROR = /base .*error: parse or semantic error/;
const SELFTEST_CONFIG_ERROR = /mutant config: error: config error/;
const SELFTEST_WRONG_VIOLATION = /expected invariant of TypeOK/;
const SELFTEST_VACUOUS_MODEL = /0 distinct states \(vacuous model\)/;
const SELFTEST_TIMEOUT = /base .*timeout after 3s/;
const SELFTEST_REPLAY_FAILURE = /1 fail.* -- exit 1/;
const SELFTEST_NO_REPLAY_TEST = /no test ran/;
const SELFTEST_SKIPPED_REPLAY_TEST = /skipped or todo/;
const SELFTEST_BAD_CHECKSUM = /checksum mismatch/;
const SELFTEST_MISSING_BASE_INVARIANT = /WithinBound is not declared under INVARIANT/;
const SELFTEST_MISSING_WIDE_INVARIANT =
  /WithinBound is not declared under INVARIANT in .*Counter_constraint/;
const SELFTEST_DEADLOCK_DISABLED = /sets CHECK_DEADLOCK FALSE/;

const selftest = Effect.fn("Formal.selftest")(function* (tools: Pick<Toolchain, "jar" | "java">) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const started = performance.now();
  const logDir = path.join(CACHE_DIR, "logs", "selftest");
  const neg = `${SELFTEST}/negative`;
  const cases: { name: string; reason: RegExp; check: Check; kind?: "replay" }[] = [
    {
      name: "a mutant that passes",
      reason: SELFTEST_MUTANT_PASSED,
      check: selftestCheck({
        mutants: [{ name: "vacuous", config: `${neg}/Counter_vacuous.cfg`, expect: "violation" }],
      }),
    },
    {
      name: "a base config that violates",
      reason: SELFTEST_BASE_VIOLATION,
      check: selftestCheck({ config: `${SELFTEST}/Counter_mutant_bound.cfg` }),
    },
    {
      name: "a parse error in the mutant spec",
      reason: SELFTEST_MUTANT_PARSE_ERROR,
      check: selftestCheck({
        mutants: [
          {
            name: "parse",
            spec: `${neg}/Broken.tla`,
            config: `${neg}/Broken.cfg`,
            expect: "violation",
          },
        ],
      }),
    },
    {
      name: "a parse error in the base spec",
      reason: SELFTEST_BASE_PARSE_ERROR,
      check: selftestCheck({ spec: `${neg}/Broken.tla`, config: `${neg}/Broken.cfg` }),
    },
    {
      name: "a config naming an undefined invariant",
      reason: SELFTEST_CONFIG_ERROR,
      check: selftestCheck({
        mutants: [{ name: "config", config: `${neg}/Counter_undefined.cfg`, expect: "violation" }],
      }),
    },
    {
      name: "a mutant that breaks a different property than declared",
      reason: SELFTEST_WRONG_VIOLATION,
      check: selftestCheck({
        mutants: [
          {
            name: "wrong-property",
            config: `${SELFTEST}/Counter_mutant_bound.cfg`,
            expect: "violation",
            violates: { kind: "invariant", name: "TypeOK" },
          },
        ],
      }),
    },
    {
      name: "a model with no initial states",
      reason: SELFTEST_VACUOUS_MODEL,
      check: selftestCheck({ spec: `${neg}/Empty.tla`, config: `${neg}/Empty.cfg`, mutants: [] }),
    },
    {
      name: "a TLC timeout",
      reason: SELFTEST_TIMEOUT,
      check: selftestCheck({
        spec: `${neg}/Slow.tla`,
        config: `${neg}/Slow.cfg`,
        timeoutSeconds: 3,
        mutants: [],
      }),
    },
    {
      name: "a failing replay harness",
      reason: SELFTEST_REPLAY_FAILURE,
      kind: "replay",
      check: selftestCheck({ kind: "replay", replay: [`${neg}/failing.replay-fixture.ts`] }),
    },
    {
      name: "a replay harness that runs no test",
      reason: SELFTEST_NO_REPLAY_TEST,
      kind: "replay",
      check: selftestCheck({ kind: "replay", replay: [`${neg}/skipped-only.replay-fixture.ts`] }),
    },
    {
      name: "a replay harness that skips a step",
      reason: SELFTEST_SKIPPED_REPLAY_TEST,
      kind: "replay",
      check: selftestCheck({ kind: "replay", replay: [`${neg}/partly-skipped.replay-fixture.ts`] }),
    },
  ];
  const lines: string[] = [];
  let ok = true;
  for (const c of cases) {
    const r =
      c.kind === "replay"
        ? yield* runReplayCheck(c.check)
        : yield* runTlcCheck(c.check, tools, { wide: false, logDir });
    const detail = Arr.findFirst(r.lines, (line) => Str.startsWith("FAIL")(line)).pipe(
      Option.map(Str.slice(5)),
      Option.getOrElse(() => "every run passed"),
    );
    // The failure must be the one the fixture provokes, not an unrelated error in the fixture.
    const reported = !r.ok && c.reason.test(detail);
    ok &&= reported;
    lines.push(
      `${reported ? "ok  " : "FAIL"} reports ${c.name} as a failure: ${detail}${reported ? "" : ` -- expected ${c.reason}`}`,
    );
  }
  // Checksum mismatches fail closed, for an override and for a download.
  const fake = path.join(CACHE_DIR, "selftest-not-a-jar.jar");
  yield* fs.makeDirectory(CACHE_DIR, { recursive: true });
  yield* fs.writeFileString(fake, "not tla2tools\n");
  const closed = Effect.fnUntraced(function* (
    name: string,
    attempt: ReturnType<typeof ensureJar>,
    leftover?: string,
  ) {
    const message = yield* attempt.pipe(
      Effect.as(""),
      Effect.catchTag("ToolchainError", (error) => Effect.succeed(error.message)),
    );
    const clean = leftover === undefined || !(yield* fs.exists(leftover));
    const good = SELFTEST_BAD_CHECKSUM.test(message) && clean;
    ok &&= good;
    lines.push(
      `${good ? "ok  " : "FAIL"} fails closed on ${name}${good ? "" : `: ${message || "no error raised"}`}${clean ? "" : `, left ${rel(path, leftover ?? "")}`}`,
    );
  });
  yield* closed("a TLA2TOOLS override with the wrong checksum", ensureJar(fake));
  yield* closed(
    "a download with the wrong checksum",
    ensureJar(undefined, {
      version: "selftest",
      url: (yield* path.toFileUrl(fake)).href,
      sha256: pinned.tla2tools.sha256,
    }),
    path.join(CACHE_DIR, "tla2tools-selftest.jar"),
  );
  yield* fs.remove(fake, { force: true });
  // Manifest validation rejects configs that would let a base pass without checking the
  // property its mutant breaks, and configs that switch deadlock checking off.
  const manifest = yield* loadManifest();
  const counter = Option.getOrUndefined(
    Arr.findFirst(manifest.checks, (c) => c.id === "selftest.counter"),
  );
  if (counter === undefined)
    return yield* ManifestError.make({ message: "selftest.counter is missing from the manifest" });
  const rejects = Effect.fnUntraced(function* (name: string, over: Partial<Check>, reason: RegExp) {
    const raw = { ...manifest, checks: [{ ...counter, ...over }] };
    const problems = yield* validateManifest(raw);
    const good = Arr.some(problems, (p) => reason.test(p));
    ok &&= good;
    lines.push(
      `${good ? "ok  " : "FAIL"} rejects ${name}${good ? "" : `: got ${Arr.join(problems, "; ") || "no problem"}`}`,
    );
  });
  yield* rejects(
    "a base config that only constrains the mutant's invariant",
    { config: `${neg}/Counter_constraint.cfg` },
    SELFTEST_MISSING_BASE_INVARIANT,
  );
  yield* rejects(
    "a wide config that omits the mutant's property",
    { wideConfig: `${neg}/Counter_constraint.cfg` },
    SELFTEST_MISSING_WIDE_INVARIANT,
  );
  yield* rejects(
    "a base config naming the mutant's invariant only inside a string",
    { config: `${neg}/Counter_quoted.cfg` },
    SELFTEST_MISSING_BASE_INVARIANT,
  );
  yield* rejects(
    "a base config naming the mutant's invariant only inside a nested comment",
    { config: `${neg}/Counter_nested.cfg` },
    SELFTEST_MISSING_BASE_INVARIANT,
  );
  yield* rejects(
    "CHECK_DEADLOCK FALSE between line comments that look like a block comment",
    { config: `${neg}/Counter_deadlock_comments.cfg` },
    SELFTEST_DEADLOCK_DISABLED,
  );
  // Written at run time so no editor or git setting can normalise the bare CR (0x0D).
  const crCfg = path.join(CACHE_DIR, "selftest-bare-cr.cfg");
  yield* fs.writeFileString(
    crCfg,
    "CONSTANTS Limit = 3 Bound = 3 Back = FALSE\nSPECIFICATION Spec\nINVARIANTS TypeOK WithinBound\nPROPERTY NoDecrease\n\\* comment\rCHECK_DEADLOCK FALSE\n",
  );
  yield* rejects(
    "CHECK_DEADLOCK FALSE after a line comment ended by a bare CR",
    { config: rel(path, crCfg) },
    SELFTEST_DEADLOCK_DISABLED,
  );
  yield* fs.remove(crCfg, { force: true });
  yield* rejects(
    "CHECK_DEADLOCK FALSE even when the check allows deadlock",
    { config: `${neg}/Counter_nodeadlock.cfg`, deadlock: "allow" },
    SELFTEST_DEADLOCK_DISABLED,
  );
  // Classifies an initial-state property violation as a named temporal violation.
  const initial = yield* runTlc(
    tools,
    {
      label: "selftest.initial-property",
      spec: `${neg}/InitProperty.tla`,
      config: `${neg}/InitProperty.cfg`,
      deadlock: "allow",
      timeoutSeconds: 60,
    },
    logDir,
  );
  const initialOk =
    initial.outcome.verdict === "violation" &&
    initial.outcome.kind === "temporal" &&
    initial.outcome.name === "IsOne";
  ok &&= initialOk;
  lines.push(
    `${initialOk ? "ok  " : "FAIL"} classifies an initial-state property violation: ${describe(initial.outcome)}`,
  );
  // A progress line reports fewer states than the completion line; the final count must win.
  const progressed = classifyTlc(
    0,
    Arr.join(
      [
        "Progress(3) at 2026-01-01 00:00:00: 10 states generated (10 s/min), 7 distinct states found, 2 states left on queue.",
        "Model checking completed. No error has been found.",
        "25 states generated, 19 distinct states found, 0 states left on queue.",
      ],
      "\n",
    ),
  );
  const progressedOk = progressed.verdict === "pass" && progressed.states === "19";
  ok &&= progressedOk;
  lines.push(
    `${progressedOk ? "ok  " : "FAIL"} reports the final distinct-state count, not a progress line's: ${describe(progressed)}`,
  );
  // Coloured bun output (FORCE_COLOR) still parses as a passing replay.
  const coloured = yield* runReplayCheck(
    selftestCheck({ kind: "replay", replay: [`${SELFTEST}/imports.replay.test.ts`] }),
    { FORCE_COLOR: "1" },
  );
  ok &&= coloured.ok;
  lines.push(
    `${coloured.ok ? "ok  " : "FAIL"} parses a passing replay under FORCE_COLOR=1${coloured.ok ? "" : `: ${coloured.lines[0]}`}`,
  );
  // A relative override is resolved before it is checksummed, so TLC loads the verified file.
  const relative = path.relative(process.cwd(), tools.jar);
  const jar = yield* ensureJar(relative);
  const viaRelative = yield* runTlcCheck(
    selftestCheck({ id: "selftest.relative-override" }),
    { java: tools.java, jar },
    { wide: false, logDir },
  );
  ok &&= viaRelative.ok;
  lines.push(
    `${viaRelative.ok ? "ok  " : "FAIL"} runs the verified jar from a relative TLA2TOOLS=${relative}${viaRelative.ok ? "" : `: ${Arr.join(viaRelative.lines, "; ")}`}`,
  );
  return {
    id: "runner self-test",
    ok,
    seconds: (performance.now() - started) / 1000,
    lines,
  } satisfies CheckResult;
});

// ---------------------------------------------------------------------------------------------
// CLI

const out = (line = "") => process.stdout.write(`${line}\n`);

interface Args {
  wide: boolean;
  only: string[];
  mode: "all" | "check-digests" | "update-digests" | "selftest";
}

const parseArgs = Effect.fn("Formal.parseArgs")(function* (argv: readonly string[]) {
  const args: Args = { wide: false, only: [], mode: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wide") args.wide = true;
    else if (a === "--only") {
      const id = argv[++i];
      if (id === undefined || id === "")
        return yield* ManifestError.make({ message: "--only needs a check id" });
      args.only.push(id);
    } else if (a === "--check-digests") args.mode = "check-digests";
    else if (a === "--update-digests") args.mode = "update-digests";
    else if (a === "--selftest") args.mode = "selftest";
    else return yield* ManifestError.make({ message: `unknown argument ${a}` });
  }
  return args;
});

const printDrift = (drift: DigestDrift[]): boolean => {
  if (drift.length === 0) {
    out("ok   covered-file digests match the working tree");
    return true;
  }
  const blocking = Arr.filter(drift, driftBlocks);
  for (const d of drift) {
    const label = driftBlocks(d) ? "FAIL" : "warn";
    const note = d.check.status === "blocked" ? ` (blocked: ${d.check.blockedReason})` : "";
    out(`${label} ${d.check.id} [tier ${d.check.tier}, skill ${d.check.skill}]${note}`);
    for (const f of d.files) out(`       ${f.problem}: ${f.path}`);
  }
  const skills = [...new Set(Arr.map(drift, (d) => d.check.skill))];
  out();
  out(`Covered code changed for: ${Arr.join(skills, ", ")}.`);
  out("Run /maintain-formal-verification-skill on those skills and classify each check as");
  out(
    "in sync, updated, bug or blocked. Then, in a maintenance commit separate from product fixes,",
  );
  out("run `bun run verify:formal --update-digests` (never advance a blocked check's syncCommit).");
  if (blocking.length === 0)
    out("Only tier 2+ or blocked checks drifted: this warns and does not fail the PR gate.");
  return blocking.length === 0;
};

const main = Effect.fn("Formal.main")(function* (argv: readonly string[]) {
  const started = performance.now();
  const args = yield* parseArgs(argv);
  const manifest = yield* loadManifest();
  if (args.mode === "check-digests") {
    const drift = yield* digestDrift(manifest);
    return printDrift(drift) ? 0 : 1;
  }

  const unknown = Arr.filter(args.only, (id) => !Arr.some(manifest.checks, (c) => c.id === id));
  if (unknown.length > 0)
    return yield* ManifestError.make({
      message: `--only: no check named ${Arr.join(unknown, ", ")}`,
    });
  if (args.mode === "update-digests") {
    const changed = yield* updateDigests(manifest, args.only);
    out(changed.length > 0 ? `updated:\n  ${Arr.join(changed, "\n  ")}` : "digests already match");
    return 0;
  }
  const allChecks = args.only.length === 0;
  const selected = Arr.filter(manifest.checks, (c) => allChecks || args.only.includes(c.id));
  const needsTlc =
    args.mode === "selftest" ||
    (allChecks && args.mode === "all") ||
    Arr.some(selected, (c) => c.kind === "tlc" && c.status !== "blocked");
  const tools = needsTlc ? yield* ensureToolchain() : undefined;
  if (tools !== undefined)
    out(`toolchain: tla2tools ${tools.tlaVersion} (sha256 verified), java ${tools.javaVersion}`);

  const results: CheckResult[] = [];
  const report = (r: CheckResult) => {
    results.push(r);
    const state = r.skipped !== undefined ? "SKIP" : r.ok ? "PASS" : "FAIL";
    out(
      `${state} ${r.id} (${r.seconds.toFixed(1)}s)${r.skipped !== undefined ? ` -- ${r.skipped}` : ""}`,
    );
    for (const l of r.lines) out(`  ${l}`);
  };
  let digestsOk = true;
  if (tools !== undefined && (args.mode === "selftest" || allChecks)) {
    const result = yield* selftest(tools);
    report(result);
  }
  if (args.mode === "all" && allChecks) {
    const drift = yield* digestDrift(manifest);
    digestsOk = printDrift(drift);
  }
  if (args.mode === "all")
    for (const c of selected) {
      if (c.status === "blocked") {
        report({
          id: c.id,
          ok: true,
          seconds: 0,
          skipped: `blocked: ${c.blockedReason}`,
          lines: [],
        });
        continue;
      }
      if (c.kind === "tlc" && tools !== undefined) {
        const result = yield* runTlcCheck(c, tools, { wide: args.wide });
        report(result);
      } else if (c.kind === "replay") {
        const result = yield* runReplayCheck(c);
        report(result);
      } else
        report({
          id: c.id,
          ok: true,
          seconds: 0,
          skipped: `${c.kind} check runs under turbo test: ${c.command}`,
          lines: [],
        });
    }
  const failed = Arr.filter(results, (r) => !r.ok);
  const total = (performance.now() - started) / 1000;
  const bad = failed.length > 0 || !digestsOk;
  out();
  out(
    `${bad ? "FAILED" : "PASSED"}: ${Arr.filter(results, (r) => r.ok && r.skipped === undefined).length} passed, ${failed.length} failed, ${Arr.filter(results, (r) => r.skipped !== undefined).length} skipped${digestsOk ? "" : ", digests drifted"} in ${total.toFixed(1)}s`,
  );
  return bad ? 1 : 0;
});

if (import.meta.main) {
  BunRuntime.runMain(
    main(Arr.drop(Bun.argv, 2)).pipe(
      Effect.matchEffect({
        onSuccess: (code) =>
          Effect.sync(() => {
            process.exitCode = code;
          }),
        onFailure: (error) => {
          process.exitCode = Schema.is(ManifestError)(error) ? 2 : 1;
          return Console.error(error.message);
        },
      }),
      Effect.provide(BunServices.layer),
    ),
  );
}
