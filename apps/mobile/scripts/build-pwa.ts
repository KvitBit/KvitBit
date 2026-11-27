/**
 * Builds the installable web app the server mounts at `/app/`:
 * `expo export` into `dist`, then the manifest, icons, service worker and the
 * head tags that tie them together. Fails when a URL in index.html would not
 * load from `/app/`.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { injectPwaHead, staticAssetUrls, urlsOutsideBase } from "./pwa/html";
import { APP_BASE, appleTouchIcon, pwaColors, pwaIcons, pwaManifest } from "./pwa/manifest";
import { serviceWorkerSource } from "./pwa/service-worker";

const appRoot = resolve(import.meta.dir, "..");
const brandWebAssets = resolve(appRoot, "../../assets/brand/web");

/** Files the `/app/` mount can't work without; checked after the build. */
export const pwaEntryFiles = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  ...pwaIcons.map((icon) => `icons/${icon.file}`),
  `icons/${appleTouchIcon}`,
] as const;

/** Short content hash of the exported shell; its script names carry the bundle hashes. */
export const exportVersion = (html: string): string =>
  new Bun.CryptoHasher("sha256").update(html).digest("hex").slice(0, 12);

/** Adds the PWA files to an existing web export in `dist`. */
export const decorateExport = async ({
  dist,
  iconSource,
}: {
  dist: string;
  iconSource: string;
}) => {
  const shellPath = join(dist, "index.html");
  const exported = await readFile(shellPath, "utf8");

  await mkdir(join(dist, "icons"), { recursive: true });
  for (const file of [...pwaIcons.map((icon) => icon.file), appleTouchIcon]) {
    await copyFile(join(iconSource, file), join(dist, "icons", file));
  }
  await writeFile(
    join(dist, "manifest.webmanifest"),
    `${JSON.stringify(pwaManifest(), null, 2)}\n`,
  );
  const shell = injectPwaHead(exported, { themeColor: pwaColors.theme });
  const outside = urlsOutsideBase(shell);
  if (outside.length > 0) {
    throw new Error(`index.html loads URLs outside /app/: ${outside.join(", ")}`);
  }
  await writeFile(shellPath, shell);
  const integrity: Record<string, string> = {};
  const artifacts = [
    "index.html",
    ...(await Array.fromAsync(new Bun.Glob("_expo/static/**/*").scan(dist))),
  ];
  for (const file of artifacts.sort()) {
    const url = file.split("/").map(encodeURIComponent).join("/");
    integrity[`${APP_BASE}${url}`] =
      `sha256-${new Bun.CryptoHasher("sha256").update(await readFile(join(dist, file))).digest("base64")}`;
  }
  const precache = staticAssetUrls(exported);
  const missingArtifacts = precache.filter((url) => !Object.hasOwn(integrity, url));
  if (missingArtifacts.length > 0) {
    throw new Error(`The PWA build lacks static artifacts: ${missingArtifacts.join(", ")}`);
  }
  await writeFile(
    join(dist, "sw.js"),
    serviceWorkerSource({ version: exportVersion(exported), precache, integrity }),
  );

  const missing: string[] = [];
  for (const file of pwaEntryFiles) {
    if (!(await Bun.file(join(dist, file)).exists())) missing.push(file);
  }
  if (missing.length > 0) throw new Error(`The PWA build lacks ${missing.join(", ")}`);
};

const exportWeb = async (dist: string) => {
  await rm(dist, { recursive: true, force: true });
  const child = Bun.spawn(["bunx", "expo", "export", "--platform", "web", "--output-dir", "dist"], {
    cwd: appRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`expo export exited with ${code}`);
};

if (import.meta.main) {
  const dist = join(appRoot, "dist");
  await exportWeb(dist);
  await decorateExport({ dist, iconSource: brandWebAssets });
  process.stdout.write(`PWA ready in ${dist} (served at /app/)\n`);
}
