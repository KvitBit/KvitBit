import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

let client: PGlite;

const rows = async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<Array<T>> =>
  (await client.query<T>(sql, [...params])).rows;

beforeAll(async () => {
  client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder });
});

afterAll(async () => {
  await client.close();
});

describe("committed migration", () => {
  test("matches the schema: drizzle-kit generate has nothing to generate", () => {
    const result = Bun.spawnSync(
      ["bunx", "drizzle-kit", "generate", "--explain", "--output", "json"],
      { cwd: packageDir, env: { ...process.env, DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" } },
    );
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('"status":"no_changes"');
  }, 60_000);

  test("creates the public and auth tables", async () => {
    const tables = await rows<{ name: string }>(
      `select table_schema || '.' || table_name as name from information_schema.tables
       where table_schema in ('public', 'auth') and table_type = 'BASE TABLE'`,
    );
    const names = tables.map((t) => t.name);
    for (const name of [
      "public.workspaces",
      "public.documents",
      "public.number_reservations",
      "public.numbering_counters",
      "public.altcha_replays",
      "public.audit_entries",
      "public.user_preferences",
      "auth.user",
      "auth.session",
      "auth.passkey",
      "auth.apikey",
      "auth.oauth_client",
      "auth.oauth_consent",
      "auth.oauth_access_token",
      "auth.oauth_refresh_token",
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe("schema invariants", () => {
  test("mutable aggregates carry an optimistic revision column", async () => {
    const withRevision = await rows<{ table_name: string }>(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'revision'
         and is_nullable = 'NO' and column_default = '1'`,
    );
    const names = withRevision.map((r) => r.table_name);
    for (const table of [
      "workspaces",
      "invitations",
      "bank_accounts",
      "numbering_series",
      "contacts",
      "price_list_items",
      "documents",
      "payments",
      "expenses",
      "templates",
      "user_preferences",
    ]) {
      expect(names).toContain(table);
    }
  });

  test("every Workspace-owned table has a non-null workspace_id", async () => {
    const global = new Set([
      "workspaces",
      "user_preferences",
      "altcha_replays",
      "fx_fixings",
      "request_log",
      "__drizzle_migrations",
    ]);
    const tables = await rows<{ table_name: string; nullable: string | null }>(
      `select t.table_name, c.is_nullable as nullable
       from information_schema.tables t
       left join information_schema.columns c
         on c.table_schema = t.table_schema and c.table_name = t.table_name
        and c.column_name = 'workspace_id'
       where t.table_schema = 'public' and t.table_type = 'BASE TABLE'`,
    );
    const offenders = tables
      .filter((t) => !global.has(t.table_name) && t.nullable !== "NO")
      .map((t) => t.table_name);
    expect(offenders).toEqual([]);
  });

  test("foreign keys between Workspace-owned tables include workspace_id", async () => {
    const fks = await rows<{ name: string; ref: string; cols: string[]; refcols: string[] }>(
      `select c.conname as name, f.relname as ref,
         array(select attname::text from pg_attribute where attrelid = c.conrelid and attnum = any(c.conkey)) as cols,
         array(select attname::text from pg_attribute where attrelid = c.confrelid and attnum = any(c.confkey)) as refcols
       from pg_constraint c
       join pg_class r on r.oid = c.conrelid
       join pg_namespace n on n.oid = r.relnamespace
       join pg_class f on f.oid = c.confrelid
       join pg_namespace fn on fn.oid = f.relnamespace
       where c.contype = 'f' and n.nspname = 'public' and fn.nspname = 'public'
         and f.relname <> 'workspaces'`,
    );
    expect(fks.length).toBeGreaterThan(10);
    const unscoped = fks
      .filter((fk) => !fk.cols.includes("workspace_id") || !fk.refcols.includes("workspace_id"))
      .map((fk) => fk.name);
    expect(unscoped).toEqual([]);
  });
});

describe("constraints", () => {
  const wsA = "0190a000-0000-7000-8000-00000000000a";
  const wsB = "0190a000-0000-7000-8000-00000000000b";
  const contactA = "0190a000-0000-7000-8000-0000000000c1";
  const seriesA = "0190a000-0000-7000-8000-0000000000e1";

  beforeAll(async () => {
    await client.exec(`
      insert into auth."user" (id, name, email) values ('u1', 'Owner', 'owner@example.test');
      insert into workspaces (id, slug, name) values ('${wsA}', 'alpha', 'Alpha'), ('${wsB}', 'beta', 'Beta');
      insert into contacts (id, workspace_id, name) values ('${contactA}', '${wsA}', 'Customer');
      insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
        values ('${seriesA}', '${wsA}', 'invoice', 'Invoices', 'YYYYNNNN', true);
    `);
  });

  test("a document cannot reference a Contact of another Workspace", async () => {
    await expect(
      client.query(
        `insert into documents (id, workspace_id, kind, contact_id, currency, language, payment_method)
         values ('0190a000-0000-7000-8000-0000000000d1', $1, 'invoice', $2, 'CZK', 'cs', 'bank_transfer')`,
        [wsB, contactA],
      ),
    ).rejects.toThrow(/documents_contact_fk/);
  });

  test("a document number is reserved once per Workspace and kind", async () => {
    const reserve = (ws: string, kind: string) =>
      client.query(
        `insert into number_reservations (workspace_id, kind, number, series_id) values ($1, $2, '20260001', $3)`,
        [ws, kind, ws === wsA ? seriesA : null],
      );
    await reserve(wsA, "invoice");
    await expect(reserve(wsA, "invoice")).rejects.toThrow(/number_reservations_pkey/);
    await reserve(wsA, "proforma");
    await reserve(wsB, "invoice");
  });

  test("issued numbers are unique per Workspace and kind; drafts have none", async () => {
    const insert = (id: string, status: string, number: string | null) =>
      client.query(
        `insert into documents (id, workspace_id, kind, status, number, contact_id, currency, language, payment_method)
         values ($1, $2, 'invoice', $3, $4, $5, 'CZK', 'cs', 'bank_transfer')`,
        [id, wsA, status, number, contactA],
      );
    await insert("0190a000-0000-7000-8000-0000000000d2", "issued", "20260001");
    await expect(
      insert("0190a000-0000-7000-8000-0000000000d3", "issued", "20260001"),
    ).rejects.toThrow(/documents_number_unique/);
    await expect(
      insert("0190a000-0000-7000-8000-0000000000d4", "draft", "20260002"),
    ).rejects.toThrow(/documents_number_iff_not_draft/);
    await expect(insert("0190a000-0000-7000-8000-0000000000d5", "issued", null)).rejects.toThrow(
      /documents_number_iff_not_draft/,
    );
  });

  test("a series cannot reuse a period counter row", async () => {
    const counter = () =>
      client.query(
        `insert into numbering_counters (workspace_id, series_id, period) values ($1, $2, '2026')`,
        [wsA, seriesA],
      );
    await counter();
    await expect(counter()).rejects.toThrow(/numbering_counters_pkey/);
    await expect(
      client.query(
        `insert into numbering_counters (workspace_id, series_id, period) values ($1, $2, '2027')`,
        [wsB, seriesA],
      ),
    ).rejects.toThrow(/numbering_counters_series_fk/);
  });

  test("only one default series per kind and one owner per Workspace", async () => {
    await expect(
      client.query(
        `insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
         values ('0190a000-0000-7000-8000-0000000000e2', $1, 'invoice', 'Second', 'NNNN', true)`,
        [wsA],
      ),
    ).rejects.toThrow(/numbering_series_one_default_per_kind/);
    await client.exec(`
      insert into auth."user" (id, name, email) values ('u2', 'Other', 'other@example.test');
      insert into memberships (workspace_id, user_id, role) values ('${wsA}', 'u1', 'owner');
    `);
    await expect(
      client.query(
        `insert into memberships (workspace_id, user_id, role) values ($1, 'u2', 'owner')`,
        [wsA],
      ),
    ).rejects.toThrow(/memberships_one_owner/);
  });

  test("an ALTCHA solution is consumed exactly once", async () => {
    const consume = () =>
      rows(
        `insert into altcha_replays (challenge_digest, scope, expires_at)
         values ('digest-1', 'sign_up', now() + interval '5 minutes')
         on conflict (challenge_digest) do nothing returning challenge_digest`,
      );
    expect(await consume()).toHaveLength(1);
    expect(await consume()).toHaveLength(0);
  });

  test("Contact reminder offsets exist only for the custom policy", async () => {
    await expect(
      client.query(
        `insert into contacts (id, workspace_id, name, reminder_policy_mode)
         values ('0190a000-0000-7000-8000-0000000000c2', $1, 'X', 'custom')`,
        [wsA],
      ),
    ).rejects.toThrow(/contacts_reminder_offsets_match_mode/);
    await client.query(
      `insert into contacts (id, workspace_id, name, reminder_policy_mode, reminder_offsets_days)
       values ('0190a000-0000-7000-8000-0000000000c3', $1, 'Y', 'custom', '{7,14}')`,
      [wsA],
    );
  });

  test("account preferences default to the elegant style and follow the Workspace theme", async () => {
    await client.query(`insert into user_preferences (user_id) values ('u1')`);
    const [prefs] = await rows<{ theme_style: string; theme_source: unknown; revision: number }>(
      `select theme_style, theme_source, revision from user_preferences where user_id = 'u1'`,
    );
    expect(prefs).toEqual({ theme_style: "elegant", theme_source: null, revision: 1 });
  });
});
