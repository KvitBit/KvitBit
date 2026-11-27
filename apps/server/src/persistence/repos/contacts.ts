/** `ContactsRepo` over `contacts` and `contact_preferred_series`. */

import { ContactsRepo } from "@kvitbit/core";
import {
  type ContactDefaults,
  ContactId,
  CurrencyCode,
  type DocumentKind,
  Locale,
  NumberingSeriesId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Types from "effect/Types";
import { asNumberArray, asStringArray, foldText, toPgArray } from "../codec";
import { col, type DbRow, makeTable, type TableSpec } from "../table";

type ContactRow = Effect.Success<ReturnType<ContactsRepo["Service"]["get"]>>;

const matchesText = (row: ContactRow, folded: string): boolean =>
  Arr.some(
    [row.name, row.ico, row.dic, ...row.billingEmails],
    (value) => value !== null && Str.includes(folded)(foldText(value)),
  );

const OptionalText = Schema.String.pipe(Schema.NullOr, Schema.optional);
const StoredContactRow = Schema.Struct({
  id: Schema.String,
  workspace_id: Schema.String,
  revision: Schema.Unknown,
  roles: Schema.NonEmptyArray(Schema.Literals(["customer", "supplier"])),
  name: Schema.String,
  ico: OptionalText,
  dic: OptionalText,
  legal_form: OptionalText,
  street: OptionalText,
  city: OptionalText,
  postal_code: OptionalText,
  country: Schema.String,
  billing_emails: Schema.optional(Schema.Json),
  phone: OptionalText,
  note: OptionalText,
  registry_fetched_at: OptionalText,
  default_currency: OptionalText,
  default_language: Locale.pipe(Schema.NullOr, Schema.optional),
  default_due_days: Schema.optional(Schema.Unknown),
  default_payment_method: PaymentMethod.pipe(Schema.NullOr, Schema.optional),
  default_note: OptionalText,
  reminder_policy_mode: Schema.Literals(["inherit", "disabled", "custom"]),
  reminder_offsets_days: Schema.optional(Schema.Json),
  archived_at: OptionalText,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const decodeRow = Schema.decodeUnknownOption(StoredContactRow);
type StoredContact = typeof StoredContactRow.Type;

const decodeDefaults = (
  row: StoredContact,
  preferred: Readonly<Partial<Record<DocumentKind, NumberingSeriesId>>>,
): ContactDefaults => {
  const mode = row.reminder_policy_mode;
  const reminderPolicy: ContactDefaults["reminderPolicy"] =
    mode === "custom"
      ? { mode: "custom", offsetsDays: asNumberArray(row.reminder_offsets_days) }
      : { mode };
  const defaults: Types.Mutable<ContactDefaults> = {};
  if (Predicate.isNotNullish(row.default_currency)) {
    defaults.currency = CurrencyCode.make(row.default_currency);
  }
  if (Predicate.isNotNullish(row.default_language)) defaults.language = row.default_language;
  if (Predicate.isNotNullish(row.default_due_days)) defaults.dueDays = Number(row.default_due_days);
  if (Predicate.isNotNullish(row.default_payment_method)) {
    defaults.paymentMethod = row.default_payment_method;
  }
  if (Predicate.isNotNullish(row.default_note)) defaults.defaultNote = row.default_note;
  if (EffectRecord.keys<string, NumberingSeriesId>(preferred).length > 0)
    defaults.preferredSeriesByKind = preferred;
  defaults.reminderPolicy = reminderPolicy;
  return defaults;
};

const spec: TableSpec<ContactRow> = {
  table: "contacts",
  collection: "contacts",
  entity: "Contact",
  select: Arr.join(
    [
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
    ],
    ", ",
  ),
  decode: Effect.fn("ContactsRepo.decode")(function* (rows: ReadonlyArray<DbRow>) {
    const stored = Arr.map(rows, (row) =>
      Option.getOrThrow(decodeRow({ ...row, roles: asStringArray(row.roles) })),
    );
    if (!Arr.isArrayNonEmpty(stored)) return [];
    const sql = yield* SqlClient.SqlClient;
    const ids = Arr.map(stored, (row) => row.id);
    const workspaceId = stored[0].workspace_id;
    const prefRows = yield* sql<{
      contact_id: string;
      kind: DocumentKind;
      series_id: string;
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
      map[p.kind] = NumberingSeriesId.make(p.series_id);
    }
    return Arr.map(
      stored,
      (row): ContactRow => ({
        id: ContactId.make(row.id),
        workspaceId: WorkspaceId.make(row.workspace_id),
        revision: Number(row.revision),
        roles: row.roles,
        name: row.name,
        ico: row.ico ?? null,
        dic: row.dic ?? null,
        legalForm: row.legal_form ?? null,
        address: {
          street: row.street ?? null,
          city: row.city ?? null,
          postalCode: row.postal_code ?? null,
          country: row.country,
        },
        billingEmails: asStringArray(row.billing_emails),
        phone: row.phone ?? null,
        note: row.note ?? null,
        defaults: decodeDefaults(row, byContact.get(row.id) ?? {}),
        registryFetchedAt: row.registry_fetched_at ?? null,
        archivedAt: row.archived_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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
  writeChildren: Effect.fn("ContactsRepo.writeChildren")(function* (row, mode) {
    const sql = yield* SqlClient.SqlClient;
    if (mode === "update") {
      yield* sql`
          delete from contact_preferred_series
          where workspace_id = ${row.workspaceId} and contact_id = ${row.id}
        `;
    }
    const preferred = row.defaults.preferredSeriesByKind;
    if (preferred === undefined) return;
    const entries = Arr.filter(
      EffectRecord.toEntries<string, NumberingSeriesId>(preferred),
      ([, v]) => v !== undefined,
    );
    const rowsToInsert = Arr.map(entries, ([kind, seriesId]) => ({
      workspace_id: row.workspaceId,
      contact_id: row.id,
      kind,
      series_id: seriesId,
    }));
    if (!Arr.isArrayNonEmpty(rowsToInsert)) return;
    yield* sql`insert into contact_preferred_series ${sql.insert(rowsToInsert)}`;
  }),
};

export const ContactsRepoSql: Layer.Layer<ContactsRepo, never, SqlClient.SqlClient> = Layer.effect(
  ContactsRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = makeTable(sql, spec);
    return ContactsRepo.of({
      get: Effect.fn("ContactsRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
      getForUpdate: Effect.fn("ContactsRepo.getForUpdate")((workspaceId, id, expectedRevision) =>
        table.getForUpdate(workspaceId, id, expectedRevision),
      ),
      lock: Effect.fn("ContactsRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
      findActiveByIco: Effect.fn("contacts.activeByIco")((workspaceId, ico) =>
        table.first(workspaceId, sql`archived_at is null and ico = ${ico}`),
      ),
      insert: table.insert,
      update: table.update,
      search: Effect.fn("ContactsRepo.search")((workspaceId, query) =>
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
            return Arr.filter(
              rows,
              (row) =>
                (query.role === undefined || row.roles.includes(query.role)) &&
                (folded === "" || matchesText(row, folded)),
            ).slice(0, query.limit);
          },
        ),
      ),
    });
  }),
);
