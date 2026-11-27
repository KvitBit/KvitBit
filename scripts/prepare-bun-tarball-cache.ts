// Bun 1.4.4 looks up lockfile v2 tarballs by the first 16 integrity bytes.
// bun2nix creates URL-keyed entries, so copy the prefetched package under
// the integrity key before Bun installs dependencies.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferEffectArray:off
// @effect-diagnostics preferEffectRecord:off
// @effect-diagnostics preferEffectString:off
import { cp } from "node:fs/promises";
import { join } from "node:path";

const [, , cache = "", deps = ""] = Bun.argv;
if (cache.length === 0 || deps.length === 0) {
  throw new Error("Run after bun2nix sets up the install cache.");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const lock: unknown = Bun.JSONC.parse(await Bun.file("bun.lock").text());
if (!(isRecord(lock) && isRecord(lock.packages))) {
  throw new Error("Expected a packages object in bun.lock.");
}

for (const entry of Object.values(lock.packages)) {
  if (!Array.isArray(entry) || entry.length !== 3) continue;
  const parts: readonly unknown[] = entry;
  const [specifier, , integrity] = parts;
  if (typeof specifier !== "string") continue;
  const url = specifier.slice(specifier.indexOf("@", 1) + 1);
  if (!/^https?:\/\//u.test(url)) continue;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`Expected SHA-512 integrity for ${specifier}`);
  }
  const hash = Buffer.from(integrity.slice("sha512-".length), "base64").subarray(0, 16);
  const name = `@T@sha512-${hash.toString("hex")}@@@1`;
  const target = join(deps, "share/bun-packages", `tarball:${url}`);
  // The combined Nix output contains symlinks; Bun only copies regular files
  // from this cache into node_modules.
  // biome-ignore lint/performance/noAwaitInLoops: Entries with the same integrity share a cache destination.
  await cp(target, join(cache, name), { recursive: true, dereference: true });
}
