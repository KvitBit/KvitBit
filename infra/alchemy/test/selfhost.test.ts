import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  test("Dockerfile includes static assets, Bun 1.4.2 multi-stage build, Chromium, non-root uid 10001, and tini entrypoint", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    const dockerignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");

    // Static assets (assets/brand) must be in Docker build context and copied before web/mobile builds
    const ignoredLines = dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(ignoredLines).not.toContain("assets");
    expect(ignoredLines).not.toContain("assets/brand");
    expect(dockerfile).toContain("COPY assets ./assets");
    expect(dockerfile.indexOf("COPY assets ./assets")).toBeLessThan(
      dockerfile.indexOf("bun run --filter @kvitbit/web build"),
    );

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

  test("docker-compose.yml separates migration owner credentials from DML-only app role (S5)", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const initScriptPath = join(repoRoot, "docker/postgres-init/01-create-app-role.sh");
    expect(existsSync(initScriptPath)).toBe(true);

    const initSyntax = Bun.spawnSync(["sh", "-n", initScriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initSyntax.exitCode).toBe(0);

    const initScript = readFileSync(initScriptPath, "utf8");
    expect(initScript).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE");
    expect(initScript).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(initScript).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE");

    const parsed = Bun.YAML.parse(compose) as {
      services: {
        postgres: { volumes: string[]; environment: Record<string, string> };
        migrate: { environment: Record<string, string> };
        kvitbit: { environment: Record<string, string> };
      };
    };
    expect(parsed.services.postgres.volumes).toContain(
      "./docker/postgres-init:/docker-entrypoint-initdb.d:ro",
    );
    expect(parsed.services.migrate.environment.DATABASE_URL_UNPOOLED).toContain("POSTGRES_USER");
    expect(parsed.services.kvitbit.environment.DATABASE_URL).toContain("POSTGRES_APP_USER");
    expect(parsed.services.kvitbit.environment.DATABASE_URL_UNPOOLED).toBeUndefined();
    expect(compose).toContain("postgres:17-alpine");
    expect(compose).toContain('command: ["migrate"]');
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("KVITBIT_RUNNER_MODE: single");
  });

  test("flake.nix has valid bun.nix, writable OCI storage dirs for uid 10001, and separate NixOS migration credentials", () => {
    const flake = readFileSync(join(repoRoot, "flake.nix"), "utf8");
    const bunNixPath = join(repoRoot, "bun.nix");
    expect(existsSync(bunNixPath)).toBe(true);
    const bunNix = readFileSync(bunNixPath, "utf8");
    expect(bunNix).toContain("{ fetchurl }:");
    expect(bunNix).toContain("sha512-");

    expect(flake).toContain("bun2nix");
    expect(flake).toContain("nix2container");
    expect(flake).toContain("ociWritableDirs");
    expect(flake).toContain("/var/lib/kvitbit/blobs");
    expect(flake).toContain("/var/lib/kvitbit/mobile");
    expect(flake).toContain("uid = 10001;");
    expect(flake).toContain("gid = 10001;");
    expect(flake).toContain("migrationEnvironmentFile = lib.mkOption");
    expect(flake).toContain("cfg.migrationEnvironmentFile");
    expect(flake).toContain('KVITBIT_RUNNER_MODE = "single"');
    expect(flake).toContain("systemd.services.kvitbit-migrate");
    expect(flake).toContain("services.nginx = lib.mkIf cfg.nginx.enable");
  });

  test(".github/workflows/deploy.yml enforces prod-only stage, bootstrap preflight, --yes deploy, optional secret flags, immutable attempt tags, runner digest check, and edge probing", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    const parsed = Bun.YAML.parse(workflow) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
    };
    expect(parsed).toBeDefined();

    // Production-only: no staging option pointing at prod secrets
    expect(parsed.on?.workflow_dispatch?.inputs?.stage).toBeUndefined();
    expect(parsed.on?.workflow_dispatch?.inputs?.bootstrap_foundation).toBeDefined();
    expect(workflow).toContain("KVITBIT_STAGE: prod");
    expect(workflow).not.toContain("- staging");

    for (const varName of [
      "GCP_PROJECT_ID",
      "GCP_PROJECT_NUMBER",
      "GCP_REGION",
      "GCP_ZONE",
      "GCP_WORKLOAD_IDENTITY_PROVIDER",
      "GCP_DEPLOYER_SERVICE_ACCOUNT",
      "ALCHEMY_STATE_BUCKET",
      "KVITBIT_ENABLE_RESEND_SECRET",
      "KVITBIT_ENABLE_SMTP_SECRET",
      "KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET",
    ]) {
      expect(workflow).toContain(`vars.${varName}`);
    }

    expect(workflow).toContain("secrets.DATABASE_URL");
    expect(workflow).toContain("secrets.DATABASE_DIRECT_URL");
    expect(workflow).toContain("GOOGLE_ACCESS_TOKEN");
    expect(workflow).toContain("GOOGLE_PROJECT_ID");
    expect(workflow).toContain("gcloud artifacts repositories describe kvitbit");
    expect(workflow).toContain(`kvitbit-\${KVITBIT_STAGE}-runner-database-url-unpooled`);
    expect(workflow).toContain(`sha-\${GITHUB_SHA}-run-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}`);
    expect(workflow).toContain("bun apps/server/src/migrate.ts");
    expect(workflow).toContain("bunx alchemy deploy --yes");
    expect(workflow).toContain("kvitbit/active-digest");
    expect(workflow).toContain(`if [ -n "\${KVITBIT_EDGE_DOMAINS:-}" ]; then`);

    const preflightPos = workflow.indexOf("gcloud artifacts repositories describe kvitbit");
    const pushPos = workflow.indexOf("docker push");
    const migratePos = workflow.indexOf("bun apps/server/src/migrate.ts");
    const deployPos = workflow.indexOf("bunx alchemy deploy --yes");
    expect(preflightPos).toBeGreaterThan(-1);
    expect(pushPos).toBeGreaterThan(preflightPos);
    expect(migratePos).toBeGreaterThan(pushPos);
    expect(deployPos).toBeGreaterThan(migratePos);
  });
});
