import type {
  AuditEntry,
  Caller,
  ContactId,
  ContactInput,
  ContactRole,
  Forbidden,
  Invalid,
  Page,
  RegistryResult,
  RequestOptions,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  ContactId as ContactIdSchema,
  Contacts,
  DocumentKind,
  NotFound,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
/**
 * `Contacts` (core-ports 4.2): Contacts with their particulars, roles and billing overrides.
 * Writes are audited on subject `Contact` (`contact.save`, `contact.archive`); `fromIco` saves
 * through the registry and is audited as `contact.save`.
 */
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { canonicalJson } from "../../shared/canonicalJson";
import { orUnavailable } from "../../shared/errors";
import { sha256Hex } from "../../shared/hash";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import type { UniqueViolation } from "../../store/CoreStore";
import { CoreStore, StoreUnavailable } from "../../store/CoreStore";
import { RegistryLookup, validateIco } from "../workspaces/registry";
import { decodeInput, foldText, invalidAt } from "./input";
import type { ContactRow, ContactSaveFields, ContactViewData } from "./model";
import {
  ContactSaveInput,
  ContactSavePayload,
  ContactViewSchema,
  normalizeDefaults,
  toContactView,
  uniqueRoles,
} from "./model";
import { CONTACTS_ACTIVE_ICO_UNIQUE, ContactsRepo } from "./repo";
import { ContactSeriesLookup } from "./series";

/** Default page size of `search`; `limit` ranges 1 to 100 (http-mcp-contracts 342). */
export const CONTACT_PAGE_SIZE = 50;
export const CONTACT_PAGE_MAX = 100;

/** The Contacts methods with the errors the spec gives them, as the domain tag declares them. */
export interface ContactsImpl {
  readonly fromIco: (
    caller: Caller,
    ico: string,
    opts?: { readonly role?: ContactRole },
  ) => Effect.Effect<ContactViewData, Invalid | NotFound | Unavailable | Forbidden>;
  readonly save: (
    caller: Caller,
    input: ContactInput & { readonly id?: ContactId; readonly expectedRevision?: number },
    opts?: RequestOptions,
  ) => Effect.Effect<ContactViewData, Invalid | NotFound | Conflict | Forbidden | Unavailable>;
  readonly archive: (
    caller: Caller,
    id: ContactId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable>;
  readonly get: (
    caller: Caller,
    id: ContactId,
  ) => Effect.Effect<ContactViewData, NotFound | Forbidden | Unavailable>;
  readonly search: (
    caller: Caller,
    q: {
      readonly text?: string;
      readonly role?: ContactRole;
      readonly cursor?: string;
      /** 1 to 100, default 50 (http-mcp-contracts 342). */
      readonly limit?: number;
    },
  ) => Effect.Effect<Page<ContactViewData>, Invalid | Forbidden | Unavailable>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const duplicateIco = Conflict.make({ reason: "duplicate" });

/** A broken active-IČO index is the duplicate Conflict; any other unique index is a bug. */
const onUniqueViolation = (violation: UniqueViolation): Effect.Effect<never, Conflict> =>
  violation.constraint === CONTACTS_ACTIVE_ICO_UNIQUE
    ? Effect.fail(duplicateIco)
    : Effect.die(violation);

/** One change per view field that differs (audit `changes`, rule C5). */
const changesOf = (
  before: ContactViewData | null,
  after: ContactViewData,
): AuditEntry["changes"] => {
  const keys = EffectRecord.keys(after);
  return EffectArray.map(
    EffectArray.filter(
      EffectArray.filter(keys, (key) => key !== "id" && key !== "revision"),
      (key) => before === null || canonicalJson(before[key]) !== canonicalJson(after[key]),
    ),
    (key) => ({ path: key, before: before === null ? null : before[key], after: after[key] }),
  );
};

/** Domain checks on decoded fields that the schema does not express. */
const checkFields = (fields: ContactSaveFields): Effect.Effect<void, Invalid> =>
  Effect.gen(function* () {
    if (fields.ico !== undefined && fields.ico !== null) yield* validateIco(fields.ico, ["ico"]);
    const defaults = fields.defaults;
    if (defaults?.dueDays !== undefined && defaults.dueDays < 0) {
      return yield* invalidAt(["defaults", "dueDays"], "request.malformed");
    }
    const policy = defaults?.reminderPolicy;
    if (policy?.mode === "custom") {
      const index = Option.getOrElse(
        EffectArray.findFirstIndex(policy.offsetsDays, (days) => days < 0),
        () => -1,
      );
      if (index !== -1) {
        return yield* invalidAt(
          ["defaults", "reminderPolicy", "offsetsDays", index],
          "request.malformed",
        );
      }
    }
  });

/** Applies `save` fields to a stored Contact (patch semantics, see `ContactSaveFields`). */
const applyFields = (row: ContactRow, fields: ContactSaveFields, now: string): ContactRow => ({
  ...row,
  roles: fields.roles !== undefined ? uniqueRoles(fields.roles) : row.roles,
  name: fields.name ?? row.name,
  ico: fields.ico !== undefined ? fields.ico : row.ico,
  dic: fields.dic !== undefined ? fields.dic : row.dic,
  legalForm: fields.legalForm !== undefined ? fields.legalForm : row.legalForm,
  address: {
    street: fields.address?.street !== undefined ? fields.address.street : row.address.street,
    city: fields.address?.city !== undefined ? fields.address.city : row.address.city,
    postalCode:
      fields.address?.postalCode !== undefined ? fields.address.postalCode : row.address.postalCode,
    country: fields.address?.country ?? row.address.country,
  },
  billingEmails: fields.billingEmails ?? row.billingEmails,
  phone: fields.phone !== undefined ? fields.phone : row.phone,
  note: fields.note !== undefined ? fields.note : row.note,
  defaults: fields.defaults !== undefined ? normalizeDefaults(fields.defaults) : row.defaults,
  updatedAt: now,
});

const emptyOrNull = (value: string): string | null =>
  EffectString.trim(value) === "" ? null : value;

/** Particulars taken from the registry; VAT-payer status is not among them. */
const registryParticulars = (result: RegistryResult) => ({
  name: EffectString.trim(result.name),
  dic: result.dic === null ? null : emptyOrNull(result.dic),
  legalForm: emptyOrNull(result.legalForm),
  address: {
    street: emptyOrNull(result.address.street),
    city: emptyOrNull(result.address.city),
    postalCode: emptyOrNull(result.address.postalCode),
    country: COUNTRY_CODE.test(result.address.country) ? result.address.country : "CZ",
  },
});

/** Whether two rows differ in anything but bookkeeping (timestamps, revision). */
const sameContent = (a: ContactRow, b: ContactRow): boolean => {
  const strip = ({ revision, updatedAt, registryFetchedAt, ...rest }: ContactRow) => rest;
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
};

// Search cursors: `<filter hash>.<anchor revision>.<id of the last row>`, opaque, bound to the
// filter they came from (http-mcp-contracts 362) and short whatever the names are (HTTP caps
// cursors at 512). The keyset boundary is the anchor row's (name, id); any write to the anchor
// bumps its revision and may move it, so a changed revision makes the cursor stale
// (`page.cursor_mismatch`, which ui-port treats as "reload from the first page").

const filterHash = (text: string, role: ContactRole | undefined) =>
  Effect.map(sha256Hex(canonicalJson([text, role ?? null])), (hex) =>
    EffectString.slice(0, 16)(hex),
  );

const makeCursor = (filter: string, last: ContactRow) => `${filter}.${last.revision}.${last.id}`;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CONTACT_CURSOR = /^([0-9a-f]{16})\.([1-9][0-9]{0,15})\.([0-9a-f-]{36})$/;
const isContactId = Schema.is(ContactIdSchema);

const parseCursor = (
  cursor: string,
): { readonly f: string; readonly r: number; readonly i: ContactId } | null => {
  const match = CONTACT_CURSOR.exec(cursor);
  return match?.[1] === undefined || match[2] === undefined || !isContactId(match[3])
    ? null
    : { f: match[1], r: Number(match[2]), i: match[3] };
};

export const makeContacts: Effect.Effect<
  ContactsImpl,
  never,
  CoreStore | IdGenerator | ContactsRepo | RegistryLookup | ContactSeriesLookup
> = Effect.gen(function* () {
  const store = yield* CoreStore;
  const repo = yield* ContactsRepo;
  // Only these services: the caller stays the one of each call.
  const ids = yield* IdGenerator;
  const context = Context.make(CoreStore, store).pipe(
    Context.add(IdGenerator, ids),
    Context.add(ContactsRepo, repo),
  );
  const registry = yield* RegistryLookup;
  const seriesLookup = yield* ContactSeriesLookup;

  /**
   * Each `preferredSeriesByKind` entry must name a series of this Workspace that numbers that
   * kind; anything else is `NotFound{NumberingSeries}` (rule R2: another Workspace's series is
   * not revealed, and a series of another kind is not one the kind can use).
   */
  const checkSeries = (
    workspaceId: WorkspaceId,
    fields: ContactSaveFields,
  ): Effect.Effect<void, NotFound | StoreUnavailable> =>
    Effect.gen(function* () {
      const wanted = EffectArray.flatMap(DocumentKind.literals, (kind) => {
        const series = fields.defaults?.preferredSeriesByKind?.[kind];
        return series === undefined ? [] : [[kind, series] as const];
      });
      if (wanted.length === 0) return;
      const kinds = yield* seriesLookup.kindsOf(
        workspaceId,
        EffectArray.map(wanted, ([, series]) => series),
      );
      for (const [kind, series] of wanted) {
        if (kinds.get(series) !== kind) {
          return yield* NotFound.make({ entity: "NumberingSeries", id: series });
        }
      }
    });

  /** Fails with `Conflict{duplicate}` when another active Contact holds `row.ico`. */
  const ensureIcoFree = (row: ContactRow): Effect.Effect<void, Conflict | StoreUnavailable> => {
    if (row.ico === null || row.archivedAt !== null) return Effect.void;
    return Effect.flatMap(repo.findActiveByIco(row.workspaceId, row.ico), (holder) =>
      Effect.fail(duplicateIco).pipe(
        Effect.when(Effect.succeed(Option.isSome(holder) && holder.value.id !== row.id)),
        Effect.asVoid,
      ),
    );
  };

  const audit = (caller: Caller, before: ContactRow | null, after: ContactRow, action: string) =>
    appendAudit(caller, {
      workspaceId: after.workspaceId,
      subject: { entity: "Contact", id: after.id },
      action,
      revision: after.revision,
      changes: changesOf(before === null ? null : toContactView(before), toContactView(after)),
    });

  const create = Effect.fn("create")(function* (
    caller: Caller,
    workspaceId: WorkspaceId,
    fields: ContactSaveFields,
  ) {
    if (fields.name === undefined) return yield* invalidAt(["name"], "request.malformed");
    const now = yield* nowIso;
    const row: ContactRow = {
      id: yield* newId(ContactIdSchema.make),
      workspaceId,
      revision: 1,
      roles: uniqueRoles(fields.roles ?? ["customer"]),
      name: fields.name,
      ico: fields.ico ?? null,
      dic: fields.dic ?? null,
      legalForm: fields.legalForm ?? null,
      address: {
        street: fields.address?.street ?? null,
        city: fields.address?.city ?? null,
        postalCode: fields.address?.postalCode ?? null,
        country: fields.address?.country ?? "CZ",
      },
      billingEmails: fields.billingEmails ?? [],
      phone: fields.phone ?? null,
      note: fields.note ?? null,
      defaults: normalizeDefaults(fields.defaults),
      registryFetchedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* checkSeries(workspaceId, fields);
    yield* ensureIcoFree(row);
    const inserted = yield* repo
      .insert(row)
      .pipe(Effect.catchTag("UniqueViolation", onUniqueViolation));
    yield* audit(caller, null, inserted, "contact.save");
    return inserted;
  });

  const edit = Effect.fn("edit")(function* (
    caller: Caller,
    workspaceId: WorkspaceId,
    id: ContactId,
    expectedRevision: number | undefined,
    fields: ContactSaveFields,
  ) {
    // An edit without expectedRevision is stale by definition (rule C2): report the current one.
    const current =
      expectedRevision === undefined
        ? yield* Effect.flatMap(repo.lock(workspaceId, id), (row) =>
            Effect.fail(
              Conflict.make({ reason: "revision_changed", currentRevision: row.revision }),
            ),
          )
        : yield* repo.getForUpdate(workspaceId, id, expectedRevision);
    // Series are a state-dependent rule: checked after the revision (C2).
    yield* checkSeries(workspaceId, fields);
    const nowIso_1 = yield* nowIso;
    const next = applyFields(current, fields, nowIso_1);
    if (sameContent(current, next)) return current;
    yield* ensureIcoFree(next);
    const updated = yield* repo
      .update(next, current.revision)
      .pipe(Effect.catchTag("UniqueViolation", onUniqueViolation));
    yield* audit(caller, current, updated, "contact.save");
    return updated;
  });

  /**
   * fromIco on an existing active Contact: refresh registry particulars, add the role. `None`
   * when, once locked, the row is no longer the active holder of `ico` (a concurrent archive or
   * IČO edit between the unlocked lookup and the lock); the caller then looks again.
   */
  const refresh = Effect.fn("refresh")(function* (
    caller: Caller,
    existing: ContactRow,
    result: RegistryResult,
    role: ContactRole | undefined,
    now: string,
  ) {
    // Contacts are never deleted, so the row just found still exists.
    const current = yield* repo
      .lock(existing.workspaceId, existing.id)
      .pipe(Effect.catchTag("NotFound", Effect.die));
    if (current.archivedAt !== null || current.ico !== result.ico) {
      return Option.none<ContactRow>();
    }
    const particulars = registryParticulars(result);
    const next: ContactRow = {
      ...current,
      ...particulars,
      // No DIČ in the registry does not erase one the user entered.
      dic: particulars.dic ?? current.dic,
      roles: role === undefined ? current.roles : uniqueRoles([...current.roles, role]),
      registryFetchedAt: now,
      updatedAt: now,
    };
    if (sameContent(current, next) && current.registryFetchedAt !== null) {
      return Option.some(current);
    }
    // The row is locked (no revision race) and the IČO does not change: all bugs here.
    const updated = yield* repo.update(next, current.revision).pipe(
      Effect.catchTags({
        NotFound: Effect.die,
        UniqueViolation: Effect.die,
        Conflict: Effect.die,
      }),
    );
    yield* audit(caller, current, updated, "contact.save");
    return Option.some(updated);
  });

  /** Bounded retries of the upsert when concurrent writers move the IČO under it. */
  const UPSERT_ATTEMPTS = 3;

  /** Refreshes the active Contact holding the IČO, else inserts one (inside the transaction). */
  const upsertByIco = (
    caller: Caller,
    workspaceId: WorkspaceId,
    result: RegistryResult,
    role: ContactRole | undefined,
    attempt: number,
  ): Effect.Effect<ContactRow, StoreUnavailable, CoreStore | IdGenerator | ContactsRepo> =>
    Effect.gen(function* () {
      if (attempt > UPSERT_ATTEMPTS) {
        // Sustained contention is an expected outcome, not a bug: retryable Unavailable{database}.
        return yield* StoreUnavailable.make({
          cause: `fromIco: IČO ${result.ico} kept moving under concurrent writes`,
        });
      }
      const again = () => upsertByIco(caller, workspaceId, result, role, attempt + 1);
      const now = yield* nowIso;
      const existing = yield* repo.findActiveByIco(workspaceId, result.ico);
      if (Option.isSome(existing)) {
        const refreshed = yield* refresh(caller, existing.value, result, role, now);
        return Option.isSome(refreshed) ? refreshed.value : yield* again();
      }
      const fresh: ContactRow = {
        id: yield* newId(ContactIdSchema.make),
        workspaceId,
        revision: 1,
        roles: [role ?? "customer"],
        ico: result.ico,
        ...registryParticulars(result),
        billingEmails: [],
        phone: null,
        note: null,
        defaults: normalizeDefaults(undefined),
        registryFetchedAt: now,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      // Savepoint: a concurrent fromIco may insert the same IČO first; then look again.
      return yield* store.transaction(repo.insert(fresh)).pipe(
        Effect.tap((inserted) => audit(caller, null, inserted, "contact.save")),
        Effect.catchTag("UniqueViolation", (violation) =>
          violation.constraint === CONTACTS_ACTIVE_ICO_UNIQUE ? again() : Effect.die(violation),
        ),
      );
    });

  const impl: ContactsImpl = {
    fromIco: Effect.fn("fromIco")(
      function* (caller: Caller, ico, opts) {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "contact.write");
        // Checksum, cache and serialized registry call, outside the transaction.
        const result = yield* registry.lookup(ico);
        if (result === null) return yield* NotFound.make({ entity: "Contact", id: ico });
        const row = yield* store.transaction(
          upsertByIco(caller, workspaceId, result, opts?.role, 1),
        );
        return toContactView(row);
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),

    save: Effect.fn("save")(
      function* (caller: Caller, input, opts) {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "contact.write");
        // The whole input, strictly: unknown fields, a malformed id or revision are Invalid.
        const { id, expectedRevision, ...fields } = yield* decodeInput(ContactSaveInput, input);
        yield* checkFields(fields);
        const row = yield* withIdempotency(
          {
            scope: { _tag: "Workspace", workspaceId },
            key: opts?.requestKey,
            method: "Contacts.save",
            payload: {
              schema: ContactSavePayload,
              value: { fields, id, expectedRevision },
            },
            result: ContactViewSchema,
          },
          Effect.gen(function* () {
            const saved =
              id === undefined
                ? yield* create(caller, workspaceId, fields)
                : yield* edit(caller, workspaceId, id, expectedRevision, fields);
            return toContactView(saved);
          }),
        );
        return row;
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),

    archive: Effect.fn("archive")(
      function* (caller: Caller, id) {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "contact.write");
        yield* store.transaction(
          Effect.gen(function* () {
            // Idempotent by state (rule C6): archiving an archived Contact changes nothing.
            const current = yield* repo.lock(workspaceId, id);
            if (current.archivedAt !== null) return;
            const now = yield* nowIso;
            const updated = yield* repo
              .update({ ...current, archivedAt: now, updatedAt: now }, current.revision)
              .pipe(Effect.catchTags({ UniqueViolation: Effect.die, Conflict: Effect.die }));
            yield* audit(caller, current, updated, "contact.archive");
          }),
        );
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),

    get: Effect.fn("get")(
      function* (caller: Caller, id) {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "contact.read");
        const value_1 = yield* repo.get(workspaceId, id);
        return toContactView(value_1);
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),

    search: Effect.fn("search")(
      function* (caller: Caller, q) {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "contact.read");
        const limit = q.limit ?? CONTACT_PAGE_SIZE;
        if (!Number.isInteger(limit) || limit < 1 || limit > CONTACT_PAGE_MAX) {
          return yield* invalidAt(["limit"], "request.malformed");
        }
        const text = q.text === undefined ? "" : foldText(q.text);
        const filter = yield* filterHash(text, q.role);
        let after: readonly [string, string] | undefined;
        if (q.cursor !== undefined) {
          const cursor = parseCursor(q.cursor);
          const mismatch = invalidAt(["cursor"], "page.cursor_mismatch");
          if (cursor === null || cursor.f !== filter) return yield* mismatch;
          // Rows are archived, never deleted; a renamed anchor makes the cursor stale.
          const last = yield* repo
            .get(workspaceId, cursor.i)
            .pipe(Effect.catchTag("NotFound", () => Effect.fail(mismatch)));
          if (last.revision !== cursor.r) return yield* mismatch;
          after = [last.name, last.id];
        }
        const rows = yield* repo.search(workspaceId, {
          text: text === "" ? undefined : text,
          role: q.role,
          after,
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: EffectArray.map(page, toContactView),
          nextCursor: rows.length > limit && last !== undefined ? makeCursor(filter, last) : null,
        };
      },
      Effect.provide(context),
      (_) => orUnavailable(_),
    ),
  };
  return impl;
});

/**
 * `Contacts` on CoreStore, IdGenerator, `ContactsRepo`, the process-wide `RegistryLookup`
 * (shared with `Workspaces.lookupCompany`, rule W9) and `ContactSeriesLookup` (from the
 * numbering module at integration).
 */
export const ContactsLive: Layer.Layer<
  Contacts,
  never,
  CoreStore | IdGenerator | ContactsRepo | RegistryLookup | ContactSeriesLookup
> = Layer.effect(Contacts, makeContacts);
