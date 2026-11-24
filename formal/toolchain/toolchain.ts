/**
 * Pinned formal toolchain: fetches tla2tools.jar into formal/.cache, verifies its sha256, and
 * checks the Java major version. Every path fails closed: a checksum mismatch, a failed
 * download or a wrong JDK throws, and nothing runs TLC on an unverified jar.
 *
 * CLI: `bun formal/toolchain/toolchain.ts` prints the verified jar path and Java version.
 * `TLA2TOOLS=/path/to/tla2tools.jar` replaces the download; the file is still checksummed.
 * `FORMAL_JAVA=/path/to/java` replaces `java` on PATH; its major version is still checked.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pins from "./toolchain.json";

export const FORMAL_DIR = path.resolve(import.meta.dir, "..");
export const CACHE_DIR = path.join(FORMAL_DIR, ".cache");

export type Toolchain = {
  readonly jar: string;
  readonly java: string;
  readonly javaVersion: string;
  readonly tlaVersion: string;
};

export const pinned = pins;

export class ToolchainError extends Error {
  override readonly name = "ToolchainError";
}

export const sha256Of = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const verify = (file: string, expected: string, origin: string): void => {
  const actual = sha256Of(file);
  if (actual !== expected)
    throw new ToolchainError(
      `tla2tools checksum mismatch for ${origin} (${file}): expected sha256 ${expected}, got ${actual}. Refusing to run TLC.`,
    );
};

/** Returns a checksum-verified tla2tools.jar, downloading it into the cache when absent. */
export const ensureJar = async (
  env: Record<string, string | undefined> = process.env,
  pin: { version: string; url: string; sha256: string } = pins.tla2tools,
): Promise<string> => {
  if (env.TLA2TOOLS) {
    // Absolute, so the file Java loads (TLC runs in each model's directory) is the one verified.
    const override = path.resolve(env.TLA2TOOLS);
    if (!existsSync(override)) throw new ToolchainError(`TLA2TOOLS=${override} does not exist.`);
    verify(override, pin.sha256, "TLA2TOOLS");
    return override;
  }
  const jar = path.join(CACHE_DIR, `tla2tools-${pin.version}.jar`);
  if (existsSync(jar)) {
    verify(jar, pin.sha256, "the cached jar (delete it to re-download)");
    return jar;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok)
    throw new ToolchainError(`Downloading ${pin.url} failed: HTTP ${response.status}.`);
  const partial = `${jar}.partial`;
  writeFileSync(partial, new Uint8Array(await response.arrayBuffer()));
  try {
    verify(partial, pin.sha256, pin.url);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, jar);
  return jar;
};

/** Returns the Java binary and its version string, failing unless its major version is pinned. */
export const ensureJava = (
  env: Record<string, string | undefined> = process.env,
  major: number = pins.java.major,
): { java: string; version: string } => {
  const java = env.FORMAL_JAVA ?? "java";
  const r = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0)
    throw new ToolchainError(
      `Cannot run ${java} -version (${r.error?.message ?? `exit ${r.status}`}). Install JDK ${major} (mise install, see formal/README.md).`,
    );
  const out = `${r.stderr}${r.stdout}`;
  const version = /version "([^"]+)"/.exec(out)?.[1];
  const found = version ? Number(version.split(/[.+-]/)[0]) : Number.NaN;
  if (found !== major)
    throw new ToolchainError(
      `${java} reports Java ${version ?? "unknown"}; formal checks pin JDK ${major}. Set FORMAL_JAVA or run mise install.`,
    );
  return { java, version: version ?? "" };
};

export const ensureToolchain = async (
  env: Record<string, string | undefined> = process.env,
): Promise<Toolchain> => {
  const { java, version } = ensureJava(env);
  const jar = await ensureJar(env);
  return { jar, java, javaVersion: version, tlaVersion: pins.tla2tools.version };
};

if (import.meta.main) {
  try {
    const t = await ensureToolchain();
    process.stdout.write(
      `tla2tools ${t.tlaVersion} (sha256 verified): ${t.jar}\njava ${t.javaVersion}: ${t.java}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
