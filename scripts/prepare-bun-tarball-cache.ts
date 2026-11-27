// Bun 1.4.4 looks up lockfile v2 tarballs by the first 16 integrity bytes.
// bun2nix creates URL-keyed entries, so copy the prefetched package under
// the integrity key before Bun installs dependencies.
// @effect-diagnostics nodeBuiltinImport:off Nix copies prefetched cache entries before installing dependencies.
// @effect-diagnostics preferEffectArray:off Read Bun lockfile arrays before Effect is installed.
// @effect-diagnostics preferEffectRecord:off Enumerate Bun lockfile entries before Effect is installed.
// @effect-diagnostics preferEffectString:off Parse tarball specifiers before Effect is installed.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { isLockObject, isLockString } from "./bun-lock-boundary";

const [, , cache = "", deps = ""] = Bun.argv;
if (cache.length === 0 || deps.length === 0) {
  throw new Error("Run after bun2nix sets up the install cache.");
}

const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text());
if (!(isLockObject(lock) && isLockObject(lock["packages"]))) {
  throw new Error("Expected a packages object in bun.lock.");
}

for (const entry of Object.values(lock["packages"])) {
  if (!Array.isArray(entry) || entry.length !== 3) continue;
  const parts: readonly unknown[] = entry;
  const [specifier, , integrity] = parts;
  if (!isLockString(specifier)) continue;
  const url = specifier.slice(specifier.indexOf("@", 1) + 1);
  if (!/^https?:\/\//u.test(url)) continue;
  if (!(isLockString(integrity) && integrity.startsWith("sha512-"))) {
    throw new Error(`Expected SHA-512 integrity for ${specifier}`);
  }
  const hash = Buffer.from(integrity.slice("sha512-".length), "base64").subarray(0, 16);
  const name = `@T@sha512-${hash.toString("hex")}@@@1`;
  const target = join(deps, "share/bun-packages", `tarball:${url}`);
  // The combined Nix output contains symlinks; Bun only copies regular files
  // from this cache into node_modules.
  cpSync(target, join(cache, name), { recursive: true, dereference: true });
}
