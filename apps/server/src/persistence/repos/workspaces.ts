/**
 * `WorkspacesRepo` over `workspaces`, `issuing_entities`, `tax_regime_periods`,
 * `workspace_slug_aliases`, `memberships`, `invitations` and `bank_accounts`.
 */
import { WorkspacesRepo } from "@kvitbit/core";
import type {
  BankAccountId,
  CurrencyCode,
  Hex,
  ImageRef,
  InvitationId,
  IsoDate,
  Locale,
  PaymentMethod,
  PdfTemplate,
  Role,
  TaxRegime,
  ThemeSource,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import { Conflict, NotFound } from "@kvitbit/domain/contract";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { asNumberArray, parseJson, toJsonb } from "../codec";
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

const SLUG_ALIAS_UNIQUE = "workspace_slug_aliases_slug_unique";
const MEMBERSHIP_USER_UNIQUE = "memberships_workspace_user_unique";
const DEFAULT_ACCENT_COLOR = "#1F5FAF" as Hex;

const workspaceSpec: TableSpec<WorkspaceRow> = {
  table: "workspaces",
  collection: "workspaces",
  entity: "Workspace",
  scope: "id",
  select: [
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
  ].join(", "),
  decode: (rows) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = rows.map((r) => r.id as string);
      const [entities, regimes, defaults] = yield* Effect.all([
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
        sql<{ workspace_id: string; currency: string; id: BankAccountId }>`
          select workspace_id, currency, id
          from bank_accounts
          where workspace_id in ${sql.in(ids)} and is_default = true and archived_at is null
        `,
      ]);

      const entityByWs = new Map<string, DbRow>(
        entities.map((e) => [e.workspace_id as string, e] as const),
      );
      const regimesByWs = new Map<string, Array<{ regime: TaxRegime; effectiveFrom: IsoDate }>>();
      for (const r of regimes) {
        const ws = r.workspace_id as string;
        const list = regimesByWs.get(ws) ?? [];
        list.push({ regime: r.regime as TaxRegime, effectiveFrom: r.effective_from as IsoDate });
        regimesByWs.set(ws, list);
      }
      const bankByWs = new Map<string, Record<string, BankAccountId>>();
      for (const b of defaults) {
        const map = bankByWs.get(b.workspace_id) ?? {};
        map[b.currency] = b.id;
        bankByWs.set(b.workspace_id, map);
      }

      return rows.map((row): WorkspaceRow => {
        const id = row.id as WorkspaceId;
        const ie = entityByWs.get(id);
        const closedAt = (row.closed_at as string | null) ?? null;
        return {
          id,
          workspaceId: id,
          revision: Number(row.revision),
          slug: row.slug as WorkspaceSlug,
          name: row.name as string,
          closed: closedAt !== null,
          closedAt,
          createdAt: row.created_at as string,
          issuingEntity: {
            name: (ie?.legal_name as string | undefined) ?? (row.name as string),
            ico: (ie?.ico as string | null | undefined) ?? null,
            dic: (ie?.dic as string | null | undefined) ?? null,
            address: {
              street: (ie?.street as string | null | undefined) ?? "",
              city: (ie?.city as string | null | undefined) ?? "",
              postalCode: (ie?.postal_code as string | null | undefined) ?? "",
              country: (ie?.country as string | undefined) ?? "CZ",
            },
            legalForm: (ie?.legal_form as string | null | undefined) ?? null,
            registerEntry: (ie?.commercial_register as string | null | undefined) ?? null,
            email: (ie?.email as string | null | undefined) ?? null,
            phone: (ie?.phone as string | null | undefined) ?? null,
            web: (ie?.web as string | null | undefined) ?? null,
          },
          taxRegimes: regimesByWs.get(id) ?? [],
          defaults: {
            currency: row.default_currency as CurrencyCode,
            language: row.default_language as Locale,
            dueDays: Number(row.default_due_days),
            paymentMethod: row.default_payment_method as PaymentMethod,
            defaultNote: (row.default_note as string | null) ?? null,
            paymentRounding: row.payment_rounding as "none" | "whole_unit",
            paymentTaxDocumentAutoSend: Boolean(row.auto_send_payment_tax_document),
          },
          bankAccountByCurrency: bankByWs.get(id) ?? {},
          reminders: {
            enabled: Boolean(row.reminders_enabled),
            proformas: Boolean(row.reminders_for_proformas),
            offsetsDays: asNumberArray(row.reminder_offsets_days),
          },
          branding: {
            pdfTemplate: row.pdf_template as PdfTemplate,
            accentColor: (row.accent_color as Hex | null) ?? DEFAULT_ACCENT_COLOR,
            footerText: (row.footer_text as string | null) ?? null,
            theme: row.theme_source === null ? null : parseJson<ThemeSource>(row.theme_source),
            logo: row.logo === null ? null : parseJson<ImageRef>(row.logo),
            stamp: row.stamp === null ? null : parseJson<ImageRef>(row.stamp),
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
    closed_at: row.closed ? (row.closedAt ?? new Date().toISOString()) : null,
    created_at: row.createdAt,
  }),
  writeChildren: (row, mode) =>
    Effect.gen(function* () {
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
      if (row.taxRegimes.length > 0) {
        const regimeRows = row.taxRegimes.map((p) => ({
          workspace_id: row.id,
          effective_from: p.effectiveFrom,
          regime: p.regime,
        })) as unknown as [Record<string, unknown>, ...Record<string, unknown>[]];
        yield* sql`insert into tax_regime_periods ${sql.insert(regimeRows)}`;
      }
      if (mode === "update") {
        const defaultIds = Object.values(row.bankAccountByCurrency);
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
  select: [
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
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): InvitationRow => ({
      id: row.id as InvitationId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      email: row.email as string,
      emailLower: (row.email as string).toLowerCase(),
      role: row.role as InvitationRow["role"],
      status: row.status as InvitationRow["status"],
      tokenHash: row.token_hash as string,
      sendEpoch: Number(row.send_epoch),
      lastSentAt: row.last_sent_at as string,
      workflowStartedAt: (row.workflow_started_at as string | null) ?? null,
      invitedBy: row.invited_by as UserId,
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
      acceptedBy: (row.accepted_by as UserId | null) ?? null,
    }),
  ),
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
  select: [
    "id",
    "workspace_id",
    "revision",
    "label",
    "iban",
    "bic",
    "currency",
    col.instant("archived_at"),
    col.instant("created_at"),
  ].join(", "),
  decode: decodeEach(
    (row: DbRow): BankAccountRow => ({
      id: row.id as BankAccountId,
      workspaceId: row.workspace_id as WorkspaceId,
      revision: Number(row.revision),
      name: (row.label as string | null) ?? null,
      iban: row.iban as string,
      bic: (row.bic as string | null) ?? null,
      currency: row.currency as CurrencyCode,
      archived: row.archived_at !== null && row.archived_at !== undefined,
      createdAt: row.created_at as string,
    }),
  ),
  encode: (row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    label: row.name,
    iban: row.iban,
    bic: row.bic,
    currency: row.currency,
    archived_at: row.archived ? new Date().toISOString() : null,
    created_at: row.createdAt,
  }),
};

const MEMBERSHIP_SELECT = [
  "workspace_id",
  "user_id",
  "role",
  col.instant("joined_at"),
  col.instant("removed_at"),
  "revision",
].join(", ");

const decodeMembership = (row: DbRow): MembershipRow => ({
  id: `${row.workspace_id as string}:${row.user_id as string}`,
  workspaceId: row.workspace_id as WorkspaceId,
  revision: Number(row.revision),
  userId: row.user_id as UserId,
  role: row.role as Role,
  joinedAt: row.joined_at as string,
  removedAt: (row.removed_at as string | null) ?? null,
});

const decodeSlugAlias = (row: DbRow): SlugAliasRow => ({
  id: row.slug as string,
  workspaceId: row.workspace_id as WorkspaceId,
  revision: 1,
  slug: row.slug as string,
  expiresAt: row.expires_at as string,
});

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

      const remapPrimary = <A, E>(self: Effect.Effect<A, E>, target: string): Effect.Effect<A, E> =>
        Effect.mapError(self, (err) => {
          if (
            typeof err === "object" &&
            err !== null &&
            "_tag" in err &&
            err._tag === "UniqueViolation" &&
            "constraint" in err &&
            err.constraint === "primary"
          ) {
            return { ...err, constraint: target } as E;
          }
          return err;
        });

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
                  new Conflict({
                    reason: "revision_changed",
                    currentRevision: Number(rows[0].revision),
                  }),
                )
              : Effect.fail(new NotFound({ entity: "Member", id })),
        );

      return WorkspacesRepo.of({
        getWorkspace: (id) => workspaces.get(id, id),
        getWorkspaceForUpdate: (id, expectedRevision) =>
          workspaces.getForUpdate(id, id, expectedRevision),
        lockWorkspace: (id) => workspaces.lock(id, id),
        insertWorkspace: workspaces.insert,
        updateWorkspace: workspaces.update,
        findWorkspaceBySlug: (slug) => workspaces.firstGlobal(sql`slug = ${slug}`),

        findSlugAlias: (slug) =>
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
        removeSlugAlias: (row) =>
          Effect.gen(function* () {
            const deleted = yield* unavailable(
              sql<{ slug: string }>`
                delete from workspace_slug_aliases
                where workspace_id = ${row.workspaceId} and slug = ${row.slug}
                returning slug
              `,
            );
            if (deleted.length === 0) {
              return yield* Effect.fail(new NotFound({ entity: "Workspace", id: row.id }));
            }
          }),
        insertSlugAlias: (row) =>
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
              (eff) => remapPrimary(eff, SLUG_ALIAS_UNIQUE),
              Effect.as({ ...row, revision: 1 }),
            ),

        findMembership: (workspaceId, userId) =>
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
        findMembershipRecord: (workspaceId, userId) =>
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
        listMembers: (workspaceId) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(MEMBERSHIP_SELECT)} from memberships
                where workspace_id = ${workspaceId} and removed_at is null
                order by joined_at asc, user_id asc
              `,
            ),
            (rows) => rows.map(decodeMembership),
          ),
        listMembershipsOfUser: (userId) =>
          Effect.map(
            unavailable(
              sql<DbRow>`
                select ${sql.unsafe(MEMBERSHIP_SELECT)} from memberships
                where user_id = ${userId} and removed_at is null
                order by joined_at asc, workspace_id asc
              `,
            ),
            (rows) => rows.map(decodeMembership),
          ),
        insertMembership: (row) =>
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
              (eff) => remapPrimary(eff, MEMBERSHIP_USER_UNIQUE),
              Effect.as({ ...row, revision: 1 }),
            ),
        updateMembership: (next, expectedRevision) =>
          Effect.gen(function* () {
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
              .pipe(memberWriteErrors, (eff) => remapPrimary(eff, MEMBERSHIP_USER_UNIQUE));
            if (rows.length === 0) {
              return yield* missedMemberCas(next.workspaceId, next.userId, next.id);
            }
            return { ...next, revision: expectedRevision + 1 };
          }),
        removeMembership: (row, removedAt) =>
          Effect.gen(function* () {
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

        getInvitation: (workspaceId, id) => invitations.get(workspaceId, id),
        lockInvitation: (workspaceId, id) => invitations.lock(workspaceId, id),
        findInvitationByTokenHash: (tokenHash) =>
          invitations.firstGlobal(sql`token_hash = ${tokenHash}`),
        findPendingInvitation: (workspaceId, emailLower) =>
          invitations.first(
            workspaceId,
            sql`status = 'pending' and lower(email) = ${emailLower.toLowerCase()}`,
          ),
        listInvitations: (workspaceId) =>
          invitations.select(workspaceId, undefined, sql`order by created_at asc, id asc`),
        insertInvitation: invitations.insert,
        updateInvitation: invitations.update,

        listBankAccounts: (workspaceId) =>
          bankAccounts.select(workspaceId, undefined, sql`order by created_at asc, id asc`),
        getBankAccount: (workspaceId, id) => bankAccounts.get(workspaceId, id),
        lockBankAccount: (workspaceId, id) => bankAccounts.lock(workspaceId, id),
        insertBankAccount: bankAccounts.insert,
        updateBankAccount: bankAccounts.update,
      });
    }),
  );
