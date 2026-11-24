/**
 * `Contacts` (core-ports 4.2): Contacts with their particulars, roles and billing overrides.
 * Writes are audited on subject `Contact` (`contact.save`, `contact.archive`); `fromIco` saves
 * through the registry and is audited as `contact.save`.
 */
import type {
  AuditEntry,
  ContactId,
  ContactInput,
  ContactRole,
  CurrentCaller,
  DocumentKind,
  Forbidden,
  Invalid,
  NumberingSeriesId,
  Page,
  RegistryResult,
  RequestOptions,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, Contacts, NotFound } from "@kvitbit/domain/contract";
import { Clock, Context, Effect, Layer, Option } from "effect";
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
    ico: string,
    opts?: { readonly role?: ContactRole },
  ) => Effect.Effect<ContactViewData, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>;
  readonly save: (
    input: ContactInput & { readonly id?: ContactId; readonly expectedRevision?: number },
    opts?: RequestOptions,
  ) => Effect.Effect<
    ContactViewData,
    Invalid | NotFound | Conflict | Forbidden | Unavailable,
    CurrentCaller
  >;
  readonly archive: (
    id: ContactId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly get: (
    id: ContactId,
  ) => Effect.Effect<ContactViewData, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly search: (q: {
    readonly text?: string;
    readonly role?: ContactRole;
    readonly cursor?: string;
    /** 1 to 100, default 50 (http-mcp-contracts 342). */
    readonly limit?: number;
  }) => Effect.Effect<Page<ContactViewData>, Invalid | Forbidden | Unavailable, CurrentCaller>;
}

const nowIso = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

const duplicateIco = new Conflict({ reason: "duplicate" });

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
  const keys = Object.keys(after) as Array<keyof ContactViewData>;
  return keys
    .filter((key) => key !== "id" && key !== "revision")
    .filter((key) => before === null || canonicalJson(before[key]) !== canonicalJson(after[key]))
    .map((key) => ({ path: key, before: before === null ? null : before[key], after: after[key] }));
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
      const index = policy.offsetsDays.findIndex((days) => days < 0);
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

const emptyOrNull = (value: string): string | null => (value.trim() === "" ? null : value);

/** Particulars taken from the registry; VAT-payer status is not among them. */
const registryParticulars = (result: RegistryResult) => ({
  name: result.name.trim(),
  dic: result.dic === null ? null : emptyOrNull(result.dic),
  legalForm: emptyOrNull(result.legalForm),
  address: {
    street: emptyOrNull(result.address.street),
    city: emptyOrNull(result.address.city),
    postalCode: emptyOrNull(result.address.postalCode),
    country: /^[A-Z]{2}$/.test(result.address.country) ? result.address.country : "CZ",
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
  Effect.map(sha256Hex(canonicalJson([text, role ?? null])), (hex) => hex.slice(0, 16));

const makeCursor = (filter: string, last: ContactRow) => `${filter}.${last.revision}.${last.id}`;

const parseCursor = (
  cursor: string,
): { readonly f: string; readonly r: number; readonly i: string } | null => {
  const match = /^([0-9a-f]{16})\.([1-9][0-9]{0,15})\.([0-9a-f-]{36})$/.exec(cursor);
  return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
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
  const context = Context.make(CoreStore, store).pipe(
    Context.add(IdGenerator, yield* IdGenerator),
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
      const wanted = Object.entries(fields.defaults?.preferredSeriesByKind ?? {}).filter(
        (entry): entry is [DocumentKind, NumberingSeriesId] => entry[1] !== undefined,
      );
      if (wanted.length === 0) return;
      const kinds = yield* seriesLookup.kindsOf(
        workspaceId,
        wanted.map(([, series]) => series),
      );
      for (const [kind, series] of wanted) {
        if (kinds.get(series) !== kind) {
          return yield* new NotFound({ entity: "NumberingSeries", id: series });
        }
      }
    });

  /** Fails with `Conflict{duplicate}` when another active Contact holds `row.ico`. */
  const ensureIcoFree = (row: ContactRow): Effect.Effect<void, Conflict | StoreUnavailable> =>
    row.ico === null || row.archivedAt !== null
      ? Effect.void
      : Effect.flatMap(repo.findActiveByIco(row.workspaceId, row.ico), (holder) =>
          Option.isSome(holder) && holder.value.id !== row.id
            ? Effect.fail(duplicateIco)
            : Effect.void,
        );

  const audit = (before: ContactRow | null, after: ContactRow, action: string) =>
    appendAudit({
      workspaceId: after.workspaceId,
      subject: { entity: "Contact", id: after.id },
      action,
      revision: after.revision,
      changes: changesOf(before === null ? null : toContactView(before), toContactView(after)),
    });

  const create = (workspaceId: WorkspaceId, fields: ContactSaveFields) =>
    Effect.gen(function* () {
      if (fields.name === undefined) return yield* invalidAt(["name"], "request.malformed");
      const now = yield* nowIso;
      const row: ContactRow = {
        id: yield* newId<ContactId>(),
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
      yield* audit(null, inserted, "contact.save");
      return inserted;
    });

  const edit = (
    workspaceId: WorkspaceId,
    id: ContactId,
    expectedRevision: number | undefined,
    fields: ContactSaveFields,
  ) =>
    Effect.gen(function* () {
      // An edit without expectedRevision is stale by definition (rule C2): report the current one.
      const current =
        expectedRevision === undefined
          ? yield* Effect.flatMap(repo.lock(workspaceId, id), (row) =>
              Effect.fail(
                new Conflict({ reason: "revision_changed", currentRevision: row.revision }),
              ),
            )
          : yield* repo.getForUpdate(workspaceId, id, expectedRevision);
      // Series are a state-dependent rule: checked after the revision (C2).
      yield* checkSeries(workspaceId, fields);
      const next = applyFields(current, fields, yield* nowIso);
      if (sameContent(current, next)) return current;
      yield* ensureIcoFree(next);
      const updated = yield* repo
        .update(next, current.revision)
        .pipe(Effect.catchTag("UniqueViolation", onUniqueViolation));
      yield* audit(current, updated, "contact.save");
      return updated;
    });

  /**
   * fromIco on an existing active Contact: refresh registry particulars, add the role. `None`
   * when, once locked, the row is no longer the active holder of `ico` (a concurrent archive or
   * IČO edit between the unlocked lookup and the lock); the caller then looks again.
   */
  const refresh = (
    existing: ContactRow,
    result: RegistryResult,
    role: ContactRole | undefined,
    now: string,
  ) =>
    Effect.gen(function* () {
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
      yield* audit(current, updated, "contact.save");
      return Option.some(updated);
    });

  /** Bounded retries of the upsert when concurrent writers move the IČO under it. */
  const UPSERT_ATTEMPTS = 3;

  /** Refreshes the active Contact holding the IČO, else inserts one (inside the transaction). */
  const upsertByIco = (
    workspaceId: WorkspaceId,
    result: RegistryResult,
    role: ContactRole | undefined,
    attempt: number,
  ): Effect.Effect<
    ContactRow,
    StoreUnavailable,
    CoreStore | IdGenerator | ContactsRepo | CurrentCaller
  > =>
    Effect.gen(function* () {
      if (attempt > UPSERT_ATTEMPTS) {
        // Sustained contention is an expected outcome, not a bug: retryable Unavailable{database}.
        return yield* new StoreUnavailable({
          cause: `fromIco: IČO ${result.ico} kept moving under concurrent writes`,
        });
      }
      const again = () => upsertByIco(workspaceId, result, role, attempt + 1);
      const now = yield* nowIso;
      const existing = yield* repo.findActiveByIco(workspaceId, result.ico);
      if (Option.isSome(existing)) {
        const refreshed = yield* refresh(existing.value, result, role, now);
        return Option.isSome(refreshed) ? refreshed.value : yield* again();
      }
      const fresh: ContactRow = {
        id: yield* newId<ContactId>(),
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
        Effect.tap((inserted) => audit(null, inserted, "contact.save")),
        Effect.catchTag("UniqueViolation", (violation) =>
          violation.constraint === CONTACTS_ACTIVE_ICO_UNIQUE ? again() : Effect.die(violation),
        ),
      );
    });

  const impl: ContactsImpl = {
    fromIco: (ico, opts) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.write");
        // Checksum, cache and serialized registry call, outside the transaction.
        const result = yield* registry.lookup(ico);
        if (result === null) return yield* new NotFound({ entity: "Contact", id: ico });
        const row = yield* store.transaction(upsertByIco(workspaceId, result, opts?.role, 1));
        return toContactView(row);
      }).pipe(Effect.provide(context), orUnavailable),

    save: (input, opts) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.write");
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
              value: {
                fields,
                ...(id !== undefined ? { id } : {}),
                ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              },
            },
            result: ContactViewSchema,
          },
          Effect.gen(function* () {
            const saved =
              id === undefined
                ? yield* create(workspaceId, fields)
                : yield* edit(workspaceId, id, expectedRevision, fields);
            return toContactView(saved);
          }),
        );
        return row;
      }).pipe(Effect.provide(context), orUnavailable),

    archive: (id) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.write");
        yield* store.transaction(
          Effect.gen(function* () {
            // Idempotent by state (rule C6): archiving an archived Contact changes nothing.
            const current = yield* repo.lock(workspaceId, id);
            if (current.archivedAt !== null) return;
            const now = yield* nowIso;
            const updated = yield* repo
              .update({ ...current, archivedAt: now, updatedAt: now }, current.revision)
              .pipe(Effect.catchTags({ UniqueViolation: Effect.die, Conflict: Effect.die }));
            yield* audit(current, updated, "contact.archive");
          }),
        );
      }).pipe(Effect.provide(context), orUnavailable),

    get: (id) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.read");
        return toContactView(yield* repo.get(workspaceId, id));
      }).pipe(Effect.provide(context), orUnavailable),

    search: (q) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace("contact.read");
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
            .get(workspaceId, cursor.i as ContactId)
            .pipe(Effect.catchTag("NotFound", () => Effect.fail(mismatch)));
          if (last.revision !== cursor.r) return yield* mismatch;
          after = [last.name, last.id];
        }
        const rows = yield* repo.search(workspaceId, {
          ...(text !== "" ? { text } : {}),
          ...(q.role !== undefined ? { role: q.role } : {}),
          ...(after !== undefined ? { after } : {}),
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(toContactView),
          nextCursor: rows.length > limit && last !== undefined ? makeCursor(filter, last) : null,
        };
      }).pipe(Effect.provide(context), orUnavailable),
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
