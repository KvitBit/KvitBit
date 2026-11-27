import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

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
      { cwd: packageDir, env: { ...Bun.env, DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" } },
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
    const names = Arr.map(tables, (t) => t.name);
    for (const name of [
      "public.workspaces",
      "public.documents",
      "public.number_reservations",
      "public.numbering_counters",
      "public.altcha_replays",
      "public.audit_entries",
      "public.mcp_confirmations",
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
    const names = Arr.map(withRevision, (r) => r.table_name);
    for (const table of [
      "workspaces",
      "invitations",
      "bank_accounts",
      "numbering_series",
      "contacts",
      "price_list_items",
      "documents",
      "deliveries",
      "payments",
      "expenses",
      "attachments",
      "templates",
      "schedules",
      "schedule_runs",
      "memberships",
      "exports",
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
      "fx_fixing_requests",
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
    const offenders = Fn.pipe(
      tables,
      Arr.filter((t) => !global.has(t.table_name) && t.nullable !== "NO"),
      Arr.map((t) => t.table_name),
    );
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
    const unscoped = Fn.pipe(
      fks,
      Arr.filter(
        (fk) => !(fk.cols.includes("workspace_id") && fk.refcols.includes("workspace_id")),
      ),
      Arr.map((fk) => fk.name),
    );
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
    ).rejects.toThrow("documents_contact_fk");
  });

  test("a document number is reserved once per Workspace and kind", async () => {
    const reserve = (ws: string, kind: string) =>
      client.query(
        `insert into number_reservations (workspace_id, kind, number, series_id) values ($1, $2, '20260001', $3)`,
        [ws, kind, ws === wsA ? seriesA : null],
      );
    await reserve(wsA, "invoice");
    await expect(reserve(wsA, "invoice")).rejects.toThrow("number_reservations_pkey");
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
    ).rejects.toThrow("documents_number_unique");
    await expect(
      insert("0190a000-0000-7000-8000-0000000000d4", "draft", "20260002"),
    ).rejects.toThrow("documents_number_iff_not_draft");
    await expect(insert("0190a000-0000-7000-8000-0000000000d5", "issued", null)).rejects.toThrow(
      "documents_number_iff_not_draft",
    );
  });

  test("a series cannot reuse a period counter row", async () => {
    const counter = () =>
      client.query(
        `insert into numbering_counters (workspace_id, series_id, period) values ($1, $2, '2026')`,
        [wsA, seriesA],
      );
    await counter();
    await expect(counter()).rejects.toThrow("numbering_counters_pkey");
    await expect(
      client.query(
        `insert into numbering_counters (workspace_id, series_id, period) values ($1, $2, '2027')`,
        [wsB, seriesA],
      ),
    ).rejects.toThrow("numbering_counters_series_fk");
  });

  test("only one default series per kind and one owner per Workspace", async () => {
    await expect(
      client.query(
        `insert into numbering_series (id, workspace_id, kind, name, pattern, is_default)
         values ('0190a000-0000-7000-8000-0000000000e2', $1, 'invoice', 'Second', 'NNNN', true)`,
        [wsA],
      ),
    ).rejects.toThrow("numbering_series_one_default_per_kind");
    await client.exec(`
      insert into auth."user" (id, name, email) values ('u2', 'Other', 'other@example.test');
      insert into memberships (workspace_id, user_id, role) values ('${wsA}', 'u1', 'owner');
    `);
    await expect(
      client.query(
        `insert into memberships (workspace_id, user_id, role) values ($1, 'u2', 'owner')`,
        [wsA],
      ),
    ).rejects.toThrow("memberships_one_owner");
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
    ).rejects.toThrow("contacts_reminder_offsets_match_mode");
    await client.query(
      `insert into contacts (id, workspace_id, name, reminder_policy_mode, reminder_offsets_days)
       values ('0190a000-0000-7000-8000-0000000000c3', $1, 'Y', 'custom', '{7,14}')`,
      [wsA],
    );
  });

  test("account preferences default to the elegant style and follow the Workspace theme", async () => {
    await client.query("insert into user_preferences (user_id) values ('u1')");
    const [prefs] = await rows<{ theme_style: string; theme_source: unknown; revision: number }>(
      "select theme_style, theme_source, revision from user_preferences where user_id = 'u1'",
    );
    expect(prefs).toEqual({ theme_style: "elegant", theme_source: null, revision: 1 });
  });
});

describe("council follow-up constraints", () => {
  const ws = "0190a000-0000-7000-8000-0000000000f0";
  const other = "0190a000-0000-7000-8000-0000000000f9";
  const contact = "0190a000-0000-7000-8000-0000000000f1";
  const proforma = "0190a000-0000-7000-8000-0000000000f2";
  const finalA = "0190a000-0000-7000-8000-0000000000f3";
  const finalB = "0190a000-0000-7000-8000-0000000000f4";
  const template = "0190a000-0000-7000-8000-0000000000f5";

  beforeAll(async () => {
    await client.exec(`
      insert into auth."user" (id, name, email) values ('u9', 'Grantor', 'grantor@example.test');
      insert into workspaces (id, slug, name) values ('${ws}', 'gamma', 'Gamma'), ('${other}', 'delta', 'Delta');
      insert into contacts (id, workspace_id, name) values ('${contact}', '${ws}', 'C');
      insert into documents (id, workspace_id, kind, status, number, contact_id, currency, language, payment_method) values
        ('${proforma}', '${ws}', 'proforma', 'issued', 'P1', '${contact}', 'CZK', 'cs', 'bank_transfer'),
        ('${finalA}', '${ws}', 'invoice', 'issued', 'F1', '${contact}', 'CZK', 'cs', 'bank_transfer'),
        ('${finalB}', '${ws}', 'invoice', 'issued', 'F2', '${contact}', 'CZK', 'cs', 'bank_transfer');
      insert into templates (id, workspace_id, name, kind, contact_id, body)
        values ('${template}', '${ws}', 'Monthly', 'invoice', '${contact}', '{}');
    `);
  });

  test("the expected workspace-scoped foreign keys exist", async () => {
    const names = Arr.map(
      await rows<{ conname: string }>("select conname from pg_constraint where contype = 'f'"),
      (row) => row.conname,
    );
    for (const fk of [
      "documents_contact_fk",
      "documents_series_fk",
      "documents_bank_account_fk",
      "documents_schedule_fk",
      "document_lines_document_fk",
      "document_lines_deducts_document_fk",
      "document_relations_from_fk",
      "document_relations_to_fk",
      "payments_document_fk",
      "payments_expense_fk",
      "payments_tax_document_fk",
      "deliveries_document_fk",
      "share_links_document_fk",
      "share_view_events_share_link_fk",
      "attachments_expense_fk",
      "templates_contact_fk",
      "schedules_template_fk",
      "schedule_runs_schedule_fk",
      "schedule_runs_document_fk",
      "schedule_runs_delivery_fk",
      "numbering_counters_series_fk",
      "number_reservations_series_fk",
      "number_reservations_document_fk",
      "contact_preferred_series_contact_fk",
      "contact_preferred_series_series_fk",
      "expenses_contact_fk",
    ]) {
      expect(names).toContain(fk);
    }
  });

  test("a number reservation cannot point at another Workspace's document", async () => {
    await expect(
      client.query(
        `insert into number_reservations (workspace_id, kind, number, document_id) values ($1, 'invoice', 'X1', $2)`,
        [other, finalA],
      ),
    ).rejects.toThrow("number_reservations_document_fk");
  });

  test("a Proforma has at most one Final Invoice", async () => {
    const link = (to: string) =>
      client.query(
        `insert into document_relations (workspace_id, from_document_id, to_document_id, relation)
         values ($1, $2, $3, 'final_invoice_for')`,
        [ws, proforma, to],
      );
    await link(finalA);
    await expect(link(finalB)).rejects.toThrow("document_relations_one_final_invoice_per_proforma");
  });

  test("a deducted VAT amount needs the deducted document", async () => {
    await expect(
      client.query(
        `insert into document_lines (id, workspace_id, document_id, position, description, unit_price, vat, deducted_vat)
         values ('0190a000-0000-7000-8000-0000000000fa', $1, $2, 1, 'Advance', '-100', 'standard', '-21')`,
        [ws, finalA],
      ),
    ).rejects.toThrow("document_lines_deducted_vat_on_deduction");
  });

  test("a detached schedule keeps its row while a new one attaches", async () => {
    const attach = (id: string) =>
      client.query(
        `insert into schedules (id, workspace_id, template_id, cadence_unit, cadence_interval, start_on, issue_as)
         values ($1, $2, $3, 'months', 1, '2026-01-01', 'invoice')`,
        [id, ws, template],
      );
    await attach("0190a000-0000-7000-8000-0000000000fb");
    await expect(attach("0190a000-0000-7000-8000-0000000000fc")).rejects.toThrow(
      "schedules_one_attached_per_template",
    );
    await client.query("update schedules set detached_at = now() where id = $1", [
      "0190a000-0000-7000-8000-0000000000fb",
    ]);
    await attach("0190a000-0000-7000-8000-0000000000fc");
  });

  test("System audit entries carry the job identifiers", async () => {
    const audit = (job: string | null) =>
      client.query(
        `insert into audit_entries (id, workspace_id, actor_system_job, actor_job, subject_entity, subject_id, action)
         values (gen_random_uuid(), $1, 'DataExport', $2::jsonb, 'Export', 'e1', 'export.ready')`,
        [ws, job],
      );
    await expect(audit(null)).rejects.toThrow("audit_entries_job_with_system_actor");
    await audit('{"exportId":"e1"}');
  });

  test("a Workspace-bound MCP grant needs a user and scopes", async () => {
    await client.query(
      "insert into auth.oauth_client (id, client_id, redirect_uris) values ('c1', 'client-1', '{https://a.test/cb}')",
    );
    const grant = (userId: string | null, scopes: string) =>
      client.query(
        `insert into auth.oauth_consent (id, client_id, user_id, scopes, workspace_id, access, granted_scopes)
         values (gen_random_uuid()::text, 'client-1', $1, '{kvitbit:read}', $2, 'read', $3::text[])`,
        [userId, ws, scopes],
      );
    await expect(grant(null, "{documents:read}")).rejects.toThrow("oauth_consent_grant_bound");
    await expect(grant("u9", "{}")).rejects.toThrow("oauth_consent_grant_bound");
    await grant("u9", "{documents:read}");
  });

  test("timestamp columns keep their own names", async () => {
    const cols = Arr.map(
      await rows<{ name: string }>(
        `select table_name || '.' || column_name as name from information_schema.columns
         where table_schema = 'public' and column_name in ('joined_at', 'reserved_at', 'consumed_at', 'at')`,
      ),
      (column) => column.name,
    );
    for (const col of [
      "memberships.joined_at",
      "number_reservations.reserved_at",
      "altcha_replays.consumed_at",
      "audit_entries.at",
      "schedule_runs.at",
      "share_view_events.at",
    ]) {
      expect(cols).toContain(col);
    }
  });
});

describe("review round 1 regressions", () => {
  const ws = "0190a000-0000-7000-8000-0000000001a0";
  const other = "0190a000-0000-7000-8000-0000000001b0";
  const contact = "0190a000-0000-7000-8000-0000000001a1";
  const foreignSeries = "0190a000-0000-7000-8000-0000000001b2";
  const foreignAccount = "0190a000-0000-7000-8000-0000000001b3";
  const foreignItem = "0190a000-0000-7000-8000-0000000001b4";
  const template = "0190a000-0000-7000-8000-0000000001a5";

  beforeAll(async () => {
    await client.exec(`
      insert into workspaces (id, slug, name) values ('${ws}', 'epsilon', 'Epsilon'), ('${other}', 'zeta', 'Zeta');
      insert into contacts (id, workspace_id, name) values ('${contact}', '${ws}', 'C');
      insert into numbering_series (id, workspace_id, kind, name, pattern) values ('${foreignSeries}', '${other}', 'invoice', 'S', 'NNNN');
      insert into bank_accounts (id, workspace_id, currency, iban) values ('${foreignAccount}', '${other}', 'CZK', 'CZ6508000000192000145399');
      insert into price_list_items (id, workspace_id, name, unit_price, currency) values ('${foreignItem}', '${other}', 'I', '10', 'CZK');
      insert into templates (id, workspace_id, name, kind, contact_id, body) values ('${template}', '${ws}', 'T', 'invoice', '${contact}', '{}');
    `);
  });

  test("a template cannot reference another Workspace's series, bank account or item", async () => {
    const tpl = (column: string, value: string) =>
      client.query(
        `insert into templates (id, workspace_id, name, kind, contact_id, body, ${column})
         values (gen_random_uuid(), $1, 'X', 'invoice', $2, '{}', $3)`,
        [ws, contact, value],
      );
    await expect(tpl("series_id", foreignSeries)).rejects.toThrow("templates_series_fk");
    await expect(tpl("bank_account_id", foreignAccount)).rejects.toThrow(
      "templates_bank_account_fk",
    );
    await expect(
      client.query(
        `insert into template_lines (id, workspace_id, template_id, position, price_list_item_id)
         values (gen_random_uuid(), $1, $2, 1, $3)`,
        [ws, template, foreignItem],
      ),
    ).rejects.toThrow("template_lines_price_list_item_fk");
  });

  test("schedule workflow starts record their occurrence", async () => {
    await expect(
      client.query(
        `insert into schedules (id, workspace_id, template_id, cadence_unit, cadence_interval, start_on, issue_as, workflow_started_at)
         values (gen_random_uuid(), $1, $2, 'weeks', 1, '2026-01-01', 'invoice', now())`,
        [ws, template],
      ),
    ).rejects.toThrow("schedules_workflow_start_complete");
  });

  test("an account deletion tombstone carries its purge date", async () => {
    await expect(
      client.query(
        "insert into auth.\"user\" (id, name, email, deleted_at) values ('u-del', 'D', 'd@example.test', now())",
      ),
    ).rejects.toThrow("user_deletion_complete");
  });

  test("reminder offsets, expense removal and OAuth provider columns exist", async () => {
    const cols = Arr.map(
      await rows<{ name: string }>(
        `select table_schema || '.' || table_name || '.' || column_name as name
         from information_schema.columns where table_schema in ('public', 'auth')`,
      ),
      (column) => column.name,
    );
    for (const col of [
      "public.documents.reminder_offsets_days",
      "public.expenses.removed_at",
      "auth.oauth_refresh_token.rotated_at",
      "auth.oauth_refresh_token.rotation_replay_response",
      "auth.oauth_refresh_token.rotation_replay_expires_at",
      "auth.oauth_access_token.confirmation",
      "auth.oauth_client.client_credentials_scopes",
      "auth.oauth_resource.identifier",
      "auth.oauth_client_resource.resource_id",
      "auth.oauth_client_assertion.expires_at",
      "auth.passkey.credential_id",
      "auth.apikey.config_id",
    ]) {
      expect(cols).toContain(col);
    }
  });
});
