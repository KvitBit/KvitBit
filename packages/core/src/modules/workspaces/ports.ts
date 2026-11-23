/**
 * Narrow ports the Workspaces module depends on, each with an in-memory implementation for tests:
 * - `UserDirectory`: Member names and emails (Better Auth owns users; apps/server implements it).
 * - `WorkspaceSeries`: Numbering Series storage, owned by the numbering module (board agreement
 *   #335 on #331/#333). Structurally identical to its `NumberingSeries` configure/list/
 *   ensureDefaults, so integration provides it from that service.
 * - `InvitationDelivery`: starts the `MemberInvitation` email after commit (section 7).
 * - `BrandingPreview`: renders the sample document of `previewBranding` (PdfRenderer).
 * - `BankAccountReferences`: drafts and Templates that use a bank account (documents, templates
 *   modules), for `removeBankAccount`.
 */
import type {
  BankAccountId,
  DocumentKind,
  FileDownload,
  InvitationId,
  IsoDate,
  Locale,
  NotFound,
  NumberingSeriesId,
  NumberingSeriesView,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, Invalid } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import type { IdGenerator } from "../../shared/ids";
import { newId } from "../../shared/ids";
import type { StoreUnavailable } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import type { Branding, InvitationRole, IssuingEntity } from "./model";

// UserDirectory -------------------------------------------------------------------------------

export interface DirectoryUser {
  readonly userId: UserId;
  readonly name: string;
  readonly email: string;
}

export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    /** Users that exist among `ids`, in any order; unknown ids are left out. */
    readonly lookup: (
      ids: ReadonlyArray<UserId>,
    ) => Effect.Effect<ReadonlyArray<DirectoryUser>, StoreUnavailable>;
  }
>()("kvitbit/core/UserDirectory") {}

/** In-memory `UserDirectory` with a writable user map. */
export class UserDirectoryFake extends Context.Service<
  UserDirectoryFake,
  { readonly users: Ref.Ref<ReadonlyMap<UserId, DirectoryUser>> }
>()("kvitbit/core/testing/UserDirectoryFake") {
  static readonly layer = (
    users: ReadonlyArray<DirectoryUser> = [],
  ): Layer.Layer<UserDirectory | UserDirectoryFake> =>
    Layer.effectContext(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyMap<UserId, DirectoryUser>>(
          new Map(users.map((u) => [u.userId, u])),
        );
        return Context.make(UserDirectoryFake, { users: ref }).pipe(
          Context.add(UserDirectory, {
            lookup: (ids) =>
              Effect.map(Ref.get(ref), (all) =>
                ids.flatMap((id) => {
                  const user = all.get(id);
                  return user === undefined ? [] : [user];
                }),
              ),
          }),
        );
      }),
    );
}

// WorkspaceSeries ------------------------------------------------------------------------------

/** Exactly the domain `configureSeries` input. */
export interface SeriesInput {
  readonly id?: NumberingSeriesId;
  readonly kind: DocumentKind;
  readonly name: string;
  readonly pattern: string;
  readonly nextNumber?: number;
  readonly isDefault?: boolean;
}

export class WorkspaceSeries extends Context.Service<
  WorkspaceSeries,
  {
    /** Runs inside the caller's transaction. Validates the pattern and the counter guard (W3). */
    readonly configure: (
      workspaceId: WorkspaceId,
      input: SeriesInput,
      today: IsoDate,
    ) => Effect.Effect<
      { readonly view: NumberingSeriesView; readonly before: NumberingSeriesView | null },
      Invalid | NotFound | Conflict | StoreUnavailable
    >;
    readonly list: (
      workspaceId: WorkspaceId,
      today: IsoDate,
    ) => Effect.Effect<ReadonlyArray<NumberingSeriesView>, StoreUnavailable>;
    /** Creates the default series of each listed kind that has none. */
    readonly ensureDefaults: (
      workspaceId: WorkspaceId,
      kinds: ReadonlyArray<DocumentKind>,
    ) => Effect.Effect<void, StoreUnavailable>;
  }
>()("kvitbit/core/WorkspaceSeries") {}

/** Default patterns per kind (core-engines `DEFAULT_SERIES_PATTERNS`, user-flows 260). */
export const DEFAULT_SERIES_PATTERNS: { readonly [K in DocumentKind]: string } = {
  invoice: "YYYY-NNNN",
  proforma: "ZF-YYYY-NNNN",
  payment_tax_document: "DD-YYYY-NNNN",
  credit_note: "OD-YYYY-NNNN",
};

const DEFAULT_SERIES_NAMES: { readonly [K in DocumentKind]: string } = {
  invoice: "Faktury",
  proforma: "Zálohové faktury",
  payment_tax_document: "Daňové doklady k platbě",
  credit_note: "Opravné doklady",
};

const FakeSeriesRow = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  revision: Schema.Number,
  kind: Schema.String,
  name: Schema.String,
  pattern: Schema.String,
  isDefault: Schema.Boolean,
  /** Next counter per period key. */
  counters: Schema.Record(Schema.String, Schema.Number),
});
interface FakeSeriesRow {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly kind: DocumentKind;
  readonly name: string;
  readonly pattern: string;
  readonly isDefault: boolean;
  readonly counters: Readonly<Record<string, number>>;
}

const FakeSeries = defineCollection<FakeSeriesRow>({
  name: "numbering_series_fake",
  entity: "NumberingSeries",
  schema: FakeSeriesRow as unknown as Schema.Codec<FakeSeriesRow, unknown>,
});

const PATTERN = /^(?:[^N]*?)(N+)(?:[^N]*)$/;

/** Period key of `pattern` on `today`: month, year, or "all". */
const periodKeyOf = (pattern: string, today: IsoDate): string =>
  pattern.includes("MM") ? today.slice(0, 7) : pattern.includes("YY") ? today.slice(0, 4) : "all";

const formatNumber = (pattern: string, counter: number, today: IsoDate): string =>
  pattern
    .replace(/N+/, (run) => String(counter).padStart(run.length, "0"))
    .replace("YYYY", today.slice(0, 4))
    .replace("YY", today.slice(2, 4))
    .replace("MM", today.slice(5, 7));

const patternInvalid = (params?: Record<string, string>) =>
  new Invalid({
    issues: [
      {
        path: ["pattern"],
        code: "numbering.pattern_invalid",
        ...(params === undefined ? {} : { params }),
      },
    ],
  });

/**
 * In-memory `WorkspaceSeries` on `MemoryTables` (transactional), approximating the numbering
 * module: one run of N, YYYY/YY/MM tokens, a counter per period that only grows.
 */
export const WorkspaceSeriesMemory: Layer.Layer<
  WorkspaceSeries,
  never,
  MemoryTables | IdGenerator
> = Layer.effect(
  WorkspaceSeries,
  Effect.gen(function* () {
    const tables = yield* MemoryTables;
    const ids = yield* Effect.context<IdGenerator>();
    const rows = tables.collection(FakeSeries);
    const view = (row: FakeSeriesRow, today: IsoDate): NumberingSeriesView => {
      const periodKey = periodKeyOf(row.pattern, today);
      const nextCounter = row.counters[periodKey] ?? 1;
      return {
        id: row.id as NumberingSeriesId,
        kind: row.kind,
        name: row.name,
        pattern: row.pattern,
        isDefault: row.isDefault,
        periodKey,
        nextCounter,
        nextNumber: formatNumber(row.pattern, nextCounter, today),
      };
    };
    const ofWorkspace = (workspaceId: WorkspaceId) => rows.list(workspaceId, { orderBy: ["kind"] });
    const demoteOthers = (workspaceId: WorkspaceId, kind: DocumentKind, keep: string) =>
      Effect.gen(function* () {
        for (const other of yield* ofWorkspace(workspaceId)) {
          if (other.kind === kind && other.id !== keep && other.isDefault) {
            yield* Effect.orDie(rows.update({ ...other, isDefault: false }, other.revision));
          }
        }
      });
    return {
      configure: (workspaceId, input, today) =>
        Effect.gen(function* () {
          if (!PATTERN.test(input.pattern)) return yield* patternInvalid();
          const periodKey = periodKeyOf(input.pattern, today);
          const all = yield* ofWorkspace(workspaceId);
          if (input.id === undefined) {
            const first = !all.some((s) => s.kind === input.kind);
            const isDefault = first || input.isDefault === true;
            const id = yield* Effect.provide(newId<NumberingSeriesId>(), ids);
            const row = yield* Effect.orDie(
              rows.insert({
                id,
                workspaceId,
                revision: 1,
                kind: input.kind,
                name: input.name,
                pattern: input.pattern,
                isDefault,
                counters: input.nextNumber === undefined ? {} : { [periodKey]: input.nextNumber },
              }),
            );
            if (isDefault) yield* demoteOthers(workspaceId, input.kind, id);
            return { view: view(row, today), before: null };
          }
          const current = yield* rows.lock(workspaceId, input.id);
          const before = view(current, today);
          if (current.kind !== input.kind)
            return yield* new Conflict({ reason: "illegal_transition" });
          if (input.isDefault === false && current.isDefault) {
            return yield* new Conflict({ reason: "illegal_transition" });
          }
          const used = current.counters[periodKey] ?? 1;
          if (input.nextNumber !== undefined && input.nextNumber < used) {
            return yield* patternInvalid({ reason: "below_used", minimum: String(used) });
          }
          const isDefault = current.isDefault || input.isDefault === true;
          const next = yield* Effect.orDie(
            rows.update(
              {
                ...current,
                name: input.name,
                pattern: input.pattern,
                isDefault,
                counters:
                  input.nextNumber === undefined
                    ? current.counters
                    : { ...current.counters, [periodKey]: input.nextNumber },
              },
              current.revision,
            ),
          );
          if (isDefault) yield* demoteOthers(workspaceId, input.kind, next.id);
          return { view: view(next, today), before };
        }),
      list: (workspaceId, today) =>
        Effect.map(ofWorkspace(workspaceId), (all) => all.map((row) => view(row, today))),
      ensureDefaults: (workspaceId, kinds) =>
        Effect.gen(function* () {
          const all = yield* ofWorkspace(workspaceId);
          for (const kind of kinds) {
            if (all.some((s) => s.kind === kind)) continue;
            const id = yield* Effect.provide(newId<NumberingSeriesId>(), ids);
            yield* Effect.orDie(
              rows.insert({
                id,
                workspaceId,
                revision: 1,
                kind,
                name: DEFAULT_SERIES_NAMES[kind],
                pattern: DEFAULT_SERIES_PATTERNS[kind],
                isDefault: true,
                counters: {},
              }),
            );
          }
        }),
    };
  }),
);

// InvitationDelivery ---------------------------------------------------------------------------

export interface InvitationSend {
  readonly workspaceId: WorkspaceId;
  readonly invitationId: InvitationId;
  /** The raw token of this send epoch; only its hash is stored. */
  readonly token: string;
  readonly sendEpoch: number;
  readonly email: string;
  readonly role: InvitationRole;
  readonly invitedBy: UserId;
}

export class InvitationDelivery extends Context.Service<
  InvitationDelivery,
  {
    /** Called after commit; starts the `MemberInvitation` email for one send epoch. */
    readonly start: (send: InvitationSend) => Effect.Effect<void>;
  }
>()("kvitbit/core/InvitationDelivery") {}

/** Captures every started invitation send. */
export class CaptureInvitationDelivery extends Context.Service<
  CaptureInvitationDelivery,
  { readonly sent: Ref.Ref<ReadonlyArray<InvitationSend>> }
>()("kvitbit/core/testing/CaptureInvitationDelivery") {
  static readonly layer: Layer.Layer<InvitationDelivery | CaptureInvitationDelivery> =
    Layer.effectContext(
      Effect.gen(function* () {
        const sent = yield* Ref.make<ReadonlyArray<InvitationSend>>([]);
        return Context.make(CaptureInvitationDelivery, { sent }).pipe(
          Context.add(InvitationDelivery, {
            start: (send) => Ref.update(sent, (all) => [...all, send]),
          }),
        );
      }),
    );
}

// BrandingPreview ------------------------------------------------------------------------------

export interface BrandingPreviewInput {
  readonly workspaceId: WorkspaceId;
  readonly branding: Branding;
  readonly issuingEntity: IssuingEntity;
  readonly kind: DocumentKind;
  readonly language: Locale;
}

export class BrandingPreview extends Context.Service<
  BrandingPreview,
  {
    /** Renders the fixed sample document; persists nothing. Renderer failures are defects. */
    readonly render: (input: BrandingPreviewInput) => Effect.Effect<FileDownload>;
  }
>()("kvitbit/core/BrandingPreview") {}

/** A renderer that returns the input as JSON bytes, so tests can see what was rendered. */
export const BrandingPreviewFake: Layer.Layer<BrandingPreview> = Layer.succeed(BrandingPreview, {
  render: (input) =>
    Effect.succeed({
      filename: `preview-${input.kind}.pdf`,
      contentType: "application/pdf",
      bytes: Stream.succeed(new TextEncoder().encode(JSON.stringify(input))),
    }),
});

// BankAccountReferences ------------------------------------------------------------------------

export class BankAccountReferences extends Context.Service<
  BankAccountReferences,
  {
    /** Drafts and Templates that use the account (issued documents keep their snapshot). */
    readonly count: (
      workspaceId: WorkspaceId,
      id: BankAccountId,
    ) => Effect.Effect<number, StoreUnavailable>;
    /** Points those drafts and Templates at `to`, inside the caller's transaction. */
    readonly reassign: (
      workspaceId: WorkspaceId,
      from: BankAccountId,
      to: BankAccountId,
    ) => Effect.Effect<void, StoreUnavailable>;
  }
>()("kvitbit/core/BankAccountReferences") {}

/** In-memory references with a writable count per account. */
export class BankAccountReferencesFake extends Context.Service<
  BankAccountReferencesFake,
  { readonly uses: Ref.Ref<ReadonlyMap<BankAccountId, number>> }
>()("kvitbit/core/testing/BankAccountReferencesFake") {
  static readonly layer: Layer.Layer<BankAccountReferences | BankAccountReferencesFake> =
    Layer.effectContext(
      Effect.gen(function* () {
        const uses = yield* Ref.make<ReadonlyMap<BankAccountId, number>>(new Map());
        return Context.make(BankAccountReferencesFake, { uses }).pipe(
          Context.add(BankAccountReferences, {
            count: (_workspaceId, id) => Effect.map(Ref.get(uses), (all) => all.get(id) ?? 0),
            reassign: (_workspaceId, from, to) =>
              Ref.update(uses, (all) => {
                const next = new Map(all);
                next.set(to, (all.get(to) ?? 0) + (all.get(from) ?? 0));
                next.delete(from);
                return next;
              }),
          }),
        );
      }),
    );
}
