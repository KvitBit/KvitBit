/**
 * Exports the installable web app and adds the files used by its /app/ mount.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { injectPwaHead, staticAssetUrls, urlsOutsideBase } from "./pwa/html";
import { jsonManifest } from "./pwa/json";
import { APP_BASE, appleTouchIcon, pwaColors, pwaIcons, pwaManifest } from "./pwa/manifest";
import { serviceWorkerSource } from "./pwa/service-worker";

const iconFiles = [...Arr.map(pwaIcons, (icon) => icon.file), appleTouchIcon];

/** Files the `/app/` mount needs. */
export const pwaEntryFiles = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  ...Arr.map(iconFiles, (file) => `icons/${file}`),
];

class PwaBuildError extends Schema.TaggedError<PwaBuildError, { readonly brand: unique symbol }>()(
  "PwaBuildError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const buildError = (cause: unknown) =>
  PwaBuildError.make({ reason: Predicate.isError(cause) ? cause.message : String(cause) });

/** Short content hash of the shell, whose bundle names carry their content hashes. */
export const exportVersion = (html: string): string =>
  Str.slice(0, 12)(new Bun.CryptoHasher("sha256").update(html).digest("hex"));

interface ExportDirectories {
  readonly dist: string;
  readonly iconSource: string;
}

/** Adds PWA assets to an existing Expo web export. */
export const decorateExport = Effect.fn("MobilePwa.decorate")(function* ({
  dist,
  iconSource,
}: ExportDirectories) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shellPath = path.join(dist, "index.html");
  const exported = yield* fs.readFileString(shellPath);

  const iconDir = path.join(dist, "icons");
  yield* fs.makeDirectory(iconDir, { recursive: true });
  yield* Effect.forEach(
    iconFiles,
    (file) => fs.copyFile(path.join(iconSource, file), path.join(iconDir, file)),
    { concurrency: "unbounded", discard: true },
  );
  yield* fs.writeFileString(
    path.join(dist, "manifest.webmanifest"),
    `${jsonManifest(pwaManifest())}\n`,
  );
  const shell = yield* Effect.try({
    try: () => injectPwaHead(exported, { themeColor: pwaColors.theme }),
    catch: buildError,
  });
  const outside = urlsOutsideBase(shell);
  if (outside.length > 0) {
    return yield* PwaBuildError.make({
      reason: `index.html loads URLs outside /app/: ${Arr.join(outside, ", ")}`,
    });
  }
  yield* fs.writeFileString(shellPath, shell);

  const staticFiles = yield* Effect.tryPromise({
    try: () => Array.fromAsync(new Bun.Glob("_expo/static/**/*").scan(dist)),
    catch: buildError,
  });
  const artifacts = Arr.sort(["index.html", ...staticFiles], Order.String);
  const entries = yield* Effect.forEach(
    artifacts,
    (file) =>
      fs.readFile(path.join(dist, file)).pipe(
        Effect.map((bytes) => {
          const url = Arr.join(Arr.map(Str.split(file, "/"), encodeURIComponent), "/");
          const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("base64");
          return [`${APP_BASE}${url}`, `sha256-${hash}`] as const;
        }),
      ),
    { concurrency: 1 },
  );
  const integrity: Readonly<Record<string, string>> = Rec.fromEntries(entries);
  const precache = staticAssetUrls(exported);
  const missingArtifacts = Arr.filter(precache, (url) => !Rec.has(integrity, url));
  if (missingArtifacts.length > 0) {
    return yield* PwaBuildError.make({
      reason: `The PWA build lacks static artifacts: ${Arr.join(missingArtifacts, ", ")}`,
    });
  }
  yield* fs.writeFileString(
    path.join(dist, "sw.js"),
    serviceWorkerSource({ version: exportVersion(exported), precache, integrity }),
  );

  const missing = yield* Effect.filter(
    pwaEntryFiles,
    (file) => fs.exists(path.join(dist, file)).pipe(Effect.map((exists) => !exists)),
    { concurrency: "unbounded" },
  );
  if (missing.length > 0) {
    return yield* PwaBuildError.make({ reason: `The PWA build lacks ${Arr.join(missing, ", ")}` });
  }
});

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const appRoot = path.resolve(import.meta.dir, "..");
  const dist = path.join(appRoot, "dist");
  const iconSource = path.resolve(appRoot, "../../assets/brand/web");

  yield* fs.remove(dist, { recursive: true, force: true });
  const child = yield* spawner.spawn(
    ChildProcess.make("bunx", ["expo", "export", "--platform", "web", "--output-dir", "dist"], {
      cwd: appRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const code = yield* child.exitCode;
  if (Number(code) !== 0) {
    return yield* PwaBuildError.make({ reason: `expo export exited with ${code}` });
  }

  yield* decorateExport({ dist, iconSource });
  yield* Console.log(`PWA ready in ${dist} (served at /app/)`);
});

if (import.meta.main) {
  BunRuntime.runMain(build.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}
