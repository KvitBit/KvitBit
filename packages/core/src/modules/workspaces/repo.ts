/**
 * `WorkspacesRepo`: the Workspaces module's repository port (src/store/tables.ts conventions)
 * and its in-memory implementation on `MemoryTables`. Tables: workspaces, workspace_slug_aliases,
 * memberships, invitations, bank_accounts. Numbering Series live in the numbering module.
 */

import type {
  BankAccountId,
  Conflict,
  InvitationId,
  NotFound,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import { BankAccountRow, InvitationRow, MembershipRow, SlugAliasRow, WorkspaceRow } from "./model";

type Fail = StoreUnavailable;

/** Unique index names (also the SQL index names). */
export const WORKSPACE_SLUG_UNIQUE = "workspaces_slug_unique";
export const SLUG_ALIAS_UNIQUE = "workspace_slug_aliases_slug_unique";
export const MEMBERSHIP_USER_UNIQUE = "memberships_workspace_user_unique";
export const INVITATION_TOKEN_UNIQUE = "invitations_token_hash_unique";
export const INVITATION_PENDING_EMAIL_UNIQUE = "invitations_pending_email_unique";

export class WorkspacesRepo extends Context.Service<
  WorkspacesRepo,
  {
    // workspaces: a Workspace row's workspaceId is its own id.
    readonly getWorkspace: (id: WorkspaceId) => Effect.Effect<WorkspaceRow, NotFound | Fail>;
    readonly getWorkspaceForUpdate: (
      id: WorkspaceId,
      expectedRevision: number,
    ) => Effect.Effect<WorkspaceRow, NotFound | Conflict | Fail>;
    readonly lockWorkspace: (id: WorkspaceId) => Effect.Effect<WorkspaceRow, NotFound | Fail>;
    readonly insertWorkspace: (
      row: WorkspaceRow,
    ) => Effect.Effect<WorkspaceRow, UniqueViolation | Fail>;
    readonly updateWorkspace: (
      next: WorkspaceRow,
      expectedRevision: number,
    ) => Effect.Effect<WorkspaceRow, NotFound | Conflict | UniqueViolation | Fail>;
    readonly findWorkspaceBySlug: (
      slug: string,
    ) => Effect.Effect<Option.Option<WorkspaceRow>, Fail>;

    // slug aliases (W6)
    readonly findSlugAlias: (slug: string) => Effect.Effect<Option.Option<SlugAliasRow>, Fail>;
    readonly removeSlugAlias: (
      row: SlugAliasRow,
    ) => Effect.Effect<void, NotFound | Conflict | Fail>;
    readonly insertSlugAlias: (
      row: SlugAliasRow,
    ) => Effect.Effect<SlugAliasRow, UniqueViolation | Fail>;

    // memberships
    /** The live membership (removed rows are invisible). */
    readonly findMembership: (
      workspaceId: WorkspaceId,
      userId: UserId,
    ) => Effect.Effect<Option.Option<MembershipRow>, Fail>;
    /** The membership row including a removed one (`removedAt` set), for C6 and rejoining. */
    readonly findMembershipRecord: (
      workspaceId: WorkspaceId,
      userId: UserId,
    ) => Effect.Effect<Option.Option<MembershipRow>, Fail>;
    readonly listMembers: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<MembershipRow>, Fail>;
    /** Cross-tenant: the Workspaces an Account caller belongs to. */
    readonly listMembershipsOfUser: (
      userId: UserId,
    ) => Effect.Effect<ReadonlyArray<MembershipRow>, Fail>;
    readonly insertMembership: (
      row: MembershipRow,
    ) => Effect.Effect<MembershipRow, UniqueViolation | Fail>;
    readonly updateMembership: (
      next: MembershipRow,
      expectedRevision: number,
    ) => Effect.Effect<MembershipRow, NotFound | Conflict | UniqueViolation | Fail>;
    /** Soft-deletes `row` (sets `removedAt`, bumps the revision). */
    readonly removeMembership: (
      row: MembershipRow,
      removedAt: string,
    ) => Effect.Effect<void, NotFound | Conflict | Fail>;

    // invitations
    readonly getInvitation: (
      workspaceId: WorkspaceId,
      id: InvitationId,
    ) => Effect.Effect<InvitationRow, NotFound | Fail>;
    readonly lockInvitation: (
      workspaceId: WorkspaceId,
      id: InvitationId,
    ) => Effect.Effect<InvitationRow, NotFound | Fail>;
    /** Cross-tenant token lookup (invitation page, accept). */
    readonly findInvitationByTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<InvitationRow>, Fail>;
    readonly findPendingInvitation: (
      workspaceId: WorkspaceId,
      emailLower: string,
    ) => Effect.Effect<Option.Option<InvitationRow>, Fail>;
    readonly listInvitations: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<InvitationRow>, Fail>;
    readonly insertInvitation: (
      row: InvitationRow,
    ) => Effect.Effect<InvitationRow, UniqueViolation | Fail>;
    readonly updateInvitation: (
      next: InvitationRow,
      expectedRevision: number,
    ) => Effect.Effect<InvitationRow, NotFound | Conflict | UniqueViolation | Fail>;

    // bank accounts
    readonly listBankAccounts: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<BankAccountRow>, Fail>;
    readonly getBankAccount: (
      workspaceId: WorkspaceId,
      id: BankAccountId,
    ) => Effect.Effect<BankAccountRow, NotFound | Fail>;
    readonly lockBankAccount: (
      workspaceId: WorkspaceId,
      id: BankAccountId,
    ) => Effect.Effect<BankAccountRow, NotFound | Fail>;
    readonly insertBankAccount: (
      row: BankAccountRow,
    ) => Effect.Effect<BankAccountRow, UniqueViolation | Fail>;
    readonly updateBankAccount: (
      next: BankAccountRow,
      expectedRevision: number,
    ) => Effect.Effect<BankAccountRow, NotFound | Conflict | UniqueViolation | Fail>;
  }
>()("@kvitbit/core/modules/workspaces/repo/WorkspacesRepo") {}

const live = (row: MembershipRow) => row.removedAt === null;

export const Workspaces = defineCollection<WorkspaceRow>({
  name: "workspaces",
  entity: "Workspace",
  schema: WorkspaceRow,
  unique: [{ name: WORKSPACE_SLUG_UNIQUE, scope: "global", key: (w) => [w.slug] }],
});

export const SlugAliases = defineCollection<SlugAliasRow>({
  name: "workspace_slug_aliases",
  entity: "Workspace",
  schema: SlugAliasRow,
  unique: [{ name: SLUG_ALIAS_UNIQUE, scope: "global", key: (a) => [a.slug] }],
});

export const Memberships = defineCollection<MembershipRow>({
  name: "memberships",
  entity: "Member",
  schema: MembershipRow,
  unique: [{ name: MEMBERSHIP_USER_UNIQUE, scope: "workspace", key: (m) => [m.userId] }],
});

export const Invitations = defineCollection<InvitationRow>({
  name: "invitations",
  entity: "Invitation",
  schema: InvitationRow,
  unique: [
    { name: INVITATION_TOKEN_UNIQUE, scope: "global", key: (i) => [i.tokenHash] },
    {
      name: INVITATION_PENDING_EMAIL_UNIQUE,
      scope: "workspace",
      key: (i) => (i.status === "pending" ? [i.emailLower] : null),
    },
  ],
});

export const BankAccounts = defineCollection<BankAccountRow>({
  name: "bank_accounts",
  entity: "BankAccount",
  schema: BankAccountRow,
});

/** `WorkspacesRepo` on `MemoryTables` (shares the in-memory store's transactions). */
export const WorkspacesRepoMemory: Layer.Layer<WorkspacesRepo, never, MemoryTables> = Layer.effect(
  WorkspacesRepo,
  Effect.gen(function* () {
    const tables = yield* MemoryTables;
    const workspaces = tables.collection(Workspaces);
    const aliases = tables.collection(SlugAliases);
    const memberships = tables.collection(Memberships);
    const invitations = tables.collection(Invitations);
    const accounts = tables.collection(BankAccounts);
    return {
      getWorkspace: Effect.fn("WorkspacesRepo.getWorkspace")((id) => workspaces.get(id, id)),
      getWorkspaceForUpdate: Effect.fn("WorkspacesRepo.getWorkspaceForUpdate")(
        (id, expectedRevision) => workspaces.getForUpdate(id, id, expectedRevision),
      ),
      lockWorkspace: Effect.fn("WorkspacesRepo.lockWorkspace")((id) => workspaces.lock(id, id)),
      insertWorkspace: workspaces.insert,
      updateWorkspace: workspaces.update,
      findWorkspaceBySlug: Effect.fn("workspaces.findSlug")((slug) =>
        workspaces.findUnique(WORKSPACE_SLUG_UNIQUE, [slug]),
      ),

      findSlugAlias: Effect.fn("WorkspacesRepo.findSlugAlias")((slug) =>
        aliases.findUnique(SLUG_ALIAS_UNIQUE, [slug]),
      ),
      removeSlugAlias: Effect.fn("WorkspacesRepo.removeSlugAlias")((row) =>
        aliases.remove(row.workspaceId, row.id, row.revision),
      ),
      insertSlugAlias: aliases.insert,

      findMembership: Effect.fn("WorkspacesRepo.findMembership")((workspaceId, userId) =>
        Effect.map(
          memberships.findUnique(MEMBERSHIP_USER_UNIQUE, [userId], workspaceId),
          Option.filter(live),
        ),
      ),
      findMembershipRecord: Effect.fn("WorkspacesRepo.findMembershipRecord")(
        (workspaceId, userId) =>
          memberships.findUnique(MEMBERSHIP_USER_UNIQUE, [userId], workspaceId),
      ),
      listMembers: Effect.fn("WorkspacesRepo.listMembers")((workspaceId) =>
        Effect.map(memberships.list(workspaceId, { orderBy: ["joinedAt"] }), (rows) =>
          EffectArray.filter(rows, live),
        ),
      ),
      listMembershipsOfUser: Effect.fn("WorkspacesRepo.listMembershipsOfUser")((userId) =>
        Effect.map(memberships.listGlobal({ where: { userId } }), (rows) =>
          EffectArray.filter(rows, live),
        ),
      ),
      insertMembership: memberships.insert,
      updateMembership: memberships.update,
      removeMembership: Effect.fn("WorkspacesRepo.removeMembership")((row, removedAt) =>
        memberships.update({ ...row, removedAt }, row.revision).pipe(
          Effect.asVoid,
          // The per-Workspace user key is unchanged, so the unique index cannot fire.
          Effect.catchTag("UniqueViolation", (e) => Effect.die(e)),
        ),
      ),

      getInvitation: invitations.get,
      lockInvitation: invitations.lock,
      findInvitationByTokenHash: Effect.fn("WorkspacesRepo.findInvitationByTokenHash")(
        (tokenHash) => invitations.findUnique(INVITATION_TOKEN_UNIQUE, [tokenHash]),
      ),
      findPendingInvitation: Effect.fn("WorkspacesRepo.findPendingInvitation")(
        (workspaceId, emailLower) =>
          invitations.findUnique(INVITATION_PENDING_EMAIL_UNIQUE, [emailLower], workspaceId),
      ),
      listInvitations: Effect.fn("WorkspacesRepo.listInvitations")((workspaceId) =>
        invitations.list(workspaceId, { orderBy: ["createdAt"] }),
      ),
      insertInvitation: invitations.insert,
      updateInvitation: invitations.update,

      listBankAccounts: Effect.fn("WorkspacesRepo.listBankAccounts")((workspaceId) =>
        accounts.list(workspaceId, { orderBy: ["createdAt"] }),
      ),
      getBankAccount: accounts.get,
      lockBankAccount: accounts.lock,
      insertBankAccount: accounts.insert,
      updateBankAccount: accounts.update,
    };
  }),
);
