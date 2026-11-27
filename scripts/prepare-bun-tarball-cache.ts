// Bun 1.4.4 looks up lockfile v2 tarballs by the first 16 integrity bytes.
// bun2nix creates URL-keyed entries, so copy the prefetched package under
// the integrity key before Bun installs dependencies.
import { cp } from "node:fs/promises";
import { join } from "node:path";

const [, , cache, deps] = process.argv;
if (!cache || !deps) throw new Error("Run after bun2nix sets up the install cache.");

const { packages } = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as {
  packages: Record<string, readonly unknown[]>;
};

for (const entry of Object.values(packages)) {
  const [specifier, , integrity] = entry;
  if (entry.length !== 3 || typeof specifier !== "string") continue;
  const url = specifier.slice(specifier.indexOf("@", 1) + 1);
  if (!/^https?:\/\//.test(url)) continue;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(`Expected SHA-512 integrity for ${specifier}`);
  }
  const hash = Buffer.from(integrity.slice("sha512-".length), "base64").subarray(0, 16);
  const name = `@T@sha512-${hash.toString("hex")}@@@1`;
  const target = join(deps, "share/bun-packages", `tarball:${url}`);
  // The combined Nix output contains symlinks; Bun only copies regular files
  // from this cache into node_modules.
  await cp(target, join(cache, name), { recursive: true, dereference: true });
}
