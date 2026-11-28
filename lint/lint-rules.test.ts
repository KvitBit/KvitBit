import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

interface RuleCase {
  readonly rule: string;
  readonly invalid: string;
  readonly valid: string;
  readonly additionalRules?: readonly string[];
}

const effectImport = 'import * as Effect from "effect/Effect";';
const runEffect = `${effectImport}\nEffect.runSync(work);`;
const aliasedEffectImport = 'import * as Fx from "effect/Effect";';
const rootEffectImport = 'import * as Lib from "effect";';

const ruleCases: readonly RuleCase[] = [
  {
    rule: "no-bare-promises",
    invalid: "Promise [ 'all' ] ( [a] );",
    valid: 'export const run = Effect.all([work], { concurrency: "unbounded" });',
  },
  {
    rule: "no-chained-type-assertions",
    invalid: 'export const value = ("text" as unknown) as number;',
    valid: 'export const value = "text" as const;',
    additionalRules: ["no-known-value-widening"],
  },
  {
    rule: "no-conditional-empty-object-spread",
    invalid: "export const config = { ...base, ...(flag ? { limit: 1 } : {}) };",
    valid: "export const config = flag ? { ...base, limit: 1 } : base;",
  },
  {
    rule: "no-direct-effect-runs",
    invalid: 'import * as Fx from "effect/Effect"; export const result = Fx.runSyncExit(work);',
    valid: `${effectImport}\nexport const result = Effect.map(work, (item) => item.id);`,
  },
  {
    rule: "no-direct-process-env",
    invalid: "export const value = process['env'].NODE_ENV;",
    valid: 'export const value = Config.string("NODE_ENV");',
  },
  {
    rule: "no-known-value-widening",
    invalid: "export const data: object = { count: 1 };",
    valid: "export const data = { count: 1 } satisfies { count: number };",
  },
  {
    rule: "no-object-parameters",
    invalid: "export const id = (item: object) => item;",
    valid: "export const id = (item: { id: string }) => item.id;",
  },
  {
    rule: "no-repeated-computed-conditional-operand",
    invalid: "export const name = items[key] ? items[key].name : null;",
    valid: "const item = items[key]; export const name = item ? item.name : null;",
  },
  {
    rule: "no-runtime-typeof",
    invalid: 'export const valid = typeof input === "string";',
    valid: "export type Person = typeof Person.Type;",
  },
  {
    rule: "no-synchronous-subprocess",
    invalid: 'import { execFileSync as run } from "node:child_process"; run("git");',
    valid: 'export const git = ChildProcess.make("git", ["status"]);',
  },
  {
    rule: "no-throw-in-effect-modules",
    invalid: "export const run = () => { throw new Error('invalid'); };",
    valid: 'export const run = () => Effect.fail(Invalid.make({ code: "invalid" }));',
  },
  {
    rule: "no-try-catch",
    invalid: "try { perform(); } finally { cleanup(); }",
    valid: "export const run = Effect.ensuring(work, cleanup);",
  },
  {
    rule: "no-unknown-parameters",
    invalid: "export const inspect = (input: unknown) => input;",
    valid: "export const inspect = (cause: unknown) => Cause.die(cause);",
  },
  {
    rule: "no-unknown-type-aliases",
    invalid: "export type Item = unknown;",
    valid: "export type Item = typeof Item.Type;",
  },
  {
    rule: "no-unsafe-dictionary-type",
    invalid: "export type Dictionary = Record<string, unknown>;",
    valid: "export type Dictionary = Record<string, string | { count: number }>;",
  },
  {
    rule: "no-useless-alias",
    invalid: "const name = 'Anna'; const alias = name; console.log(alias);",
    valid: "let name = 'Anna'; const snapshot = name; name = 'Mila'; console.log(snapshot);",
  },
  {
    rule: "no-widen-then-assert",
    invalid: "const value: unknown = 1; export const number = value as number;",
    valid: "const value = 1; export const number = Number(value);",
    additionalRules: ["no-known-value-widening"],
  },
  {
    rule: "prefer-effect-fn",
    invalid: "export const run = () => Effect.gen(function* () { return yield* work; });",
    valid: 'export const run = Effect.fn("run")(function* () { return yield* work; });',
  },
  {
    rule: "prefer-effect-value",
    invalid: 'export const run = Effect.fn("load")(() => Effect.sync(read));',
    valid: 'Effect.sync(read).pipe(Effect.withSpan("x"));',
  },
  {
    rule: "prefer-effect-when",
    invalid: "export const run = flag ? work : Effect.void;",
    valid: "export const run = Effect.when(work, () => flag);",
  },
];

const serverEntryCases = Arr.map(["main", "migrate", "worker"], (entry) => ({
  file: `apps/server/src/${entry}.ts`,
  source: runEffect,
  rules: [],
}));

const scopeCases = [
  ...serverEntryCases,
  {
    file: "apps/web/src/entry.ts",
    source: `${runEffect}\nPromise.resolve(1);`,
    rules: ["no-bare-promises"],
  },
  {
    file: "packages/domain/src/apps/web/src/entry.ts",
    source: runEffect,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "packages/domain/src/apps/mobile/src/config/env.ts",
    source: "export const origin = process.env.EXPO_PUBLIC_ORIGIN;",
    rules: ["no-direct-process-env"],
  },
  {
    file: "apps/server/src/runner-import.ts",
    source: 'import { runSync as run, runPromiseExit } from "effect/Effect";',
    rules: ["no-direct-effect-runs", "no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/unrelated-import.ts",
    source: 'import { runSync } from "./process";',
    rules: [],
  },
  {
    file: "apps/server/src/runner-callback.ts",
    source: 'import { Schema, Effect as Fx } from "effect";\nFx.runCallback(work);',
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-destructure.ts",
    source: `${effectImport}\nconst { runSync } = Effect;\nrunSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-destructure-renamed.ts",
    source: `${effectImport}\nconst { runFork: start } = Effect;\nstart(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace.ts",
    source: 'import * as Lib from "effect";\nLib.Effect.runSync(work);',
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-computed.ts",
    source: 'import * as Lib from "effect";\nLib [ "Effect" ] [ "runSync" ] (work);',
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-binding.ts",
    source: `${rootEffectImport}\nconst { Effect } = Lib;\nEffect.runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-binding-alias.ts",
    source: `${rootEffectImport}\nconst { Effect: Fx } = Lib;\nFx.runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-binding-export.ts",
    source: `${rootEffectImport}\nexport const { ["Effect"]: Fx } = Lib;\nFx.runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-binding-valid.ts",
    source: `${rootEffectImport}\nconst { Effect } = Lib;\nEffect.succeed(1);`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-namespace-binding-local.ts",
    source: `${rootEffectImport}\nfunction run() { const { Effect: Fx } = Lib; return Fx.runSync(work); }`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-binding-shadow.ts",
    source: `${rootEffectImport}\nconst { Effect: Fx } = Lib;\nfunction run(Fx: { runSync(): number }) { return Fx.runSync(); }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-namespace-source-shadow.ts",
    source: `${rootEffectImport}\nfunction run(Lib: { Effect: { runSync(): number } }) { const { Effect } = Lib; return Effect.runSync(); }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-nested-extraction.ts",
    source: `${rootEffectImport}\nconst { Effect: { runSync } } = Lib;\nrunSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-nested-assignment.ts",
    source: `${rootEffectImport}\nlet run;\n({ Effect: { runSync: run } } = Lib);\nrun(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-nested-computed-extraction.ts",
    source: `${rootEffectImport}\nconst { Effect: { succeed, ["runSync"]: run } } = Lib;`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-nested-computed-assignment.ts",
    source: `${rootEffectImport}\nlet run;\n({ Effect: { ["runSync"]: run } } = Lib);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-destructure-computed-assignment.ts",
    source: `${aliasedEffectImport}\nlet run;\n({ ["runSync"]: run } = Fx);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-destructure-dynamic-key.ts",
    source: `${aliasedEffectImport}\nconst runSync = "succeed";\nconst { [runSync]: make } = Fx;`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-destructure-assignment.ts",
    source: `${aliasedEffectImport}\nlet runSync;\n({ runSync } = Fx);\nrunSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-assignment.ts",
    source: `${rootEffectImport}\nlet Effect;\n({ Effect } = Lib);\nEffect.runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-assignment-valid.ts",
    source: `${rootEffectImport}\nlet Fx;\n({ Effect: Fx } = Lib);\nFx.succeed(1);`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-namespace-assignment-alias.ts",
    source: `${rootEffectImport}\nlet Fx;\n({ Effect: Fx } = Lib);\nFx.runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-namespace-assignment-local.ts",
    source: `${rootEffectImport}\nfunction run() { let Fx; ({ Effect: Fx } = Lib); return Fx.runSync(work); }`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-parenthesized.ts",
    source: `${aliasedEffectImport}\n(Fx).runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-wrapped.ts",
    source: `${effectImport}\n((Effect satisfies typeof Effect)).runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-wrapped-unrelated.ts",
    source: `${aliasedEffectImport}\n(makeMock(Fx)).runSync();`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-root-import.ts",
    source: 'import { Effect } from "effect";\nEffect.runFork(work);',
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-shadow.ts",
    source:
      'import * as Fx from "effect/Effect";\nexport const mapped = Fx.map(work, f);\nexport const f = (Fx: { runSync(): number }) => Fx.runSync();',
    rules: [],
  },
  {
    file: "apps/server/src/runner-same-name.ts",
    source:
      'import * as Fx from "effect/Effect";\nFx.runSync(work);\nexport const f = (Fx: { runSync(): number }) => Fx.runSync();',
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-block-shadow.ts",
    source: `${runEffect}\n{\nconst Effect = mock();\nEffect.runSync();\n}`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-constructor-shadow.ts",
    source: `${aliasedEffectImport}\nclass Demo { constructor(Fx: { runSync(): number }) { Fx.runSync(); } }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-constructor-property-shadow.ts",
    source: `${aliasedEffectImport}\nclass Demo { constructor(private Fx: { runSync(): number }) { Fx.runSync(); } }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-constructor-default-callback.ts",
    source: `${aliasedEffectImport}\ntype Options = { map?: (n: number) => number };\nclass Demo { constructor({ map = (Fx: number) => Fx }: Options = {}) { Fx.runSync(Fx.succeed(map(1))); } }`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-constructor-nested-binding.ts",
    source: `${aliasedEffectImport}\nclass Demo { constructor({ items: [Fx] }: { items: [{ runSync(): number }] }) { Fx.runSync(); } }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-for-of-shadow.ts",
    source: `${aliasedEffectImport}\nfor (const Fx of items) { Fx.runSync(); }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-for-of-default-callback.ts",
    source: `${aliasedEffectImport}\ntype Options = { map?: (n: number) => number };\nfunction each(options: Options[]) { for (const { map = (Fx: number) => Fx } of options) { Fx.runSync(Fx.succeed(map(1))); } }`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-for-of-computed-callback.ts",
    source: `${aliasedEffectImport}\nconst key = (map: (key: "item") => "item") => map("item");\nfunction each(items: { item: number }[]) { for (const { [key((Fx) => Fx)]: item } of items) { Fx.runSync(Fx.succeed(item)); } }`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/server/src/runner-for-in-shadow.ts",
    source: `${aliasedEffectImport}\nfor (const Fx in items) { Fx.runSync(); }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-for-shadow.ts",
    source: `${aliasedEffectImport}\nfor (let Fx = mock(); keepGoing(); step()) { Fx.runSync(); }`,
    rules: [],
  },
  {
    file: "apps/server/src/runner-unshadowed-import.ts",
    source: `${aliasedEffectImport}\nclass Demo { constructor(Fx: { runSync(): number }) { Fx.runSync(); } }\nfor (const Fx of items) { Fx.runSync(); }\nFx.runSync(work);`,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "apps/mobile/src/runtime/request-intent.ts",
    source: runEffect,
    rules: [],
  },
  {
    file: "apps/mobile/src/runtime/reusable.ts",
    source: runEffect,
    rules: ["no-direct-effect-runs"],
  },
  {
    file: "packages/domain/src/mapped-unknown.ts",
    source: "export type Meta = { [K in string]: unknown };",
    rules: ["no-unsafe-dictionary-type"],
  },
  {
    file: "packages/domain/src/mapped-empty.ts",
    source: "export type Meta = { readonly [K in string]?: {} };",
    rules: ["no-unsafe-dictionary-type"],
  },
  {
    file: "packages/domain/src/mapped-value.ts",
    source: "export type Meta = { [K in string]: { count: number } };",
    rules: [],
  },
  {
    file: "apps/mobile/src/config/env.ts",
    source: "export const origin = process.env.EXPO_PUBLIC_ORIGIN;",
    rules: [],
  },
  {
    file: "apps/mobile/app/route.tsx",
    source: "export const route = () => { throw new Error('invalid'); };",
    rules: ["no-throw-in-effect-modules"],
  },
  {
    file: "packages/db/src/probe.ts",
    source: "export const run = () => { throw new Error('invalid'); };",
    rules: ["no-throw-in-effect-modules"],
  },
  {
    file: "packages/brand/src/mark.ts",
    source: "throw new TypeError();",
    rules: [],
  },
  {
    file: "packages/brand/src/new-module.ts",
    source: "throw new Error();",
    rules: ["no-throw-in-effect-modules"],
  },
  {
    file: "infra/alchemy/src/promise.ts",
    source: "globalThis.Promise.reject(error);",
    rules: ["no-bare-promises"],
  },
  {
    file: "packages/adapters/src/env.ts",
    source: "globalThis.process.env.NODE_ENV;",
    rules: ["no-direct-process-env"],
  },
  {
    file: "packages/adapters/src/recover.ts",
    source: "try { perform(); } catch { recover(); }",
    rules: ["no-try-catch"],
  },
  {
    file: "packages/core/src/typed-parameter.ts",
    source: "const run = (because: unknown) => because;",
    rules: ["no-unknown-parameters"],
  },
  {
    file: "packages/core/src/probe.test.ts",
    source: `${runEffect}\nPromise.resolve(1); throw new Error('fixture');`,
    rules: [],
  },
  {
    file: "apps/mobile/src/testing/probe.ts",
    source: `${runEffect}\nthrow new Error('fixture');`,
    rules: [],
  },
  {
    file: "packages/core/src/test/fixture.ts",
    source: `${runEffect}\nthrow new Error('fixture');`,
    rules: [],
  },
  {
    file: "packages/core/src/generated/probe.ts",
    source: `${runEffect}\nexport type Value = unknown;`,
    rules: [],
  },
  {
    file: "formal/probe.replay.test.ts",
    source: `${runEffect}\nthrow new Error('fixture');`,
    rules: [],
  },
];

const report = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      diagnostics: Schema.Array(
        Schema.Struct({
          category: Schema.String,
          message: Schema.String,
          severity: Schema.String,
          location: Schema.Struct({ path: Schema.String }),
        }),
      ),
    }),
  ),
);
const ruleLabel = /^\[(?:anti-slop\/)?([\w-]+)\]/;

test("Biome enforces every GritQL rule and keeps its configured path boundaries", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-lint-rules-" });
    const lintFiles = yield* fs.readDirectory(path.join(root, "lint"));
    const plugins = Arr.filter(lintFiles, Str.endsWith(".grit"));
    expect(Arr.sort(plugins, Order.String)).toEqual(
      Arr.sort(
        Arr.map(ruleCases, ({ rule }) => `${rule}.grit`),
        Order.String,
      ),
    );

    for (const config of ["biome.jsonc", "packages/db/biome.json"]) {
      const target = path.join(scratch, config);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.copyFile(path.join(root, config), target);
    }
    yield* fs.makeDirectory(path.join(scratch, "lint"));
    for (const plugin of plugins) {
      yield* fs.copyFile(path.join(root, "lint", plugin), path.join(scratch, "lint", plugin));
    }

    const cases = [...scopeCases];
    for (const { rule, invalid, valid, additionalRules = [] } of ruleCases) {
      cases.push(
        {
          file: `packages/core/src/${rule}-invalid.ts`,
          source: invalid,
          rules: [rule, ...additionalRules],
        },
        { file: `packages/core/src/${rule}-valid.ts`, source: valid, rules: [] },
      );
    }
    for (const { file, source } of cases) {
      const target = path.join(scratch, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, `${source}\n`);
    }

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        path.join(root, "node_modules/.bin/biome"),
        [
          "lint",
          "--only=plugin",
          "--reporter=json",
          "--max-diagnostics=none",
          "--vcs-enabled=false",
          ...Arr.map(cases, ({ file }) => file),
        ],
        { cwd: scratch },
      ),
    );
    const { stdout, stderr, exitCode } = yield* Effect.all(
      {
        stdout: handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        stderr: handle.stderr.pipe(Stream.decodeText, Stream.mkString),
        exitCode: handle.exitCode,
      },
      { concurrency: "unbounded" },
    );
    expect(stdout, stderr).not.toBe("");
    expect(Number(exitCode)).toBe(1);
    const { diagnostics } = yield* report(stdout);
    const actual = Arr.map(diagnostics, ({ category, severity, message, location }) => {
      expect(category).toBe("plugin");
      expect(severity).toBe("error");
      const rule = ruleLabel.exec(message)?.[1];
      expect(rule, message).toBeDefined();
      return `${location.path} ${rule}`;
    });
    const expected = Arr.flatMap(cases, ({ file, rules }) =>
      Arr.map(rules, (rule) => `${file} ${rule}`),
    );
    expect(Arr.sort(actual, Order.String)).toEqual(Arr.sort(expected, Order.String));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));
