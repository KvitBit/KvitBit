/**
 * `WorkspacesLive`: the domain `Workspaces` service (core-ports 4.1) over `WorkspacesRepo`,
 * `WorkspaceSeries`, `UserDirectory`, `RegistryLookup`, `BlobStorage` and the narrow ports in
 * ./ports.ts.
 *
 * Error channels: the domain tag omits `Unavailable` on most methods (and `Conflict` on
 * `create`, which `withIdempotency` raises on a key reused with another payload). Every method
 * here is typed honestly as `WorkspacesImpl` (domain errors plus those) and the layer exposes it
 * through the single cast in `WorkspacesLive`; the gaps are reported for a domain fix.
 */
import type {
  AccessEvent,
  Action,
  AuditEntry,
  BankAccountId,
  BankAccountView,
  BrandingImage,
  BrandingPatch,
  Caller,
  DocumentKind,
  FileDownload,
  ImageRef,
  InvitationId,
  InvitationPeek,
  InvitationView,
  Issue,
  IssuingEntityPatch,
  MemberCaller,
  MemberView,
  NumberingSeriesId,
  RegistryResult,
  Role,
  NumberingSeriesView as SeriesView,
  TaxRegime,
  UserId,
  WorkspaceId,
  WorkspaceSettingsPatch,
  WorkspaceSlug,
  WorkspaceSummary,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import {
  Channel,
  ClientRef,
  Conflict,
  CurrentCaller,
  DocumentKind as DocumentKindSchema,
  Forbidden,
  Hex,
  InvitationView as InvitationViewSchema,
  Locale,
  NotFound,
  NumberingSeriesId as NumberingSeriesIdSchema,
  NumberingSeriesView,
  Role as RoleSchema,
  Scope,
  ThemeSource,
  type Unavailable,
  UserId as UserIdSchema,
  WorkspaceId as WorkspaceIdSchema,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { BlobKey } from "@kvitbit/domain/ports";
import { BlobStorage } from "@kvitbit/domain/ports";
import { Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { can } from "../../policy/can";
import { checkMembershipChange } from "../../policy/membership";
import { authorize, authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { withIdempotency } from "../../shared/idempotency";
import { type IdGenerator, newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import {
  BankAccountFields,
  type BankAccountRow,
  BankAccountViewFields,
  type Branding,
  DEFAULT_BRANDING,
  DEFAULT_REMINDERS,
  type InvitationRow,
  type IssuingEntity,
  IssuingEntityPatchFields,
  NewWorkspaceFields,
  type SeriesByKind,
  type SettingsPatchFields as SettingsPatch,
  SettingsPatchFields,
  type WorkspaceRow,
  type WorkspaceViewFields,
} from "./model";
import {
  BankAccountReferences,
  BrandingPreview,
  InvitationDelivery,
  InvitationTokens,
  UserDirectory,
  WorkspaceSeries,
} from "./ports";
import { isValidIco, RegistryLookup } from "./registry";
import { WORKSPACE_SLUG_UNIQUE, WorkspacesRepo } from "./repo";
import {
  BRANDING_IMAGE_MAX_BYTES,
  BRANDING_IMAGE_TYPES,
  decodeInput,
  FOOTER_MAX_LENGTH,
  failIssues,
  IMAGE_SIGNATURE_BYTES,
  INVITATION_LIST_EXPIRED_MILLIS,
  INVITATION_TTL_MILLIS,
  invalid,
  issue,
  isValidBic,
  isValidEmail,
  isValidIban,
  isValidSlug,
  MAX_DUE_DAYS,
  MAX_REMINDER_OFFSETS,
  matchesImageSignature,
  normalizeIban,
  nowIso,
  RESEND_COOLDOWN_MILLIS,
  regimeOn,
  SLUG_ALIAS_TTL_MILLIS,
  slugify,
  storeOnly,
  today,
  withSuffix,
} from "./rules";

// Honest error channels -----------------------------------------------------------------------

type Widen<F, X> = F extends (...args: infer A) => Effect.Effect<infer S, infer E, infer R>
  ? (...args: A) => Effect.Effect<S, E | X, R>
  : F extends Effect.Effect<infer S, infer E, infer R>
    ? Effect.Effect<S, E | X, R>
    : never;
type Service = Workspaces["Service"];

/** The domain interface with the errors the methods really raise. */
export type WorkspacesImpl = {
  readonly [K in Exclude<keyof Service, "create">]: Widen<Service[K], Unavailable>;
} & { readonly create: Widen<Service["create"], Unavailable | Conflict> };

/** Codec of the `MemberCaller` that `create` stores for request-key replay. */
export const MemberCallerSchema = Schema.Struct({
  _tag: Schema.Literal("Member"),
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  role: RoleSchema,
  scopes: Schema.Union([Schema.Literal("all"), Schema.Array(Scope)]),
  locale: Locale,
  channel: Channel,
  client: Schema.NullOr(ClientRef),
});

const SeriesInputSchema = Schema.Struct({
  id: Schema.optional(NumberingSeriesIdSchema),
  kind: DocumentKindSchema,
  name: Schema.String,
  pattern: Schema.String,
  nextNumber: Schema.optional(Schema.Number),
  isDefault: Schema.optional(Schema.Boolean),
});

const InvitePayload = Schema.Struct({ email: Schema.String, role: RoleSchema });

const codec = <A>(schema: unknown) => schema as Schema.Codec<A, unknown>;

// Small helpers -------------------------------------------------------------------------------

type AuditChange = AuditEntry["changes"][number];

/** Changed top-level fields of two records, as audit changes under `prefix`. */
const diff = (prefix: string, before: object, after: object): Array<AuditChange> => {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: Array<AuditChange> = [];
  for (const key of keys) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      out.push({ path: `${prefix}${key}`, before: b[key] ?? null, after: a[key] ?? null });
    }
  }
  return out;
};

/** W5: a closed Workspace rejects every non-read action. */
const requireOpen = (row: WorkspaceRow, action: Forbidden["action"]) =>
  row.closed ? Effect.fail(new Forbidden({ action })) : Effect.void;

const seriesKindsFor = (regime: TaxRegime): ReadonlyArray<DocumentKind> =>
  regime === "vat_payer"
    ? ["invoice", "proforma", "payment_tax_document", "credit_note"]
    : ["invoice", "proforma", "credit_note"];

const brandingKey = (workspaceId: WorkspaceId, image: BrandingImage, sha256: string) =>
  `branding/${workspaceId}/${image}/${sha256}` as BlobKey;

/** Internal: the create probe found no committed key, so the registry must be consulted. */
class RegistryNeeded extends Data.TaggedError("RegistryNeeded") {}

/** W6: generated-slug inserts retried on a concurrent unique violation before giving up. */
const SLUG_INSERT_ATTEMPTS = 20;

const EMPTY_ADDRESS = { street: "", city: "", postalCode: "", country: "CZ" };

const invitationStatus = (row: InvitationRow, now: string): InvitationView["status"] =>
  row.status === "pending" && row.expiresAt <= now ? "expired" : row.status;

const notPending = () =>
  new Conflict({ reason: "illegal_transition", detail: "invitation.not_pending" });

const memberCaller = (input: {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly role: Role;
  readonly scopes: MemberCaller["scopes"];
  readonly locale: MemberCaller["locale"];
  readonly channel: MemberCaller["channel"];
  readonly client: MemberCaller["client"];
}): MemberCaller => ({ _tag: "Member", ...input });

/** Material Theme Builder JSON is at most 64 KB encoded (domain theme.ts). */
const THEME_JSON_MAX_BYTES = 64 * 1024;

/** The issue a theme source raises, or null when it is acceptable (contrast is apps/server's). */
const themeIssueOf = (theme: unknown): Issue["code"] | null => {
  if (theme === undefined || theme === null) return null;
  const tag = typeof theme === "object" && "_tag" in theme ? theme._tag : undefined;
  if (tag === "Seed") {
    const seed = (theme as { readonly seed?: unknown }).seed;
    return typeof seed === "string" && Schema.is(Hex)(seed) ? null : "theme.seed_invalid";
  }
  if (tag === "MaterialThemeBuilder") {
    const json = (theme as { readonly json?: unknown }).json;
    if (typeof json !== "object" || json === null || Array.isArray(json))
      return "theme.json_invalid";
    const size = new TextEncoder().encode(JSON.stringify(json)).byteLength;
    return size > THEME_JSON_MAX_BYTES ? "theme.too_large" : null;
  }
  return Schema.is(ThemeSource)(theme) ? null : "request.malformed";
};

// Branding validation shared by updateSettings and previewBranding.
const brandingIssues = (patch: {
  readonly accentColor?: string | undefined;
  readonly footerText?: string | null | undefined;
  readonly theme?: unknown;
}): Array<Issue> => {
  const issues: Array<Issue> = [];
  const themeIssue = themeIssueOf(patch.theme);
  if (themeIssue !== null) issues.push(issue(["branding", "theme"], themeIssue));
  if (patch.accentColor !== undefined && !Schema.is(Hex)(patch.accentColor)) {
    issues.push(issue(["branding", "accentColor"], "branding.accent_invalid"));
  }
  if (
    patch.footerText !== undefined &&
    patch.footerText !== null &&
    patch.footerText.length > FOOTER_MAX_LENGTH
  ) {
    issues.push(issue(["branding", "footerText"], "request.malformed"));
  }
  return issues;
};

const mergeBranding = (
  current: Branding,
  patch: SettingsPatch["branding"] | BrandingPatch | undefined,
): Branding =>
  patch === undefined
    ? current
    : {
        ...current,
        ...(patch.pdfTemplate === undefined ? {} : { pdfTemplate: patch.pdfTemplate }),
        ...(patch.accentColor === undefined ? {} : { accentColor: patch.accentColor as Hex }),
        ...(patch.footerText === undefined ? {} : { footerText: patch.footerText }),
        ...(patch.theme === undefined ? {} : { theme: patch.theme as Branding["theme"] }),
      };

// The service ---------------------------------------------------------------------------------

export const makeWorkspaces = Effect.gen(function* () {
  const repo = yield* WorkspacesRepo;
  const series = yield* WorkspaceSeries;
  const directory = yield* UserDirectory;
  const registry = yield* RegistryLookup;
  const blobs = yield* BlobStorage;
  const delivery = yield* InvitationDelivery;
  const tokens = yield* InvitationTokens;
  const preview = yield* BrandingPreview;
  const references = yield* BankAccountReferences;
  const store = yield* CoreStore;
  const context = yield* Effect.context<CoreStore | IdGenerator>();

  /** Provides the store and ids captured at layer build; every method needs only CurrentCaller. */
  const run = <A, E>(
    effect: Effect.Effect<A, E, CoreStore | IdGenerator | CurrentCaller>,
  ): Effect.Effect<
    A,
    | Exclude<E, { readonly _tag: "StoreUnavailable" | "BlobUnavailable" | "RegistryUnavailable" }>
    | Unavailable,
    CurrentCaller
  > => orUnavailable(Effect.provideContext(effect, context)) as never;

  const audit = (
    workspaceId: WorkspaceId,
    action: string,
    revision: number | null,
    changes: ReadonlyArray<AuditChange>,
    extra: { readonly actor?: AuditEntry["actor"]; readonly subject?: AuditEntry["subject"] } = {},
  ) =>
    appendAudit({
      workspaceId,
      subject: extra.subject ?? { entity: "Workspace", id: workspaceId },
      action,
      revision,
      changes,
      ...(extra.actor === undefined ? {} : { actor: extra.actor }),
    });

  /** `UniqueViolation` on the slug index is a lost race for the slug (W6). */
  const slugRace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchTag(
      effect as Effect.Effect<A, E | { readonly _tag: "UniqueViolation" }, R>,
      "UniqueViolation",
      () => Effect.fail(invalid(["slug"], "workspace.slug_taken")),
    ) as Effect.Effect<
      A,
      Exclude<E, { readonly _tag: "UniqueViolation" }> | ReturnType<typeof invalid>,
      R
    >;

  /** Whether `slug` is free for `workspaceId` (another Workspace's slug or live alias is taken). */
  const slugFree = (slug: string, workspaceId: WorkspaceId | null, now: string) =>
    Effect.gen(function* () {
      const owner = yield* repo.findWorkspaceBySlug(slug);
      if (Option.isSome(owner) && owner.value.id !== workspaceId) return false;
      const alias = yield* repo.findSlugAlias(slug);
      if (
        Option.isSome(alias) &&
        alias.value.workspaceId !== workspaceId &&
        alias.value.expiresAt > now
      ) {
        return false;
      }
      return true;
    });

  const accountView = (row: BankAccountRow, workspace: WorkspaceRow): BankAccountViewFields => ({
    id: row.id,
    name: row.name,
    iban: row.iban,
    bic: row.bic,
    currency: row.currency,
    isDefault: workspace.bankAccountByCurrency[row.currency] === row.id,
    revision: row.revision,
  });

  const activeAccounts = (workspaceId: WorkspaceId) =>
    Effect.map(repo.listBankAccounts(workspaceId), (all) => all.filter((a) => !a.archived));

  const defaultSeries = (views: ReadonlyArray<SeriesView>): SeriesByKind => {
    const out: { [K in DocumentKind]?: NumberingSeriesId } = {};
    for (const view of views) if (view.isDefault) out[view.kind] = view.id;
    return out as SeriesByKind;
  };

  const workspaceView = (row: WorkspaceRow) =>
    Effect.gen(function* () {
      const date = yield* today;
      const accounts = yield* activeAccounts(row.id);
      const seriesViews = yield* series.list(row.id, date);
      const view: WorkspaceViewFields = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        closed: row.closed,
        revision: row.revision,
        issuingEntity: row.issuingEntity,
        taxRegime: regimeOn(row.taxRegimes, date),
        taxRegimeHistory: row.taxRegimes,
        defaults: { ...row.defaults, preferredSeriesByKind: defaultSeries(seriesViews) },
        reminderPolicy: row.reminders,
        bankAccounts: accounts.map((a) => accountView(a, row)),
        branding: row.branding,
      };
      return view as unknown as WorkspaceView;
    });

  const names = (ids: ReadonlyArray<UserId>) =>
    Effect.map(
      directory.lookup([...new Set(ids)]),
      (users) => new Map(users.map((u) => [u.userId, u])),
    );

  const invitationView = (
    row: InvitationRow,
    inviterName: string,
    now: string,
  ): InvitationView => ({
    id: row.id,
    email: row.email,
    role: row.role,
    status: invitationStatus(row, now),
    invitedBy: { userId: row.invitedBy, name: inviterName },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });

  const memberWorkspace = (caller: Caller, action: Forbidden["action"]) =>
    caller._tag === "Member" ? Effect.succeed(caller) : Effect.fail(new Forbidden({ action }));

  /** Starts the invitation email for `row`'s current epoch once the transaction commits. */
  const sendAfterCommit = (row: InvitationRow) =>
    store.afterCommit(
      Effect.andThen(
        delivery.start({
          workspaceId: row.workspaceId,
          invitationId: row.id,
          epoch: row.sendEpoch,
        }),
        stampStarted(row),
      ),
    );

  /**
   * J1: records the successful start of `row`'s epoch. The epoch guard keeps a late start from
   * stamping a newer resend. An unstamped epoch is restarted by reconciliation (idempotent per
   * epoch), so a failed stamp is only logged.
   */
  const stampStarted = (row: InvitationRow) =>
    Effect.provideContext(
      store.transaction(
        Effect.gen(function* () {
          const current = yield* repo.lockInvitation(row.workspaceId, row.id);
          if (current.sendEpoch !== row.sendEpoch || current.workflowStartedAt !== null) return;
          yield* repo.updateInvitation(
            { ...current, workflowStartedAt: yield* nowIso },
            current.revision,
          );
        }),
      ),
      context,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("invitation workflow start not recorded", cause),
      ),
    );

  const tokenHashOf = (invitationId: InvitationId, epoch: number) =>
    Effect.flatMap(tokens.token(invitationId, epoch), sha256Hex);

  const findByToken = (token: string) =>
    Effect.gen(function* () {
      const tokenHash = yield* sha256Hex(token);
      const found = yield* repo.findInvitationByTokenHash(tokenHash);
      if (Option.isNone(found)) return yield* new NotFound({ entity: "Invitation", id: "token" });
      return found.value;
    });

  /**
   * R1/R1c under the workspace lock: re-reads the actor's membership and re-runs `can` with the
   * stored role, so a request admitted before a demotion, removal or transfer cannot commit a
   * privileged change. Call after `repo.lockWorkspace`. Non-Member callers pass through.
   */
  const recheck = <C extends Caller>(caller: C, workspaceId: WorkspaceId, action: Action) =>
    Effect.gen(function* () {
      if (caller._tag !== "Member") return caller;
      const stored = yield* repo.findMembership(workspaceId, caller.userId);
      if (Option.isNone(stored)) return yield* new Forbidden({ action });
      const actor = { ...caller, role: stored.value.role } as C;
      if (!can(actor, action)) return yield* new Forbidden({ action });
      return actor;
    });

  /** Whether the latest ownership transfer was `from` → `to` and `to` still owns the Workspace. */
  const transferredBy = (workspaceId: WorkspaceId, from: UserId, to: UserId) =>
    Effect.gen(function* () {
      const target = yield* repo.findMembership(workspaceId, to);
      if (Option.isNone(target) || target.value.role !== "owner") return false;
      const history = yield* store.audit.history(workspaceId, {
        entity: "Workspace",
        id: workspaceId,
      });
      const last = history.filter((e) => e.action === "workspace.transferOwnership").at(-1);
      if (last === undefined || last.actor._tag !== "Member" || last.actor.userId !== from)
        return false;
      return last.changes.some((c) => c.path === `members.${to}` && c.after === "owner");
    });

  /**
   * Locks the Workspace for a revision-checked settings write. Closed state (W5) and the stored
   * role (R1) are checked before the revision (C2), so a caller without access learns nothing
   * from a `Conflict{revision_changed, currentRevision}`.
   */
  const lockForSettings = (caller: Caller, workspaceId: WorkspaceId, expectedRevision: number) =>
    Effect.gen(function* () {
      const row = yield* storeOnly(repo.lockWorkspace(workspaceId));
      yield* requireOpen(row, "workspace.settings");
      yield* recheck(caller, workspaceId, "workspace.settings");
      if (row.revision !== expectedRevision) {
        return yield* new Conflict({ reason: "revision_changed", currentRevision: row.revision });
      }
      return row;
    });

  /**
   * Before field validation and any request-log replay (W5, R1a, C3): a closed Workspace, or an
   * actor whose stored membership no longer allows `action`, gets no cached write result.
   * Returns the actor with its stored role; the locked write rechecks.
   */
  const preflight = <C extends Caller>(caller: C, workspaceId: WorkspaceId, action: Action) =>
    Effect.gen(function* () {
      yield* requireOpen(yield* storeOnly(repo.getWorkspace(workspaceId)), action);
      return yield* recheck(caller, workspaceId, action);
    });

  /** Owner/admin gate for invitations to the `admin` role (R1c). */
  const manageAdminsFor = (caller: Caller, role: InvitationRow["role"]) =>
    role === "admin" && !can(caller, "member.manageAdmins")
      ? Effect.fail(new Forbidden({ action: "member.manageAdmins" }))
      : Effect.void;

  const impl: WorkspacesImpl = {
    // Account caller -------------------------------------------------------------------------

    create: (input, opts) =>
      run(
        Effect.gen(function* () {
          const caller = yield* authorize("workspace.create");
          if (caller._tag !== "Account")
            return yield* new Forbidden({ action: "workspace.create" });
          const fields = yield* decodeInput(codec<NewWorkspaceFields>(NewWorkspaceFields), input);
          const ico = fields.ico?.trim();
          const idempotency = {
            scope: { _tag: "User", userId: caller.userId } as const,
            key: opts?.requestKey,
            method: "Workspaces.create",
            // The decoded fields: the slug is a plain string here, so an invalid slug reaches
            // the slug rule below instead of failing the fingerprint encoding.
            payload: { schema: codec<NewWorkspaceFields>(NewWorkspaceFields), value: fields },
            result: codec<MemberCaller>(MemberCallerSchema),
          };
          const createBody = (record: RegistryResult | null) =>
            Effect.gen(function* () {
              const name = (fields.name ?? record?.name ?? "").trim();
              if (name === "") return yield* invalid(["name"], "request.malformed");
              const now = yield* nowIso;
              const date = yield* today;
              const base = slugify(name);
              let suffix = 1;
              /** The next free generated candidate after `suffix` (W6). */
              const nextGenerated = Effect.gen(function* () {
                for (;;) {
                  const candidate = suffix === 1 ? base : withSuffix(base, suffix);
                  suffix++;
                  if (yield* slugFree(candidate, null, now)) return candidate;
                }
              });
              let slug: string;
              if (fields.slug !== undefined) {
                if (!isValidSlug(fields.slug))
                  return yield* invalid(["slug"], "workspace.slug_invalid");
                if (!(yield* slugFree(fields.slug, null, now))) {
                  return yield* invalid(["slug"], "workspace.slug_taken");
                }
                slug = fields.slug;
              } else {
                slug = yield* nextGenerated;
              }
              const workspaceId = yield* newId<WorkspaceId>();
              const regime = fields.taxRegime ?? "non_vat_payer";
              const issuingEntity: IssuingEntity = {
                name: record?.name ?? name,
                ico: ico === undefined || ico === "" ? null : ico,
                dic: record?.dic ?? null,
                address: record?.address ?? EMPTY_ADDRESS,
                legalForm: record?.legalForm ?? null,
                registerEntry: record?.registerEntry ?? null,
                email: caller.email,
                phone: null,
                web: null,
              };
              const row: WorkspaceRow = {
                id: workspaceId,
                workspaceId,
                revision: 1,
                slug: slug as WorkspaceSlug,
                name,
                closed: false,
                closedAt: null,
                createdAt: now,
                issuingEntity,
                taxRegimes: [{ regime, effectiveFrom: date }],
                defaults: {
                  currency:
                    fields.defaults?.currency ?? ("CZK" as WorkspaceRow["defaults"]["currency"]),
                  language: fields.defaults?.language ?? caller.locale,
                  dueDays: 14,
                  paymentMethod: "bank_transfer",
                  defaultNote: null,
                  paymentRounding: "none",
                  paymentTaxDocumentAutoSend: false,
                },
                bankAccountByCurrency: {},
                reminders: DEFAULT_REMINDERS,
                branding: DEFAULT_BRANDING,
              };
              // W6: the insert runs in a savepoint, so a concurrent create that took a generated
              // candidate first only costs a retry with the next suffix (bounded). An explicitly
              // requested slug still fails `slug_taken`.
              for (let attempt = 1; ; attempt++) {
                const inserted = yield* Effect.result(
                  store.transaction(repo.insertWorkspace({ ...row, slug: slug as WorkspaceSlug })),
                );
                if (inserted._tag === "Success") break;
                const error = inserted.failure;
                if (error._tag !== "UniqueViolation") return yield* Effect.fail(error);
                // Another unique key (a duplicate fresh id) is a defect, as before.
                if (error.constraint !== WORKSPACE_SLUG_UNIQUE) return yield* Effect.die(error);
                if (fields.slug !== undefined || attempt >= SLUG_INSERT_ATTEMPTS)
                  return yield* invalid(["slug"], "workspace.slug_taken");
                slug = yield* nextGenerated;
              }
              yield* storeOnly(
                repo.insertMembership({
                  id: yield* newId<string>(),
                  workspaceId,
                  revision: 1,
                  userId: caller.userId,
                  role: "owner",
                  joinedAt: now,
                  removedAt: null,
                }),
              );
              yield* series.ensureDefaults(workspaceId, seriesKindsFor(regime));
              yield* audit(
                workspaceId,
                "workspace.create",
                1,
                [
                  { path: "slug", before: null, after: slug },
                  { path: "name", before: null, after: name },
                  { path: `members.${caller.userId}`, before: null, after: "owner" },
                ],
                {
                  actor: {
                    _tag: "Member",
                    userId: caller.userId,
                    channel: caller.channel,
                    client: null,
                  },
                },
              );
              return memberCaller({
                userId: caller.userId,
                workspaceId,
                role: "owner",
                scopes: "all",
                locale: caller.locale,
                channel: caller.channel,
                client: null,
              });
            });
          let created: MemberCaller;
          if (ico === undefined || ico === "") {
            created = yield* withIdempotency(idempotency, createBody(null));
          } else {
            // C3: a committed key replays before any registry I/O. The probe claims the key and,
            // on a miss, rolls back (releasing it); the lookup then runs outside any transaction.
            const probe =
              idempotency.key === undefined
                ? null
                : yield* Effect.result(
                    withIdempotency(idempotency, Effect.fail(new RegistryNeeded())),
                  );
            if (probe !== null && probe._tag === "Success") {
              created = probe.success;
            } else {
              if (probe !== null && probe.failure._tag !== "RegistryNeeded") {
                return yield* Effect.fail(probe.failure);
              }
              const record = yield* registry.lookup(ico);
              created = yield* withIdempotency(idempotency, createBody(record));
            }
          }
          // A replay returns the stored caller; rebuild it from the membership as it is now, so a
          // creator who left or was demoted since does not get a stale owner caller back (R1a).
          const membership = yield* repo.findMembership(created.workspaceId, caller.userId);
          if (Option.isNone(membership)) {
            return yield* new Forbidden({ action: "workspace.enter" });
          }
          return memberCaller({
            userId: caller.userId,
            workspaceId: created.workspaceId,
            role: membership.value.role,
            scopes: "all",
            locale: caller.locale,
            channel: caller.channel,
            client: null,
          });
        }),
      ),

    listMine: run(
      Effect.gen(function* () {
        const caller = yield* authorize("workspace.listMine");
        if (caller._tag !== "Account")
          return yield* new Forbidden({ action: "workspace.listMine" });
        const date = yield* today;
        const memberships = yield* repo.listMembershipsOfUser(caller.userId);
        const out: Array<WorkspaceSummary> = [];
        for (const membership of memberships) {
          const row = yield* storeOnly(repo.getWorkspace(membership.workspaceId));
          const members = yield* repo.listMembers(row.id);
          out.push({
            id: row.id,
            slug: row.slug,
            name: row.name,
            role: membership.role,
            memberCount: members.length,
            taxRegime: regimeOn(row.taxRegimes, date),
            closed: row.closed,
          });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      }),
    ),

    enter: (workspace, opts) =>
      run(
        Effect.gen(function* () {
          const caller = yield* authorize("workspace.enter");
          if (caller._tag !== "Account") return yield* new Forbidden({ action: "workspace.enter" });
          const membership = yield* repo.findMembership(workspace, caller.userId);
          if (Option.isNone(membership)) {
            return yield* new NotFound({ entity: "Workspace", id: workspace });
          }
          return memberCaller({
            userId: caller.userId,
            workspaceId: workspace,
            role: membership.value.role,
            scopes: opts.scopes,
            locale: caller.locale,
            channel: opts.channel,
            client: opts.client ?? null,
          });
        }),
      ),

    acceptInvitation: (token) =>
      run(
        Effect.gen(function* () {
          const caller = yield* authorize("invitation.accept");
          if (caller._tag !== "Account")
            return yield* new Forbidden({ action: "invitation.accept" });
          return yield* store.transaction(
            Effect.gen(function* () {
              const found = yield* findByToken(token);
              // Lock order everywhere: workspace, then invitation (resend and revoke do the same).
              const workspace = yield* storeOnly(repo.lockWorkspace(found.workspaceId));
              yield* requireOpen(workspace, "invitation.accept");
              const invitation = yield* repo.lockInvitation(found.workspaceId, found.id);
              const now = yield* nowIso;
              if (invitation.tokenHash !== found.tokenHash) {
                return yield* new NotFound({ entity: "Invitation", id: "token" });
              }
              if (invitationStatus(invitation, now) !== "pending") return yield* notPending();
              if (invitation.emailLower !== caller.email.trim().toLowerCase()) {
                return yield* new Forbidden({ action: "invitation.accept" });
              }
              const existing = yield* repo.findMembership(workspace.id, caller.userId);
              const role: Role = Option.isSome(existing) ? existing.value.role : invitation.role;
              if (Option.isNone(existing)) {
                // A removed membership is reactivated: the unique index is per (workspace, user).
                const removed = yield* repo.findMembershipRecord(workspace.id, caller.userId);
                if (Option.isSome(removed)) {
                  yield* storeOnly(
                    repo.updateMembership(
                      { ...removed.value, role, joinedAt: now, removedAt: null },
                      removed.value.revision,
                    ),
                  );
                } else {
                  yield* storeOnly(
                    repo.insertMembership({
                      id: yield* newId<string>(),
                      workspaceId: workspace.id,
                      revision: 1,
                      userId: caller.userId,
                      role,
                      joinedAt: now,
                      removedAt: null,
                    }),
                  );
                }
              }
              yield* storeOnly(
                repo.updateInvitation(
                  { ...invitation, status: "accepted", acceptedBy: caller.userId },
                  invitation.revision,
                ),
              );
              yield* audit(
                workspace.id,
                "invitation.accept",
                workspace.revision,
                [
                  {
                    path: `invitations.${invitation.id}.status`,
                    before: "pending",
                    after: "accepted",
                  },
                  ...(Option.isSome(existing)
                    ? []
                    : [{ path: `members.${caller.userId}`, before: null, after: role }]),
                ],
                {
                  actor: {
                    _tag: "Member",
                    userId: caller.userId,
                    channel: caller.channel,
                    client: null,
                  },
                },
              );
              return memberCaller({
                userId: caller.userId,
                workspaceId: workspace.id,
                role,
                scopes: "all",
                locale: caller.locale,
                channel: caller.channel,
                client: null,
              });
            }),
          );
        }),
      ),

    lookupCompany: (ico) =>
      run(
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          // R1e: Account callers hold registry.lookup; Members need contact.read.
          yield* authorize(caller._tag === "Member" ? "contact.read" : "registry.lookup");
          const trimmed = ico.trim();
          const result = yield* registry.lookup(trimmed);
          if (result === null) return yield* new NotFound({ entity: "Contact", id: trimmed });
          return result;
        }),
      ),

    peekInvitation: run(
      Effect.gen(function* () {
        // The invitation page sees only NotFound, whoever asks.
        const caller = yield* Effect.mapError(
          authorize("invitation.peek"),
          () => new NotFound({ entity: "Invitation", id: "token" }),
        );
        if (caller._tag !== "InvitationHolder") {
          return yield* new NotFound({ entity: "Invitation", id: "token" });
        }
        const invitation = yield* findByToken(caller.token);
        const workspace = yield* storeOnly(repo.getWorkspace(invitation.workspaceId));
        const inviter = (yield* names([invitation.invitedBy])).get(invitation.invitedBy);
        const peek: InvitationPeek = {
          workspaceName: workspace.name,
          inviterName: inviter?.name ?? "",
          role: invitation.role,
          email: invitation.email,
          status: invitationStatus(invitation, yield* nowIso),
          expiresAt: invitation.expiresAt,
        };
        return peek;
      }),
    ),

    // Member caller ----------------------------------------------------------------------------

    current: run(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("workspace.read");
        return yield* workspaceView(yield* storeOnly(repo.getWorkspace(workspaceId)));
      }),
    ),

    updateIssuingEntity: (patch: IssuingEntityPatch, expectedRevision) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          const fields = yield* decodeInput(
            codec<IssuingEntityPatchFields>(IssuingEntityPatchFields),
            patch,
          );
          return yield* store.transaction(
            Effect.gen(function* () {
              const row = yield* lockForSettings(caller, workspaceId, expectedRevision);
              const issues: Array<Issue> = [];
              if (fields.name !== undefined && fields.name.trim() === "") {
                issues.push(issue(["name"], "request.malformed"));
              }
              if (fields.ico !== undefined && fields.ico !== null) {
                if (!isValidIco(fields.ico)) issues.push(issue(["ico"], "ico.checksum"));
              }
              if (
                fields.email !== undefined &&
                fields.email !== null &&
                !isValidEmail(fields.email)
              ) {
                issues.push(issue(["email"], "request.malformed"));
              }
              const last = row.taxRegimes[row.taxRegimes.length - 1];
              if (
                fields.taxRegime !== undefined &&
                last !== undefined &&
                fields.taxRegime.effectiveFrom < last.effectiveFrom
              ) {
                issues.push(issue(["taxRegime", "effectiveFrom"], "request.malformed"));
              }
              yield* failIssues(issues);
              const { taxRegime, ...entityPatch } = fields;
              const issuingEntity: IssuingEntity = {
                ...row.issuingEntity,
                ...Object.fromEntries(
                  Object.entries(entityPatch).filter(([, v]) => v !== undefined),
                ),
                ...(entityPatch.name === undefined ? {} : { name: entityPatch.name.trim() }),
              };
              let taxRegimes = row.taxRegimes;
              if (
                taxRegime !== undefined &&
                last !== undefined &&
                taxRegime.regime !== last.regime
              ) {
                // W2: the first (baseline) period is never replaced, so tax points before a
                // change keep the baseline even when the change takes effect on creation day.
                taxRegimes =
                  row.taxRegimes.length > 1 && taxRegime.effectiveFrom === last.effectiveFrom
                    ? [...row.taxRegimes.slice(0, -1), taxRegime]
                    : [...row.taxRegimes, taxRegime];
              }
              const next = yield* storeOnly(
                repo.updateWorkspace({ ...row, issuingEntity, taxRegimes }, row.revision),
              );
              if (taxRegime?.regime === "vat_payer") {
                yield* series.ensureDefaults(workspaceId, ["payment_tax_document"]);
              }
              yield* audit(workspaceId, "workspace.issuingEntity.update", next.revision, [
                ...diff("issuingEntity.", row.issuingEntity, issuingEntity),
                ...(taxRegimes === row.taxRegimes
                  ? []
                  : [{ path: "taxRegimes", before: row.taxRegimes, after: taxRegimes }]),
              ]);
              return yield* workspaceView(next);
            }),
          );
        }),
      ),

    updateSettings: (patch: WorkspaceSettingsPatch, expectedRevision) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          const fields = yield* decodeInput(codec<SettingsPatch>(SettingsPatchFields), patch);
          return yield* store.transaction(
            Effect.gen(function* () {
              const row = yield* lockForSettings(caller, workspaceId, expectedRevision);
              const now = yield* nowIso;
              const date = yield* today;
              const issues: Array<Issue> = [];
              const name = fields.name?.trim();
              if (name === "") issues.push(issue(["name"], "request.malformed"));
              const slugChanged = fields.slug !== undefined && fields.slug !== row.slug;
              if (fields.slug !== undefined && !isValidSlug(fields.slug)) {
                issues.push(issue(["slug"], "workspace.slug_invalid"));
              } else if (
                slugChanged &&
                !(yield* slugFree(fields.slug as string, workspaceId, now))
              ) {
                issues.push(issue(["slug"], "workspace.slug_taken"));
              }
              issues.push(...brandingIssues(fields.branding ?? {}));
              const defaults = fields.defaults ?? {};
              if (
                defaults.dueDays !== undefined &&
                (defaults.dueDays < 0 || defaults.dueDays > MAX_DUE_DAYS)
              ) {
                issues.push(issue(["defaults", "dueDays"], "request.malformed"));
              }
              const seriesViews = yield* series.list(workspaceId, date);
              const promote: Array<SeriesView> = [];
              for (const [kind, id] of Object.entries(
                defaults.preferredSeriesByKind ?? {},
              ) as Array<[DocumentKind, NumberingSeriesId | undefined]>) {
                if (id === undefined) continue;
                const target = seriesViews.find((s) => s.id === id && s.kind === kind);
                if (target === undefined) {
                  issues.push(
                    issue(["defaults", "preferredSeriesByKind", kind], "request.malformed"),
                  );
                } else if (!target.isDefault) promote.push(target);
              }
              const offsets = fields.reminderPolicy?.offsetsDays;
              if (
                offsets !== undefined &&
                (offsets.length > MAX_REMINDER_OFFSETS ||
                  offsets.some((d) => d < 1 || d > MAX_DUE_DAYS) ||
                  new Set(offsets).size !== offsets.length)
              ) {
                issues.push(issue(["reminderPolicy", "offsetsDays"], "request.malformed"));
              }
              yield* failIssues(issues);

              const { preferredSeriesByKind: _ignored, ...defaultFields } = defaults;
              const next: WorkspaceRow = {
                ...row,
                ...(name === undefined ? {} : { name }),
                ...(fields.slug === undefined ? {} : { slug: fields.slug as WorkspaceSlug }),
                defaults: {
                  ...row.defaults,
                  ...(Object.fromEntries(
                    Object.entries(defaultFields).filter(([, v]) => v !== undefined),
                  ) as Partial<WorkspaceRow["defaults"]>),
                },
                reminders: {
                  ...row.reminders,
                  ...(Object.fromEntries(
                    Object.entries(fields.reminderPolicy ?? {}).filter(([, v]) => v !== undefined),
                  ) as Partial<WorkspaceRow["reminders"]>),
                  ...(offsets === undefined
                    ? {}
                    : { offsetsDays: [...offsets].sort((a, b) => a - b) }),
                },
                branding: mergeBranding(row.branding, fields.branding),
              };
              if (slugChanged) {
                const target = yield* repo.findSlugAlias(next.slug);
                if (Option.isSome(target)) yield* storeOnly(repo.removeSlugAlias(target.value));
                const stale = yield* repo.findSlugAlias(row.slug);
                if (Option.isSome(stale)) yield* storeOnly(repo.removeSlugAlias(stale.value));
              }
              const saved = yield* slugRace(
                Effect.catchTag(repo.updateWorkspace(next, row.revision), "NotFound", Effect.die),
              );
              if (slugChanged) {
                yield* storeOnly(
                  repo.insertSlugAlias({
                    id: yield* newId<string>(),
                    workspaceId,
                    revision: 1,
                    slug: row.slug,
                    expiresAt: new Date(Date.parse(now) + SLUG_ALIAS_TTL_MILLIS).toISOString(),
                  }),
                );
              }
              for (const target of promote) {
                yield* Effect.catchTag(
                  series.configure(
                    workspaceId,
                    {
                      id: target.id,
                      kind: target.kind,
                      name: target.name,
                      pattern: target.pattern,
                      isDefault: true,
                    },
                    date,
                  ),
                  "NotFound",
                  () =>
                    Effect.fail(
                      invalid(
                        ["defaults", "preferredSeriesByKind", target.kind],
                        "request.malformed",
                      ),
                    ),
                );
              }
              const { revision: _a, ...beforeFields } = row;
              const { revision: _b, ...afterFields } = saved;
              yield* audit(workspaceId, "workspace.settings.update", saved.revision, [
                ...diff("", beforeFields, afterFields),
                ...promote.map((s) => ({
                  path: `defaults.preferredSeriesByKind.${s.kind}`,
                  before: seriesViews.find((v) => v.kind === s.kind && v.isDefault)?.id ?? null,
                  after: s.id,
                })),
              ]);
              return yield* workspaceView(saved);
            }),
          );
        }),
      ),

    saveBankAccount: (input, opts) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          yield* preflight(caller, workspaceId, "workspace.settings");
          const fields = yield* decodeInput(codec<BankAccountFields>(BankAccountFields), input);
          const iban = normalizeIban(fields.iban);
          const bic =
            fields.bic === undefined || fields.bic === null
              ? null
              : fields.bic.trim().toUpperCase();
          const issues: Array<Issue> = [];
          if (!isValidIban(iban)) issues.push(issue(["iban"], "request.malformed"));
          if (bic !== null && !isValidBic(bic)) issues.push(issue(["bic"], "request.malformed"));
          yield* failIssues(issues);
          const view = yield* withIdempotency(
            {
              scope: { _tag: "Workspace", workspaceId },
              // C6: replacing an existing account is idempotent by state and applies to the
              // current state; only a create (no id) is replayed from the request log.
              key: fields.id === undefined ? opts?.requestKey : undefined,
              method: "Workspaces.saveBankAccount",
              payload: { schema: codec<BankAccountFields>(BankAccountFields), value: fields },
              result: codec<BankAccountViewFields>(BankAccountViewFields),
            },
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "workspace.settings");
              yield* recheck(caller, workspaceId, "workspace.settings");
              const now = yield* nowIso;
              // Full replacement (C6): an omitted name or bic clears it.
              const name = fields.name?.trim() || null;
              let before: BankAccountRow | null = null;
              let saved: BankAccountRow;
              if (fields.id !== undefined) {
                const current = yield* repo.lockBankAccount(workspaceId, fields.id);
                if (current.archived)
                  return yield* new NotFound({ entity: "BankAccount", id: fields.id });
                before = current;
                const isDefaultNow =
                  workspace.bankAccountByCurrency[current.currency] === current.id;
                if (
                  current.iban === iban &&
                  current.bic === bic &&
                  current.name === name &&
                  current.currency === fields.currency &&
                  (fields.isDefault !== true || isDefaultNow)
                ) {
                  return accountView(current, workspace); // idempotent by state (C6)
                }
                if (current.currency !== fields.currency) {
                  // A currency change moves drafts, Templates and a currency default with it.
                  const others = (yield* activeAccounts(workspaceId)).some(
                    (a) => a.currency === current.currency && a.id !== current.id,
                  );
                  const uses = yield* references.count(workspaceId, current.id);
                  if (uses > 0 || (isDefaultNow && others)) {
                    return yield* new Conflict({
                      reason: "illegal_transition",
                      detail: "bank_account.in_use",
                    });
                  }
                }
                saved = yield* storeOnly(
                  repo.updateBankAccount(
                    { ...current, iban, bic, name, currency: fields.currency },
                    current.revision,
                  ),
                );
              } else {
                saved = yield* storeOnly(
                  repo.insertBankAccount({
                    id: yield* newId<BankAccountId>(),
                    workspaceId,
                    revision: 1,
                    name,
                    iban,
                    bic,
                    currency: fields.currency,
                    archived: false,
                    createdAt: now,
                  }),
                );
              }
              const byCurrency: Record<string, BankAccountId> = {
                ...workspace.bankAccountByCurrency,
              };
              if (
                before !== null &&
                before.currency !== saved.currency &&
                byCurrency[before.currency] === saved.id
              ) {
                // The account left its old currency: promote another account of it, if any.
                const others = (yield* activeAccounts(workspaceId)).filter(
                  (a) => a.currency === before?.currency && a.id !== saved.id,
                );
                if (others[0] === undefined) delete byCurrency[before.currency];
                else byCurrency[before.currency] = others[0].id;
              }
              if (fields.isDefault === true || byCurrency[saved.currency] === undefined) {
                byCurrency[saved.currency] = saved.id;
              }
              const nextWorkspace = yield* storeOnly(
                repo.updateWorkspace(
                  { ...workspace, bankAccountByCurrency: byCurrency },
                  workspace.revision,
                ),
              );
              const result = accountView(saved, nextWorkspace);
              yield* audit(workspaceId, "workspace.bankAccount.save", nextWorkspace.revision, [
                {
                  path: `bankAccounts.${saved.id}`,
                  before: before === null ? null : accountView(before, workspace),
                  after: result,
                },
              ]);
              return result;
            }),
          );
          return view as unknown as BankAccountView;
        }),
      ),

    removeBankAccount: (id, replacement) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          yield* store.transaction(
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "workspace.settings");
              yield* recheck(caller, workspaceId, "workspace.settings");
              const account = yield* repo.lockBankAccount(workspaceId, id);
              if (account.archived) return; // idempotent by state (C6)
              let substitute: BankAccountRow | undefined;
              if (replacement !== undefined) {
                // Scoped fetch first: a foreign or unknown id is NotFound (R2).
                const candidate = yield* repo.getBankAccount(workspaceId, replacement);
                if (
                  candidate.archived ||
                  candidate.id === id ||
                  candidate.currency !== account.currency
                ) {
                  return yield* invalid(["replacement"], "bank_account.replacement_invalid");
                }
                substitute = candidate;
              }
              const uses = yield* references.count(workspaceId, id);
              const isDefault = workspace.bankAccountByCurrency[account.currency] === id;
              // A currency default is always in use (4.1), even as its currency's only account.
              const inUse = uses > 0 || isDefault;
              if (inUse && substitute === undefined) {
                return yield* new Conflict({
                  reason: "illegal_transition",
                  detail: "bank_account.in_use",
                });
              }
              if (substitute !== undefined && uses > 0) {
                yield* references.reassign(workspaceId, id, substitute.id);
              }
              const byCurrency: Record<string, BankAccountId> = {
                ...workspace.bankAccountByCurrency,
              };
              if (isDefault) {
                if (substitute === undefined) delete byCurrency[account.currency];
                else byCurrency[account.currency] = substitute.id;
              }
              yield* storeOnly(
                repo.updateBankAccount({ ...account, archived: true }, account.revision),
              );
              const next = yield* storeOnly(
                repo.updateWorkspace(
                  { ...workspace, bankAccountByCurrency: byCurrency },
                  workspace.revision,
                ),
              );
              yield* audit(workspaceId, "workspace.bankAccount.remove", next.revision, [
                {
                  path: `bankAccounts.${id}`,
                  before: accountView(account, workspace),
                  after: null,
                },
                ...(substitute === undefined
                  ? []
                  : [
                      {
                        path: `bankAccounts.${id}.replacement`,
                        before: null,
                        after: substitute.id,
                      },
                    ]),
              ]);
            }),
          );
        }),
      ),

    configureSeries: (input, opts) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          yield* preflight(caller, workspaceId, "workspace.settings");
          // W3: the next counter is a positive safe integer (NumberingSeriesView.nextCounter is
          // Schema.Int).
          if (
            input.nextNumber !== undefined &&
            !(Number.isSafeInteger(input.nextNumber) && input.nextNumber >= 1)
          ) {
            return yield* invalid(["nextNumber"], "request.malformed");
          }
          return yield* withIdempotency(
            {
              scope: { _tag: "Workspace", workspaceId },
              // C6: as saveBankAccount, only a create (no id) uses the request log.
              key: input.id === undefined ? opts?.requestKey : undefined,
              method: "Workspaces.configureSeries",
              payload: { schema: codec<typeof input>(SeriesInputSchema), value: input },
              result: codec<SeriesView>(NumberingSeriesView),
            },
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "workspace.settings");
              yield* recheck(caller, workspaceId, "workspace.settings");
              const { view, before } = yield* series.configure(workspaceId, input, yield* today);
              // A repeat with the same configuration changes nothing (C6 full replacement).
              if (before !== null && JSON.stringify(before) === JSON.stringify(view)) return view;
              // The default series per kind is part of WorkspaceView, so its revision moves.
              const next = yield* storeOnly(repo.updateWorkspace(workspace, workspace.revision));
              yield* audit(workspaceId, "workspace.series.configure", next.revision, [
                { path: `series.${view.id}`, before, after: view },
              ]);
              return view;
            }),
          );
        }),
      ),

    listSeries: run(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("workspace.read");
        return yield* series.list(workspaceId, yield* today);
      }),
    ),

    setBrandingImage: (image, file) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          yield* preflight(caller, workspaceId, "workspace.settings");
          const contentType = file.contentType.toLowerCase();
          if (!(BRANDING_IMAGE_TYPES as ReadonlyArray<string>).includes(contentType)) {
            return yield* invalid(["contentType"], "branding.image_type_rejected");
          }
          // Checked while streaming (W7): the size cap aborts early and the signature is checked
          // as soon as its signature's bytes have arrived (PNG 8, JPEG 3), before any further
          // chunk is pulled.
          const headerBytes =
            IMAGE_SIGNATURE_BYTES[contentType as keyof typeof IMAGE_SIGNATURE_BYTES];
          const parts: Array<Uint8Array> = [];
          let size = 0;
          let headerChecked = false;
          const joined = (length: number) => {
            const out = new Uint8Array(length);
            let offset = 0;
            for (const part of parts) {
              if (offset >= length) break;
              const take = part.subarray(0, length - offset);
              out.set(take, offset);
              offset += take.byteLength;
            }
            return out;
          };
          yield* Stream.runForEach(file.bytes, (chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              if (size > BRANDING_IMAGE_MAX_BYTES) {
                return yield* invalid(["file"], "branding.image_too_large");
              }
              // An owned copy on arrival (`Buffer.slice` would alias): the producer may reuse
              // its buffer, and these bytes are validated, hashed and stored.
              parts.push(new Uint8Array(chunk));
              if (!headerChecked && size >= headerBytes) {
                headerChecked = true;
                if (!matchesImageSignature(contentType, joined(headerBytes))) {
                  return yield* invalid(["file"], "branding.image_type_rejected");
                }
              }
            }),
          );
          const bytes = joined(size);
          if (!headerChecked && !matchesImageSignature(contentType, bytes)) {
            return yield* invalid(["file"], "branding.image_type_rejected");
          }
          const sha256 = yield* sha256Hex(bytes);
          const key = brandingKey(workspaceId, image, sha256);
          yield* Effect.catchTag(
            blobs.put(key, Stream.succeed(bytes), {
              contentType,
              maxBytes: BRANDING_IMAGE_MAX_BYTES,
            }),
            "BlobTooLarge",
            () => Effect.fail(invalid(["file"], "branding.image_too_large")),
          );
          const fresh: ImageRef = { contentType, bytes: size, sha256, updatedAt: yield* nowIso };
          return yield* store.transaction(
            Effect.gen(function* () {
              const row = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(row, "workspace.settings");
              yield* recheck(caller, workspaceId, "workspace.settings");
              const previous = row.branding[image];
              // Idempotent by content hash (C6): the same image keeps its ref and the revision.
              if (
                previous !== null &&
                previous.sha256 === sha256 &&
                previous.contentType === contentType
              ) {
                return previous;
              }
              const ref = fresh;
              const next = yield* storeOnly(
                repo.updateWorkspace(
                  { ...row, branding: { ...row.branding, [image]: ref } },
                  row.revision,
                ),
              );
              yield* audit(workspaceId, "workspace.branding.image.set", next.revision, [
                { path: `branding.${image}`, before: previous, after: ref },
              ]);
              // Superseded blobs stay: keys are content-addressed, so deleting one here could
              // remove an image a concurrent request just stored again. Housekeeping collects them.
              return ref;
            }),
          );
        }),
      ),

    brandingImage: (image) =>
      run(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("workspace.read");
          const row = yield* storeOnly(repo.getWorkspace(workspaceId));
          const ref = row.branding[image];
          if (ref === null) return yield* new NotFound({ entity: "BrandingImage", id: image });
          const bytes = yield* Effect.catchTag(
            blobs.get(brandingKey(workspaceId, image, ref.sha256)),
            "BlobMissing",
            () => Effect.fail(new NotFound({ entity: "BrandingImage", id: image })),
          );
          const download: FileDownload = {
            filename: `${image}.${ref.contentType === "image/png" ? "png" : "jpg"}`,
            contentType: ref.contentType,
            bytes,
          };
          return download;
        }),
      ),

    removeBrandingImage: (image) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          yield* store.transaction(
            Effect.gen(function* () {
              const row = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(row, "workspace.settings");
              yield* recheck(caller, workspaceId, "workspace.settings");
              const previous = row.branding[image];
              if (previous === null) return;
              const next = yield* storeOnly(
                repo.updateWorkspace(
                  { ...row, branding: { ...row.branding, [image]: null } },
                  row.revision,
                ),
              );
              yield* audit(workspaceId, "workspace.branding.image.remove", next.revision, [
                { path: `branding.${image}`, before: previous, after: null },
              ]);
            }),
          );
        }),
      ),

    previewBranding: (input) =>
      run(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("workspace.settings");
          const row = yield* storeOnly(repo.getWorkspace(workspaceId));
          yield* requireOpen(row, "workspace.settings");
          yield* failIssues(brandingIssues(input.branding));
          return yield* preview.render({
            workspaceId,
            branding: mergeBranding(row.branding, input.branding),
            issuingEntity: row.issuingEntity,
            kind: input.kind,
            language: input.language,
          });
        }),
      ),

    members: run(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("member.read");
        const rows = yield* repo.listMembers(workspaceId);
        const users = yield* names(rows.map((m) => m.userId));
        return rows.map(
          (m): MemberView => ({
            userId: m.userId,
            name: users.get(m.userId)?.name ?? "",
            email: users.get(m.userId)?.email ?? "",
            role: m.role,
            joinedAt: m.joinedAt,
          }),
        );
      }),
    ),

    invitations: run(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("invitation.read");
        const now = yield* nowIso;
        const cutoff = new Date(Date.parse(now) - INVITATION_LIST_EXPIRED_MILLIS).toISOString();
        const rows = (yield* repo.listInvitations(workspaceId)).filter(
          (i) => (i.status === "pending" || i.status === "expired") && i.expiresAt > cutoff,
        );
        const users = yield* names(rows.map((i) => i.invitedBy));
        return rows.map((i) => invitationView(i, users.get(i.invitedBy)?.name ?? "", now));
      }),
    ),

    invite: (email, role, opts) =>
      run(
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          yield* checkMembershipChange(caller, { _tag: "Invite", role });
          const member = yield* memberWorkspace(caller, "member.invite");
          const workspaceId = member.workspaceId;
          // The stored role must still allow this invitation before a replay is served (R1c).
          yield* checkMembershipChange(yield* preflight(member, workspaceId, "member.invite"), {
            _tag: "Invite",
            role,
          });
          const address = email.trim();
          if (!isValidEmail(address)) return yield* invalid(["email"], "request.malformed");
          const inviteRole = role as InvitationRow["role"];
          return yield* withIdempotency(
            {
              scope: { _tag: "Workspace", workspaceId },
              key: opts?.requestKey,
              method: "Workspaces.invite",
              payload: { schema: InvitePayload, value: { email: address, role } },
              result: codec<InvitationView>(InvitationViewSchema),
            },
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "member.invite");
              const actor = yield* recheck(member, workspaceId, "member.invite");
              yield* checkMembershipChange(actor, { _tag: "Invite", role });
              const now = yield* nowIso;
              const emailLower = address.toLowerCase();
              const memberRows = yield* repo.listMembers(workspaceId);
              const users = yield* names([...memberRows.map((m) => m.userId), member.userId]);
              if (memberRows.some((m) => users.get(m.userId)?.email.toLowerCase() === emailLower)) {
                return yield* new Conflict({ reason: "duplicate" });
              }
              const inviterName = users.get(member.userId)?.name ?? "";
              const pending = yield* repo.findPendingInvitation(workspaceId, emailLower);
              if (Option.isSome(pending) && invitationStatus(pending.value, now) === "pending") {
                // Inviting an email with a pending invitation returns it (4.1 Idempotency).
                const existing = pending.value;
                return invitationView(existing, users.get(existing.invitedBy)?.name ?? "", now);
              }
              const expiresAt = new Date(Date.parse(now) + INVITATION_TTL_MILLIS).toISOString();
              let row: InvitationRow;
              if (Option.isSome(pending)) {
                // A pending invitation past its expiry is renewed in place with a new epoch.
                const old = pending.value;
                const sendEpoch = old.sendEpoch + 1;
                row = yield* storeOnly(
                  repo.updateInvitation(
                    {
                      ...old,
                      email: address,
                      role: inviteRole,
                      tokenHash: yield* tokenHashOf(old.id, sendEpoch),
                      sendEpoch,
                      workflowStartedAt: null,
                      invitedBy: member.userId,
                      createdAt: now,
                      lastSentAt: now,
                      expiresAt,
                    },
                    old.revision,
                  ),
                );
              } else {
                const id = yield* newId<InvitationId>();
                row = yield* storeOnly(
                  repo.insertInvitation({
                    id,
                    workspaceId,
                    revision: 1,
                    email: address,
                    emailLower,
                    role: inviteRole,
                    status: "pending",
                    tokenHash: yield* tokenHashOf(id, 0),
                    sendEpoch: 0,
                    workflowStartedAt: null,
                    invitedBy: member.userId,
                    createdAt: now,
                    lastSentAt: now,
                    expiresAt,
                    acceptedBy: null,
                  }),
                );
              }
              yield* sendAfterCommit(row);
              yield* audit(workspaceId, "member.invite", workspace.revision, [
                { path: `invitations.${row.id}`, before: null, after: { email: address, role } },
              ]);
              return invitationView(row, inviterName, now);
            }),
          );
        }),
      ),

    resendInvitation: (id) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("member.invite");
          yield* store.transaction(
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "member.invite");
              const actor = yield* recheck(caller, workspaceId, "member.invite");
              const invitation = yield* repo.lockInvitation(workspaceId, id);
              yield* manageAdminsFor(actor, invitation.role);
              const now = yield* nowIso;
              // Pending invitations only; an expired one is renewed by inviting the email again.
              if (invitationStatus(invitation, now) !== "pending") return yield* notPending();
              // C6: no second email within 60 s of the last one.
              if (Date.parse(now) - Date.parse(invitation.lastSentAt) < RESEND_COOLDOWN_MILLIS)
                return;
              const sendEpoch = invitation.sendEpoch + 1;
              const next = yield* storeOnly(
                repo.updateInvitation(
                  {
                    ...invitation,
                    tokenHash: yield* tokenHashOf(invitation.id, sendEpoch),
                    sendEpoch,
                    workflowStartedAt: null,
                    lastSentAt: now,
                    expiresAt: new Date(Date.parse(now) + INVITATION_TTL_MILLIS).toISOString(),
                  },
                  invitation.revision,
                ),
              );
              yield* sendAfterCommit(next);
              yield* audit(workspaceId, "member.invite.resend", workspace.revision, [
                {
                  path: `invitations.${id}.expiresAt`,
                  before: invitation.expiresAt,
                  after: next.expiresAt,
                },
              ]);
            }),
          );
        }),
      ),

    revokeInvitation: (id) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("member.invite");
          yield* store.transaction(
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "member.invite");
              const actor = yield* recheck(caller, workspaceId, "member.invite");
              const invitation = yield* repo.lockInvitation(workspaceId, id);
              yield* manageAdminsFor(actor, invitation.role);
              const status = invitationStatus(invitation, yield* nowIso);
              // Idempotent by state: revoked or accepted stays as it is; expired can be revoked.
              if (status !== "pending" && status !== "expired") return;
              yield* storeOnly(
                repo.updateInvitation({ ...invitation, status: "revoked" }, invitation.revision),
              );
              yield* audit(workspaceId, "member.invite.revoke", workspace.revision, [
                { path: `invitations.${id}.status`, before: status, after: "revoked" },
              ]);
            }),
          );
        }),
      ),

    setRole: (userId, role) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("member.setRole");
          yield* store.transaction(
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "member.setRole");
              const actor = yield* recheck(caller, workspaceId, "member.setRole");
              const found = yield* repo.findMembership(workspaceId, userId);
              if (Option.isNone(found)) {
                // C6: repeating a removal of a member removed from this Workspace succeeds; a
                // user who never belonged here stays NotFound (R2).
                const record = yield* repo.findMembershipRecord(workspaceId, userId);
                if (role === null && Option.isSome(record)) {
                  return yield* checkMembershipChange(actor, {
                    _tag: "Remove",
                    targetRole: record.value.role,
                  });
                }
                return yield* new NotFound({ entity: "Member", id: userId });
              }
              const target = found.value;
              yield* checkMembershipChange(
                actor,
                role === null
                  ? { _tag: "Remove", targetRole: target.role }
                  : { _tag: "SetRole", targetRole: target.role, role },
              );
              if (role === target.role) return;
              if (role === null) {
                // W8: ends the membership; apps/server then revokes its keys and grants.
                yield* storeOnly(repo.removeMembership(target, yield* nowIso));
              } else {
                yield* storeOnly(repo.updateMembership({ ...target, role }, target.revision));
              }
              yield* audit(
                workspaceId,
                role === null ? "member.remove" : "member.setRole",
                workspace.revision,
                [{ path: `members.${userId}`, before: target.role, after: role }],
              );
            }),
          );
        }),
      ),

    leave: run(
      Effect.gen(function* () {
        const caller = yield* CurrentCaller;
        yield* checkMembershipChange(caller, { _tag: "Leave" });
        const member = yield* memberWorkspace(caller, "member.leave");
        yield* store.transaction(
          Effect.gen(function* () {
            const workspace = yield* storeOnly(repo.lockWorkspace(member.workspaceId));
            yield* requireOpen(workspace, "member.leave");
            const found = yield* repo.findMembership(member.workspaceId, member.userId);
            if (Option.isNone(found)) return;
            // R3 against the stored role: a caller promoted to owner since entering cannot leave.
            if (found.value.role === "owner") {
              return yield* new Conflict({
                reason: "illegal_transition",
                detail: "member.owner_cannot_leave",
              });
            }
            yield* storeOnly(repo.removeMembership(found.value, yield* nowIso));
            yield* audit(member.workspaceId, "member.leave", workspace.revision, [
              { path: `members.${member.userId}`, before: found.value.role, after: null },
            ]);
          }),
        );
      }),
    ),

    transferOwnership: (to) =>
      run(
        Effect.gen(function* () {
          // The role gate is the stored owner role, checked under the lock below; here only the
          // caller's kind and scopes must allow the action. A former owner who re-entered as
          // admin thus reaches the exact-transfer check (C6).
          const caller = yield* CurrentCaller;
          const member = yield* memberWorkspace(caller, "workspace.transferOwnership");
          if (!can({ ...member, role: "owner" }, "workspace.transferOwnership")) {
            return yield* new Forbidden({ action: "workspace.transferOwnership" });
          }
          const workspaceId = member.workspaceId;
          yield* store.transaction(
            Effect.gen(function* () {
              const workspace = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* requireOpen(workspace, "workspace.transferOwnership");
              const self = yield* repo.findMembership(workspaceId, member.userId);
              if (Option.isNone(self)) {
                return yield* new Forbidden({ action: "workspace.transferOwnership" });
              }
              if (self.value.role !== "owner") {
                // C6: a retry of this caller's completed transfer to `to` succeeds; any other
                // transfer by a non-owner stays Forbidden (R1).
                if (yield* transferredBy(workspaceId, member.userId, to)) return;
                return yield* new Forbidden({ action: "workspace.transferOwnership" });
              }
              // A new transfer needs the supplied caller's own role too (R1a): a request that
              // entered as admin gains nothing from a promotion since.
              if (!can(member, "workspace.transferOwnership")) {
                return yield* new Forbidden({ action: "workspace.transferOwnership" });
              }
              if (to === member.userId)
                return yield* new Conflict({ reason: "illegal_transition" });
              const target = yield* repo.findMembership(workspaceId, to);
              if (Option.isNone(target)) return yield* new NotFound({ entity: "Member", id: to });
              // W4: one transaction; the caller becomes admin first, so a unique owner index
              // never sees two owners.
              yield* storeOnly(
                repo.updateMembership({ ...self.value, role: "admin" }, self.value.revision),
              );
              yield* storeOnly(
                repo.updateMembership({ ...target.value, role: "owner" }, target.value.revision),
              );
              yield* audit(workspaceId, "workspace.transferOwnership", workspace.revision, [
                { path: `members.${to}`, before: target.value.role, after: "owner" },
                { path: `members.${member.userId}`, before: "owner", after: "admin" },
              ]);
            }),
          );
        }),
      ),

    close: (confirmName) =>
      run(
        Effect.gen(function* () {
          const { caller, workspaceId } = yield* authorizeInWorkspace("workspace.close");
          yield* store.transaction(
            Effect.gen(function* () {
              const row = yield* storeOnly(repo.lockWorkspace(workspaceId));
              yield* recheck(caller, workspaceId, "workspace.close");
              if (row.closed) return; // idempotent by state (C6 wins over W5 here)
              if (confirmName.trim() !== row.name)
                return yield* invalid(["confirmName"], "request.malformed");
              const now = yield* nowIso;
              const next = yield* storeOnly(
                repo.updateWorkspace({ ...row, closed: true, closedAt: now }, row.revision),
              );
              yield* audit(workspaceId, "workspace.close", next.revision, [
                { path: "closed", before: false, after: true },
              ]);
            }),
          );
        }),
      ),

    recordAccessEvent: (event: AccessEvent) =>
      run(
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          const action =
            event.action === "apiKey.create" || event.action === "apiKey.revoke"
              ? "apiKey.manage"
              : event.action === "grant.create"
                ? "grant.create"
                : caller._tag === "Member" &&
                    event.onBehalfOf !== undefined &&
                    event.onBehalfOf !== caller.userId
                  ? "grant.revoke.all"
                  : "grant.revoke.own";
          const { workspaceId } = yield* authorizeInWorkspace(action);
          const entity = event.action.startsWith("apiKey.") ? "ApiKey" : "McpGrant";
          if (event.subject.entity !== entity) return yield* new Forbidden({ action });
          yield* store.transaction(
            Effect.gen(function* () {
              // The workspace lock serializes duplicate hooks, so the history check below and the
              // append are atomic at READ COMMITTED (C6).
              const row = yield* storeOnly(repo.lockWorkspace(workspaceId));
              // W5: no new credentials on a closed Workspace; revocations stay possible.
              if (event.action.endsWith(".create")) yield* requireOpen(row, action);
              // Idempotent by subject and action (C6): a repeated hook writes no second entry.
              const prior = yield* store.audit.history(workspaceId, {
                entity,
                id: event.subject.id,
              });
              if (prior.some((e) => e.action === event.action)) return;
              const created = event.action.endsWith(".create");
              yield* audit(
                workspaceId,
                event.action,
                null,
                [
                  {
                    path: "name",
                    before: created ? null : event.subject.name,
                    after: created ? event.subject.name : null,
                  },
                  ...(event.onBehalfOf === undefined
                    ? []
                    : [{ path: "onBehalfOf", before: null, after: event.onBehalfOf }]),
                ],
                { subject: { entity, id: event.subject.id } },
              );
            }),
          );
        }),
      ),
  };

  return impl;
});

/**
 * The live `Workspaces` service. Requires CoreStore | IdGenerator | WorkspacesRepo |
 * WorkspaceSeries | UserDirectory | RegistryLookup | BlobStorage | InvitationDelivery |
 * InvitationTokens | BrandingPreview | BankAccountReferences.
 *
 * The one cast: `WorkspacesImpl` widens the domain signatures with `Unavailable` (and
 * `Conflict{idempotency_mismatch}` on `create`); see the module header.
 */
export const WorkspacesLive: Layer.Layer<Workspaces, never, WorkspacesRequirements> = Layer.effect(
  Workspaces,
  makeWorkspaces as Effect.Effect<
    WorkspacesImpl,
    never,
    WorkspacesRequirements
  > as unknown as Effect.Effect<Workspaces["Service"], never, WorkspacesRequirements>,
);

export type WorkspacesRequirements =
  | CoreStore
  | IdGenerator
  | WorkspacesRepo
  | WorkspaceSeries
  | UserDirectory
  | RegistryLookup
  | BlobStorage
  | InvitationDelivery
  | InvitationTokens
  | BrandingPreview
  | BankAccountReferences;
