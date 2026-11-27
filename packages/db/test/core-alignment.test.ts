import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun uses Node's synchronous filesystem APIs to stage the migration tree.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as Arr from "effect/Array";

// The core record alignment migration (#451, #479, #557) is applied on top of a database that
// already holds rows from the init migration, as it would be in a deployed install.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const INIT = "20261123175822_init";

const ws = "0190a000-0000-7000-8000-0000000002a0";
const contact = "0190a000-0000-7000-8000-0000000002a1";
const template = "0190a000-0000-7000-8000-0000000002a2";
const schedule = "0190a000-0000-7000-8000-0000000002a3";
const run = "0190a000-0000-7000-8000-0000000002a4";
const paidExpense = "0190a000-0000-7000-8000-0000000002a5";
const unpaidExpense = "0190a000-0000-7000-8000-0000000002a6";
const overpaidExpense = "0190a000-0000-7000-8000-0000000002a7";
const issuedDoc = "0190a000-0000-7000-8000-0000000002a8";
const delivery = "0190a000-0000-7000-8000-0000000002a9";
const queuedRun = "0190a000-0000-7000-8000-0000000002c1";
const sendFailedRun = "0190a000-0000-7000-8000-0000000002c2";
const issueFailedRun = "0190a000-0000-7000-8000-0000000002c3";

let client: PGlite;
let initOnly: string | undefined;

const rows = async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<Array<T>> =>
  (await client.query<T>(sql, [...params])).rows;

beforeAll(async () => {
  initOnly = mkdtempSync(join(tmpdir(), "kvitbit-db-init-"));
  cpSync(join(migrationsFolder, INIT), join(initOnly, INIT), { recursive: true });
  client = new PGlite();
  await migrate(drizzle({ client }), { migrationsFolder: initOnly });
  await client.exec(`
    insert into workspaces (id, slug, name) values ('${ws}', 'eta', 'Eta');
    insert into auth."user" (id, name, email) values ('u-align', 'A', 'a@example.test');
    insert into memberships (workspace_id, user_id, role) values ('${ws}', 'u-align', 'owner');
    insert into contacts (id, workspace_id, name) values ('${contact}', '${ws}', 'C');
    insert into templates (id, workspace_id, name, kind, contact_id, body)
      values ('${template}', '${ws}', 'T', 'invoice', '${contact}', '{}');
    insert into schedules (id, workspace_id, template_id, cadence_unit, cadence_interval, start_on, issue_as)
      values ('${schedule}', '${ws}', '${template}', 'months', 1, '2026-01-01', 'invoice');
    insert into schedule_runs (id, workspace_id, schedule_id, occurrence, outcome)
      values ('${run}', '${ws}', '${schedule}', '2026-01-01', 'skipped_missed');
    insert into documents (id, workspace_id, kind, contact_id, currency, language, payment_method)
      values ('${issuedDoc}', '${ws}', 'invoice', '${contact}', 'CZK', 'cs', 'bank_transfer');
    insert into deliveries (id, workspace_id, document_id, document_revision, purpose, recipients, language, subject, render_model)
      values ('${delivery}', '${ws}', '${issuedDoc}', 1, 'document', '{a@example.test}', 'cs', 'S', '{}');
    insert into schedule_runs (id, workspace_id, schedule_id, occurrence, outcome, document_id, delivery_id, failure) values
      ('${queuedRun}', '${ws}', '${schedule}', '2026-02-01', 'issued', '${issuedDoc}', '${delivery}', null),
      ('${sendFailedRun}', '${ws}', '${schedule}', '2026-03-01', 'issued', '${issuedDoc}', null, 'contact_email_missing'),
      ('${issueFailedRun}', '${ws}', '${schedule}', '2026-04-01', 'failed', null, null, 'contact_email_missing');
    insert into expenses (id, workspace_id, status, currency) values
      ('${paidExpense}', '${ws}', 'incomplete', 'CZK'),
      ('${unpaidExpense}', '${ws}', 'incomplete', 'CZK'),
      ('${overpaidExpense}', '${ws}', 'incomplete', 'CZK');
    insert into payments (id, workspace_id, expense_id, amount, currency, paid_on, method, removed_at) values
      (gen_random_uuid(), '${ws}', '${paidExpense}', '100.50', 'CZK', '2026-01-02', 'cash', null),
      (gen_random_uuid(), '${ws}', '${paidExpense}', '20.00', 'CZK', '2026-01-03', 'cash', null),
      (gen_random_uuid(), '${ws}', '${paidExpense}', '999.00', 'CZK', '2026-01-04', 'cash', now()),
      (gen_random_uuid(), '${ws}', '${overpaidExpense}', '9999999999999999.99', 'CZK', '2026-01-02', 'cash', null),
      (gen_random_uuid(), '${ws}', '${overpaidExpense}', '0.01', 'CZK', '2026-01-03', 'cash', null);
  `);
  await migrate(drizzle({ client }), { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (initOnly !== undefined) rmSync(initOnly, { recursive: true, force: true });
});

describe("core record alignment migration", () => {
  test("adds the columns core rows carry, with their types, nullability and defaults", async () => {
    const cols = await rows<{
      name: string;
      type: string;
      nullable: string;
      default: string | null;
    }>(
      `select table_name || '.' || column_name as name, udt_name as type,
              is_nullable as nullable, column_default as default
       from information_schema.columns where table_schema = 'public'`,
    );
    const byName = new Map(Arr.map(cols, (c) => [c.name, c]));
    const expected: ReadonlyArray<readonly [string, string, "YES" | "NO", string | null]> = [
      ["schedules.catch_up_through", "date", "YES", null],
      ["schedules.paused_error", "text", "YES", null],
      ["schedules.revision", "int4", "NO", "1"],
      ["schedule_runs.send_state", "recurring_send_state", "NO", "'none'::recurring_send_state"],
      ["schedule_runs.revision", "int4", "NO", "1"],
      ["document_lines.deducted_vat_czk", "numeric", "YES", null],
      ["expenses.deductible_percent", "int4", "NO", "100"],
      ["expenses.paid", "numeric", "NO", "'0'::numeric"],
      ["expenses.payments", "int4", "NO", "0"],
      ["memberships.removed_at", "timestamptz", "YES", null],
      ["memberships.revision", "int4", "NO", "1"],
      ["deliveries.provider", "text", "YES", null],
      ["deliveries.provider_message_id", "text", "YES", null],
      ["fx_fixing_requests.requested_on", "date", "NO", null],
      ["fx_fixing_requests.fixing_date", "date", "NO", null],
    ];
    for (const [name, type, nullable, dflt] of expected) {
      expect({ name, ...byName.get(name) }).toEqual({ name, type, nullable, default: dflt });
    }
  });

  test("the send state enum has core's RunSend literals", async () => {
    const labels = await rows<{ label: string }>(
      `select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'recurring_send_state' order by e.enumsortorder`,
    );
    expect(Arr.map(labels, (l) => l.label)).toEqual(["none", "pending", "queued", "failed"]);
  });

  test("existing rows get defaults; expense paid totals are backfilled from live Payments", async () => {
    expect(await rows("select revision, paused_error, catch_up_through from schedules")).toEqual([
      { revision: 1, paused_error: null, catch_up_through: null },
    ]);
    expect(await rows("select id, revision, send_state from schedule_runs order by id")).toEqual([
      { id: run, revision: 1, send_state: "none" },
      { id: queuedRun, revision: 1, send_state: "queued" },
      { id: sendFailedRun, revision: 1, send_state: "failed" },
      { id: issueFailedRun, revision: 1, send_state: "none" },
    ]);
    expect(await rows("select revision, removed_at from memberships")).toEqual([
      { revision: 1, removed_at: null },
    ]);
    expect(
      await rows("select id, deductible_percent, paid, payments from expenses order by id"),
    ).toEqual([
      { id: paidExpense, deductible_percent: 100, paid: "120.50", payments: 2 },
      { id: unpaidExpense, deductible_percent: 100, paid: "0", payments: 0 },
      { id: overpaidExpense, deductible_percent: 100, paid: "10000000000000000.00", payments: 2 },
    ]);
  });

  test("the new checks reject rows core never writes", async () => {
    await expect(
      client.query("update expenses set deductible_percent = 101 where id = $1", [paidExpense]),
    ).rejects.toThrow("expenses_deductible_percent_range");
    await expect(
      client.query("update expenses set payments = -1 where id = $1", [paidExpense]),
    ).rejects.toThrow("expenses_payments_nonnegative");
    await expect(
      client.query(`update schedule_runs set send_state = 'sent' where id = $1`, [run]),
    ).rejects.toThrow("invalid input value for enum recurring_send_state");
    await expect(
      client.query(`update schedule_runs set send_state = 'failed' where id = $1`, [
        issueFailedRun,
      ]),
    ).rejects.toThrow("schedule_runs_send_needs_issued");
    await expect(
      client.query(`update schedule_runs set send_state = 'queued' where id = $1`, [sendFailedRun]),
    ).rejects.toThrow("schedule_runs_queued_has_delivery");
    await expect(
      client.query(`update schedules set paused_error = 'NotFound:Contact' where id = $1`, [
        schedule,
      ]),
    ).rejects.toThrow("schedules_pause_fields_need_paused_at");
    const doc = "0190a000-0000-7000-8000-0000000002b0";
    await client.query(
      `insert into documents (id, workspace_id, kind, contact_id, currency, language, payment_method)
       values ($1, $2, 'invoice', $3, 'CZK', 'cs', 'bank_transfer')`,
      [doc, ws, contact],
    );
    await expect(
      client.query(
        `insert into document_lines (id, workspace_id, document_id, position, description, unit_price, vat, deducted_vat_czk)
         values (gen_random_uuid(), $1, $2, 1, 'L', '1', 'standard', '1.00')`,
        [ws, doc],
      ),
    ).rejects.toThrow("document_lines_deducted_vat_czk_on_deduction");
  });

  test("an FX request date resolves to a stored fixing", async () => {
    await client.query(
      "insert into fx_fixings (fixing_date, sequence, rates) values ('2026-01-05', 2, '[]')",
    );
    await expect(
      client.query(
        "insert into fx_fixing_requests (requested_on, fixing_date) values ('2026-01-04', '2026-01-05')",
      ),
    ).rejects.toThrow("fx_fixing_requests_not_after_request");
    await client.exec(`
      insert into fx_fixings (fixing_date, sequence, rates) values ('2026-01-02', 1, '[]');
      insert into fx_fixing_requests (requested_on, fixing_date)
        values ('2026-01-02', '2026-01-02'), ('2026-01-03', '2026-01-02'), ('2026-01-04', '2026-01-02');
    `);
    expect(
      await rows(
        `select f.fixing_date::text, f.sequence from fx_fixing_requests r
         join fx_fixings f using (fixing_date) where r.requested_on = '2026-01-04'`,
      ),
    ).toEqual([{ fixing_date: "2026-01-02", sequence: 1 }]);
  });
});
