import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const entrypointPath = join(repoRoot, "docker/entrypoint.sh");

const runEntrypoint = (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } => {
  const result = Bun.spawnSync(["sh", entrypointPath, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
};

const runEntrypointAsync = async (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn(["sh", entrypointPath, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("docker/entrypoint.sh dispatch contract (#878, #908, #913)", () => {
  test("exits 69 with clear stderr message when apps/server is absent", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-ep-missing-"));
    try {
      const serverRes = runEntrypoint(["server"], { KVITBIT_APP_ROOT: sandbox });
      expect(serverRes.exitCode).toBe(69);
      expect(serverRes.stderr).toContain("apps/server/src/main.ts");

      const workerRes = runEntrypoint(["worker"], { KVITBIT_APP_ROOT: sandbox });
      expect(workerRes.exitCode).toBe(69);
      expect(workerRes.stderr).toContain("apps/server/src/worker.ts");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("dispatches server, worker, and migrate to bun with expected entrypoints", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-ep-ok-"));
    try {
      const serverDir = join(sandbox, "apps/server/src");
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, "main.ts"), "// main\n");
      writeFileSync(join(serverDir, "worker.ts"), "// worker\n");
      writeFileSync(join(serverDir, "migrate.ts"), "// migrate\n");

      const fakeBun = join(sandbox, "fake-bun.sh");
      writeFileSync(fakeBun, '#!/bin/sh\necho "FAKE_BUN:$*"\n');
      chmodSync(fakeBun, 0o755);

      const serverRes = runEntrypoint(["server"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
      });
      expect(serverRes.exitCode).toBe(0);
      expect(serverRes.stdout.trim()).toBe(`FAKE_BUN:${join(serverDir, "main.ts")}`);

      const workerRes = runEntrypoint(["worker"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
      });
      expect(workerRes.exitCode).toBe(0);
      expect(workerRes.stdout.trim()).toBe(`FAKE_BUN:${join(serverDir, "worker.ts")}`);

      const migrateNoDb = runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
      });
      expect(migrateNoDb.exitCode).toBe(64);

      const migrateOk = runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        DATABASE_URL_UNPOOLED: "postgres://user:pass@localhost:5432/kvitbit",
      });
      expect(migrateOk.exitCode).toBe(0);
      expect(migrateOk.stdout.trim()).toBe(`FAKE_BUN:${join(serverDir, "migrate.ts")}`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("healthcheck verifies GET 127.0.0.1:$PORT/healthz and exec fallback runs arbitrary commands", async () => {
    let status = 200;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          return new Response(status === 200 ? "ok" : "unhealthy", { status });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const ok = await runEntrypointAsync(["healthcheck"], {
        PORT: String(server.port),
        KVITBIT_BUN_BIN: process.execPath,
      });
      expect(ok.exitCode).toBe(0);

      status = 503;
      const fail = await runEntrypointAsync(["healthcheck"], {
        PORT: String(server.port),
        KVITBIT_BUN_BIN: process.execPath,
      });
      expect(fail.exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }

    const arbitrary = runEntrypoint(["echo", "kvitbit-ok"], {});
    expect(arbitrary.exitCode).toBe(0);
    expect(arbitrary.stdout.trim()).toBe("kvitbit-ok");
  });
});

describe("Self-hosting and CI deploy artifacts", () => {
  test("Dockerfile defines multi-stage Bun 1.4.2 build, Chromium, non-root uid 10001, tini entrypoint, and shared env", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG BUN_VERSION=1.4.2");
    expect(dockerfile).toContain("AS builder");
    expect(dockerfile).toContain("AS prod-deps");
    expect(dockerfile).toContain("AS runtime");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kvitbit"]');
    expect(dockerfile).toContain("KVITBIT_CHROMIUM_PATH=/usr/bin/chromium");
    expect(dockerfile).toContain("KVITBIT_WEB_DIR=/app/public/web");
    expect(dockerfile).toContain("KVITBIT_PWA_DIR=/app/public/app");
    expect(dockerfile).toContain("KVITBIT_RUNNER_MODE=single");
  });

  test("docker-compose.yml validates and wires Postgres 17, migrate, and SingleRunner server", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain("postgres:17-alpine");
    expect(compose).toContain('command: ["migrate"]');
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("KVITBIT_RUNNER_MODE: single");
    expect(compose).toContain("KVITBIT_BLOB_DRIVER:");
    expect(compose).toContain("KVITBIT_CHROMIUM_PATH: /usr/bin/chromium");
    expect(compose).toContain("BETTER_AUTH_SECRET:");

    const parsed = Bun.YAML.parse(compose) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect("services" in parsed).toBe(true);
  });

  test("flake.nix exposes bun2nix server, nix2container ociImage, and nixosModules.kvitbit", () => {
    const flake = readFileSync(join(repoRoot, "flake.nix"), "utf8");
    expect(flake).toContain("bun2nix");
    expect(flake).toContain("nix2container");
    expect(flake).toContain("x86_64-linux");
    expect(flake).toContain("aarch64-linux");
    expect(flake).toContain("nixosModules = rec {");
    expect(flake).toContain("kvitbit =");
    expect(flake).toContain("ociImage = n2c.buildImage");
    expect(flake).toContain('KVITBIT_RUNNER_MODE = "single"');
    expect(flake).toContain("systemd.services.kvitbit-migrate");
    expect(flake).toContain("services.nginx = lib.mkIf cfg.nginx.enable");
  });

  test(".github/workflows/deploy.yml uses all 7 repo vars, OIDC + GOOGLE_ACCESS_TOKEN, and migrates before Alchemy deploy", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    const parsed = Bun.YAML.parse(workflow) as Record<string, unknown>;
    expect(parsed).toBeDefined();

    for (const varName of [
      "GCP_PROJECT_ID",
      "GCP_PROJECT_NUMBER",
      "GCP_REGION",
      "GCP_ZONE",
      "GCP_WORKLOAD_IDENTITY_PROVIDER",
      "GCP_DEPLOYER_SERVICE_ACCOUNT",
      "ALCHEMY_STATE_BUCKET",
    ]) {
      expect(workflow).toContain(`vars.${varName}`);
    }

    expect(workflow).toContain("secrets.DATABASE_URL");
    expect(workflow).toContain("secrets.DATABASE_DIRECT_URL");
    expect(workflow).toContain("GOOGLE_ACCESS_TOKEN");
    expect(workflow).toContain("GOOGLE_PROJECT_ID");
    expect(workflow).toContain("bun apps/server/src/migrate.ts");
    expect(workflow).toContain("bunx alchemy deploy");

    const migratePos = workflow.indexOf("bun apps/server/src/migrate.ts");
    const deployPos = workflow.indexOf("bunx alchemy deploy");
    expect(migratePos).toBeGreaterThan(-1);
    expect(deployPos).toBeGreaterThan(migratePos);
  });
});
