/**
 * CLI entrypoint executed by `.github/workflows/deploy.yml` in the
 * "Validate GCP deployment variables" step.
 */

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { SECRET_FLAG_ENV_VARS, validateDeployPreflight } from "./deploy-preflight";

const preflight = Effect.gen(function* () {
  const result = validateDeployPreflight(process.env);
  if (!result.ok) {
    process.stdout.write(`::error::${result.message}\n`);
    process.exitCode = 1;
    return;
  }
  const githubEnvPath = yield* Config.option(Config.String("GITHUB_ENV"));
  if (Option.isNone(githubEnvPath) || githubEnvPath.value === "") return;
  const lines = Arr.join(
    Arr.map(
      SECRET_FLAG_ENV_VARS,
      (name) => `${name}=${result.normalizedBooleans[name] ? "true" : "false"}\n`,
    ),
    "",
  );
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(githubEnvPath.value, lines, { flag: "a" });
});

BunRuntime.runMain(preflight.pipe(Effect.provide(BunFileSystem.layer)));
