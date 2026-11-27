import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workflow = Bun.YAML.parse(
  await Bun.file(resolve(import.meta.dir, "../../../.github/workflows/mobile-release.yml")).text(),
) as {
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps: Array<{ id?: string; uses?: string; run?: string; env?: Record<string, string> }>;
    }
  >;
};

test("every workload-identity release job can request a GitHub OIDC token", () => {
  const authenticated = Object.entries(workflow.jobs).filter(([, job]) =>
    job.steps.some((step) => step.uses?.startsWith("google-github-actions/auth@")),
  );
  expect(authenticated.map(([name]) => name)).toEqual([
    "build-and-publish-apk",
    "publish-ota",
    "rollback",
  ]);
  for (const [, job] of authenticated) expect(job.permissions?.["id-token"]).toBe("write");
});

test("release mode validates dispatch values loaded through the step environment", async () => {
  const mode = workflow.jobs.prepare?.steps.find(({ id }) => id === "mode");
  expect(mode?.env?.INPUT_CHANNEL).toMatch(/^\$\{\{ inputs\.channel \}\}$/);
  expect(mode?.env?.INPUT_RUNTIME_VERSION).toMatch(/^\$\{\{ inputs\.runtime_version \}\}$/);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      expect(step.run ?? "").not.toMatch(/\$\{\{\s*(?:inputs\.|needs\.prepare\.outputs\.)/);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "kvitbit-release-workflow-"));
  try {
    const output = join(dir, "outputs");
    const run = (channel: string, runtime: string) =>
      Bun.spawnSync(["bash", "-c", mode?.run ?? ""], {
        env: {
          EVENT_NAME: "workflow_dispatch",
          INPUT_ACTION: "ota-only",
          INPUT_DRY_RUN: "false",
          INPUT_CHANNEL: channel,
          INPUT_PLATFORM: "android",
          INPUT_RUNTIME_VERSION: runtime,
          GITHUB_OUTPUT: output,
        },
      });

    const badChannel = run("prod/preview", "runtime-123");
    expect(badChannel.exitCode).toBe(1);
    expect(badChannel.stderr.toString()).toContain("Invalid release channel");
    const badRuntime = run("preview", "runtime version");
    expect(badRuntime.exitCode).toBe(1);
    expect(badRuntime.stderr.toString()).toContain("Invalid runtime version");
    expect(await Bun.file(output).exists()).toBe(false);

    expect(run("preview", "runtime-123").exitCode).toBe(0);
    expect(await Bun.file(output).text()).toContain(
      "channel=preview\nplatform=android\nruntime-version=runtime-123\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
