import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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

      const migrateRuntimeOnly = runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        DATABASE_URL: "postgres://app:pw@external.invalid:5432/kvitbit",
      });
      expect(migrateRuntimeOnly.exitCode).toBe(64);
      expect(migrateRuntimeOnly.stderr).toContain("direct owner connection");

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

  test("migrate and reconcile require the bundled host, port, and database before using owner credentials", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kvitbit-ep-migrate-"));
    try {
      const serverDir = join(sandbox, "apps/server/src");
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, "migrate.ts"), "// migrate\n");
      const fakeBun = join(sandbox, "fake-bun.sh");
      writeFileSync(fakeBun, '#!/bin/sh\nprintf "%s\\n" "$DATABASE_URL_UNPOOLED"\n');
      chmodSync(fakeBun, 0o755);

      const bundledUrl = "postgres://owner:synthetic@postgres:5432/kvitbit";
      const ownerUrl = "postgres://owner:synthetic@postgres:5432/other";
      const migrate = (url: string, owner?: string) =>
        runEntrypoint(["migrate"], {
          KVITBIT_APP_ROOT: sandbox,
          KVITBIT_BUN_BIN: fakeBun,
          KVITBIT_RUNTIME_DATABASE_URL: url,
          KVITBIT_BUNDLED_DATABASE_NAME: "kvitbit",
          KVITBIT_BUNDLED_MIGRATION_URL: bundledUrl,
          ...(owner === undefined ? {} : { DATABASE_MIGRATION_URL: owner }),
        });

      const same = migrate("postgresql://app:p%40ss@Postgres/kvit%62it?sslmode=disable");
      expect(same.exitCode).toBe(0);
      expect(same.stdout.trim()).toBe(bundledUrl);

      for (const url of [
        "postgres://app:synthetic@postgres:5432/other",
        "postgres://app:synthetic@postgres:5433/kvitbit",
        "postgres://app:synthetic@away.invalid:5432/kvitbit?application_name=@postgres:5432",
        "postgres://app:synthetic@postgres:5432/kvitbit?%68ost=away.invalid",
        "postgres://app:synthetic@postgres:5432/kvitbit?port=5433",
        "postgres://app:synthetic@postgres:5432/kvitbit?host=away.invalid&host=postgres",
        "postgres://app:synthetic@postgres:5432/kvitbit?dbname=other",
      ]) {
        const rejected = migrate(url);
        expect(rejected.exitCode).toBe(64);
        expect(rejected.stdout).toBe("");
        expect(rejected.stderr).not.toContain("synthetic");
      }

      const explicit = migrate("postgres://app:synthetic@postgres:5432/other", ownerUrl);
      expect(explicit.exitCode).toBe(0);
      expect(explicit.stdout.trim()).toBe(ownerUrl);

      const invalidFallback = runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        KVITBIT_BUNDLED_DATABASE_NAME: "kvitbit",
        KVITBIT_BUNDLED_MIGRATION_URL: ownerUrl,
      });
      expect(invalidFallback.exitCode).toBe(64);
      expect(invalidFallback.stdout).toBe("");

      const runtimeUrl = "postgres://app:synthetic@postgres:5432/second_db";
      const fakePsql = join(sandbox, "psql");
      writeFileSync(fakePsql, '#!/bin/sh\nprintf "%s\\n" "unexpected owner access"\n');
      chmodSync(fakePsql, 0o755);
      for (const runtime of [
        { DATABASE_URL: runtimeUrl },
        { KVITBIT_RUNTIME_DATABASE_URL: runtimeUrl },
      ]) {
        const wrongDatabase = runEntrypoint(["migrate"], {
          KVITBIT_APP_ROOT: sandbox,
          KVITBIT_BUN_BIN: fakeBun,
          KVITBIT_BUNDLED_DATABASE_NAME: "first_db",
          KVITBIT_BUNDLED_MIGRATION_URL: "postgres://owner:synthetic@postgres:5432/first_db",
          ...runtime,
        });
        expect(wrongDatabase.exitCode).toBe(64);
        expect(wrongDatabase.stdout).toBe("");

        const roleResult = Bun.spawnSync(["sh", join(repoRoot, "docker/reconcile-app-role.sh")], {
          env: {
            PATH: `${sandbox}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            PGHOST: "postgres",
            PGPORT: "5432",
            POSTGRES_DB: "first_db",
            ...runtime,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(roleResult.exitCode).toBe(64);
        expect(roleResult.stdout.toString()).toBe("");
        expect(roleResult.stderr.toString()).toContain("different database");
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
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
    const targetScriptPath = join(repoRoot, "docker/database-target.sh");
    expect(existsSync(initScriptPath)).toBe(true);
    expect(existsSync(reconcileScriptPath)).toBe(true);

    for (const scriptPath of [initScriptPath, reconcileScriptPath, targetScriptPath]) {
      const syntax = Bun.spawnSync(["sh", "-n", scriptPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(syntax.exitCode).toBe(0);
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
    expect(parsed.services.postgres.volumes).toContain(
      "./docker/reconcile-app-role.sh:/usr/local/bin/reconcile-app-role.sh:ro",
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
    expect(parsed.services["reconcile-roles"].volumes).toContain(
      "./docker/database-target.sh:/usr/local/bin/database-target.sh:ro",
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

  const makePostgresRoleSandbox = (container: string) => {
    const owner = "kvitbit";
    const ownerPassword = "synthetic-pg-owner";
    const passwordMarker = "synthetic-runtime-password-sentinel";
    const password = `${passwordMarker}-'quoted`;
    const fresh = "kvitbit_fresh";
    const existing = "kvitbit_existing";
    const migration = join(repoRoot, "packages/db/drizzle/20261123175822_init/migration.sql");
    const runDocker = (args: ReadonlyArray<string>) => {
      const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const exec = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
      runDocker([
        "exec",
        ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        container,
        ...args,
      ]);
    const psql = (db: string, args: ReadonlyArray<string>, user = owner) =>
      exec(
        [
          "psql",
          "-XqAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-h",
          "127.0.0.1",
          "-U",
          user,
          "-d",
          db,
          ...args,
        ],
        { PGPASSWORD: user === owner ? ownerPassword : password },
      );
    const sql = (db: string, statement: string, user?: string) => psql(db, ["-c", statement], user);
    const assertOk = (result: ReturnType<typeof runDocker>) => {
      if (result.exitCode !== 0) throw new Error(result.stderr.replaceAll(password, "[redacted]"));
      return result.stdout.trim();
    };
    const assertPrivate = (result: ReturnType<typeof runDocker>) => {
      expect(result.stdout.includes(passwordMarker)).toBe(false);
      expect(result.stderr.includes(passwordMarker)).toBe(false);
    };

    const start = async () => {
      assertOk(
        runDocker([
          "run",
          "--detach",
          "--rm",
          "--name",
          container,
          "--env",
          `POSTGRES_USER=${owner}`,
          "--env",
          `POSTGRES_PASSWORD=${ownerPassword}`,
          "--env",
          `POSTGRES_DB=${fresh}`,
          "--env",
          `POSTGRES_APP_PASSWORD=${password}`,
          "--mount",
          `type=bind,src=${join(repoRoot, "docker/postgres-init")},dst=/docker-entrypoint-initdb.d,readonly`,
          "--mount",
          `type=bind,src=${join(repoRoot, "docker/reconcile-app-role.sh")},dst=/usr/local/bin/reconcile-app-role.sh,readonly`,
          "--mount",
          `type=bind,src=${join(repoRoot, "docker/database-target.sh")},dst=/usr/local/bin/database-target.sh,readonly`,
          "--mount",
          `type=bind,src=${migration},dst=/migration.sql,readonly`,
          "postgres:17-alpine",
        ]),
      );

      let version = "";
      for (let attempt = 0; attempt < 50; attempt++) {
        const probe = sql(fresh, "SHOW server_version_num");
        if (probe.exitCode === 0) {
          version = probe.stdout.trim();
          break;
        }
        await Bun.sleep(100);
      }
      if (!version)
        throw new Error(runDocker(["logs", container]).stderr.replaceAll(password, "[redacted]"));
      expect(version).toMatch(/^17[0-9]{4}$/);
      expect(assertOk(sql(fresh, "SELECT current_user", "kvitbit_app"))).toBe("kvitbit_app");
    };
    const init = "/docker-entrypoint-initdb.d/01-create-app-role.sh";
    const reconcile = "/usr/local/bin/reconcile-app-role.sh";
    const roleScript = (
      script: string,
      db: string,
      role: string,
      env: Record<string, string> = {},
    ) => {
      return exec(["sh", script], {
        PGHOST: "127.0.0.1",
        PGPORT: "5432",
        PGPASSWORD: ownerPassword,
        POSTGRES_DB: db,
        POSTGRES_APP_USER: role,
        POSTGRES_APP_PASSWORD: password,
        ...env,
      });
    };
    return {
      start,
      stop: () => runDocker(["rm", "-f", container]),
      logs: () => runDocker(["logs", container]),
      init,
      reconcile,
      roleScript,
      fresh,
      existing,
      owner,
      psql,
      sql,
      assertOk,
      assertPrivate,
    };
  };

  const withPostgresRoleSandbox = async (
    run: (fixture: ReturnType<typeof makePostgresRoleSandbox>) => void,
  ) => {
    const fixture = makePostgresRoleSandbox(`kvitbit-pg-roles-${randomUUID()}`);
    try {
      await fixture.start();
      run(fixture);
    } finally {
      fixture.stop();
    }
  };

  test("PostgreSQL 17 init and reconcile keep runtime passwords out of stdout and stderr", async () => {
    await withPostgresRoleSandbox(
      ({ init, reconcile, fresh, roleScript, logs, sql, assertOk, assertPrivate }) => {
        assertPrivate(logs());
        assertOk(sql(fresh, "CREATE ROLE elevated_privacy SUPERUSER"));
        for (const script of [init, reconcile]) {
          const ok = roleScript(script, fresh, "kvitbit_app");
          assertPrivate(ok);
          assertOk(ok);

          const rejected = roleScript(script, fresh, "elevated_privacy");
          assertPrivate(rejected);
          expect(rejected.exitCode).not.toBe(0);
          expect(rejected.stderr).toContain("Refusing elevated runtime role");
        }
      },
    );
  }, 45_000);

  test("PostgreSQL 17 rejects runtime ownership of existing application tables", async () => {
    await withPostgresRoleSandbox(({ init, reconcile, fresh, roleScript, sql, assertOk }) => {
      assertOk(
        sql(
          fresh,
          `
          CREATE ROLE legacy_app;
          CREATE ROLE legacy_member;
          CREATE ROLE legacy_inherit_member;
          CREATE ROLE legacy_set_inherit_bridge;
          CREATE ROLE legacy_set_inherit_member;
          CREATE ROLE legacy_admin_member;
          CREATE ROLE legacy_inherit_admin_bridge;
          CREATE ROLE legacy_inherit_admin_member;
          CREATE ROLE legacy_table_owner;
          CREATE TABLE public.legacy_table (id integer);
          ALTER TABLE public.legacy_table OWNER TO legacy_app;
          CREATE SCHEMA auth;
          CREATE TABLE auth.legacy_table (id integer);
          ALTER TABLE auth.legacy_table OWNER TO legacy_table_owner;
          GRANT legacy_table_owner TO legacy_member WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
          GRANT legacy_table_owner TO legacy_inherit_member WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
          GRANT legacy_table_owner TO legacy_set_inherit_bridge WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
          GRANT legacy_set_inherit_bridge TO legacy_set_inherit_member WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
          GRANT legacy_table_owner TO legacy_admin_member WITH INHERIT FALSE, SET FALSE, ADMIN TRUE;
          GRANT legacy_table_owner TO legacy_inherit_admin_bridge WITH INHERIT FALSE, SET FALSE, ADMIN TRUE;
          GRANT legacy_inherit_admin_bridge TO legacy_inherit_admin_member WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
        `,
        ),
      );

      for (const role of [
        "legacy_app",
        "legacy_member",
        "legacy_inherit_member",
        "legacy_set_inherit_member",
        "legacy_admin_member",
        "legacy_inherit_admin_member",
      ]) {
        expect(
          assertOk(
            sql(
              fresh,
              `
              SELECT has_database_privilege('${role}', current_database(), 'CREATE'),
                     has_schema_privilege('${role}', 'public', 'CREATE'),
                     has_schema_privilege('${role}', 'auth', 'CREATE')
            `,
            ),
          ),
        ).toBe("f|f|f");
        for (const script of [init, reconcile]) {
          const result = roleScript(script, fresh, role);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("owns database object");
        }
        expect(
          assertOk(sql(fresh, `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${role}'`)),
        ).toBe("f");
      }
    });
  }, 45_000);

  test("PostgreSQL 17 allows inactive table-owner membership while keeping runtime DDL blocked", async () => {
    await withPostgresRoleSandbox(({ init, reconcile, fresh, roleScript, sql, assertOk }) => {
      assertOk(
        sql(
          fresh,
          `
          CREATE ROLE relation_owner;
          CREATE ROLE report_reader;
          CREATE TABLE public.owned_records (id integer);
          ALTER TABLE public.owned_records OWNER TO relation_owner;
          GRANT relation_owner TO report_reader WITH INHERIT FALSE, SET FALSE, ADMIN FALSE;
        `,
        ),
      );

      expect(
        assertOk(
          sql(
            fresh,
            `
            SELECT pg_has_role('report_reader', 'relation_owner', 'MEMBER'),
                   pg_has_role('report_reader', 'relation_owner', 'USAGE'),
                   pg_has_role('report_reader', 'relation_owner', 'SET')
          `,
          ),
        ),
      ).toBe("t|f|f");

      for (const script of [init, reconcile]) {
        assertOk(roleScript(script, fresh, "report_reader"));
      }

      expect(
        assertOk(
          sql(
            fresh,
            "INSERT INTO public.owned_records (id) VALUES (1); SELECT count(*) FROM public.owned_records;",
            "report_reader",
          ),
        ),
      ).toBe("1");

      for (const ddl of [
        "ALTER TABLE public.owned_records ADD COLUMN extra integer",
        "DROP TABLE public.owned_records",
        "SET ROLE relation_owner",
        "GRANT relation_owner TO report_reader WITH SET TRUE",
      ]) {
        const denied = sql(fresh, ddl, "report_reader");
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stderr).toMatch(/must be owner|permission denied/);
      }
    });
  }, 45_000);

  test("PostgreSQL 17 revokes database CREATE and enforces DML-only runtime roles", async () => {
    await withPostgresRoleSandbox(
      ({ init, reconcile, fresh, existing, owner, roleScript, psql, sql, assertOk }) => {
        const runtimeUrl = `postgres://kvitbit_app:synthetic@127.0.0.1/${fresh}`;
        assertOk(psql(fresh, ["-f", "/migration.sql"]));
        assertOk(
          roleScript(reconcile, fresh, "kvitbit_app", { KVITBIT_RUNTIME_DATABASE_URL: runtimeUrl }),
        );
        expect(
          assertOk(
            sql(
              fresh,
              `
        INSERT INTO auth."user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('u1', 'Ada', 'ada@example.com', true, now(), now());
        INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
        VALUES ('a1', 'acc1', 'credential', 'u1', now(), now());
        SELECT count(*) FROM auth.account;
        SELECT count(*) FROM public.workspaces;
      `,
              "kvitbit_app",
            ),
          ),
        ).toBe("1\n0");
        for (const ddl of [
          "CREATE SCHEMA should_fail",
          "CREATE TABLE public.should_fail (id int)",
          "CREATE TABLE auth.should_fail (id int)",
          "DROP TABLE auth.account",
        ]) {
          expect(sql(fresh, ddl, "kvitbit_app").stderr).toMatch(/permission denied|must be owner/);
        }

        assertOk(sql(fresh, `CREATE DATABASE ${existing}`));
        assertOk(psql(existing, ["-f", "/migration.sql"]));
        assertOk(roleScript(reconcile, existing, "new_app"));
        expect(assertOk(sql(existing, "SELECT count(*) FROM auth.account", "new_app"))).toBe("0");

        const wrongDbUrl = { KVITBIT_RUNTIME_DATABASE_URL: `${runtimeUrl}_other` };
        const wrongDb = roleScript(reconcile, fresh, "unselected_app", wrongDbUrl);
        expect(wrongDb.exitCode).toBe(64);
        expect(wrongDb.stderr).toContain("different database");
        assertOk(
          roleScript(reconcile, fresh, "unselected_app", {
            ...wrongDbUrl,
            DATABASE_URL_UNPOOLED: "postgres://owner:synthetic@127.0.0.1/kvitbit_fresh_other",
          }),
        );
        assertOk(
          roleScript(reconcile, fresh, "unselected_app", {
            KVITBIT_RUNTIME_DATABASE_URL: `${runtimeUrl}?port=5433`,
          }),
        );
        expect(assertOk(sql(fresh, "SELECT to_regrole('unselected_app') IS NULL"))).toBe("t");

        assertOk(
          sql(
            existing,
            `
        CREATE ROLE actual_db_owner;
        ALTER DATABASE ${existing} OWNER TO actual_db_owner;
        CREATE ROLE owner_member;
        GRANT actual_db_owner TO owner_member WITH INHERIT FALSE, SET TRUE;
        CREATE ROLE configured_owner_member;
        GRANT ${owner} TO configured_owner_member WITH INHERIT FALSE, SET TRUE;
        CREATE ROLE superuser_member;
        CREATE ROLE member_bridge;
        CREATE ROLE elevated_superuser SUPERUSER;
        GRANT elevated_superuser TO member_bridge WITH INHERIT FALSE, SET TRUE;
        GRANT member_bridge TO superuser_member WITH INHERIT FALSE, SET TRUE;
        CREATE ROLE set_role_app;
        CREATE ROLE inherit_role_app;
        CREATE ROLE schema_creator;
        GRANT CREATE ON SCHEMA auth TO schema_creator;
        GRANT schema_creator TO set_role_app WITH INHERIT FALSE, SET TRUE;
        GRANT schema_creator TO inherit_role_app WITH INHERIT TRUE, SET FALSE;
        CREATE ROLE elevated_createdb CREATEDB;
        CREATE ROLE elevated_createrole CREATEROLE;
        CREATE ROLE elevated_bypassrls BYPASSRLS;
        CREATE ROLE elevated_replication REPLICATION;
      `,
          ),
        );

        for (const [script, role] of [
          [init, "init_app"],
          [reconcile, "reconcile_app"],
        ] as const) {
          assertOk(
            sql(
              existing,
              `
          CREATE ROLE ${role};
          GRANT CREATE ON DATABASE ${existing} TO ${role};
          GRANT CREATE ON SCHEMA public, auth TO ${role};
        `,
            ),
          );
          assertOk(roleScript(script, existing, role));
          expect(
            assertOk(
              sql(
                existing,
                `
          SELECT has_database_privilege(current_user, current_database(), 'CREATE'),
                 has_schema_privilege(current_user, 'public', 'CREATE'),
                 has_schema_privilege(current_user, 'auth', 'CREATE')
        `,
                role,
              ),
            ),
          ).toBe("f|f|f");
          expect(assertOk(sql(existing, "SELECT count(*) FROM public.workspaces", role))).toBe("0");

          for (const [invalidRole, diagnostic] of [
            [owner, "must name different roles"],
            ["actual_db_owner", "owns the database or belongs"],
            ["owner_member", "owns the database or belongs"],
            ["configured_owner_member", "owns the database or belongs"],
            ["superuser_member", "owns the database or belongs"],
            ["set_role_app", "effective CREATE privileges"],
            ["inherit_role_app", "effective CREATE privileges"],
            ...["superuser", "createdb", "createrole", "bypassrls", "replication"].map(
              (flag) => [`elevated_${flag}`, "Refusing elevated runtime role"] as const,
            ),
          ] as const) {
            const result = roleScript(script, existing, invalidRole);
            expect(result.stderr).toContain(diagnostic);
            expect(result.exitCode).not.toBe(0);
          }

          for (const target of [`DATABASE ${existing}`, "SCHEMA public"]) {
            assertOk(
              sql(
                existing,
                `
            GRANT CREATE ON DATABASE ${existing} TO ${role};
            GRANT CREATE ON ${target} TO PUBLIC;
          `,
              ),
            );
            const result = roleScript(script, existing, role);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("effective CREATE privileges");
            assertOk(sql(existing, `REVOKE CREATE ON ${target} FROM PUBLIC`));
            // A failed check rolls back the role script's direct grant changes.
            expect(
              assertOk(
                sql(
                  existing,
                  `
            SELECT has_database_privilege('${role}', current_database(), 'CREATE')
          `,
                ),
              ),
            ).toBe("t");
            assertOk(roleScript(script, existing, role));
          }
        }
      },
    );
  }, 45_000);

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

  test("deploy.yml verifies readiness and both static mounts through the public Cloud Run URL", async () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: { deploy: { steps: Array<{ name?: string; run?: string }> } };
    };
    const script = parsed.jobs.deploy.steps.find(
      (step) => step.name === "Verify database readiness and static mounts",
    )?.run;
    if (script === undefined) throw new Error("Missing external deploy verification step");

    const paths: string[] = [];
    const webPage = () =>
      new Response("<html>Web app</html>", { headers: { "Content-Type": "text/html" } });
    const routes = new Map([
      ["/readyz", () => Response.json({ status: "ok" })],
      ["/", webPage],
      [
        "/app/manifest.webmanifest",
        () =>
          new Response('{"name":"Kvitbit"}', {
            headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
          }),
      ],
    ]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        // Cloud Run's frontend returns 404 for /healthz.
        return routes.get(path)?.() ?? new Response("Not found", { status: 404 });
      },
    });
    const runProbe = async () => {
      paths.length = 0;
      const child = Bun.spawn(
        ["bash", "-c", `gcloud() { printf '%s\\n' "$TEST_ORIGIN"; }\n${script}`],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            TEST_ORIGIN: server.url.origin,
            KVITBIT_STAGE: "prod",
            GCP_PROJECT_ID: "test",
            GCP_REGION: "europe-west3",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, output: stdout + stderr };
    };
    try {
      expect((await runProbe()).exitCode).toBe(0);
      expect(paths).toEqual(["/readyz", "/", "/app/manifest.webmanifest"]);

      routes.set("/readyz", () => Response.json({ status: "down" }));
      const notReady = await runProbe();
      expect(notReady.exitCode).toBe(1);
      expect(notReady.output).toContain("/readyz did not report status ok");
      expect(paths).toEqual(["/readyz"]);

      routes.set("/readyz", () => Response.json({ status: "ok" }));
      routes.set(
        "/",
        () =>
          new Response(null, {
            status: 302,
            headers: { "Content-Type": "text/html", Location: "/login" },
          }),
      );
      const webRedirect = await runProbe();
      expect(webRedirect.exitCode).toBe(1);
      expect(webRedirect.output).toContain("/ returned '302 text/html'");
      expect(paths).toEqual(["/readyz", "/"]);

      routes.set("/", webPage);
      routes.set("/app/manifest.webmanifest", webPage);
      const manifestFallback = await runProbe();
      expect(manifestFallback.exitCode).toBe(1);
      expect(manifestFallback.output).toContain("expected HTTP 200 with application/manifest+json");
    } finally {
      server.stop();
    }
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
