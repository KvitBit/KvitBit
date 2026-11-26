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

      // External DATABASE_URL with missing DATABASE_URL_UNPOOLED must fail fast instead of
      // silently falling back to bundled postgres.
      const migrateExternalMissingUnpooled = runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        KVITBIT_RUNTIME_DATABASE_URL: "postgres://app:pw@external.invalid:5432/kvitbit",
        KVITBIT_BUNDLED_MIGRATION_URL: "postgres://kvitbit:kvitbit@postgres:5432/kvitbit",
      });
      expect(migrateExternalMissingUnpooled.exitCode).toBe(64);
      expect(migrateExternalMissingUnpooled.stderr).toContain("external database");

      // Bundled postgres fallback succeeds when runtime URL is unset
      const migrateBundled = runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        KVITBIT_BUNDLED_MIGRATION_URL: "postgres://kvitbit:kvitbit@postgres:5432/kvitbit",
      });
      expect(migrateBundled.exitCode).toBe(0);
      expect(migrateBundled.stdout.trim()).toBe(`FAKE_BUN:${join(serverDir, "migrate.ts")}`);
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

  test("docker-compose.yml separates migration owner credentials from DML-only app role, reconciles roles post-migration, and preserves DATABASE_URL_UNPOOLED (S5)", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const initScriptPath = join(repoRoot, "docker/postgres-init/01-create-app-role.sh");
    const reconcileScriptPath = join(repoRoot, "docker/reconcile-app-role.sh");
    expect(existsSync(initScriptPath)).toBe(true);
    expect(existsSync(reconcileScriptPath)).toBe(true);

    for (const scriptPath of [initScriptPath, reconcileScriptPath]) {
      const syntax = Bun.spawnSync(["sh", "-n", scriptPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(syntax.exitCode).toBe(0);

      const content = readFileSync(scriptPath, "utf8");
      expect(content).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE");
      expect(content).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
      expect(content).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE");
      expect(content).toContain("ARRAY['public', 'auth']");
      expect(content).toContain("rolsuper OR v_role.rolcreatedb OR v_role.rolcreaterole");
    }

    const parsed = Bun.YAML.parse(compose) as {
      services: {
        postgres: { volumes: string[]; environment: Record<string, string> };
        migrate: { environment: Record<string, string> };
        "reconcile-roles": {
          depends_on: Record<string, { condition: string }>;
          volumes: string[];
          environment: Record<string, string>;
        };
        kvitbit: {
          depends_on: Record<string, { condition: string }>;
          environment: Record<string, string>;
        };
      };
    };
    expect(parsed.services.postgres.volumes).toContain(
      "./docker/postgres-init:/docker-entrypoint-initdb.d:ro",
    );
    expect(parsed.services.migrate.environment.DATABASE_URL_UNPOOLED).toContain(
      "DATABASE_URL_UNPOOLED",
    );
    expect(parsed.services.migrate.environment.KVITBIT_BUNDLED_MIGRATION_URL).toContain(
      "POSTGRES_USER",
    );
    expect(parsed.services["reconcile-roles"].depends_on.migrate?.condition).toBe(
      "service_completed_successfully",
    );
    expect(parsed.services["reconcile-roles"].volumes).toContain(
      "./docker/reconcile-app-role.sh:/usr/local/bin/reconcile-app-role.sh:ro",
    );
    expect(parsed.services.kvitbit.depends_on["reconcile-roles"]?.condition).toBe(
      "service_completed_successfully",
    );
    expect(parsed.services.kvitbit.environment.DATABASE_URL).toContain("POSTGRES_APP_USER");
    expect(parsed.services.kvitbit.environment.DATABASE_URL_UNPOOLED).toBeUndefined();
    expect(compose).toContain("postgres:17-alpine");
    expect(compose).toContain('command: ["migrate"]');
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("KVITBIT_RUNNER_MODE: single");
  });

  test("Postgres role reconciliation grants DML on public and auth schemas for fresh and existing volumes, denies DDL, and rejects role collision or elevated roles", async () => {
    const pgBinDir = ["/usr/lib/postgresql/18/bin", "/usr/lib/postgresql/17/bin"].find((dir) =>
      existsSync(join(dir, "initdb")),
    );
    if (pgBinDir === undefined) {
      throw new Error("Expected local PostgreSQL binaries (initdb/postgres) to be installed");
    }

    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-pg-roles-"));
    const dataDir = join(sandbox, "pgdata");
    const socketDir = join(sandbox, "sock");
    mkdirSync(socketDir, { recursive: true });

    let pgProc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const initdb = Bun.spawnSync(
        [
          join(pgBinDir, "initdb"),
          "-D",
          dataDir,
          "-U",
          "kvitbit",
          "--auth=trust",
          "--no-sync",
          "--no-instructions",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(initdb.exitCode).toBe(0);

      pgProc = Bun.spawn(
        [
          join(pgBinDir, "postgres"),
          "-D",
          dataDir,
          "-k",
          socketDir,
          "-h",
          "",
          "-c",
          "fsync=off",
          "-c",
          "synchronous_commit=off",
          "-c",
          "full_page_writes=off",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      // Wait for Postgres socket readiness
      let ready = false;
      for (let i = 0; i < 40; i += 1) {
        const probe = Bun.spawnSync(
          ["psql", "-h", socketDir, "-U", "kvitbit", "-d", "postgres", "-c", "SELECT 1"],
          { stdout: "pipe", stderr: "pipe" },
        );
        if (probe.exitCode === 0) {
          ready = true;
          break;
        }
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);

      const psql = (args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) =>
        Bun.spawnSync(["psql", "-v", "ON_ERROR_STOP=1", "-h", socketDir, ...args], {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...extraEnv },
          stdout: "pipe",
          stderr: "pipe",
        });

      const initScriptPath = join(repoRoot, "docker/postgres-init/01-create-app-role.sh");
      const reconcileScriptPath = join(repoRoot, "docker/reconcile-app-role.sh");
      const initMigrationSql = join(
        repoRoot,
        "packages/db/drizzle/20261123175822_init/migration.sql",
      );

      // Create fresh DB and existing-volume DB
      expect(
        psql(["-U", "kvitbit", "-d", "postgres", "-c", "CREATE DATABASE kvitbit_fresh;"]).exitCode,
      ).toBe(0);
      expect(
        psql(["-U", "kvitbit", "-d", "postgres", "-c", "CREATE DATABASE kvitbit_existing;"])
          .exitCode,
      ).toBe(0);

      const runRoleScript = (script: string, env: Record<string, string>) =>
        Bun.spawnSync(["sh", script], {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            PGHOST: socketDir,
            ...env,
          },
          stdout: "pipe",
          stderr: "pipe",
        });

      // 1. Fresh volume: initdb script -> Drizzle migrations -> post-migration reconcile
      expect(
        runRoleScript(initScriptPath, {
          POSTGRES_USER: "kvitbit",
          POSTGRES_DB: "kvitbit_fresh",
          POSTGRES_APP_USER: "kvitbit_app",
          POSTGRES_APP_PASSWORD: "app_password_1",
        }).exitCode,
      ).toBe(0);

      expect(psql(["-U", "kvitbit", "-d", "kvitbit_fresh", "-f", initMigrationSql]).exitCode).toBe(
        0,
      );

      expect(
        runRoleScript(reconcileScriptPath, {
          POSTGRES_USER: "kvitbit",
          POSTGRES_DB: "kvitbit_fresh",
          POSTGRES_APP_USER: "kvitbit_app",
          POSTGRES_APP_PASSWORD: "app_password_1",
        }).exitCode,
      ).toBe(0);

      // Verify kvitbit_app can SELECT & INSERT on auth.user / auth.account and public.workspaces
      expect(
        psql([
          "-U",
          "kvitbit_app",
          "-d",
          "kvitbit_fresh",
          "-c",
          `INSERT INTO auth."user" (id, name, email, email_verified, created_at, updated_at)
           VALUES ('u1', 'Ada', 'ada@example.com', true, now(), now());
           INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
           VALUES ('a1', 'acc1', 'credential', 'u1', now(), now());
           SELECT count(*) FROM auth.account;
           SELECT count(*) FROM public.workspaces;`,
        ]).exitCode,
      ).toBe(0);

      // Verify kvitbit_app is denied DDL in both public and auth schemas
      expect(
        psql([
          "-U",
          "kvitbit_app",
          "-d",
          "kvitbit_fresh",
          "-c",
          "CREATE TABLE public.should_fail (id int);",
        ]).exitCode,
      ).not.toBe(0);
      expect(
        psql([
          "-U",
          "kvitbit_app",
          "-d",
          "kvitbit_fresh",
          "-c",
          "CREATE TABLE auth.should_fail (id int);",
        ]).exitCode,
      ).not.toBe(0);
      expect(
        psql(["-U", "kvitbit_app", "-d", "kvitbit_fresh", "-c", "DROP TABLE auth.account;"])
          .exitCode,
      ).not.toBe(0);

      // 2. Existing volume upgrade: NO initdb script ran; migrations exist; reconcile creates role & grants
      expect(
        psql(["-U", "kvitbit", "-d", "kvitbit_existing", "-f", initMigrationSql]).exitCode,
      ).toBe(0);
      expect(
        runRoleScript(reconcileScriptPath, {
          POSTGRES_USER: "kvitbit",
          POSTGRES_DB: "kvitbit_existing",
          POSTGRES_APP_USER: "kvitbit_app_existing",
          POSTGRES_APP_PASSWORD: "app_password_2",
        }).exitCode,
      ).toBe(0);
      expect(
        psql([
          "-U",
          "kvitbit_app_existing",
          "-d",
          "kvitbit_existing",
          "-c",
          "SELECT count(*) FROM auth.account; SELECT count(*) FROM public.workspaces;",
        ]).exitCode,
      ).toBe(0);
      expect(
        psql([
          "-U",
          "kvitbit_app_existing",
          "-d",
          "kvitbit_existing",
          "-c",
          "CREATE TABLE auth.should_fail_existing (id int);",
        ]).exitCode,
      ).not.toBe(0);

      // 3. Role-name collision (POSTGRES_USER == POSTGRES_APP_USER) is rejected by BOTH scripts
      for (const script of [initScriptPath, reconcileScriptPath]) {
        const collision = runRoleScript(script, {
          POSTGRES_USER: "kvitbit",
          POSTGRES_DB: "kvitbit_fresh",
          POSTGRES_APP_USER: "kvitbit",
          POSTGRES_APP_PASSWORD: "any",
        });
        expect(collision.exitCode).not.toBe(0);
      }

      // 4. Pre-existing elevated role (SUPERUSER / CREATEDB / CREATEROLE) is rejected by BOTH scripts
      expect(
        psql(["-U", "kvitbit", "-d", "postgres", "-c", "CREATE ROLE elevated_app LOGIN SUPERUSER;"])
          .exitCode,
      ).toBe(0);
      for (const script of [initScriptPath, reconcileScriptPath]) {
        const elevated = runRoleScript(script, {
          POSTGRES_USER: "kvitbit",
          POSTGRES_DB: "kvitbit_fresh",
          POSTGRES_APP_USER: "elevated_app",
          POSTGRES_APP_PASSWORD: "any",
        });
        expect(elevated.exitCode).not.toBe(0);
      }
    } finally {
      if (pgProc !== undefined) {
        pgProc.kill("SIGTERM");
        await pgProc.exited;
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);

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
    expect(workflow).toContain("kvitbit/active-target");
    expect(workflow).toContain("--format='value(value)'");
    expect(workflow).not.toContain("--format='value(queryValue)'");
    expect(workflow).toContain(
      `KVITBIT_ENABLE_RESEND_SECRET: \${{ env.KVITBIT_ENABLE_RESEND_SECRET }}`,
    );
    expect(workflow).toContain(
      `KVITBIT_ENABLE_SMTP_SECRET: \${{ env.KVITBIT_ENABLE_SMTP_SECRET }}`,
    );
    expect(workflow).toContain(
      `KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: \${{ env.KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET }}`,
    );
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

  test("deploy.yml normalizes secret flags and resets legacy runners that cannot confirm a verified target", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: {
        deploy: {
          steps: Array<{ name?: string; run?: string }>;
        };
      };
    };

    const validateStep = parsed.jobs.deploy.steps.find(
      (s) => s.name === "Validate GCP deployment variables",
    );
    const verifyStep = parsed.jobs.deploy.steps.find(
      (s) => s.name === "Verify runner pool reconciled target digest and config",
    );
    expect(validateStep?.run).toBeDefined();
    expect(verifyStep?.run).toBeDefined();

    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-deploy-yml-"));
    try {
      // 1. Test boolean normalization step with YES / 1 / OFF and invalid value
      const ghEnv = join(sandbox, "github_env");
      writeFileSync(ghEnv, "");
      const baseVars = {
        KVITBIT_STAGE: "prod",
        GCP_PROJECT_ID: "kvitbit-prod",
        GCP_PROJECT_NUMBER: "449188423567",
        GCP_REGION: "europe-west3",
        GCP_ZONE: "europe-west3-a",
        GCP_WORKLOAD_IDENTITY_PROVIDER:
          "projects/1/locations/global/workloadIdentityPools/gh/providers/gh",
        GCP_DEPLOYER_SERVICE_ACCOUNT: "deployer@kvitbit-prod.iam.gserviceaccount.com",
        ALCHEMY_STATE_BUCKET: "alchemy-state-kvitbit-prod",
        GITHUB_ENV: ghEnv,
      };
      const normOk = Bun.spawnSync(["bash", "-c", validateStep?.run ?? ""], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...baseVars,
          KVITBIT_ENABLE_RESEND_SECRET: "YES",
          KVITBIT_ENABLE_SMTP_SECRET: "1",
          KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "OFF",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(normOk.exitCode).toBe(0);
      const exported = readFileSync(ghEnv, "utf8");
      expect(exported).toContain("KVITBIT_ENABLE_RESEND_SECRET=true");
      expect(exported).toContain("KVITBIT_ENABLE_SMTP_SECRET=true");
      expect(exported).toContain("KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET=false");

      const normBad = Bun.spawnSync(["bash", "-c", validateStep?.run ?? ""], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...baseVars,
          KVITBIT_ENABLE_RESEND_SECRET: "maybe",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(normBad.exitCode).not.toBe(0);

      // 2. Verify the rollout step requires the combined acknowledgement from the current script.
      const binDir = join(sandbox, "bin");
      const stateDir = join(sandbox, "state");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(stateDir, { recursive: true });

      const targetDigest = `sha256:${"a".repeat(64)}`;
      const targetConfigSha = `sha256:${"c".repeat(64)}`;

      writeFileSync(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "sleep"), 0o755);

      writeFileSync(
        join(binDir, "gcloud"),
        `#!/bin/sh
set -eu
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "list" ]; then
  printf 'kvitbit-prod-runner-0\\nkvitbit-prod-runner-1\\n'
  exit 0
fi
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "describe" ]; then
  printf '{"metadata":{"items":[{"key":"kvitbit-worker-config-sha","value":"${targetConfigSha}"}]}}'
  exit 0
fi
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "reset" ]; then
  echo "reset:$4" >> "${stateDir}/resets"
  touch "${stateDir}/reset-$4"
  exit 0
fi
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "get-guest-attributes" ]; then
  RUNNER="$4"
  QUERY_PATH=""
  FORMAT=""
  for arg in "$@"; do
    case "$arg" in
      --query-path=*) QUERY_PATH="\${arg#--query-path=}" ;;
      --format=*) FORMAT="\${arg#--format=}" ;;
    esac
  done
  # Enforce exact gcloud value(value) projection
  if [ "$FORMAT" != "value(value)" ]; then
    exit 0
  fi
  case "$QUERY_PATH" in
    "kvitbit/active-digest") printf '%s\\n' "${targetDigest}" ;;
    "kvitbit/active-config-sha") printf '%s\\n' "${targetConfigSha}" ;;
    "kvitbit/active-target")
      # Legacy runner-1 advertises matching individual attributes. Only the updated script,
      # installed on reset, can attest to the combined target.
      if [ "$RUNNER" = "kvitbit-prod-runner-0" ] || [ -f "${stateDir}/reset-kvitbit-prod-runner-1" ]; then
        printf '%s\\n' "${targetDigest}|${targetConfigSha}"
      fi
      ;;
  esac
  exit 0
fi
exit 1
`,
      );
      chmodSync(join(binDir, "gcloud"), 0o755);

      const verifyRes = Bun.spawnSync(["bash", "-c", verifyStep?.run ?? ""], {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          GCP_PROJECT_ID: "kvitbit-prod",
          GCP_ZONE: "europe-west3-a",
          KVITBIT_STAGE: "prod",
          TARGET_DIGEST: targetDigest,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(verifyRes.exitCode).toBe(0);
      expect(new TextDecoder().decode(verifyRes.stdout)).toContain(
        `Verified runner kvitbit-prod-runner-0 is running digest=${targetDigest} config=${targetConfigSha}`,
      );
      expect(new TextDecoder().decode(verifyRes.stdout)).toContain(
        `Verified runner kvitbit-prod-runner-1 is running digest=${targetDigest} config=${targetConfigSha}`,
      );
      expect(readFileSync(join(stateDir, "resets"), "utf8").trim()).toBe(
        "reset:kvitbit-prod-runner-1",
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
