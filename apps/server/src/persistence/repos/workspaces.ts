/**
 * `WorkspacesRepo` over `workspaces`, `issuing_entities`, `tax_regime_periods`,
 * `workspace_slug_aliases`, `memberships`, `invitations` and `bank_accounts`.
 */
import { WorkspacesModule, WorkspacesRepo } from "@kvitbit/core";
import { StoreUnavailable, UniqueViolation } from "@kvitbit/core/ports";
import {
  BankAccountId,
  Conflict,
  CurrencyCode,
  Hex,
  ImageRef,
  InvitationId,
  InvitationRole,
  InvitationStatus,
  IsoDate,
  Locale,
  NotFound,
  PaymentMethod,
  PdfTemplate,
  Role,
  TaxRegime,
  ThemeSource,
  UserId,
  type WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { asNumberArray, decodeStored, decodeWorkspaceId, parseJson, toJsonb } from "../codec";
import { unavailable, writeErrors } from "../errors";
import { col, type DbRow, decodeEach, makeTable, type TableSpec } from "../table";

type WorkspaceRow = Effect.Success<ReturnType<WorkspacesRepo["Service"]["getWorkspace"]>>;
type SlugAliasRow = Option.Option.Value<
  Effect.Success<ReturnType<WorkspacesRepo["Service"]["findSlugAlias"]>>
>;
type MembershipRow = Option.Option.Value<
  Effect.Success<ReturnType<WorkspacesRepo["Service"]["findMembership"]>>
>;
type InvitationRow = Effect.Success<ReturnType<WorkspacesRepo["Service"]["getInvitation"]>>;
type BankAccountRow = Effect.Success<ReturnType<WorkspacesRepo["Service"]["getBankAccount"]>>;

const { MEMBERSHIP_USER_UNIQUE, SLUG_ALIAS_UNIQUE } = WorkspacesModule;

const invalidStoredValue = () => new Error("Invalid stored value");

const readBrandingJson = parseJson(Schema.Unknown);

// Workspace updates write branding back, so preserve extra fields in validated JSONB values.
const decodeBranding = <S extends Schema.Constraint>(schema: S) => {
  const validate = Option.liftPredicate<unknown, S["Type"]>(Schema.is(schema));
  return (value: DbRow[string]): S["Type"] =>
    Option.getOrThrowWith(validate(readBrandingJson(value)), invalidStoredValue);
};

const decodeString = decodeStored(Schema.String);
const decodeNullableString = decodeStored(Schema.NullOr(Schema.String));
const decodeTaxRegime = decodeStored(TaxRegime);
const decodeLocale = decodeStored(Locale);
const decodePaymentMethod = decodeStored(PaymentMethod);
const decodePaymentRounding = decodeStored(WorkspacesModule.PaymentRounding);
const decodePdfTemplate = decodeStored(PdfTemplate);
const decodeInvitationRole = decodeStored(InvitationRole);
const decodeInvitationStatus = decodeStored(InvitationStatus);
const decodeRole = decodeStored(Role);
const decodeTheme = decodeBranding(ThemeSource);
const decodeImageRef = decodeBranding(ImageRef);

const workspaceSpec: TableSpec<WorkspaceRow> = {
  table: "workspaces",
  collection: "workspaces",
  entity: "Workspace",
  scope: "id",
  select: Arr.join(
    [
      "id",
      "revision",
      "slug",
      "name",
      "default_currency",
      "default_language",
      "default_due_days",
      "default_note",
      "default_payment_method",
      "payment_rounding",
      "auto_send_payment_tax_document",
      "reminders_enabled",
      "reminders_for_proformas",
      "reminder_offsets_days",
      "pdf_template",
      "accent_color",
      "footer_text",
      "theme_source",
      "logo",
      "stamp",
      col.instant("closed_at"),
      col.instant("created_at"),
    ],
    ", ",
  ),
  decode: Effect.fn("WorkspacesRepo.decodeWorkspaces")(function* (rows: ReadonlyArray<DbRow>) {
    const sql = yield* SqlClient.SqlClient;
    const ids = Arr.map(rows, (r) => decodeString(r["id"]));
    const [entities, regimes, defaults] = yield* Effect.all(
      [
        sql<DbRow>`
          select workspace_id, legal_name, legal_form, ico, dic, street, city, postal_code,
            country, commercial_register, email, phone, web
          from issuing_entities
          where workspace_id in ${sql.in(ids)}
        `,
        sql<DbRow>`
          select workspace_id, ${sql.unsafe(col.date("effective_from"))}, regime
          from tax_regime_periods
          where workspace_id in ${sql.in(ids)}
          order by effective_from asc
        `,
        sql<DbRow>`
          select workspace_id, currency, id
          from bank_accounts
          where workspace_id in ${sql.in(ids)} and is_default = true and archived_at is null
        `,
      ],
      { concurrency: 1 },
    );

    const entityByWs = new Map<string, DbRow>(
      Arr.map(entities, (e) => [decodeString(e["workspace_id"]), e] as const),
    );
    const regimesByWs = new Map<string, Array<{ regime: TaxRegime; effectiveFrom: IsoDate }>>();
    for (const r of regimes) {
      const ws = decodeString(r["workspace_id"]);
      const list = regimesByWs.get(ws) ?? [];
      list.push({
        regime: decodeTaxRegime(r["regime"]),
        effectiveFrom: IsoDate.make(decodeString(r["effective_from"])),
      });
      regimesByWs.set(ws, list);
    }
    const bankByWs = new Map<string, Record<string, BankAccountId>>();
    for (const b of defaults) {
      const ws = decodeString(b["workspace_id"]);
      const map = bankByWs.get(ws) ?? {};
      map[CurrencyCode.make(decodeString(b["currency"]))] = BankAccountId.make(
        decodeString(b["id"]),
      );
      bankByWs.set(ws, map);
    }

    return Arr.map(rows, (row): WorkspaceRow => {
      const id = decodeWorkspaceId(row["id"]);
      const ie = entityByWs.get(id) ?? {};
      const closedAt = decodeNullableString(row["closed_at"] ?? null);
      const name = decodeString(row["name"]);
      return {
        id,
        workspaceId: id,
        revision: Number(row["revision"]),
        slug: WorkspaceSlug.make(decodeString(row["slug"])),
        name,
        closed: closedAt !== null,
        closedAt,
        createdAt: decodeString(row["created_at"]),
        issuingEntity: {
          name: decodeString(ie["legal_name"] ?? name),
          ico: decodeNullableString(ie["ico"] ?? null),
          dic: decodeNullableString(ie["dic"] ?? null),
          address: {
            street: decodeString(ie["street"] ?? ""),
            city: decodeString(ie["city"] ?? ""),
            postalCode: decodeString(ie["postal_code"] ?? ""),
            country: decodeString(ie["country"] ?? "CZ"),
          },
          legalForm: decodeNullableString(ie["legal_form"] ?? null),
          registerEntry: decodeNullableString(ie["commercial_register"] ?? null),
          email: decodeNullableString(ie["email"] ?? null),
          phone: decodeNullableString(ie["phone"] ?? null),
          web: decodeNullableString(ie["web"] ?? null),
        },
        taxRegimes: regimesByWs.get(id) ?? [],
        defaults: {
          currency: CurrencyCode.make(decodeString(row["default_currency"])),
          language: decodeLocale(row["default_language"]),
          dueDays: Number(row["default_due_days"]),
          paymentMethod: decodePaymentMethod(row["default_payment_method"]),
          defaultNote: decodeNullableString(row["default_note"] ?? null),
          paymentRounding: decodePaymentRounding(row["payment_rounding"]),
          paymentTaxDocumentAutoSend: Boolean(row["auto_send_payment_tax_document"]),
        },
        bankAccountByCurrency: bankByWs.get(id) ?? {},
        reminders: {
          enabled: Boolean(row["reminders_enabled"]),
          proformas: Boolean(row["reminders_for_proformas"]),
          offsetsDays: asNumberArray(row["reminder_offsets_days"]),
        },
        branding: {
          pdfTemplate: decodePdfTemplate(row["pdf_template"]),
          accentColor: Hex.make(
            decodeString(row["accent_color"] ?? WorkspacesModule.DEFAULT_BRANDING.accentColor),
          ),
          footerText: decodeNullableString(row["footer_text"] ?? null),
          theme: row["theme_source"] === null ? null : decodeTheme(row["theme_source"]),
          logo: row["logo"] === null ? null : decodeImageRef(row["logo"]),
          stamp: row["stamp"] === null ? null : decodeImageRef(row["stamp"]),
        },
      };
    });
  }),
  encode: (row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    default_currency: row.defaults.currency,
    default_language: row.defaults.language,
    default_due_days: row.defaults.dueDays,
    default_note: row.defaults.defaultNote,
    default_payment_method: row.defaults.paymentMethod,
    payment_rounding: row.defaults.paymentRounding,
    auto_send_payment_tax_document: row.defaults.paymentTaxDocumentAutoSend,
    reminders_enabled: row.reminders.enabled,
    reminders_for_proformas: row.reminders.proformas,
    reminder_offsets_days: [...row.reminders.offsetsDays],
    pdf_template: row.branding.pdfTemplate,
    accent_color: row.branding.accentColor,
    footer_text: row.branding.footerText,
    theme_source: toJsonb(row.branding.theme),
    logo: toJsonb(row.branding.logo),
    stamp: toJsonb(row.branding.stamp),
    closed_at: row.closed ? (row.closedAt ?? DateTime.formatIso(DateTime.nowUnsafe())) : null,
    created_at: row.createdAt,
  }),
  writeChildren: Effect.fn("WorkspacesRepo.writeWorkspaceChildren")(function* (
    row: WorkspaceRow,
    mode: "insert" | "update",
  ) {
    const sql = yield* SqlClient.SqlClient;
    const ie = {
      workspace_id: row.id,
      legal_name: row.issuingEntity.name,
      legal_form: row.issuingEntity.legalForm,
      ico: row.issuingEntity.ico,
      dic: row.issuingEntity.dic,
      street: row.issuingEntity.address.street,
      city: row.issuingEntity.address.city,
      postal_code: row.issuingEntity.address.postalCode,
      country: row.issuingEntity.address.country,
      commercial_register: row.issuingEntity.registerEntry,
      email: row.issuingEntity.email,
      phone: row.issuingEntity.phone,
      web: row.issuingEntity.web,
    };
    if (mode === "insert") {
      yield* sql`insert into issuing_entities ${sql.insert(ie)}`;
    } else {
      const { workspace_id: _ws, ...patch } = ie;
      yield* sql`
          insert into issuing_entities ${sql.insert(ie)}
          on conflict (workspace_id) do update set ${sql.update(patch)}
        `;
      yield* sql`delete from tax_regime_periods where workspace_id = ${row.id}`;
    }
    if (Arr.isReadonlyArrayNonEmpty(row.taxRegimes)) {
      const regimeRows = Arr.map(row.taxRegimes, (p) => ({
        workspace_id: row.id,
        effective_from: p.effectiveFrom,
        regime: p.regime,
      }));
      yield* sql`insert into tax_regime_periods ${sql.insert(regimeRows)}`;
    }
    if (mode === "update") {
      const defaultIds = EffectRecord.values(row.bankAccountByCurrency);
      yield* sql`
          update bank_accounts set is_default = false
          where workspace_id = ${row.id} and is_default = true
        `;
      if (defaultIds.length > 0) {
        yield* sql`
            update bank_accounts set is_default = true
            where workspace_id = ${row.id} and id in ${sql.in(defaultIds)} and archived_at is null
          `;
      }
    }
  }),
};

const invitationSpec: TableSpec<InvitationRow> = {
  table: "invitations",
  collection: "invitations",
  entity: "Invitation",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "email",
      "role",
      "status",
      "token_hash",
      "send_epoch",
      col.instant("last_sent_at"),
      col.instant("workflow_started_at"),
      "invited_by",
      col.instant("created_at"),
      col.instant("expires_at"),
      "accepted_by",
    ],
    ", ",
  ),
  decode: decodeEach((row): InvitationRow => {
    const email = decodeString(row["email"]);
    return {
      id: InvitationId.make(decodeString(row["id"])),
      workspaceId: decodeWorkspaceId(row["workspace_id"]),
      revision: Number(row["revision"]),
      email,
      emailLower: Str.toLowerCase(email),
      role: decodeInvitationRole(row["role"]),
      status: decodeInvitationStatus(row["status"]),
      tokenHash: decodeString(row["token_hash"]),
      sendEpoch: Number(row["send_epoch"]),
      lastSentAt: decodeString(row["last_sent_at"]),
      workflowStartedAt: decodeNullableString(row["workflow_started_at"] ?? null),
      invitedBy: UserId.make(decodeString(row["invited_by"])),
      createdAt: decodeString(row["created_at"]),
      expiresAt: decodeString(row["expires_at"]),
      acceptedBy:
        row["accepted_by"] === null || row["accepted_by"] === undefined
          ? null
          : UserId.make(decodeString(row["accepted_by"])),
    };
  }),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    email: row.email,
    role: row.role,
    status: row.status,
    token_hash: row.tokenHash,
    send_epoch: row.sendEpoch,
    last_sent_at: row.lastSentAt,
    workflow_started_at: row.workflowStartedAt,
    invited_by: row.invitedBy,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    accepted_by: row.acceptedBy,
  }),
};

const bankAccountSpec: TableSpec<BankAccountRow> = {
  table: "bank_accounts",
  collection: "bank_accounts",
  entity: "BankAccount",
  select: Arr.join(
    [
      "id",
      "workspace_id",
      "revision",
      "label",
      "iban",
      "bic",
      "currency",
      col.instant("archived_at"),
      col.instant("created_at"),
    ],
    ", ",
  ),
  decode: Effect.fn("WorkspacesRepo.decodeBankAccounts")(function* (rows) {
    const decoded: BankAccountRow[] = [];
    for (const row of rows) {
      const id = BankAccountId.make(decodeString(row["id"]));
      if (row["iban"] === null) {
        // Core bank accounts require an IBAN. The domestic account number cannot stand in for it.
        return yield* StoreUnavailable.make({
          cause: new Error(`Bank account ${id} has no stored IBAN`),
        });
      }
      decoded.push({
        id,
        workspaceId: decodeWorkspaceId(row["workspace_id"]),
        revision: Number(row["revision"]),
        name: decodeNullableString(row["label"] ?? null),
        iban: decodeString(row["iban"]),
        bic: decodeNullableString(row["bic"] ?? null),
        currency: CurrencyCode.make(decodeString(row["currency"])),
        archived: row["archived_at"] !== null && row["archived_at"] !== undefined,
        createdAt: decodeString(row["created_at"]),
      });
    }
    return decoded;
  }),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    label: row.name,
    iban: row.iban,
    bic: row.bic,
    currency: row.currency,
    archived_at: row.archived ? DateTime.formatIso(DateTime.nowUnsafe()) : null,
    created_at: row.createdAt,
  }),
};

const MEMBERSHIP_SELECT = Arr.join(
  [
    "workspace_id",
    "user_id",
    "role",
    col.instant("joined_at"),
    col.instant("removed_at"),
    "revision",
  ],
  ", ",
);

const decodeMembership = (row: DbRow): MembershipRow => {
  const workspaceId = decodeWorkspaceId(row["workspace_id"]);
  const userId = UserId.make(decodeString(row["user_id"]));
  return {
    id: `${workspaceId}:${userId}`,
    workspaceId,
    revision: Number(row["revision"]),
    userId,
    role: decodeRole(row["role"]),
    joinedAt: decodeString(row["joined_at"]),
    removedAt: decodeNullableString(row["removed_at"] ?? null),
  };
};

const decodeSlugAlias = (row: DbRow): SlugAliasRow => {
  const slug = decodeString(row["slug"]);
  return {
    id: slug,
    workspaceId: decodeWorkspaceId(row["workspace_id"]),
    revision: 1,
    slug,
    expiresAt: decodeString(row["expires_at"]),
  };
};

export const WorkspacesRepoSql: Layer.Layer<WorkspacesRepo, never, SqlClient.SqlClient> =
  Layer.effect(
    WorkspacesRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspaces = makeTable(sql, workspaceSpec);
      const invitations = makeTable(sql, invitationSpec);
      const bankAccounts = makeTable(sql, bankAccountSpec);

      const aliasWriteErrors = writeErrors("workspace_slug_aliases", (c) =>
        c === "workspace_slug_aliases_pkey" ? SLUG_ALIAS_UNIQUE : c,
      );
      const memberWriteErrors = writeErrors("memberships", (c) =>
        c === "memberships_pkey" ? MEMBERSHIP_USER_UNIQUE : c,
      );

      const remapPrimary = (target: string) =>
        Effect.mapError((err: StoreUnavailable | UniqueViolation) =>
          err._tag === "UniqueViolation" && err.constraint === "primary"
            ? UniqueViolation.make({ collection: err.collection, constraint: target })
            : err,
        );

      const missedMemberCas = (workspaceId: WorkspaceId, userId: UserId, id: string) =>
        Effect.flatMap(
          unavailable(
            sql<{ revision: number }>`
              select revision from memberships
              where workspace_id = ${workspaceId} and user_id = ${userId}
            `,
          ),
          (rows): Effect.Effect<never, NotFound | Conflict> =>
            rows[0] !== undefined
              ? Effect.fail(
                  Conflict.make({
                    reason: "revision_changed",
                    currentRevision: Number(rows[0].revision),
                  }),
                )
              : Effect.fail(NotFound.make({ entity: "Member", id })),
        );

      return WorkspacesRepo.of({
        getWorkspace: Effect.fn("WorkspacesRepo.getWorkspace")((id) => workspaces.get(id, id)),
        getWorkspaceForUpdate: Effect.fn("WorkspacesRepo.getWorkspaceForUpdate")(
          (id, expectedRevision) => workspaces.getForUpdate(id, id, expectedRevision),
        ),
        lockWorkspace: Effect.fn("WorkspacesRepo.lockWorkspace")((id) => workspaces.lock(id, id)),
        insertWorkspace: workspaces.insert,
        updateWorkspace: workspaces.update,
        findWorkspaceBySlug: Effect.fn("WorkspacesRepo.findBySlug")((slug) =>
          workspaces.firstGlobal(sql`slug = ${slug}`),
        ),

        findSlugAlias: Effect.fn("WorkspacesRepo.findSlugAlias")((slug) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select slug, workspace_id, ${sql.unsafe(col.instant("expires_at"))}
                from workspace_slug_aliases
                where slug = ${slug}
              `,
            ),
            (rows) =>
              rows[0] === undefined ? Option.none() : Option.some(decodeSlugAlias(rows[0])),
          ),
        ),
        removeSlugAlias: Effect.fn("WorkspacesRepo.removeSlugAlias")(function* (row) {
          const deleted = yield* unavailable(
            sql<{ slug: string }>`
                delete from workspace_slug_aliases
                where workspace_id = ${row.workspaceId} and slug = ${row.slug}
                returning slug
              `,
          );
          if (deleted.length === 0) {
            return yield* NotFound.make({ entity: "Workspace", id: row.id });
          }
        }),
        insertSlugAlias: Effect.fn("WorkspacesRepo.insertSlugAlias")((row) =>
          sql
            .withTransaction(
              sql`insert into workspace_slug_aliases ${sql.insert({
                slug: row.slug,
                workspace_id: row.workspaceId,
                expires_at: row.expiresAt,
              })}`,
            )
            .pipe(
              aliasWriteErrors,
              remapPrimary(SLUG_ALIAS_UNIQUE),
              Effect.as({ ...row, revision: 1 }),
            ),
        ),

        findMembership: Effect.fn("WorkspacesRepo.findMembership")((workspaceId, userId) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(MEMBERSHIP_SELECT)} from memberships
                where workspace_id = ${workspaceId} and user_id = ${userId} and removed_at is null
              `,
            ),
            (rows) =>
              rows[0] === undefined ? Option.none() : Option.some(decodeMembership(rows[0])),
          ),
        ),
        findMembershipRecord: Effect.fn("WorkspacesRepo.findMembershipRecord")(
          (workspaceId, userId) =>
            Effect.map(
              unavailable(
                sql<DbRow>`
                select ${sql.unsafe(MEMBERSHIP_SELECT)} from memberships
                where workspace_id = ${workspaceId} and user_id = ${userId}
              `,
              ),
              (rows) =>
                rows[0] === undefined ? Option.none() : Option.some(decodeMembership(rows[0])),
            ),
        ),
        listMembers: Effect.fn("WorkspacesRepo.listMembers")((workspaceId) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(MEMBERSHIP_SELECT)} from memberships
                where workspace_id = ${workspaceId} and removed_at is null
                order by joined_at asc, user_id asc
              `,
            ),
            (rows) => Arr.map(rows, decodeMembership),
          ),
        ),
        listMembershipsOfUser: Effect.fn("WorkspacesRepo.listMembershipsOfUser")((userId) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(MEMBERSHIP_SELECT)} from memberships
                where user_id = ${userId} and removed_at is null
                order by joined_at asc, workspace_id asc
              `,
            ),
            (rows) => Arr.map(rows, decodeMembership),
          ),
        ),
        insertMembership: Effect.fn("WorkspacesRepo.insertMembership")((row) =>
          sql
            .withTransaction(
              sql`insert into memberships ${sql.insert({
                workspace_id: row.workspaceId,
                user_id: row.userId,
                role: row.role,
                joined_at: row.joinedAt,
                removed_at: row.removedAt,
                revision: 1,
              })}`,
            )
            .pipe(
              memberWriteErrors,
              remapPrimary(MEMBERSHIP_USER_UNIQUE),
              Effect.as({ ...row, revision: 1 }),
            ),
        ),
        updateMembership: Effect.fn("WorkspacesRepo.updateMembership")(
          function* (next, expectedRevision) {
            const rows = yield* sql
              .withTransaction(
                sql<{ user_id: string }>`
                  update memberships
                  set role = ${next.role}, joined_at = ${next.joinedAt},
                      removed_at = ${next.removedAt}, revision = ${expectedRevision + 1}
                  where workspace_id = ${next.workspaceId} and user_id = ${next.userId}
                    and revision = ${expectedRevision}
                  returning user_id
                `,
              )
              .pipe(memberWriteErrors, remapPrimary(MEMBERSHIP_USER_UNIQUE));
            if (rows.length === 0) {
              return yield* missedMemberCas(next.workspaceId, next.userId, next.id);
            }
            return { ...next, revision: expectedRevision + 1 };
          },
        ),
        removeMembership: Effect.fn("WorkspacesRepo.removeMembership")(function* (row, removedAt) {
          const rows = yield* unavailable(
            sql<{ user_id: string }>`
                update memberships
                set removed_at = ${removedAt}, revision = ${row.revision + 1}
                where workspace_id = ${row.workspaceId} and user_id = ${row.userId}
                  and revision = ${row.revision}
                returning user_id
              `,
          );
          if (rows.length === 0) {
            return yield* missedMemberCas(row.workspaceId, row.userId, row.id);
          }
        }),

        getInvitation: Effect.fn("WorkspacesRepo.getInvitation")((workspaceId, id) =>
          invitations.get(workspaceId, id),
        ),
        lockInvitation: Effect.fn("WorkspacesRepo.lockInvitation")((workspaceId, id) =>
          invitations.lock(workspaceId, id),
        ),
        findInvitationByTokenHash: Effect.fn("WorkspacesRepo.findInvitationByTokenHash")(
          (tokenHash) => invitations.firstGlobal(sql`token_hash = ${tokenHash}`),
        ),
        findPendingInvitation: Effect.fn("WorkspacesRepo.findPendingInvitation")(
          (workspaceId, emailLower) =>
            invitations.first(
              workspaceId,
              sql`status = 'pending' and lower(email) = ${Str.toLowerCase(emailLower)}`,
            ),
        ),
        listInvitations: Effect.fn("WorkspacesRepo.listInvitations")((workspaceId) =>
          invitations.select(workspaceId, undefined, sql`order by created_at asc, id asc`),
        ),
        insertInvitation: invitations.insert,
        updateInvitation: invitations.update,

        listBankAccounts: Effect.fn("WorkspacesRepo.listBankAccounts")((workspaceId) =>
          // Core omits archived accounts. Skip legacy rows it cannot decode.
          bankAccounts.select(
            workspaceId,
            sql`archived_at is null or iban is not null`,
            sql`order by created_at asc, id asc`,
          ),
        ),
        getBankAccount: Effect.fn("WorkspacesRepo.getBankAccount")((workspaceId, id) =>
          bankAccounts.get(workspaceId, id),
        ),
        lockBankAccount: Effect.fn("WorkspacesRepo.lockBankAccount")((workspaceId, id) =>
          bankAccounts.lock(workspaceId, id),
        ),
        insertBankAccount: bankAccounts.insert,
        updateBankAccount: bankAccounts.update,
      });
    }),
  );
