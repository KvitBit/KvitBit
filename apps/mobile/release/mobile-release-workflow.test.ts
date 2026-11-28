import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { runReleaseProcess } from "./release-process.testkit";

const stepSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const workflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.Array(stepSchema),
    }),
  ),
});
const workflowPath = new URL("../../../.github/workflows/mobile-release.yml", import.meta.url);
const workflow = Schema.decodeUnknownOption(workflowSchema)(
  Bun.YAML.parse(await Bun.file(workflowPath).text()),
).pipe(Option.getOrThrow);
const channelInput = /^\$\{\{ inputs\.channel \}\}$/;
const runtimeInput = /^\$\{\{ inputs\.runtime_version \}\}$/;
const shellInterpolation = /\$\{\{\s*(?:inputs\.|needs\.prepare\.outputs\.)/;

const { fileSystem, path } = Effect.runSync(
  Effect.all({ fileSystem: FileSystem.FileSystem, path: Path.Path }, { concurrency: 1 }).pipe(
    Effect.provide(BunServices.layer),
  ),
);

test("every workload-identity release job can request a GitHub OIDC token", () => {
  const authenticated = Arr.filter(Rec.toEntries(workflow.jobs), ([, job]) =>
    Arr.some(job.steps, (step) => Str.startsWith("google-github-actions/auth@")(step.uses ?? "")),
  );
  expect(Arr.map(authenticated, ([name]) => name)).toEqual([
    "build-and-publish-apk",
    "publish-ota",
    "rollback",
  ]);
  for (const [, job] of authenticated) expect(job.permissions?.["id-token"]).toBe("write");
});

test("release mode validates dispatch values loaded through the step environment", async () => {
  const prepare = Rec.get(workflow.jobs, "prepare").pipe(Option.getOrThrow);
  const mode = Arr.findFirst(prepare.steps, ({ id }) => id === "mode").pipe(Option.getOrThrow);
  expect(mode.env?.["INPUT_CHANNEL"]).toMatch(channelInput);
  expect(mode.env?.["INPUT_RUNTIME_VERSION"]).toMatch(runtimeInput);
  for (const job of Rec.values(workflow.jobs)) {
    for (const step of job.steps) {
      expect(step.run ?? "").not.toMatch(shellInterpolation);
    }
  }

  const dir = await Effect.runPromise(
    fileSystem.makeTempDirectory({ prefix: "kvitbit-release-workflow-" }),
  );
  try {
    const output = path.join(dir, "outputs");
    const run = (channel: string, runtime: string) =>
      runReleaseProcess(
        ChildProcess.make("bash", ["-c", mode.run ?? ""], {
          env: {
            EVENT_NAME: "workflow_dispatch",
            INPUT_ACTION: "ota-only",
            INPUT_DRY_RUN: "false",
            INPUT_CHANNEL: channel,
            INPUT_PLATFORM: "android",
            INPUT_RUNTIME_VERSION: runtime,
            GITHUB_OUTPUT: output,
          },
        }),
      );

    const badChannel = await run("prod/preview", "runtime-123");
    expect(badChannel.exitCode).toBe(1);
    expect(badChannel.stderr).toContain("Invalid release channel");
    const badRuntime = await run("preview", "runtime version");
    expect(badRuntime.exitCode).toBe(1);
    expect(badRuntime.stderr).toContain("Invalid runtime version");
    expect(await Bun.file(output).exists()).toBe(false);

    const good = await run("preview", "runtime-123");
    expect(good.exitCode).toBe(0);
    const expected = ["channel=preview", "platform=android", "runtime-version=runtime-123", ""];
    expect(await Bun.file(output).text()).toContain(Arr.join(expected, "\n"));
  } finally {
    await Effect.runPromise(fileSystem.remove(dir, { recursive: true, force: true }));
  }
});
