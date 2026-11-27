/**
 * The browser-safe entry points (`./contract`, `./engines`) must never reach server code
 * (core-ports 0): walk their transitive relative imports statically and check every file and
 * every package import against an allow-list.
 */

import { describe, expect, test } from "bun:test";
import * as EffectArray from "effect/Array";
import * as EffectString from "effect/String";

const SRC = new URL("../src/", import.meta.url);
const relativeToSource = (file: URL) => EffectString.replace(SRC.pathname, "")(file.pathname);

/** Directories and files the browser entries may reach (domain contract, policy, engines). */
const ALLOWED_FILES = [
  /^contract\.ts$/,
  /^policy\/[^/]+\.ts$/,
  /^engines\/[^/]+\.ts$/,
  // The System caller seal `can` checks: pure, imports only domain contract types.
  /^internal\/system\.ts$/,
];
/** Package imports they may use: effect and the domain contract (never ports or Node). */
const ALLOWED_PACKAGES = [/^effect(\/.*)?$/, /^@kvitbit\/domain\/contract$/];

/** Runtime imports only: `import type` / `export type` are erased and never reach a bundle. */
const SPECIFIER =
  /(?:import|export)\s(?!type\s)[^"']*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

const resolveFile = async (from: URL, specifier: string) => {
  const base = new URL(specifier, from);
  if (EffectString.endsWith(".ts")(base.pathname) && (await Bun.file(base).exists())) return base;
  const extension = new URL(`${base.href}.ts`);
  if (await Bun.file(extension).exists()) return extension;
  const index = new URL(`${base.href}/index.ts`);
  if (await Bun.file(index).exists()) return index;
  throw new Error(`cannot resolve ${specifier} from ${relativeToSource(from)}`);
};

/** Every file reachable from `entry` (relative to src) and every package it imports. */
const graph = async (entry: string) => {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const visit = async (file: URL): Promise<void> => {
    if (files.has(file.href)) return;
    files.add(file.href);
    const source = EffectString.replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    )(await Bun.file(file).text());
    await EffectArray.reduce(
      EffectString.matchAll(SPECIFIER)(source),
      Promise.resolve(),
      (previous, match) =>
        previous.then(async () => {
          const specifier = match[1] ?? match[2] ?? match[3];
          if (specifier === undefined) return;
          if (EffectString.startsWith(".")(specifier))
            await visit(await resolveFile(file, specifier));
          else packages.set(specifier, relativeToSource(file));
        }),
    );
  };
  await visit(new URL(entry, SRC));
  return {
    files: EffectArray.map([...files], (href) => relativeToSource(new URL(href))),
    packages,
  };
};

describe.each(["contract.ts", "engines/index.ts"])("import graph of src/%s", (entry) => {
  const result = graph(entry);

  test("reaches only contract, policy and engine files", async () => {
    const { files } = await result;
    expect(
      EffectArray.filter(files, (f) => !EffectArray.some(ALLOWED_FILES, (re) => re.test(f))),
    ).toEqual([]);
    // Guard the walker itself: it found the entry and followed at least its own file.
    expect(files).toContain(entry);
  });

  test("imports only effect and the domain contract", async () => {
    const { packages } = await result;
    const offending = EffectArray.filter(
      [...packages],
      ([p]) => !EffectArray.some(ALLOWED_PACKAGES, (re) => re.test(p)),
    );
    expect(offending).toEqual([]);
  });
});

describe("the walker", () => {
  test("flags server code when reached", async () => {
    const { files, packages } = await graph("index.ts");
    expect(files).toContain("modules/documents/index.ts");
    expect(files).toContain("store/CoreStore.ts");
    expect([...packages.keys()]).toContain("@kvitbit/domain/ports");
  });
});
