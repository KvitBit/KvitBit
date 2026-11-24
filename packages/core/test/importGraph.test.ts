/**
 * The browser-safe entry points (`./contract`, `./engines`) must never reach server code
 * (core-ports 0): walk their transitive relative imports statically and check every file and
 * every package import against an allow-list.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

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

const resolveFile = (from: string, specifier: string): string => {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${relative(SRC, from)}`);
};

/** Every file reachable from `entry` (relative to src) and every package it imports. */
const graph = (entry: string) => {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) visit(resolveFile(file, specifier));
      else packages.set(specifier, relative(SRC, file));
    }
  };
  visit(join(SRC, entry));
  return { files: [...files].map((f) => relative(SRC, f)).sort(), packages };
};

describe.each(["contract.ts", "engines/index.ts"])("import graph of src/%s", (entry) => {
  const { files, packages } = graph(entry);

  test("reaches only contract, policy and engine files", () => {
    expect(files.filter((f) => !ALLOWED_FILES.some((re) => re.test(f)))).toEqual([]);
    // Guard the walker itself: it found the entry and followed at least its own file.
    expect(files).toContain(entry);
  });

  test("imports only effect and the domain contract", () => {
    const offending = [...packages].filter(([p]) => !ALLOWED_PACKAGES.some((re) => re.test(p)));
    expect(offending).toEqual([]);
  });
});

describe("the walker", () => {
  test("flags server code when reached", () => {
    const { files, packages } = graph("index.ts");
    expect(files).toContain("modules/documents/index.ts");
    expect(files).toContain("store/CoreStore.ts");
    expect([...packages.keys()]).toContain("@kvitbit/domain/ports");
  });
});
