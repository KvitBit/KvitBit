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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CACHE_DIR,
  ensureJar,
  ensureToolchain,
  pinned,
  sha256Of,
  type Toolchain,
  ToolchainError,
} from "./toolchain/toolchain";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");
const MANIFEST = path.join(REPO_ROOT, "formal/manifest.json");

// ---------------------------------------------------------------------------------------------
// Manifest

export type CheckKind = "tlc" | "replay" | "property" | "exhaustive";
export type ViolationKind = "invariant" | "action" | "deadlock" | "temporal" | "assert";
export type Deadlock = "check" | "allow";

export type Mutant = {
  readonly name: string;
  readonly config?: string;
  readonly spec?: string;
  readonly expect: "violation";
  /** Optional: the violation kind and, for invariant/action, the property name TLC must name. */
  readonly violates?: { readonly kind: ViolationKind; readonly name?: string };
  readonly deadlock?: Deadlock;
  readonly description?: string;
};

export type Check = {
  readonly id: string;
  readonly skill: string;
  readonly tier: number;
  readonly kind: CheckKind;
  readonly status?: "active" | "blocked";
  readonly blockedReason?: string;
  readonly syncCommit?: string;
  readonly spec?: string;
  readonly config?: string;
  readonly wideConfig?: string;
  readonly deadlock?: Deadlock;
  readonly mutants?: readonly Mutant[];
  readonly replay?: readonly string[];
  readonly command?: string;
  readonly timeoutSeconds?: number;
  readonly wideTimeoutSeconds?: number;
  readonly coveredFiles: readonly { readonly path: string; sha256: string }[];
  readonly guardedSymbols: readonly string[];
  readonly bounds: string;
  readonly assumptions: readonly string[];
  readonly toolVersions: Readonly<Record<string, string>>;
};

export type Manifest = {
  readonly schemaVersion: 1;
  readonly syncCommit: string;
  readonly toolchain: { readonly tla2tools: string; readonly java: number };
  readonly checks: readonly Check[];
};

const KINDS: readonly CheckKind[] = ["tlc", "replay", "property", "exhaustive"];
const VIOLATIONS: readonly ViolationKind[] = [
  "invariant",
  "action",
  "deadlock",
  "temporal",
  "assert",
];

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** Validates a parsed manifest and returns the list of problems (empty when valid). */
export const validateManifest = (raw: unknown, root = REPO_ROOT): string[] => {
  const problems: string[] = [];
  const bad = (where: string, what: string) => problems.push(`${where}: ${what}`);
  if (!isObject(raw)) return ["manifest: not a JSON object"];
  if (raw.schemaVersion !== 1) bad("manifest", "schemaVersion must be 1");
  if (!isString(raw.syncCommit)) bad("manifest", "syncCommit must be a commit SHA");
  const tc = raw.toolchain;
  if (!isObject(tc) || tc.tla2tools !== pinned.tla2tools.version || tc.java !== pinned.java.major)
    bad(
      "manifest.toolchain",
      `must be {"tla2tools":"${pinned.tla2tools.version}","java":${pinned.java.major}} to match formal/toolchain/toolchain.json`,
    );
  if (!Array.isArray(raw.checks)) {
    bad("manifest", "checks must be an array");
    return problems;
  }
  const ids = new Set<string>();
  const exists = (where: string, p: unknown, field: string) => {
    if (!isString(p)) bad(where, `${field} must be a repo-relative path`);
    else if (!existsSync(path.join(root, p))) bad(where, `${field} ${p} does not exist`);
  };
  raw.checks.forEach((c: unknown, i: number) => {
    const where = `checks[${i}]${isObject(c) && isString(c.id) ? ` (${c.id})` : ""}`;
    if (!isObject(c)) {
      bad(where, "not an object");
      return;
    }
    if (!isString(c.id)) bad(where, "id is required");
    else if (ids.has(c.id)) bad(where, "duplicate id");
    else ids.add(c.id);
    if (!isString(c.skill)) bad(where, "skill is required");
    if (typeof c.tier !== "number" || !Number.isInteger(c.tier) || c.tier < 0)
      bad(where, "tier must be an integer >= 0");
    if (!KINDS.includes(c.kind as CheckKind)) bad(where, `kind must be one of ${KINDS.join("|")}`);
    if (c.status !== undefined && c.status !== "active" && c.status !== "blocked")
      bad(where, "status must be active|blocked");
    if (c.status === "blocked" && !isString(c.blockedReason))
      bad(where, "a blocked check needs blockedReason");
    if (!Array.isArray(c.coveredFiles) || c.coveredFiles.length === 0)
      bad(where, "coveredFiles must list at least one file");
    else
      c.coveredFiles.forEach((f: unknown, j: number) => {
        if (!isObject(f) || !isString(f.path) || typeof f.sha256 !== "string")
          bad(where, `coveredFiles[${j}] must be {path, sha256}`);
      });
    if (!isStrings(c.guardedSymbols)) bad(where, "guardedSymbols must be a string array");
    if (!isString(c.bounds)) bad(where, "bounds must describe the bounds checked");
    if (!isStrings(c.assumptions)) bad(where, "assumptions must be a string array");
    if (!isObject(c.toolVersions)) bad(where, "toolVersions must be an object");
    for (const t of ["timeoutSeconds", "wideTimeoutSeconds"])
      if (c[t] !== undefined && !(typeof c[t] === "number" && c[t] > 0))
        bad(where, `${t} must be a positive number`);
    for (const d of [c.deadlock])
      if (d !== undefined && d !== "check" && d !== "allow")
        bad(where, "deadlock must be check|allow");
    if (c.kind === "tlc") {
      exists(where, c.spec, "spec");
      exists(where, c.config, "config");
      if (c.wideConfig !== undefined) exists(where, c.wideConfig, "wideConfig");
      if (isObject(c.toolVersions) && c.toolVersions.tla2tools !== pinned.tla2tools.version)
        bad(
          where,
          `toolVersions.tla2tools must be ${pinned.tla2tools.version} (the pinned toolchain); rerun the check after a toolchain bump and update it`,
        );
      const mutants = c.mutants;
      if (!Array.isArray(mutants) || mutants.length === 0)
        bad(where, "a tlc check needs at least one mutant that must fail");
      else
        mutants.forEach((m: unknown, j: number) => {
          const mw = `${where}.mutants[${j}]`;
          if (!isObject(m)) {
            bad(mw, "not an object");
            return;
          }
          if (!isString(m.name)) bad(mw, "name is required");
          if (m.expect !== "violation") bad(mw, 'expect must be "violation"');
          if (m.config === undefined && m.spec === undefined)
            bad(mw, "set config and/or spec (the mutated part)");
          if (m.config !== undefined) exists(mw, m.config, "config");
          if (m.spec !== undefined) exists(mw, m.spec, "spec");
          const v = m.violates;
          if (v !== undefined && (!isObject(v) || !VIOLATIONS.includes(v.kind as ViolationKind)))
            bad(mw, `violates.kind must be one of ${VIOLATIONS.join("|")}`);
          if (m.deadlock !== undefined && m.deadlock !== "check" && m.deadlock !== "allow")
            bad(mw, "deadlock must be check|allow");
        });
    }
    if (c.kind === "replay") {
      if (!isStrings(c.replay) || c.replay.length === 0)
        bad(where, "a replay check needs replay: [test file paths]");
      else for (const r of c.replay) exists(where, r, "replay");
    }
    if ((c.kind === "property" || c.kind === "exhaustive") && !isString(c.command))
      bad(where, "property/exhaustive checks need the command that runs them (under turbo test)");
  });
  return problems;
};

export const loadManifest = (file = MANIFEST, root = REPO_ROOT): Manifest => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ManifestError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = validateManifest(raw, root);
  if (problems.length) throw new ManifestError(`${file} is invalid:\n  ${problems.join("\n  ")}`);
  return raw as Manifest;
};

// ---------------------------------------------------------------------------------------------
// TLC

/** Flags pinned for reproducible runs: one worker, fixed fingerprint seed, metadir in the cache. */
export const TLC_FLAGS = ["-workers", "1", "-fp", "0", "-lncheck", "final", "-cleanup"] as const;

export type TlcOutcome =
  | { readonly verdict: "pass"; readonly states: string }
  | {
      readonly verdict: "violation";
      readonly kind: ViolationKind;
      readonly name?: string;
      readonly states: string;
    }
  | { readonly verdict: "error"; readonly reason: string }
  | { readonly verdict: "timeout"; readonly seconds: number };

const VIOLATION_EXIT: Record<number, ViolationKind[]> = {
  11: ["deadlock"],
  12: ["invariant", "action"],
  // TLC 1.7.4 exits 13 (VIOLATION_LIVENESS) for a violated action property such as [][A]_v.
  13: ["temporal", "action"],
  14: ["assert"],
};

/**
 * Classifies one TLC run from its exit status and output. A pass needs exit 0, the completion
 * line and an empty queue; a violation needs a violation exit code and the matching error line.
 * Anything else (parse/semantic 150, config 151, exception 255, bad option 1, a missing marker)
 * is an error, so a broken model can never count as a passing base or a failing mutant.
 */
export const classifyTlc = (status: number | null, output: string): TlcOutcome => {
  const states = /(\d[\d,]*) distinct states found/.exec(output)?.[1] ?? "?";
  const firstError = /^Error: .*$/m.exec(output)?.[0];
  if (/^\*\*\* ?(?:Errors|Abort messages|Parse Error)/m.test(output) || status === 150)
    return { verdict: "error", reason: `parse or semantic error (exit ${status})` };
  if (status === 151)
    return { verdict: "error", reason: `config error: ${firstError ?? "exit 151"}` };
  if (status === 0) {
    if (
      /^Model checking completed\. No error has been found\./m.test(output) &&
      / 0 states left on queue/.test(output)
    )
      return { verdict: "pass", states };
    return { verdict: "error", reason: "TLC exited 0 without completing the search" };
  }
  const kinds = status === null ? undefined : VIOLATION_EXIT[status];
  if (kinds) {
    const invariant = /^Error: Invariant (\S+) is violated/m.exec(output);
    if (kinds.includes("invariant") && invariant?.[1])
      return { verdict: "violation", kind: "invariant", name: invariant[1], states };
    const action = /^Error: Action property (\S+) is violated/m.exec(output);
    if (kinds.includes("action") && action?.[1])
      return { verdict: "violation", kind: "action", name: action[1], states };
    if (kinds.includes("deadlock") && /^Error: Deadlock reached\./m.test(output))
      return { verdict: "violation", kind: "deadlock", states };
    if (kinds.includes("temporal") && /^Error: Temporal properties were violated\./m.test(output))
      return { verdict: "violation", kind: "temporal", states };
    if (
      kinds.includes("assert") &&
      /^Error: The first argument of Assert evaluated to FALSE/m.test(output)
    )
      return { verdict: "violation", kind: "assert", states };
  }
  return {
    verdict: "error",
    reason: `TLC exit ${status}: ${firstError ?? "no violation named in the output"}`,
  };
};

type RunResult = { status: number | null; output: string; timedOut: boolean; seconds: number };

const run = (cmd: string, args: readonly string[], cwd: string, timeoutSeconds: number) =>
  new Promise<RunResult>((resolve) => {
    const started = performance.now();
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    const done = (status: number | null, extra = "") => {
      clearTimeout(timer);
      resolve({
        status,
        output: Buffer.concat(chunks).toString("utf8") + extra,
        timedOut,
        seconds: (performance.now() - started) / 1000,
      });
    };
    child.on("error", (e) => done(null, `\nspawn failed: ${e.message}`));
    child.on("close", (code) => done(code));
  });

const rel = (p: string) => path.relative(REPO_ROOT, p) || ".";

export type TlcRun = {
  readonly label: string;
  readonly spec: string;
  readonly config: string;
  readonly deadlock: Deadlock;
  readonly timeoutSeconds: number;
};

export const runTlc = async (
  tools: Pick<Toolchain, "jar" | "java">,
  r: TlcRun,
  logDir: string,
): Promise<{ outcome: TlcOutcome; seconds: number; log: string }> => {
  const spec = path.resolve(REPO_ROOT, r.spec);
  const config = path.resolve(REPO_ROOT, r.config);
  const slug = r.label.replace(/[^\w.-]+/g, "_");
  const metadir = path.join(CACHE_DIR, "tlc", slug);
  rmSync(metadir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
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
  const res = await run(tools.java, args, path.dirname(spec), r.timeoutSeconds);
  const log = path.join(logDir, `${slug}.log`);
  writeFileSync(log, `$ ${tools.java} ${args.join(" ")}\n${res.output}`);
  rmSync(metadir, { recursive: true, force: true });
  const outcome: TlcOutcome = res.timedOut
    ? { verdict: "timeout", seconds: r.timeoutSeconds }
    : classifyTlc(res.status, res.output);
  return { outcome, seconds: res.seconds, log };
};

// ---------------------------------------------------------------------------------------------
// Checks

const DEFAULT_TIMEOUT = 300;
const LOG_DIR = path.join(CACHE_DIR, "logs");

export type CheckResult = {
  readonly id: string;
  readonly ok: boolean;
  readonly skipped?: string;
  readonly seconds: number;
  readonly lines: string[];
};

const describe = (o: TlcOutcome): string => {
  switch (o.verdict) {
    case "pass":
      return `passed, ${o.states} distinct states`;
    case "violation":
      return `${o.kind} violation${o.name ? ` of ${o.name}` : ""} after ${o.states} distinct states`;
    case "error":
      return `error: ${o.reason}`;
    case "timeout":
      return `timeout after ${o.seconds}s (an incomplete search is a failure)`;
  }
};

const tail = (file: string, n = 25) => readFileSync(file, "utf8").trimEnd().split("\n").slice(-n);

export const runTlcCheck = async (
  check: Check,
  tools: Pick<Toolchain, "jar" | "java">,
  opts: { wide: boolean; logDir?: string },
): Promise<CheckResult> => {
  const logDir = opts.logDir ?? LOG_DIR;
  const lines: string[] = [];
  let ok = true;
  let seconds = 0;
  const wide = opts.wide && check.wideConfig !== undefined;
  const timeout =
    (wide ? check.wideTimeoutSeconds : undefined) ?? check.timeoutSeconds ?? DEFAULT_TIMEOUT;
  const base = await runTlc(
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
    `${baseOk ? "ok  " : "FAIL"} ${wide ? "wide" : "base"} ${rel(path.resolve(REPO_ROOT, (wide ? check.wideConfig : check.config) ?? ""))}: ${describe(base.outcome)} (${base.seconds.toFixed(1)}s)`,
  );
  if (!baseOk)
    lines.push(`     log ${rel(base.log)}:`, ...tail(base.log).map((l) => `     | ${l}`));
  for (const m of check.mutants ?? []) {
    const res = await runTlc(
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
    if (o.verdict === "violation" && m.violates) {
      const kindOk = o.kind === m.violates.kind;
      const nameOk = m.violates.name === undefined || o.name === m.violates.name;
      if (!kindOk || !nameOk) {
        mutantOk = false;
        why = ` -- expected ${m.violates.kind}${m.violates.name ? ` of ${m.violates.name}` : ""}`;
      }
    }
    if (o.verdict === "error" || o.verdict === "timeout")
      why = " -- only a genuine violation counts for a mutant";
    ok &&= mutantOk;
    lines.push(
      `${mutantOk ? "ok  " : "FAIL"} mutant ${m.name}: ${describe(o)}${why} (${res.seconds.toFixed(1)}s)`,
    );
    if (!mutantOk)
      lines.push(`     log ${rel(res.log)}:`, ...tail(res.log).map((l) => `     | ${l}`));
  }
  return { id: check.id, ok, seconds, lines };
};

/**
 * Runs each replay harness in its own `bun test` so every file must execute at least one
 * passing test: an empty or all-skipped harness would otherwise pass while checking nothing.
 */
export const runReplayCheck = async (check: Check): Promise<CheckResult> => {
  const timeout = check.timeoutSeconds ?? DEFAULT_TIMEOUT;
  const lines: string[] = [];
  let ok = true;
  let seconds = 0;
  for (const f of check.replay ?? []) {
    const file = `./${path.normalize(f)}`;
    const res = await run(process.execPath, ["test", file], REPO_ROOT, timeout);
    seconds += res.seconds;
    const count = (word: string) =>
      Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(res.output)?.[1] ?? 0);
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
      `${fileOk ? "ok  " : "FAIL"} bun test ${file}: ${pass} pass, ${fail} fail, ${skip} skip, ${todo} todo${why ? ` -- ${why}` : ""} (${res.seconds.toFixed(1)}s)`,
    );
    if (!fileOk)
      lines.push(
        ...res.output
          .trimEnd()
          .split("\n")
          .slice(-30)
          .map((l) => `     | ${l}`),
      );
  }
  return { id: check.id, ok, seconds, lines };
};

// ---------------------------------------------------------------------------------------------
// Digests

export type DigestDrift = {
  readonly check: Check;
  readonly files: { readonly path: string; readonly problem: "changed" | "missing" }[];
};

export const digestDrift = (manifest: Manifest, root = REPO_ROOT): DigestDrift[] =>
  manifest.checks.flatMap((check) => {
    const files = check.coveredFiles.flatMap((f): DigestDrift["files"] => {
      const p = path.join(root, f.path);
      if (!existsSync(p)) return [{ path: f.path, problem: "missing" as const }];
      return sha256Of(p) === f.sha256 ? [] : [{ path: f.path, problem: "changed" as const }];
    });
    return files.length ? [{ check, files }] : [];
  });

/** Tier 0 and 1 drift fails the PR gate; tier 2+ and blocked checks only warn. */
export const driftBlocks = (d: DigestDrift) => d.check.tier <= 1 && d.check.status !== "blocked";

export const updateDigests = (file = MANIFEST, root = REPO_ROOT): string[] => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const changed: string[] = [];
  for (const check of raw.checks)
    for (const f of check.coveredFiles) {
      const p = path.join(root, f.path);
      if (!existsSync(p)) throw new ManifestError(`${check.id}: covered file ${f.path} is missing`);
      const sha = sha256Of(p);
      if (sha !== f.sha256) {
        changed.push(`${check.id}: ${f.path}`);
        f.sha256 = sha;
      }
    }
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  // Keep the file in Biome's JSON style so `bun run lint` stays green after an update.
  const biome = path.join(root, "node_modules/.bin/biome");
  if (existsSync(biome)) spawnSync(biome, ["format", "--write", file], { stdio: "ignore" });
  return changed;
};

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
  mutants: [{ name: "bound", config: `${SELFTEST}/Counter_mutant_bound.cfg`, expect: "violation" }],
  timeoutSeconds: 60,
  coveredFiles: [],
  guardedSymbols: [],
  bounds: "",
  assumptions: [],
  toolVersions: {},
  ...over,
});

export const selftest = async (tools: Pick<Toolchain, "jar" | "java">): Promise<CheckResult> => {
  const started = performance.now();
  const logDir = path.join(CACHE_DIR, "logs", "selftest");
  const neg = `${SELFTEST}/negative`;
  const cases: { name: string; reason: RegExp; check: Check; kind?: "replay" }[] = [
    {
      name: "a mutant that passes",
      reason: /mutant vacuous: passed/,
      check: selftestCheck({
        mutants: [{ name: "vacuous", config: `${neg}/Counter_vacuous.cfg`, expect: "violation" }],
      }),
    },
    {
      name: "a base config that violates",
      reason: /base .*invariant violation of WithinBound/,
      check: selftestCheck({ config: `${SELFTEST}/Counter_mutant_bound.cfg` }),
    },
    {
      name: "a parse error in the mutant spec",
      reason: /mutant parse: error: parse or semantic error/,
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
      reason: /base .*error: parse or semantic error/,
      check: selftestCheck({ spec: `${neg}/Broken.tla`, config: `${neg}/Broken.cfg` }),
    },
    {
      name: "a config naming an undefined invariant",
      reason: /mutant config: error: config error/,
      check: selftestCheck({
        mutants: [{ name: "config", config: `${neg}/Counter_undefined.cfg`, expect: "violation" }],
      }),
    },
    {
      name: "a mutant that breaks a different property than declared",
      reason: /expected invariant of TypeOK/,
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
      name: "a TLC timeout",
      reason: /base .*timeout after 3s/,
      check: selftestCheck({
        spec: `${neg}/Slow.tla`,
        config: `${neg}/Slow.cfg`,
        timeoutSeconds: 3,
        mutants: [],
      }),
    },
    {
      name: "a failing replay harness",
      reason: /1 fail.* -- exit 1/,
      kind: "replay",
      check: selftestCheck({ kind: "replay", replay: [`${neg}/failing.replay-fixture.ts`] }),
    },
    {
      name: "a replay harness that runs no test",
      reason: /no test ran/,
      kind: "replay",
      check: selftestCheck({ kind: "replay", replay: [`${neg}/skipped-only.replay-fixture.ts`] }),
    },
    {
      name: "a replay harness that skips a step",
      reason: /skipped or todo/,
      kind: "replay",
      check: selftestCheck({ kind: "replay", replay: [`${neg}/partly-skipped.replay-fixture.ts`] }),
    },
  ];
  const lines: string[] = [];
  let ok = true;
  for (const c of cases) {
    const r =
      c.kind === "replay"
        ? await runReplayCheck(c.check)
        : await runTlcCheck(c.check, tools, { wide: false, logDir });
    const detail = r.lines.find((l) => l.startsWith("FAIL"))?.slice(5) ?? "every run passed";
    // The failure must be the one the fixture provokes, not an unrelated error in the fixture.
    const reported = !r.ok && c.reason.test(detail);
    ok &&= reported;
    lines.push(
      `${reported ? "ok  " : "FAIL"} reports ${c.name} as a failure: ${detail}${reported ? "" : ` -- expected ${c.reason}`}`,
    );
  }
  // Checksum mismatches fail closed, for an override and for a download.
  const fake = path.join(CACHE_DIR, "selftest-not-a-jar.jar");
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(fake, "not tla2tools\n");
  const closed = async (name: string, attempt: () => Promise<unknown>, leftover?: string) => {
    let message = "";
    try {
      await attempt();
    } catch (error) {
      if (error instanceof ToolchainError) message = error.message;
      else throw error;
    }
    const clean = leftover === undefined || !existsSync(leftover);
    const good = /checksum mismatch/.test(message) && clean;
    ok &&= good;
    lines.push(
      `${good ? "ok  " : "FAIL"} fails closed on ${name}${good ? "" : `: ${message || "no error raised"}${clean ? "" : `, left ${rel(leftover ?? "")}`}`}`,
    );
  };
  await closed("a TLA2TOOLS override with the wrong checksum", () =>
    ensureJar({ TLA2TOOLS: fake }),
  );
  await closed(
    "a download with the wrong checksum",
    () =>
      ensureJar(
        {},
        { version: "selftest", url: `file://${fake}`, sha256: pinned.tla2tools.sha256 },
      ),
    path.join(CACHE_DIR, "tla2tools-selftest.jar"),
  );
  rmSync(fake, { force: true });
  // A relative override is resolved before it is checksummed, so TLC loads the verified file.
  const relative = path.relative(process.cwd(), tools.jar);
  const viaRelative = await runTlcCheck(
    selftestCheck({ id: "selftest.relative-override" }),
    { java: tools.java, jar: await ensureJar({ TLA2TOOLS: relative }) },
    { wide: false, logDir },
  );
  ok &&= viaRelative.ok;
  lines.push(
    `${viaRelative.ok ? "ok  " : "FAIL"} runs the verified jar from a relative TLA2TOOLS=${relative}${viaRelative.ok ? "" : `: ${viaRelative.lines.join("; ")}`}`,
  );
  return { id: "runner self-test", ok, seconds: (performance.now() - started) / 1000, lines };
};

// ---------------------------------------------------------------------------------------------
// CLI

const out = (line = "") => process.stdout.write(`${line}\n`);

type Args = {
  wide: boolean;
  only: string[];
  mode: "all" | "check-digests" | "update-digests" | "selftest";
};

export const parseArgs = (argv: readonly string[]): Args => {
  const args: Args = { wide: false, only: [], mode: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wide") args.wide = true;
    else if (a === "--only") {
      const id = argv[++i];
      if (!id) throw new ManifestError("--only needs a check id");
      args.only.push(id);
    } else if (a === "--check-digests") args.mode = "check-digests";
    else if (a === "--update-digests") args.mode = "update-digests";
    else if (a === "--selftest") args.mode = "selftest";
    else throw new ManifestError(`unknown argument ${a}`);
  }
  return args;
};

const printDrift = (drift: DigestDrift[]): boolean => {
  if (!drift.length) {
    out("ok   covered-file digests match the working tree");
    return true;
  }
  const blocking = drift.filter(driftBlocks);
  for (const d of drift) {
    const label = driftBlocks(d) ? "FAIL" : "warn";
    const note = d.check.status === "blocked" ? ` (blocked: ${d.check.blockedReason})` : "";
    out(`${label} ${d.check.id} [tier ${d.check.tier}, skill ${d.check.skill}]${note}`);
    for (const f of d.files) out(`       ${f.problem}: ${f.path}`);
  }
  const skills = [...new Set(drift.map((d) => d.check.skill))];
  out();
  out(`Covered code changed for: ${skills.join(", ")}.`);
  out("Run /maintain-formal-verification-skill on those skills and classify each check as");
  out(
    "in sync, updated, bug or blocked. Then, in a maintenance commit separate from product fixes,",
  );
  out("run `bun run verify:formal --update-digests` (never advance a blocked check's syncCommit).");
  if (!blocking.length)
    out("Only tier 2+ or blocked checks drifted: this warns and does not fail the PR gate.");
  return blocking.length === 0;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const started = performance.now();
  const args = parseArgs(argv);
  if (args.mode === "update-digests") {
    loadManifest();
    const changed = updateDigests();
    out(changed.length ? `updated:\n  ${changed.join("\n  ")}` : "digests already match");
    return 0;
  }
  const manifest = loadManifest();
  if (args.mode === "check-digests") return printDrift(digestDrift(manifest)) ? 0 : 1;

  const unknown = args.only.filter((id) => !manifest.checks.some((c) => c.id === id));
  if (unknown.length) throw new ManifestError(`--only: no check named ${unknown.join(", ")}`);
  const selected = manifest.checks.filter((c) => !args.only.length || args.only.includes(c.id));
  const needsTlc =
    args.mode === "selftest" ||
    (!args.only.length && args.mode === "all") ||
    selected.some((c) => c.kind === "tlc" && c.status !== "blocked");
  const tools = needsTlc ? await ensureToolchain() : undefined;
  if (tools)
    out(`toolchain: tla2tools ${tools.tlaVersion} (sha256 verified), java ${tools.javaVersion}`);

  const results: CheckResult[] = [];
  const report = (r: CheckResult) => {
    results.push(r);
    const state = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
    out(`${state} ${r.id} (${r.seconds.toFixed(1)}s)${r.skipped ? ` -- ${r.skipped}` : ""}`);
    for (const l of r.lines) out(`  ${l}`);
  };
  let digestsOk = true;
  if (tools && (args.mode === "selftest" || !args.only.length)) report(await selftest(tools));
  if (args.mode === "all" && !args.only.length) digestsOk = printDrift(digestDrift(manifest));
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
      if (c.kind === "tlc" && tools) report(await runTlcCheck(c, tools, { wide: args.wide }));
      else if (c.kind === "replay") report(await runReplayCheck(c));
      else
        report({
          id: c.id,
          ok: true,
          seconds: 0,
          skipped: `${c.kind} check runs under turbo test: ${c.command}`,
          lines: [],
        });
    }
  const failed = results.filter((r) => !r.ok);
  const total = (performance.now() - started) / 1000;
  out();
  out(
    `${failed.length || !digestsOk ? "FAILED" : "PASSED"}: ${results.filter((r) => r.ok && !r.skipped).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped${digestsOk ? "" : ", digests drifted"} in ${total.toFixed(1)}s`,
  );
  return failed.length || !digestsOk ? 1 : 0;
};

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const known = error instanceof ManifestError || error instanceof ToolchainError;
      process.stderr.write(`${error instanceof Error && known ? error.message : String(error)}\n`);
      process.exit(known && error instanceof ManifestError ? 2 : 1);
    },
  );
}
