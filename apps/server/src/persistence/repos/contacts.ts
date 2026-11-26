/** `ContactsRepo` over `contacts` and `contact_preferred_series`. */
import { ContactsRepo } from "@kvitbit/core";
import type {
  ContactDefaults,
  ContactId,
  ContactRole,
  CurrencyCode,
  DocumentKind,
  Locale,
  NumberingSeriesId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { asNumberArray, asStringArray, foldText, toPgArray } from "../codec";
import { col, type DbRow, makeTable, type TableSpec } from "../table";

type ContactRow = Effect.Success<ReturnType<ContactsRepo["Service"]["get"]>>;

const matchesText = (row: ContactRow, folded: string): boolean =>
  [row.name, row.ico, row.dic, ...row.billingEmails].some(
    (value) => value !== null && foldText(value).includes(folded),
  );

const decodeDefaults = (
  row: DbRow,
  preferred: Readonly<Partial<Record<DocumentKind, NumberingSeriesId>>>,
): ContactDefaults => {
  const mode = row.reminder_policy_mode as "inherit" | "disabled" | "custom";
  const reminderPolicy: ContactDefaults["reminderPolicy"] =
    mode === "custom"
      ? { mode: "custom", offsetsDays: asNumberArray(row.reminder_offsets_days) }
      : { mode };
  return {
    ...(row.default_currency != null ? { currency: row.default_currency as CurrencyCode } : {}),
    ...(row.default_language != null ? { language: row.default_language as Locale } : {}),
    ...(row.default_due_days != null ? { dueDays: Number(row.default_due_days) } : {}),
    ...(row.default_payment_method != null
      ? { paymentMethod: row.default_payment_method as PaymentMethod }
      : {}),
    ...(row.default_note != null ? { defaultNote: row.default_note as string } : {}),
    ...(Object.keys(preferred).length > 0 ? { preferredSeriesByKind: preferred } : {}),
    reminderPolicy,
  };
};

const spec: TableSpec<ContactRow> = {
  table: "contacts",
  collection: "contacts",
  entity: "Contact",
  select: [
    "id",
    "workspace_id",
    "revision",
    "roles::text[] as roles",
    "name",
    "ico",
    "dic",
    "legal_form",
    "street",
    "city",
    "postal_code",
    "country",
    "billing_emails",
    "phone",
    "note",
    col.instant("registry_fetched_at"),
    "default_currency",
    "default_language",
    "default_due_days",
    "default_payment_method",
    "default_note",
    "reminder_policy_mode",
    "reminder_offsets_days",
    col.instant("archived_at"),
    col.instant("created_at"),
    col.instant("updated_at"),
  ].join(", "),
  decode: (rows) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = rows.map((r) => r.id as string);
      const workspaceId = rows[0]?.workspace_id as string;
      const prefRows = yield* sql<{
        contact_id: string;
        kind: DocumentKind;
        series_id: NumberingSeriesId;
      }>`
        select contact_id, kind, series_id
        from contact_preferred_series
        where workspace_id = ${workspaceId} and contact_id in ${sql.in(ids)}
      `;
      const byContact = new Map<string, Partial<Record<DocumentKind, NumberingSeriesId>>>();
      for (const p of prefRows) {
        let map = byContact.get(p.contact_id);
        if (map === undefined) {
          map = {};
          byContact.set(p.contact_id, map);
        }
        map[p.kind] = p.series_id;
      }
      return rows.map(
        (row): ContactRow => ({
          id: row.id as ContactId,
          workspaceId: row.workspace_id as WorkspaceId,
          revision: Number(row.revision),
          roles: asStringArray(row.roles) as unknown as ContactRow["roles"],
          name: row.name as string,
          ico: (row.ico as string | null) ?? null,
          dic: (row.dic as string | null) ?? null,
          legalForm: (row.legal_form as string | null) ?? null,
          address: {
            street: (row.street as string | null) ?? null,
            city: (row.city as string | null) ?? null,
            postalCode: (row.postal_code as string | null) ?? null,
            country: row.country as string,
          },
          billingEmails: asStringArray(row.billing_emails),
          phone: (row.phone as string | null) ?? null,
          note: (row.note as string | null) ?? null,
          defaults: decodeDefaults(row, byContact.get(row.id as string) ?? {}),
          registryFetchedAt: (row.registry_fetched_at as string | null) ?? null,
          archivedAt: (row.archived_at as string | null) ?? null,
          createdAt: row.created_at as string,
          updatedAt: row.updated_at as string,
        }),
      );
    }),
  encode: (row) => {
    const policy = row.defaults.reminderPolicy;
    const mode = policy?.mode ?? "inherit";
    const offsets = mode === "custom" && policy?.mode === "custom" ? [...policy.offsetsDays] : null;
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      roles: toPgArray(row.roles),
      name: row.name,
      ico: row.ico,
      dic: row.dic,
      legal_form: row.legalForm,
      street: row.address.street,
      city: row.address.city,
      postal_code: row.address.postalCode,
      country: row.address.country,
      billing_emails: [...row.billingEmails],
      phone: row.phone,
      note: row.note,
      registry_fetched_at: row.registryFetchedAt,
      default_currency: row.defaults.currency ?? null,
      default_language: row.defaults.language ?? null,
      default_due_days: row.defaults.dueDays ?? null,
      default_payment_method: row.defaults.paymentMethod ?? null,
      default_note: row.defaults.defaultNote ?? null,
      reminder_policy_mode: mode,
      reminder_offsets_days: offsets,
      archived_at: row.archivedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  },
  writeChildren: (row, mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (mode === "update") {
        yield* sql`
          delete from contact_preferred_series
          where workspace_id = ${row.workspaceId} and contact_id = ${row.id}
        `;
      }
      const preferred = row.defaults.preferredSeriesByKind;
      if (preferred === undefined) return;
      const entries = Object.entries(preferred).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const rowsToInsert = entries.map(([kind, seriesId]) => ({
        workspace_id: row.workspaceId,
        contact_id: row.id,
        kind,
        series_id: seriesId,
      })) as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
      yield* sql`insert into contact_preferred_series ${sql.insert(rowsToInsert)}`;
    }),
};

export const ContactsRepoSql: Layer.Layer<ContactsRepo, never, SqlClient.SqlClient> = Layer.effect(
  ContactsRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = makeTable(sql, spec);
    return ContactsRepo.of({
      get: (workspaceId, id) => table.get(workspaceId, id),
      getForUpdate: (workspaceId, id, expectedRevision) =>
        table.getForUpdate(workspaceId, id, expectedRevision),
      lock: (workspaceId, id) => table.lock(workspaceId, id),
      findActiveByIco: (workspaceId, ico) =>
        table.first(workspaceId, sql`archived_at is null and ico = ${ico}`),
      insert: table.insert,
      update: table.update,
      search: (workspaceId, query) =>
        Effect.map(
          table.select(
            workspaceId,
            query.after === undefined
              ? sql`archived_at is null`
              : sql`archived_at is null and (name collate "C" > ${query.after[0]} collate "C" or (name collate "C" = ${query.after[0]} collate "C" and id > ${query.after[1]}::uuid))`,
            sql`order by name collate "C" asc, id asc`,
          ),
          (rows) => {
            const folded = query.text === undefined ? "" : foldText(query.text);
            return rows
              .filter(
                (row) =>
                  (query.role === undefined || row.roles.includes(query.role as ContactRole)) &&
                  (folded === "" || matchesText(row, folded)),
              )
              .slice(0, query.limit);
          },
        ),
    });
  }),
);
