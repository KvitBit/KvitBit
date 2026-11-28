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
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DocumentKind as DocumentKindSchema,
  Invalid,
  NumberingSeriesId as NumberingSeriesIdSchema,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import { sha256Hex } from "../../shared/hash";
import type { IdGenerator } from "../../shared/ids";
import { newId } from "../../shared/ids";
import { CoreStore, type StoreUnavailable } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import type { Branding, IssuingEntity } from "./model";
import { storeOnly } from "./rules";

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
>()("@kvitbit/core/modules/workspaces/ports/UserDirectory") {}

/** In-memory `UserDirectory` with a writable user map. */
export class UserDirectoryFake extends Context.Service<
  UserDirectoryFake,
  { readonly users: Ref.Ref<ReadonlyMap<UserId, DirectoryUser>> }
>()("@kvitbit/core/modules/workspaces/ports/UserDirectoryFake") {
  static readonly layer = (
    users: ReadonlyArray<DirectoryUser> = [],
  ): Layer.Layer<UserDirectory | UserDirectoryFake> =>
    Layer.effectContext(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyMap<UserId, DirectoryUser>>(
          new Map(EffectArray.map(users, (u) => [u.userId, u])),
        );
        return Context.make(UserDirectoryFake, { users: ref }).pipe(
          Context.add(UserDirectory, {
            lookup: (ids) =>
              Effect.map(Ref.get(ref), (all) =>
                EffectArray.flatMap(ids, (id) => {
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
>()("@kvitbit/core/modules/workspaces/ports/WorkspaceSeries") {}

/** Default patterns per kind (core-engines `DEFAULT_SERIES_PATTERNS`, user-flows 260). */
export const DEFAULT_SERIES_PATTERNS = {
  invoice: "YYYY-NNNN",
  proforma: "ZF-YYYY-NNNN",
  payment_tax_document: "DD-YYYY-NNNN",
  credit_note: "OD-YYYY-NNNN",
} satisfies { readonly [K in DocumentKind]: string };

const DEFAULT_SERIES_NAMES = {
  invoice: "Faktury",
  proforma: "Zálohové faktury",
  payment_tax_document: "Daňové doklady k platbě",
  credit_note: "Opravné doklady",
} satisfies { readonly [K in DocumentKind]: string };

const FakeSeriesRow = Schema.Struct({
  id: NumberingSeriesIdSchema,
  workspaceId: WorkspaceId,
  revision: Schema.Finite,
  kind: DocumentKindSchema,
  name: Schema.String,
  pattern: Schema.String,
  isDefault: Schema.Boolean,
  /** Next counter per period key. */
  counters: Schema.Record(Schema.String, Schema.Finite),
});
type FakeSeriesRow = typeof FakeSeriesRow.Type;

const FakeSeries = defineCollection<FakeSeriesRow>({
  name: "numbering_series_fake",
  entity: "NumberingSeries",
  schema: FakeSeriesRow,
});

const PATTERN = /^(?:[^N]*?)(N+)(?:[^N]*)$/;
const COUNTER_PATTERN = /N+/;

/** Period key of `pattern` on `today`: month, year, or "all". */
const periodKeyOf = (pattern: string, today: IsoDate): string =>
  EffectString.includes("MM")(pattern)
    ? EffectString.slice(0, 7)(today)
    : EffectString.includes("YY")(pattern)
      ? EffectString.slice(0, 4)(today)
      : "all";

const formatNumber = (pattern: string, counter: number, today: IsoDate): string => {
  const counterWidth = COUNTER_PATTERN.exec(pattern)?.[0].length ?? 0;
  return Fn.pipe(
    pattern,
    EffectString.replace(
      COUNTER_PATTERN,
      EffectString.padStart(counterWidth, "0")(String(counter)),
    ),
    EffectString.replace("YYYY", EffectString.slice(0, 4)(today)),
    EffectString.replace("YY", EffectString.slice(2, 4)(today)),
    EffectString.replace("MM", EffectString.slice(5, 7)(today)),
  );
};

const patternInvalid = (params?: Record<string, string>) =>
  Invalid.make({
    issues: [
      {
        path: ["pattern"],
        code: "numbering.pattern_invalid",
        params,
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
        id: row.id,
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
    const demoteOthers = Effect.fn("demoteOthers")(function* (
      workspaceId: WorkspaceId,
      kind: DocumentKind,
      keep: string,
    ) {
      for (const other of yield* ofWorkspace(workspaceId)) {
        if (other.kind === kind && other.id !== keep && other.isDefault) {
          yield* storeOnly(rows.update({ ...other, isDefault: false }, other.revision));
        }
      }
    });
    return {
      configure: Effect.fn("WorkspaceSeries.configure")(function* (workspaceId, input, today) {
        if (!PATTERN.test(input.pattern)) return yield* patternInvalid();
        if (
          input.nextNumber !== undefined &&
          !(Number.isSafeInteger(input.nextNumber) && input.nextNumber >= 1)
        ) {
          return yield* Invalid.make({
            issues: [{ path: ["nextNumber"], code: "request.malformed" }],
          });
        }
        const periodKey = periodKeyOf(input.pattern, today);
        const all = yield* ofWorkspace(workspaceId);
        if (input.id === undefined) {
          const first = !EffectArray.some(all, (s) => s.kind === input.kind);
          const isDefault = first || input.isDefault === true;
          const id = yield* Effect.provide(newId(NumberingSeriesIdSchema.make), ids);
          const row = yield* storeOnly(
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
          return yield* Conflict.make({ reason: "illegal_transition" });
        if (input.isDefault === false && current.isDefault) {
          return yield* Conflict.make({ reason: "illegal_transition" });
        }
        const used = current.counters[periodKey] ?? 1;
        if (input.nextNumber !== undefined && input.nextNumber < used) {
          return yield* patternInvalid({ reason: "below_used", minimum: String(used) });
        }
        const isDefault = current.isDefault || input.isDefault === true;
        const next = yield* storeOnly(
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
      list: Effect.fn("WorkspaceSeries.list")((workspaceId, today) =>
        Effect.map(ofWorkspace(workspaceId), (all) =>
          EffectArray.map(all, (row) => view(row, today)),
        ),
      ),
      ensureDefaults: Effect.fn("WorkspaceSeries.ensureDefaults")(function* (workspaceId, kinds) {
        const all = yield* ofWorkspace(workspaceId);
        for (const kind of kinds) {
          if (EffectArray.some(all, (s) => s.kind === kind)) continue;
          const id = yield* Effect.provide(newId(NumberingSeriesIdSchema.make), ids);
          yield* storeOnly(
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

/** The `MemberInvitation` workflow payload: one execution per send epoch (invite = 0). */
export interface InvitationSend {
  readonly workspaceId: WorkspaceId;
  readonly invitationId: InvitationId;
  readonly epoch: number;
}

/**
 * Invitation tokens, derived per (invitation, epoch) with a server secret (HMAC in apps/server),
 * so the workflow's send activity and `OutboxReconcile` rebuild the link from the payload alone.
 * Core stores only the token's SHA-256; a resend bumps the epoch, which invalidates the old token.
 */
export class InvitationTokens extends Context.Service<
  InvitationTokens,
  { readonly token: (invitationId: InvitationId, epoch: number) => Effect.Effect<string> }
>()("@kvitbit/core/modules/workspaces/ports/InvitationTokens") {}

/** Deterministic test tokens (a fixed test secret; never use outside tests). */
export const InvitationTokensFake: Layer.Layer<InvitationTokens> = Layer.succeed(InvitationTokens, {
  token: Effect.fn("InvitationTokens.token")((invitationId, epoch) =>
    sha256Hex(`test-secret:${invitationId}:${epoch}`),
  ),
});

export class InvitationDelivery extends Context.Service<
  InvitationDelivery,
  {
    /** Called after commit; starts the `MemberInvitation` email for one send epoch. */
    readonly start: (send: InvitationSend) => Effect.Effect<void>;
  }
>()("@kvitbit/core/modules/workspaces/ports/InvitationDelivery") {}

/** Captures every started invitation send. */
export class CaptureInvitationDelivery extends Context.Service<
  CaptureInvitationDelivery,
  { readonly sent: Ref.Ref<ReadonlyArray<InvitationSend>> }
>()("@kvitbit/core/modules/workspaces/ports/CaptureInvitationDelivery") {
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
>()("@kvitbit/core/modules/workspaces/ports/BrandingPreview") {}

const encodePreview = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A renderer that returns the input as JSON bytes, so tests can see what was rendered. */
export const BrandingPreviewFake: Layer.Layer<BrandingPreview> = Layer.succeed(BrandingPreview, {
  render: Effect.fn("BrandingPreview.render")(function* (input) {
    const json = yield* encodePreview(input).pipe(Effect.orDie);
    return {
      filename: `preview-${input.kind}.pdf`,
      contentType: "application/pdf",
      bytes: Stream.succeed(new TextEncoder().encode(json)),
    };
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
>()("@kvitbit/core/modules/workspaces/ports/BankAccountReferences") {}

const FakeReferenceRow = Schema.Struct({
  /** The bank account id. */
  id: Schema.String,
  workspaceId: WorkspaceId,
  revision: Schema.Finite,
  uses: Schema.Finite,
});
type FakeReferenceRow = typeof FakeReferenceRow.Type;

const FakeReferences = defineCollection<FakeReferenceRow>({
  name: "bank_account_references_fake",
  entity: "BankAccount",
  schema: FakeReferenceRow,
});

/**
 * In-memory references on `MemoryTables` (transactional, like `WorkspaceSeriesMemory`): a
 * rolled-back `removeBankAccount` restores the counts (C1). The controls run their own
 * transaction.
 */
export class BankAccountReferencesFake extends Context.Service<
  BankAccountReferencesFake,
  {
    /** Sets how many drafts and Templates use the account. */
    readonly set: (
      workspaceId: WorkspaceId,
      id: BankAccountId,
      uses: number,
    ) => Effect.Effect<void, StoreUnavailable>;
    readonly get: (
      workspaceId: WorkspaceId,
      id: BankAccountId,
    ) => Effect.Effect<number, StoreUnavailable>;
  }
>()("@kvitbit/core/modules/workspaces/ports/BankAccountReferencesFake") {
  static readonly layer: Layer.Layer<
    BankAccountReferences | BankAccountReferencesFake,
    never,
    MemoryTables | CoreStore
  > = Layer.effectContext(
    Effect.gen(function* () {
      const tables = yield* MemoryTables;
      const store = yield* CoreStore;
      const rows = tables.collection(FakeReferences);
      const count = (workspaceId: WorkspaceId, id: BankAccountId) =>
        Effect.map(rows.find(workspaceId, id), (row) => (row._tag === "Some" ? row.value.uses : 0));
      /** Upserts the count; inside the caller's transaction. */
      const write = Effect.fn("write")(function* (
        workspaceId: WorkspaceId,
        id: BankAccountId,
        uses: number,
      ) {
        const current = yield* rows.find(workspaceId, id);
        if (current._tag === "Some") {
          yield* storeOnly(rows.update({ ...current.value, uses }, current.value.revision));
        } else {
          yield* storeOnly(rows.insert({ id, workspaceId, revision: 1, uses }));
        }
      });
      return Context.make(BankAccountReferencesFake, {
        set: (workspaceId, id, uses) => store.transaction(write(workspaceId, id, uses)),
        get: (workspaceId, id) => store.transaction(count(workspaceId, id)),
      }).pipe(
        Context.add(BankAccountReferences, {
          count,
          reassign: Effect.fn("reassign")(function* (workspaceId, from, to) {
            const moved = yield* count(workspaceId, from);
            const kept = yield* count(workspaceId, to);
            yield* write(workspaceId, to, kept + moved);
            yield* write(workspaceId, from, 0);
          }),
        }),
      );
    }),
  );
}
