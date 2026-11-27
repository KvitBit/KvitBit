// Build the fetchBunDeps expression from a Bun v2 lockfile. Bun installs the
// workspace links from source, so only external packages belong in the cache.
const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as {
  lockfileVersion: number;
  packages: Record<string, readonly unknown[]>;
};

if (lock.lockfileVersion !== 2) {
  throw new Error(`Unsupported Bun lockfile version: ${lock.lockfileVersion}`);
}

const nixString = (value: string) => JSON.stringify(value).replaceAll("${", "\\${");
const entries = new Map<string, string>();
for (const [name, entry] of Object.entries(lock.packages)) {
  const [specifier, registryUrl] = entry;
  if (typeof specifier !== "string") throw new Error(`Missing specifier for ${name}`);

  const separator = specifier.indexOf("@", 1);
  const packageName = specifier.slice(0, separator);
  const source = specifier.slice(separator + 1);
  if (entry.length === 1 && source.startsWith("workspace:")) continue;

  const hash = entry.at(-1);
  if (separator < 1 || typeof hash !== "string" || !hash.startsWith("sha512-")) {
    throw new Error(`Unsupported lockfile entry for ${name}: ${specifier}`);
  }

  const basename = packageName.slice(packageName.lastIndexOf("/") + 1);
  const tarball = /^https?:\/\//.test(source);
  const key = tarball ? `tarball:${source}` : specifier;
  const url = tarball
    ? source
    : typeof registryUrl === "string" && registryUrl
      ? registryUrl
      : `https://registry.npmjs.org/${packageName}/-/${basename}-${source}.tgz`;
  if ((tarball && entry.length !== 3) || (!tarball && entry.length !== 4)) {
    throw new Error(`Unsupported lockfile entry for ${name}: ${specifier}`);
  }

  // A URL without a .tgz suffix still needs that extension for bun2nix extraction.
  const expression = [
    `  ${nixString(key)} = fetchurl {`,
    ...(tarball || registryUrl ? [`    name = ${nixString(`${basename}.tgz`)};`] : []),
    `    url = ${nixString(url)};`,
    `    hash = ${nixString(hash)};`,
    "  };",
  ].join("\n");
  const previous = entries.get(key);
  if (previous !== undefined && previous !== expression) {
    throw new Error(`Conflicting tarballs in bun.lock for ${key}`);
  }
  entries.set(key, expression);
}

const generated = [
  "# Generated from bun.lock by bun run generate:bun-nix",
  "{ fetchurl }:",
  "",
  "{",
  ...[...entries.values()].sort(),
  "}",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  if ((await Bun.file("bun.nix").text()) !== generated) {
    throw new Error("bun.nix is stale. Run bun run generate:bun-nix.");
  }
} else {
  await Bun.write("bun.nix", generated);
}
